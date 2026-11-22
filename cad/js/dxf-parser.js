/*
 * Lector de DXF ASCII (R12 a 2018) para el editor.
 * Convierte el dibujo del espacio modelo en entidades simples (ver geometry.js).
 * Los bloques (INSERT) se expanden y sus piezas comparten un identificador de grupo "g".
 */
(function (global) {
  'use strict';
  const G = global.Geo;
  const D2R = Math.PI / 180;

  function decode(buf) {
    const bytes = new Uint8Array(buf);
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 22));
    if (head.startsWith('AutoCAD Binary DXF')) throw new Error('DXF binario no soportado. Guárdelo como DXF ASCII desde su programa CAD.');
    if (/^AC10\d\d/.test(head)) throw new Error('Es un archivo DWG. Conviértalo a DXF (por ejemplo con ODA File Converter, LibreCAD o el propio AutoCAD: "Guardar como DXF").');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  function decodeText(s) {
    return s
      .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
      .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%')
      .replace(/%%(\d{3})/g, (_, n) => String.fromCharCode(+n));
  }

  function mtextPlain(s) {
    s = s.replace(/\\\\/g, '\u0001').replace(/\\[{]/g, '\u0002').replace(/\\[}]/g, '\u0003');
    s = s.replace(/\\[Pp]/g, '\n').replace(/\\~/g, ' ')
      .replace(/\\S([^;]*?)[\^#/]([^;]*?);/g, '$1/$2')
      .replace(/\\[ACcFfHhQTWp][^;]*;/g, '')
      .replace(/\\[LlOoKkNX]/g, '')
      .replace(/[{}]/g, '');
    return decodeText(s.replace(/\u0001/g, '\\').replace(/\u0002/g, '{').replace(/\u0003/g, '}'));
  }

  /* Registro: {type, g:[[code, value], ...]} */
  function rec(r) {
    const first = code => { for (const [c, v] of r.g) if (c === code) return v; return undefined; };
    return {
      type: r.type,
      g: r.g,
      s: (code, def) => { const v = first(code); return v === undefined ? def : v; },
      n: (code, def) => { const v = first(code); if (v === undefined) return def; const x = parseFloat(v); return isNaN(x) ? def : x; },
      all: code => r.g.filter(([c]) => c === code).map(([, v]) => parseFloat(v))
    };
  }

  function parse(text) {
    const lines = text.split(/\r\n|\n|\r/);
    const pairs = [];
    let i = 0;
    while (i < lines.length - 1) {
      const t = lines[i].trim();
      if (t === '') { i++; continue; }
      const c = parseInt(t, 10);
      if (isNaN(c)) { i++; continue; }
      const v = lines[i + 1];
      pairs.push([c, c === 1 || c === 3 ? v.replace(/\s+$/, '') : v.trim()]);
      i += 2;
    }

    const sections = {};
    for (let k = 0; k < pairs.length; k++) {
      if (pairs[k][0] === 0 && pairs[k][1] === 'SECTION' && pairs[k + 1] && pairs[k + 1][0] === 2) {
        const name = pairs[k + 1][1].toUpperCase();
        const recs = [];
        let cur = null;
        k += 2;
        for (; k < pairs.length; k++) {
          const [c, v] = pairs[k];
          if (c === 0) {
            if (v === 'ENDSEC') break;
            cur = { type: v.toUpperCase(), g: [] };
            recs.push(cur);
          } else if (cur) cur.g.push([c, v]);
          else if (name === 'HEADER') { cur = { type: 'HEADER', g: [[c, v]] }; recs.push(cur); }
        }
        sections[name] = recs;
      }
    }

    /* Cabecera */
    let units = 0;
    if (sections.HEADER) {
      const g = sections.HEADER.flatMap(r => r.g);
      for (let k = 0; k < g.length; k++) if (g[k][0] === 9 && g[k][1] === '$INSUNITS' && g[k + 1]) units = parseInt(g[k + 1][1], 10) || 0;
    }

    /* Capas */
    const layers = [];
    const layerMap = new Map();
    (sections.TABLES || []).forEach(r0 => {
      if (r0.type !== 'LAYER') return;
      const r = rec(r0);
      const name = r.s(2, '0');
      if (layerMap.has(name)) return;
      const col = r.n(62, 7), flags = r.n(70, 0), tc = r.s(420);
      const L = {
        name, aci: Math.abs(col) || 7, visible: col >= 0 && !(flags & 1), locked: !!(flags & 4),
        rgb: tc !== undefined ? global.Colors.trueColorHex(parseInt(tc, 10)) : undefined
      };
      layers.push(L); layerMap.set(name, L);
    });
    const ensureLayer = name => {
      if (!layerMap.has(name)) { const L = { name, aci: 7, visible: true, locked: false }; layers.push(L); layerMap.set(name, L); }
    };
    ensureLayer('0');

    /* Bloques */
    const blocks = new Map();
    let blk = null;
    (sections.BLOCKS || []).forEach(r0 => {
      if (r0.type === 'BLOCK') {
        const r = rec(r0);
        blk = { name: r.s(2, ''), bx: r.n(10, 0), by: r.n(20, 0), recs: [] };
        blocks.set(blk.name.toUpperCase(), blk);
      } else if (r0.type === 'ENDBLK') blk = null;
      else if (blk) blk.recs.push(r0);
    });

    const out = [];
    const skipped = {};
    let groupSeq = 1;
    const MIRX = [-1, 0, 0, 1, 0, 0];

    function common(r, ctx) {
      let layer = r.s(8, '0');
      let color = r.n(62, 256);
      const tc = r.s(420);
      let rgb = tc !== undefined ? global.Colors.trueColorHex(parseInt(tc, 10)) : undefined;
      if (ctx.depth > 0) {
        if (layer === '0') layer = ctx.layer;
        if (color === 0) { color = ctx.color; if (!rgb) rgb = ctx.rgb; }
      }
      if (color === 0) color = 7;
      ensureLayer(layer);
      const e = { type: '', layer, color };
      if (rgb) e.rgb = rgb;
      if (ctx.g) e.g = ctx.g;
      return e;
    }

    function push(e, r, ctx) {
      let m = ctx.m;
      if (r.n(230, 1) < 0) m = G.mMul(m, MIRX);
      out.push(G.isIdentity(m) ? e : G.transform(e, m));
    }

    function polyFromVerts(e, verts, closed) {
      e.type = 'polyline';
      e.pts = verts;
      e.closed = closed;
      if (closed && verts.length > 1) {
        const a = verts[0], b = verts[verts.length - 1];
        if (Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12 && !b.b) verts.pop();
      }
      return verts.length >= 2;
    }

    function textEntity(r, base, ctx, isAttrib) {
      const e = Object.assign(base, { type: 'text' });
      e.text = decodeText(r.s(1, ''));
      e.h = r.n(40, 1) || 1;
      e.rot = r.n(50, 0) * D2R;
      const ha = r.n(72, 0), va = r.n(isAttrib ? 74 : 73, 0);
      let x = r.n(10, 0), y = r.n(20, 0);
      if (ha === 3 || ha === 5) {
        const x2 = r.n(11, x), y2 = r.n(21, y);
        e.rot = Math.atan2(y2 - y, x2 - x) || e.rot;
        x = (x + x2) / 2; y = (y + y2) / 2;
        e.align = 'center'; e.valign = 'baseline';
      } else {
        if (ha || va) { x = r.n(11, x); y = r.n(21, y); }
        e.align = ha === 1 || ha === 4 ? 'center' : ha === 2 ? 'right' : 'left';
        e.valign = ha === 4 ? 'middle' : ['baseline', 'bottom', 'middle', 'top'][va] || 'baseline';
      }
      e.x = x; e.y = y;
      return e.text.trim() !== '';
    }

    function nurbs(deg, knots, ctrl, weights, n) {
      const pts = [];
      const lo = knots[deg], hi = knots[knots.length - deg - 1];
      for (let s = 0; s <= n; s++) {
        let t = lo + (hi - lo) * s / n;
        if (t >= hi) t = hi - 1e-10;
        let k = deg;
        while (k < knots.length - deg - 2 && t >= knots[k + 1]) k++;
        const d = [];
        for (let j = 0; j <= deg; j++) {
          const c = ctrl[k - deg + j], w = weights[k - deg + j] || 1;
          d.push([c[0] * w, c[1] * w, w]);
        }
        for (let r = 1; r <= deg; r++) {
          for (let j = deg; j >= r; j--) {
            const i = k - deg + j;
            const den = knots[i + deg - r + 1] - knots[i];
            const a = den ? (t - knots[i]) / den : 0;
            d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
          }
        }
        pts.push({ x: d[deg][0] / d[deg][2], y: d[deg][1] / d[deg][2], b: 0 });
      }
      return pts;
    }

    function hatchLoops(r) {
      const g = r.g;
      let k = g.findIndex(([c]) => c === 91);
      if (k < 0) return [];
      const nPaths = parseInt(g[k][1], 10);
      k++;
      const loops = [];
      const next = code => { while (k < g.length && g[k][0] !== code) k++; return k < g.length ? parseFloat(g[k++][1]) : NaN; };
      for (let p = 0; p < nPaths; p++) {
        const flags = next(92);
        const loop = [];
        if (flags & 2) {
          const hasB = next(72); next(73);
          const nv = next(93);
          for (let v = 0; v < nv; v++) {
            const x = next(10), y = next(20);
            let b = 0;
            if (hasB && k < g.length && g[k][0] === 42) b = parseFloat(g[k++][1]);
            loop.push({ x, y, b });
          }
        } else {
          const ne = next(93);
          for (let ed = 0; ed < ne; ed++) {
            const et = next(72);
            if (et === 1) {
              const x1 = next(10), y1 = next(20), x2 = next(11), y2 = next(21);
              loop.push({ x: x1, y: y1, b: 0 });
              loop._end = { x: x2, y: y2 };
            } else if (et === 2) {
              const cx = next(10), cy = next(20), rr = next(40), a0 = next(50) * D2R, a1 = next(51) * D2R, ccw = next(73);
              let s0 = a0, s1 = a1;
              if (!ccw) { s0 = -a0; s1 = -a1; }
              let span = G.normAng(s1 - s0) || G.TAU;
              if (!ccw) span = -span;
              const pts = G.sampleArc(cx, cy, rr, s0, span, []);
              pts.slice(0, -1).forEach(([x, y]) => loop.push({ x, y, b: 0 }));
            } else if (et === 3) {
              const cx = next(10), cy = next(20), mx = next(11), my = next(21), ratio = next(40);
              let t0 = next(50) * D2R, t1 = next(51) * D2R; const ccw = next(73);
              if (!ccw) { const t = t0; t0 = -t1; t1 = -t; }
              const R = Math.hypot(mx, my), rot = Math.atan2(my, mx);
              const span = G.normAng(t1 - t0) || G.TAU;
              const N = Math.max(8, Math.ceil(span / (G.TAU / 72)));
              for (let s = 0; s < N; s++) {
                const t = t0 + span * s / N, ux = R * Math.cos(t), uy = R * ratio * Math.sin(t);
                loop.push({ x: cx + ux * Math.cos(rot) - uy * Math.sin(rot), y: cy + ux * Math.sin(rot) + uy * Math.cos(rot), b: 0 });
              }
            } else if (et === 4) {
              next(94); next(73); next(74);
              const nk = next(95), nc = next(96);
              const knots = [], ctrl = [];
              for (let q = 0; q < nk; q++) knots.push(next(40));
              for (let q = 0; q < nc; q++) ctrl.push([next(10), next(20)]);
              ctrl.forEach(([x, y]) => loop.push({ x, y, b: 0 }));
            }
          }
        }
        if (loop.length >= 3) loops.push(loop);
      }
      return loops;
    }

    function emit(recs, ctx) {
      for (let idx = 0; idx < recs.length; idx++) {
        const r0 = recs[idx];
        const r = rec(r0);
        if (r.n(67, 0) === 1 || r.n(60, 0) === 1) {
          if (r.type === 'POLYLINE' || (r.type === 'INSERT' && r.n(66, 0))) {
            while (idx + 1 < recs.length && recs[idx + 1].type !== 'SEQEND') idx++;
            idx++;
          }
          continue;
        }
        try {
          const e = common(r, ctx);
          switch (r.type) {
            case 'LINE':
              Object.assign(e, { type: 'line', x1: r.n(10, 0), y1: r.n(20, 0), x2: r.n(11, 0), y2: r.n(21, 0) });
              push(e, r, ctx); break;
            case 'POINT':
              if (ctx.depth > 0 && e.layer.toUpperCase() === 'DEFPOINTS') break;
              Object.assign(e, { type: 'point', x: r.n(10, 0), y: r.n(20, 0) }); push(e, r, ctx); break;
            case 'CIRCLE':
              Object.assign(e, { type: 'circle', cx: r.n(10, 0), cy: r.n(20, 0), r: r.n(40, 0) }); push(e, r, ctx); break;
            case 'ARC':
              Object.assign(e, { type: 'arc', cx: r.n(10, 0), cy: r.n(20, 0), r: r.n(40, 0), a0: r.n(50, 0) * D2R, a1: r.n(51, 0) * D2R });
              push(e, r, ctx); break;
            case 'LWPOLYLINE': {
              const verts = [];
              let cur = null;
              for (const [c, v] of r.g) {
                if (c === 10) { cur = { x: parseFloat(v), y: 0, b: 0 }; verts.push(cur); }
                else if (c === 20 && cur) cur.y = parseFloat(v);
                else if (c === 42 && cur) cur.b = parseFloat(v);
              }
              if (polyFromVerts(e, verts, !!(r.n(70, 0) & 1))) push(e, r, ctx);
              break;
            }
            case 'POLYLINE': {
              const flags = r.n(70, 0);
              const verts = [];
              while (idx + 1 < recs.length && recs[idx + 1].type === 'VERTEX') {
                const v = rec(recs[++idx]);
                const vf = v.n(70, 0);
                if (vf & 16) continue;
                if (vf & 128 && !(vf & 64)) continue;
                verts.push({ x: v.n(10, 0), y: v.n(20, 0), b: v.n(42, 0) });
              }
              if (idx + 1 < recs.length && recs[idx + 1].type === 'SEQEND') idx++;
              if (flags & (16 | 64)) { skipped['MALLA 3D'] = (skipped['MALLA 3D'] || 0) + 1; break; }
              if (polyFromVerts(e, verts, !!(flags & 1))) push(e, r, ctx);
              break;
            }
            case 'SOLID': case 'TRACE': case '3DFACE': {
              const p = [[10, 20], [11, 21], [12, 22], [13, 23]].map(([a, b]) => ({ x: r.n(a, 0), y: r.n(b, 0), b: 0 }));
              let verts = r.type === '3DFACE' ? p : [p[0], p[1], p[3], p[2]];
              verts = verts.filter((q, k) => k === 0 || Math.hypot(q.x - verts[k - 1].x, q.y - verts[k - 1].y) > 1e-12);
              if (polyFromVerts(e, verts, true)) { e.fill = r.type !== '3DFACE'; push(e, r, ctx); }
              break;
            }
            case 'ELLIPSE': {
              const cx = r.n(10, 0), cy = r.n(20, 0), mx = r.n(11, 1), my = r.n(21, 0), ratio = r.n(40, 1);
              const t0 = r.n(41, 0), t1 = r.n(42, G.TAU);
              const R = Math.hypot(mx, my), rot = Math.atan2(my, mx);
              const span = G.arcSpan(t0, t1), full = span >= G.TAU - 1e-6;
              const N = Math.max(16, Math.ceil(span / (G.TAU / 96)));
              const verts = [];
              for (let s = 0; s <= (full ? N - 1 : N); s++) {
                const t = t0 + span * s / N, ux = R * Math.cos(t), uy = R * ratio * Math.sin(t);
                verts.push({ x: cx + ux * Math.cos(rot) - uy * Math.sin(rot), y: cy + ux * Math.sin(rot) + uy * Math.cos(rot), b: 0 });
              }
              if (polyFromVerts(e, verts, full)) push(e, r, ctx);
              break;
            }
            case 'SPLINE': {
              const deg = r.n(71, 3), knots = r.all(40), weights = r.all(41);
              const cx = r.all(10), cy = r.all(20), fx = r.all(11), fy = r.all(21);
              const ctrl = cx.map((x, k) => [x, cy[k]]);
              let verts;
              if (ctrl.length > deg && knots.length === ctrl.length + deg + 1) {
                verts = nurbs(deg, knots, ctrl, weights, Math.min(400, ctrl.length * 12));
              } else if (fx.length >= 2) verts = fx.map((x, k) => ({ x, y: fy[k], b: 0 }));
              else verts = ctrl.map(([x, y]) => ({ x, y, b: 0 }));
              if (polyFromVerts(e, verts, !!(r.n(70, 0) & 1))) push(e, r, ctx);
              break;
            }
            case 'TEXT':
              if (textEntity(r, e, ctx, false)) push(e, r, ctx);
              break;
            case 'MTEXT': {
              let raw = r.g.filter(([c]) => c === 3).map(([, v]) => v).join('') + r.s(1, '');
              e.type = 'text';
              e.text = mtextPlain(raw).replace(/\s+$/, '');
              e.h = r.n(40, 1) || 1;
              e.x = r.n(10, 0); e.y = r.n(20, 0);
              const dx = r.n(11), dy = r.n(21);
              e.rot = dx !== undefined ? Math.atan2(dy || 0, dx) : r.n(50, 0) * D2R;
              const at = r.n(71, 1);
              e.align = ['left', 'center', 'right'][(at - 1) % 3] || 'left';
              e.valign = ['top', 'middle', 'bottom'][Math.floor((at - 1) / 3)] || 'top';
              if (e.text.trim()) push(e, r, ctx);
              break;
            }
            case 'INSERT': case 'DIMENSION': {
              const name = r.s(2, '').toUpperCase();
              const b = blocks.get(name);
              const attribs = [];
              if (r.type === 'INSERT' && r.n(66, 0)) {
                while (idx + 1 < recs.length && recs[idx + 1].type === 'ATTRIB') attribs.push(recs[++idx]);
                if (idx + 1 < recs.length && recs[idx + 1].type === 'SEQEND') idx++;
              }
              const g = ctx.depth === 0 ? groupSeq++ : ctx.g;
              const sub = { depth: ctx.depth + 1, layer: e.layer, color: e.color === 256 ? (layerMap.get(e.layer) || { aci: 7 }).aci : e.color, rgb: e.rgb, g, stack: ctx.stack };
              if (b && !ctx.stack.includes(name) && ctx.depth < 16) {
                let M;
                if (r.type === 'DIMENSION') M = ctx.m;
                else {
                  const sx = r.n(41, 1), sy = r.n(42, 1), rot = r.n(50, 0) * D2R;
                  const cols = Math.max(1, r.n(70, 1)), rows = Math.max(1, r.n(71, 1));
                  const cs = r.n(44, 0), rs = r.n(45, 0);
                  const base = G.mMul(G.mScale(sx, sy), G.mTranslate(-b.bx, -b.by));
                  const ins = G.mMul(G.mTranslate(r.n(10, 0), r.n(20, 0)), G.mRotate(rot));
                  const ocs = r.n(230, 1) < 0 ? MIRX : G.I;
                  for (let rr = 0; rr < rows; rr++) for (let cc = 0; cc < cols; cc++) {
                    M = G.mMul(ctx.m, G.mMul(ocs, G.mMul(ins, G.mMul(G.mTranslate(cc * cs, rr * rs), base))));
                    emit(b.recs, Object.assign({}, sub, { m: M, stack: ctx.stack.concat(name) }));
                  }
                  M = null;
                }
                if (M) emit(b.recs, Object.assign({}, sub, { m: M, stack: ctx.stack.concat(name) }));
              } else if (r.type === 'DIMENSION') {
                Object.assign(e, { type: 'dim', x1: r.n(13, 0), y1: r.n(23, 0), x2: r.n(14, 0), y2: r.n(24, 0), x3: r.n(10, 0), y3: r.n(20, 0), h: 2.5 });
                push(e, r, ctx);
              }
              attribs.forEach(a0 => {
                const a = rec(a0);
                if (a.n(70, 0) & 1) return;
                const te = common(a, ctx);
                if (ctx.depth === 0) te.g = g;
                if (textEntity(a, te, ctx, true)) push(te, a, ctx);
              });
              break;
            }
            case 'HATCH': {
              if (!r.n(70, 0)) { skipped['SOMBREADO CON PATRÓN'] = (skipped['SOMBREADO CON PATRÓN'] || 0) + 1; break; }
              const loops = hatchLoops(r);
              if (loops.length) { e.type = 'hatch'; e.loops = loops; push(e, r, ctx); }
              break;
            }
            case 'ATTDEF': case 'VIEWPORT': case 'SEQEND': case 'VERTEX': break;
            default:
              skipped[r.type] = (skipped[r.type] || 0) + 1;
          }
        } catch (err) {
          skipped[r.type + ' (error)'] = (skipped[r.type + ' (error)'] || 0) + 1;
        }
      }
    }

    emit(sections.ENTITIES || [], { depth: 0, m: G.I, stack: [], g: 0 });
    if (!sections.ENTITIES && !sections.HEADER) throw new Error('El archivo no parece un DXF válido.');
    return { entities: out, layers, units, skipped };
  }

  global.DXF = global.DXF || {};
  global.DXF.decode = decode;
  global.DXF.parse = parse;
})(window);
