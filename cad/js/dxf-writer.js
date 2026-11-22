/*
 * Escritor DXF R12 (AC1009): el formato más compatible (AutoCAD, BricsCAD, LibreCAD, QCAD, DraftSight...).
 * Las cotas se guardan descompuestas (líneas, flechas y texto) y los sombreados como polilíneas de contorno.
 */
(function (global) {
  'use strict';
  const G = global.Geo;
  const R2D = 180 / Math.PI;

  const num = v => {
    if (!Number.isFinite(v)) return '0';
    const r = Math.round(v * 1e8) / 1e8;
    return Object.is(r, -0) ? '0' : String(r);
  };

  function layerNamer(layers) {
    const map = new Map(), used = new Set();
    layers.forEach(L => {
      let n = L.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9_\-$]/g, '_').toUpperCase() || 'CAPA';
      let k = n, i = 2;
      while (used.has(k)) k = n + '_' + i++;
      used.add(k); map.set(L.name, k);
    });
    return name => map.get(name) || '0';
  }

  /** Codifica en Windows-1252; los caracteres fuera de rango se escriben como \U+XXXX. */
  function encode(str) {
    const cp = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
    const bytes = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) bytes.push(c);
      else if (cp[c]) bytes.push(cp[c]);
      else for (const b of ('\\U+' + c.toString(16).toUpperCase().padStart(4, '0'))) bytes.push(b.charCodeAt(0));
    }
    return new Uint8Array(bytes);
  }

  function write(doc) {
    const o = [];
    const p = (c, v) => { o.push(String(c)); o.push(String(v)); };
    const ln = layerNamer(doc.layers);
    const colorOf = e => {
      if (e.rgb) return global.Colors.nearestAci(e.rgb);
      return e.color == null ? 256 : e.color;
    };
    const head = (type, e) => {
      p(0, type); p(8, ln(e.layer));
      const c = colorOf(e);
      if (c !== 256) p(62, c);
    };

    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    doc.entities.forEach(e => { const b = G.bbox(e); x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); });
    if (!Number.isFinite(x0)) { x0 = y0 = 0; x1 = y1 = 100; }

    p(999, 'Creado con Sierpes CAD');
    p(0, 'SECTION'); p(2, 'HEADER');
    p(9, '$ACADVER'); p(1, 'AC1009');
    p(9, '$DWGCODEPAGE'); p(3, 'ANSI_1252');
    p(9, '$INSBASE'); p(10, 0); p(20, 0); p(30, 0);
    p(9, '$EXTMIN'); p(10, num(x0)); p(20, num(y0)); p(30, 0);
    p(9, '$EXTMAX'); p(10, num(x1)); p(20, num(y1)); p(30, 0);
    p(9, '$INSUNITS'); p(70, doc.units || 0);
    p(0, 'ENDSEC');

    p(0, 'SECTION'); p(2, 'TABLES');
    p(0, 'TABLE'); p(2, 'LTYPE'); p(70, 1);
    p(0, 'LTYPE'); p(2, 'CONTINUOUS'); p(70, 0); p(3, 'Solid line'); p(72, 65); p(73, 0); p(40, 0);
    p(0, 'ENDTAB');
    p(0, 'TABLE'); p(2, 'LAYER'); p(70, doc.layers.length);
    doc.layers.forEach(L => {
      const aci = L.rgb ? global.Colors.nearestAci(L.rgb) : (L.aci || 7);
      p(0, 'LAYER'); p(2, ln(L.name)); p(70, L.locked ? 4 : 0); p(62, L.visible ? aci : -aci); p(6, 'CONTINUOUS');
    });
    p(0, 'ENDTAB');
    p(0, 'TABLE'); p(2, 'STYLE'); p(70, 1);
    p(0, 'STYLE'); p(2, 'STANDARD'); p(70, 0); p(40, 0); p(41, 1); p(50, 0); p(71, 0); p(42, 2.5); p(3, 'txt'); p(4, '');
    p(0, 'ENDTAB');
    p(0, 'ENDSEC');

    p(0, 'SECTION'); p(2, 'BLOCKS'); p(0, 'ENDSEC');

    const line = (e, ax, ay, bx, by) => { head('LINE', e); p(10, num(ax)); p(20, num(ay)); p(30, 0); p(11, num(bx)); p(21, num(by)); p(31, 0); };
    const poly = (e, pts, closed) => {
      head('POLYLINE', e); p(66, 1); p(10, 0); p(20, 0); p(30, 0); p(70, closed ? 1 : 0);
      pts.forEach(v => { p(0, 'VERTEX'); p(8, ln(e.layer)); p(10, num(v.x)); p(20, num(v.y)); p(30, 0); if (v.b) p(42, num(v.b)); });
      p(0, 'SEQEND'); p(8, ln(e.layer));
    };
    const text = (e, t) => {
      const L = G.textLayout(t);
      const c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
      const ha = { left: 0, center: 1, right: 2 }[t.align] || 0;
      L.lines.forEach((str, i) => {
        if (!str.trim()) return;
        const x = t.x - L.ys[i] * s, y = t.y + L.ys[i] * c;
        head('TEXT', e);
        p(10, num(x)); p(20, num(y)); p(30, 0); p(40, num(t.h)); p(1, str);
        if (t.rot) p(50, num(t.rot * R2D));
        if (ha) { p(72, ha); p(11, num(x)); p(21, num(y)); p(31, 0); }
      });
    };

    p(0, 'SECTION'); p(2, 'ENTITIES');
    doc.entities.forEach(e => {
      switch (e.type) {
        case 'line': line(e, e.x1, e.y1, e.x2, e.y2); break;
        case 'point': head('POINT', e); p(10, num(e.x)); p(20, num(e.y)); p(30, 0); break;
        case 'circle': head('CIRCLE', e); p(10, num(e.cx)); p(20, num(e.cy)); p(30, 0); p(40, num(e.r)); break;
        case 'arc': head('ARC', e); p(10, num(e.cx)); p(20, num(e.cy)); p(30, 0); p(40, num(e.r)); p(50, num(G.normAng(e.a0) * R2D)); p(51, num(G.normAng(e.a1) * R2D)); break;
        case 'polyline':
          if (e.fill && e.pts.length >= 3 && e.pts.length <= 4 && !e.pts.some(v => v.b)) {
            const q = e.pts;
            const order = q.length === 4 ? [q[0], q[1], q[3], q[2]] : [q[0], q[1], q[2], q[2]];
            head('SOLID', e);
            order.forEach((v, k) => { p(10 + k, num(v.x)); p(20 + k, num(v.y)); p(30 + k, 0); });
          } else poly(e, e.pts, e.closed);
          break;
        case 'hatch': e.loops.forEach(l => poly(e, l, true)); break;
        case 'text': text(e, e); break;
        case 'dim': {
          const d = G.dimGeom(e);
          d.lines.forEach(l => line(e, l[0], l[1], l[2], l[3]));
          d.arrows.forEach(a => {
            head('SOLID', e);
            [a[0], a[1], a[2], a[2]].forEach((v, k) => { p(10 + k, num(v[0])); p(20 + k, num(v[1])); p(30 + k, 0); });
          });
          text(e, d.text);
          break;
        }
      }
    });
    p(0, 'ENDSEC');
    p(0, 'EOF');
    return encode(o.join('\r\n') + '\r\n');
  }

  global.DXF = global.DXF || {};
  global.DXF.write = write;
})(window);
