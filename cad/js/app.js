/* Sierpes CAD — editor 2D de planos en el navegador. */
(function () {
  'use strict';
  const G = window.Geo, C = window.Colors, DXF = window.DXF;
  const $ = s => document.querySelector(s);
  const cv = $('#cv'), ctx = cv.getContext('2d');
  const cmd = $('#cmd');
  const base = document.createElement('canvas'), bctx = base.getContext('2d');
  const R2D = 180 / Math.PI, D2R = Math.PI / 180;

  /* ====================== Estado ====================== */
  const S = {
    entities: [],
    layers: [{ name: '0', aci: 7, visible: true, locked: false }],
    cur: '0',
    units: 4,
    sel: new Set(),
    undo: [], redo: [],
    dirty: false,
    fileName: 'sin título',
    snap: true, ortho: false, grid: true,
    underlay: null,
    lastTool: null, pending: null,
    textH: 2.5, dimH: 2.5, offsetD: null,
    mouse: { sx: 0, sy: 0, x: 0, y: 0, inside: false },
    snapPt: null,
    hover: null,
    press: null, box: null, drag: null, pan: null, pinch: null,
    staticDirty: true, panOffset: null,
    clean: false
  };
  const V = { s: 1, ox: 0, oy: 0 };
  let dpr = window.devicePixelRatio || 1;
  let nextId = 1, nextGroup = 1;
  let tool = null;
  let layerIdx = new Map();

  /* Medida real del texto para cajas y selección */
  const mctx = document.createElement('canvas').getContext('2d');
  mctx.font = '100px Arial, Helvetica, sans-serif';
  const mcache = new Map();
  G.measure = s => {
    let w = mcache.get(s);
    if (w === undefined) {
      w = mctx.measureText(s).width / 72;
      if (mcache.size > 5000) mcache.clear();
      mcache.set(s, w);
    }
    return w;
  };

  /* ====================== Utilidades ====================== */
  const fmt = (v, p = 4) => G.fmt(v, p);
  const isDark = () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#ffffff';
    const [r, g, b] = C.hexToRgb(bg.length === 4 ? '#' + bg[1] + bg[1] + bg[2] + bg[2] + bg[3] + bg[3] : bg);
    return (r * 0.299 + g * 0.587 + b * 0.114) < 128;
  };
  let DARK = false, BG = '#ffffff';
  function readTheme() {
    BG = getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim() || '#ffffff';
    DARK = isDark();
  }
  const ACCENT = () => (DARK ? '#4c8dff' : '#1f6feb');
  const SNAPC = '#f5a300';

  function toast(msg, ms = 3800) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }
  function setPrompt(s) { $('#prompt').textContent = s; }

  function rebuildLayerIdx() { layerIdx = new Map(S.layers.map(L => [L.name, L])); }
  const layerOf = name => layerIdx.get(name);
  function ensureLayer(name) {
    if (!layerIdx.has(name)) { S.layers.push({ name, aci: 7, visible: true, locked: false }); rebuildLayerIdx(); }
  }
  const visible = e => { const L = layerOf(e.layer); return !L || L.visible; };
  const editable = e => { const L = layerOf(e.layer); return !L || (L.visible && !L.locked); };

  function colorOf(e) {
    if (e.rgb) return fixContrast(e.rgb);
    let aci = e.color;
    if (aci == null || aci === 256) {
      const L = layerOf(e.layer);
      if (L && L.rgb) return fixContrast(L.rgb);
      aci = L ? L.aci : 7;
    }
    return aci === 7 || aci === 0 ? C.aciHex(aci, DARK) : fixContrast(C.aciHex(aci, DARK));
  }
  const contrastCache = new Map();
  /** Ajusta colores que apenas se verían sobre el fondo (amarillo sobre blanco, azul oscuro sobre negro...). */
  function fixContrast(hex) {
    const key = hex + DARK;
    let out = contrastCache.get(key);
    if (out) return out;
    const [r, g, b] = C.hexToRgb(hex), l = r * 0.299 + g * 0.587 + b * 0.114;
    out = hex;
    if (DARK && l < 40) out = l < 8 ? '#ffffff' : C.mix(hex, 60 / Math.max(l, 1));
    else if (!DARK && l > 235) out = '#000000';
    else if (!DARK && l > 150) out = C.mix(hex, 150 / l);
    contrastCache.set(key, out);
    return out;
  }

  /* ====================== Vista ====================== */
  const w2s = (x, y) => [x * V.s + V.ox, V.oy - y * V.s];
  const s2w = (sx, sy) => [(sx - V.ox) / V.s, (V.oy - sy) / V.s];

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const r = cv.getBoundingClientRect();
    cv.width = Math.max(1, Math.round(r.width * dpr));
    cv.height = Math.max(1, Math.round(r.height * dpr));
    base.width = cv.width; base.height = cv.height;
    invalidate();
  }

  function extents(onlyVisible = true) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of S.entities) {
      if (onlyVisible && !visible(e)) continue;
      const b = G.bbox(e);
      if (!Number.isFinite(b[0])) continue;
      if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3];
    }
    const u = S.underlay;
    if (u) { x0 = Math.min(x0, u.x); y0 = Math.min(y0, u.y); x1 = Math.max(x1, u.x + u.w); y1 = Math.max(y1, u.y + u.h); }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
  }

  function zoomTo(b, pad = 0.06) {
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!b) { V.s = Math.min(W, H) / 300; V.ox = W / 2 - 100 * V.s; V.oy = H / 2 + 80 * V.s; invalidate(); return; }
    let w = b[2] - b[0], h = b[3] - b[1];
    if (w < 1e-9 && h < 1e-9) { w = h = 10; }
    V.s = Math.min(W * (1 - 2 * pad) / (w || h), H * (1 - 2 * pad) / (h || w));
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    V.ox = W / 2 - cx * V.s; V.oy = H / 2 + cy * V.s;
    invalidate();
  }
  const zoomExtents = () => zoomTo(extents());

  function zoomAt(sx, sy, f) {
    const ns = Math.min(1e7, Math.max(1e-7, V.s * f));
    f = ns / V.s;
    V.ox = sx - (sx - V.ox) * f; V.oy = sy - (sy - V.oy) * f; V.s = ns;
    invalidate();
  }

  /* ====================== Dibujo ====================== */
  let rafPending = false;
  function requestRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(render); } }
  function invalidate() { S.staticDirty = true; requestRender(); }

  function strokeEntity(c, e, col, lw) {
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = lw;
    switch (e.type) {
      case 'line': {
        const [ax, ay] = w2s(e.x1, e.y1), [bx, by] = w2s(e.x2, e.y2);
        c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke(); break;
      }
      case 'polyline': {
        c.beginPath(); tracePts(c, e.pts, e.closed);
        if (e.fill) { const a = c.globalAlpha; c.globalAlpha = a * 0.85; c.fill('evenodd'); c.globalAlpha = a; }
        c.stroke(); break;
      }
      case 'hatch': {
        c.beginPath(); e.loops.forEach(l => tracePts(c, l, true));
        const a = c.globalAlpha; c.globalAlpha = a * 0.55; c.fill('evenodd'); c.globalAlpha = a;
        break;
      }
      case 'circle': {
        const [x, y] = w2s(e.cx, e.cy);
        c.beginPath(); c.arc(x, y, Math.max(0.5, e.r * V.s), 0, G.TAU); c.stroke(); break;
      }
      case 'arc': {
        const [x, y] = w2s(e.cx, e.cy);
        c.beginPath(); c.arc(x, y, Math.max(0.5, e.r * V.s), -e.a0, -e.a1, true); c.stroke(); break;
      }
      case 'point': {
        const [x, y] = w2s(e.x, e.y);
        c.beginPath(); c.moveTo(x - 3, y); c.lineTo(x + 3, y); c.moveTo(x, y - 3); c.lineTo(x, y + 3); c.stroke(); break;
      }
      case 'text': drawText(c, e, col); break;
      case 'dim': {
        const d = G.dimGeom(e);
        c.beginPath();
        d.lines.forEach(l => { const [ax, ay] = w2s(l[0], l[1]), [bx, by] = w2s(l[2], l[3]); c.moveTo(ax, ay); c.lineTo(bx, by); });
        c.stroke();
        c.beginPath();
        d.arrows.forEach(a => { a.forEach((p, i) => { const [x, y] = w2s(p[0], p[1]); i ? c.lineTo(x, y) : c.moveTo(x, y); }); c.closePath(); });
        c.fill();
        drawText(c, d.text, col);
        break;
      }
    }
  }

  function tracePts(c, pts, closed) {
    const n = pts.length;
    if (!n) return;
    let [x, y] = w2s(pts[0].x, pts[0].y);
    c.moveTo(x, y);
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if (p.b) {
        const a = G.bulgeArc(p.x, p.y, q.x, q.y, p.b);
        if (a) { const [cx, cy] = w2s(a.cx, a.cy); c.arc(cx, cy, a.r * V.s, -a.a0, -a.a1, a.ccw); continue; }
      }
      [x, y] = w2s(q.x, q.y); c.lineTo(x, y);
    }
    if (closed) c.closePath();
  }

  function drawText(c, e, col) {
    const px = e.h * V.s / 0.72;
    if (px < 1.2) return;
    const [x, y] = w2s(e.x, e.y);
    const L = G.textLayout(e);
    if (px < 3) {
      // demasiado pequeño para leerse: una barra
      c.save(); c.translate(x, y); c.rotate(-(e.rot || 0)); c.globalAlpha *= 0.5; c.fillStyle = col;
      const x0 = e.align === 'center' ? -L.W / 2 : e.align === 'right' ? -L.W : 0;
      L.ys.forEach(yy => c.fillRect(x0 * V.s, -(yy + e.h) * V.s, L.W * V.s, e.h * V.s));
      c.restore(); return;
    }
    c.save();
    c.translate(x, y); c.rotate(-(e.rot || 0));
    c.font = px + 'px Arial, Helvetica, sans-serif';
    c.textAlign = e.align || 'left'; c.textBaseline = 'alphabetic'; c.fillStyle = col;
    L.lines.forEach((ln, i) => c.fillText(ln, 0, -L.ys[i] * V.s));
    c.restore();
  }

  function drawGrid(c, W, H) {
    let step = Math.pow(10, Math.ceil(Math.log10(12 / V.s)));
    if (step * V.s > 60) step /= 5; else if (step * V.s > 30) step /= 2;
    const [x0, y1] = s2w(0, 0), [x1, y0] = s2w(W, H);
    if ((x1 - x0) / step > 400) return;
    const major = step * 10;
    c.lineWidth = 1;
    const line = (sx0, sy0, sx1, sy1) => { c.moveTo(Math.round(sx0) + 0.5, Math.round(sy0) + 0.5); c.lineTo(Math.round(sx1) + 0.5, Math.round(sy1) + 0.5); };
    c.beginPath();
    c.strokeStyle = DARK ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.05)';
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) { const sx = w2s(x, 0)[0]; line(sx, 0, sx, H); }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) { const sy = w2s(0, y)[1]; line(0, sy, W, sy); }
    c.stroke();
    c.beginPath();
    c.strokeStyle = DARK ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.1)';
    for (let x = Math.ceil(x0 / major) * major; x <= x1; x += major) { const sx = w2s(x, 0)[0]; line(sx, 0, sx, H); }
    for (let y = Math.ceil(y0 / major) * major; y <= y1; y += major) { const sy = w2s(0, y)[1]; line(0, sy, W, sy); }
    c.stroke();
  }

  function drawStatic() {
    const W = cv.clientWidth, H = cv.clientHeight;
    const c = bctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = BG;
    c.fillRect(0, 0, W, H);
    const u = S.underlay;
    if (u) {
      const [sx, sy] = w2s(u.x, u.y + u.h);
      c.globalAlpha = u.opacity;
      c.imageSmoothingQuality = 'high';
      c.drawImage(u.img, sx, sy, u.w * V.s, u.h * V.s);
      c.globalAlpha = 1;
      if (!S.clean) { c.setLineDash([4, 4]); c.strokeStyle = DARK ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)'; c.lineWidth = 1; c.strokeRect(sx, sy, u.w * V.s, u.h * V.s); c.setLineDash([]); }
    }
    if (S.grid && !S.clean) drawGrid(c, W, H);
    if (!S.clean) {
      const [ox, oy] = w2s(0, 0);
      c.lineWidth = 1;
      c.strokeStyle = 'rgba(220,60,60,0.55)'; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox + 40, oy); c.stroke();
      c.strokeStyle = 'rgba(40,170,70,0.6)'; c.beginPath(); c.moveTo(ox, oy); c.lineTo(ox, oy - 40); c.stroke();
    }
    const [vx0, vy1] = s2w(0, 0), [vx1, vy0] = s2w(W, H);
    for (const e of S.entities) {
      if (!visible(e)) continue;
      const b = G.bbox(e);
      if (b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1) continue;
      strokeEntity(c, e, colorOf(e), 1);
    }
    S.staticDirty = false;
  }

  function render() {
    rafPending = false;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (S.staticDirty && !S.panOffset) drawStatic();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (S.panOffset) {
      ctx.fillStyle = BG; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(base, S.panOffset[0] * dpr, S.panOffset[1] * dpr);
    } else ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (S.clean) return;

    // Selección
    const acc = ACCENT();
    const selList = S.entities.filter(e => S.sel.has(e.id));
    if (!S.panOffset) {
      if (S.hover && !S.sel.has(S.hover.id) && !tool) {
        ctx.globalAlpha = 0.9;
        strokeEntity(ctx, S.hover, colorOf(S.hover), 2.5);
        ctx.globalAlpha = 1;
      }
      ctx.setLineDash([6, 4]);
      selList.forEach(e => strokeEntity(ctx, e, acc, 1.6));
      ctx.setLineDash([]);
      if (selList.length && selList.length <= 150 && !tool) {
        ctx.fillStyle = acc; ctx.strokeStyle = DARK ? '#0b1b3a' : '#ffffff'; ctx.lineWidth = 1;
        selList.forEach(e => { if (!editable(e)) return; G.grips(e).forEach(g => { const [x, y] = w2s(g.x, g.y); ctx.fillRect(x - 4, y - 4, 8, 8); ctx.strokeRect(x - 4, y - 4, 8, 8); }); });
      }
    }

    // Arrastre de pinzamiento
    if (S.drag && S.drag.preview) {
      ctx.globalAlpha = 0.85; strokeEntity(ctx, S.drag.preview, SNAPC, 1.5); ctx.globalAlpha = 1;
    }

    // Vista previa de la herramienta
    if (tool && tool.preview && S.mouse.inside) {
      ctx.save(); ctx.globalAlpha = 0.9;
      tool.preview(ctx, curPoint());
      ctx.restore();
    }

    // Ventana de selección
    if (S.box) {
      const { x0, y0, x1, y1 } = S.box;
      const crossing = x1 < x0;
      ctx.fillStyle = crossing ? 'rgba(40,180,90,0.12)' : 'rgba(31,111,235,0.12)';
      ctx.strokeStyle = crossing ? '#28b45a' : acc;
      ctx.setLineDash(crossing ? [5, 4] : []);
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }

    // Marcador de referencia
    if (S.snapPt && S.mouse.inside) drawSnapMarker(S.snapPt);
  }

  const SNAP_NAMES = { end: 'Punto final', mid: 'Punto medio', cen: 'Centro', quad: 'Cuadrante', int: 'Intersección', node: 'Punto de inserción' };
  function drawSnapMarker(p) {
    const [x, y] = w2s(p.x, p.y), r = 6;
    ctx.strokeStyle = SNAPC; ctx.lineWidth = 2;
    ctx.beginPath();
    switch (p.k) {
      case 'end': ctx.rect(x - r, y - r, 2 * r, 2 * r); break;
      case 'mid': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y + r); ctx.lineTo(x - r, y + r); ctx.closePath(); break;
      case 'cen': ctx.arc(x, y, r, 0, G.TAU); break;
      case 'quad': ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); break;
      case 'int': ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); break;
      default: ctx.arc(x, y, r, 0, G.TAU); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); break;
    }
    ctx.stroke();
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = SNAPC; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(SNAP_NAMES[p.k] || '', x + 10, y + 8);
  }

  /* Dibujo auxiliar para vistas previas */
  function pv(e, col) { strokeEntity(ctx, e, col || ACCENT(), 1.3); }
  function pvLine(a, b) {
    const [ax, ay] = w2s(a.x, a.y), [bx, by] = w2s(b.x, b.y);
    ctx.strokeStyle = ACCENT(); ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }
  function pvDashed(a, b) { ctx.setLineDash([4, 4]); pvLine(a, b); ctx.setLineDash([]); }
  function pvLabel(p, txt) {
    const [x, y] = w2s(p.x, p.y);
    ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const w = ctx.measureText(txt).width;
    ctx.fillStyle = DARK ? 'rgba(20,22,28,0.85)' : 'rgba(255,255,255,0.9)';
    ctx.fillRect(x + 14, y - 30, w + 10, 18);
    ctx.fillStyle = DARK ? '#e6e8ec' : '#1d2330';
    ctx.fillText(txt, x + 19, y - 14);
  }
  const lenAng = (a, b) => `L=${fmt(G.dist(a.x, a.y, b.x, b.y), 3)}  ∠${fmt(G.normAng(Math.atan2(b.y - a.y, b.x - a.x)) * R2D, 2)}°`;

  /* ====================== Referencias a objetos ====================== */
  function findSnap(sx, sy) {
    if (!S.snap) return null;
    const tol = 10 / V.s;
    const [x, y] = s2w(sx, sy);
    const cands = [];
    for (const e of S.entities) {
      if (!visible(e)) continue;
      if (S.drag && e.id === S.drag.id) continue;
      const b = G.bbox(e);
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      cands.push(e);
    }
    let best = null, bd = tol;
    for (const e of cands) {
      for (const p of G.snapPoints(e)) {
        const d = Math.hypot(p.x - x, p.y - y) * (p.k === 'end' ? 0.8 : 1);
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best || best.k !== 'end') {
      const segs = [];
      for (const e of cands.slice(0, 80)) {
        if (e.type === 'text') continue;
        for (const p of G.paths(e)) for (let i = 1; i < p.length; i++) {
          if (G.distPtSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < tol) segs.push([p[i - 1], p[i], e.id]);
          if (segs.length > 300) break;
        }
      }
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i], b = segs[j];
        if (a[2] === b[2] && (a[1] === b[0] || a[0] === b[1])) continue;
        const q = G.segInt(a[0][0], a[0][1], a[1][0], a[1][1], b[0][0], b[0][1], b[1][0], b[1][1]);
        if (q) { const d = Math.hypot(q.x - x, q.y - y) * 0.8; if (d < bd) { bd = d; best = { x: q.x, y: q.y, k: 'int' }; } }
      }
    }
    return best;
  }

  /** Punto actual del cursor con referencias y modo ortogonal aplicados. */
  function curPoint() {
    if (S.snapPt) return { x: S.snapPt.x, y: S.snapPt.y };
    let p = { x: S.mouse.x, y: S.mouse.y };
    const b = tool && tool.base && tool.base();
    if (S.ortho && b) {
      if (Math.abs(p.x - b.x) >= Math.abs(p.y - b.y)) p.y = b.y; else p.x = b.x;
    }
    return p;
  }

  /* ====================== Selección ====================== */
  function pick(sx, sy) {
    const tol = 5 / V.s;
    const [x, y] = s2w(sx, sy);
    let best = null, bd = tol;
    for (let i = S.entities.length - 1; i >= 0; i--) {
      const e = S.entities[i];
      if (!editable(e)) continue;
      const b = G.bbox(e);
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      let d = G.hitDist(e, x, y);
      if (d === 0 && (e.type === 'hatch' || e.fill)) d = tol * 0.95; // lo que hay encima del relleno tiene prioridad
      if (d < bd) { bd = d; best = e; if (d === 0) break; }
    }
    return best;
  }
  function groupOf(e) { return e.g ? S.entities.filter(o => o.g === e.g) : [e]; }

  function selectIds(ids, mode) {
    if (mode === 'replace') S.sel = new Set(ids);
    else if (mode === 'add') ids.forEach(i => S.sel.add(i));
    else if (mode === 'toggle') {
      const allIn = ids.every(i => S.sel.has(i));
      ids.forEach(i => allIn ? S.sel.delete(i) : S.sel.add(i));
    }
    onSelectionChange();
  }
  function clearSel() { if (S.sel.size) { S.sel.clear(); onSelectionChange(); } }
  function onSelectionChange() { renderProps(); requestRender(); }
  const selected = () => S.entities.filter(e => S.sel.has(e.id));

  function boxSelect(b, additive) {
    const [ax, ay] = s2w(b.x0, b.y0), [bx, by] = s2w(b.x1, b.y1);
    const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
    const crossing = b.x1 < b.x0;
    const ids = new Set();
    const groups = new Set();
    for (const e of S.entities) {
      if (!editable(e)) continue;
      const bb = G.bbox(e);
      let hit;
      if (crossing) hit = !(bb[2] < x0 || bb[0] > x1 || bb[3] < y0 || bb[1] > y1) && ((bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1) || G.crossesRect(e, x0, y0, x1, y1));
      else hit = bb[0] >= x0 && bb[2] <= x1 && bb[1] >= y0 && bb[3] <= y1;
      if (hit) { ids.add(e.id); if (e.g) groups.add(e.g); }
    }
    if (groups.size) S.entities.forEach(e => { if (e.g && groups.has(e.g)) ids.add(e.id); });
    selectIds([...ids], additive ? 'add' : 'replace');
  }

  /* ====================== Historial y cambios ====================== */
  const serialize = () => JSON.stringify({ e: S.entities, l: S.layers, c: S.cur });
  function snapshot() {
    S.undo.push(serialize());
    if (S.undo.length > 80) S.undo.shift();
    S.redo.length = 0;
    S.dirty = true;
  }
  function restore(str) {
    const o = JSON.parse(str);
    S.entities = o.e; S.layers = o.l; S.cur = o.c;
    rebuildLayerIdx();
    nextId = S.entities.reduce((m, e) => Math.max(m, e.id + 1), nextId);
    const ids = new Set(S.entities.map(e => e.id));
    S.sel = new Set([...S.sel].filter(i => ids.has(i)));
    changed();
  }
  function undo() {
    if (tool) { endTool(); }
    if (!S.undo.length) { toast('Nada que deshacer'); return; }
    S.redo.push(serialize()); restore(S.undo.pop()); S.dirty = true;
  }
  function redo() {
    if (!S.redo.length) { toast('Nada que rehacer'); return; }
    S.undo.push(serialize()); restore(S.redo.pop()); S.dirty = true;
  }
  function changed() {
    S.hover = null;
    renderLayers(); renderProps(); updateWelcome(); updateTitle();
    invalidate();
  }

  function newEntity(o) {
    return Object.assign({ id: nextId++, layer: S.cur, color: 256 }, o);
  }
  function addEntities(list, noSnapshot) {
    if (!list.length) return;
    if (!noSnapshot) snapshot();
    list.forEach(e => { if (!e.id) e.id = nextId++; S.entities.push(e); });
    changed();
  }
  function replaceEntities(map) { // Map id -> new entity
    snapshot();
    S.entities = S.entities.map(e => map.has(e.id) ? Object.assign(map.get(e.id), { id: e.id }) : e);
    changed();
  }
  function deleteSelected() {
    if (!S.sel.size) { toast('No hay nada seleccionado'); return; }
    snapshot();
    const n = S.sel.size;
    S.entities = S.entities.filter(e => !S.sel.has(e.id));
    S.sel.clear();
    changed();
    toast(`${n} objeto(s) borrado(s)`);
  }
  function explodeSelected() {
    const sel = selected().filter(e => e.g);
    if (!sel.length) { toast('Seleccione un bloque para descomponerlo'); return; }
    snapshot();
    S.entities = S.entities.map(e => S.sel.has(e.id) && e.g ? Object.assign({}, e, { g: undefined }) : e);
    changed();
    toast('Bloque descompuesto: ahora puede seleccionar sus piezas por separado');
  }
  function transformSelected(m, copy) {
    const sel = selected();
    if (!sel.length) return;
    if (copy) {
      const gmap = new Map();
      const out = sel.map(e => {
        const n = G.transform(e, m);
        n.id = nextId++;
        if (e.g) { if (!gmap.has(e.g)) gmap.set(e.g, nextGroup++); n.g = gmap.get(e.g); }
        return n;
      });
      addEntities(out);
      return out;
    }
    const map = new Map(sel.map(e => [e.id, G.transform(e, m)]));
    replaceEntities(map);
  }

  /* ====================== Herramientas ====================== */
  const same = (a, b) => a && b && Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;

  const TOOLS = {
    select: { label: 'Seleccionar', icon: 'M5 3l13 8-6 1.4L9.5 19z', aliases: ['SEL'] },
    pan: { label: 'Mano', icon: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15a1.6 1.6 0 0 1 2.6-1.8L8 15', aliases: ['P', 'PAN', 'ENCUADRE'] },
    '-1': {},
    line: {
      label: 'Línea', icon: 'M4 20L20 4M4 20h0M20 4h0', aliases: ['L', 'LINEA', 'LINE'],
      create() {
        const pts = [];
        return {
          prompt: () => pts.length ? 'Siguiente punto (Intro para terminar)' : 'Línea: primer punto',
          base: () => pts[pts.length - 1],
          point(p) {
            const a = pts[pts.length - 1];
            if (a) { if (same(a, p)) return; addEntities([newEntity({ type: 'line', x1: a.x, y1: a.y, x2: p.x, y2: p.y })]); }
            pts.push(p);
          },
          word(w) { if (w === 'C' && pts.length > 2) { const a = pts[pts.length - 1], b = pts[0]; addEntities([newEntity({ type: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y })]); return 'end'; } },
          preview(c, p) { const a = pts[pts.length - 1]; if (a) { pvLine(a, p); pvLabel(p, lenAng(a, p)); } }
        };
      }
    },
    polyline: {
      label: 'Polilínea', icon: 'M3 18l5-9 6 6 7-11', aliases: ['PL', 'POL', 'POLILINEA', 'PLINE'],
      create() {
        const pts = [];
        const finish = closed => {
          if (pts.length >= 2) addEntities([newEntity({ type: 'polyline', pts: pts.map(p => ({ x: p.x, y: p.y, b: 0 })), closed: closed && pts.length > 2 })]);
          return 'end';
        };
        return {
          prompt: () => pts.length ? 'Siguiente punto (Intro terminar · C cerrar · D deshacer punto)' : 'Polilínea: primer punto',
          base: () => pts[pts.length - 1],
          point(p) { if (!same(pts[pts.length - 1], p)) pts.push(p); },
          word(w) {
            if (w === 'C' || w === 'CERRAR') return finish(true);
            if (w === 'D' || w === 'H') { pts.pop(); return 'keep'; }
          },
          enter: () => finish(false),
          dbl: () => finish(false),
          preview(c, p) {
            if (!pts.length) return;
            const e = { type: 'polyline', pts: pts.concat([p]).map(q => ({ x: q.x, y: q.y, b: 0 })), closed: false };
            pv(e); pvLabel(p, lenAng(pts[pts.length - 1], p));
          }
        };
      }
    },
    rect: {
      label: 'Rectáng.', icon: 'M4 6h16v12H4z', aliases: ['REC', 'RECT', 'RECTANG', 'RECTANGULO'],
      create() {
        let a = null;
        const mk = (a, b) => ({ type: 'polyline', closed: true, pts: [{ x: a.x, y: a.y, b: 0 }, { x: b.x, y: a.y, b: 0 }, { x: b.x, y: b.y, b: 0 }, { x: a.x, y: b.y, b: 0 }] });
        return {
          prompt: () => a ? 'Esquina opuesta (o @ancho,alto)' : 'Rectángulo: primera esquina',
          base: () => a,
          point(p) {
            if (!a) { a = p; return; }
            if (Math.abs(p.x - a.x) < 1e-12 || Math.abs(p.y - a.y) < 1e-12) return;
            addEntities([newEntity(mk(a, p))]); return 'end';
          },
          preview(c, p) { if (a) { pv(mk(a, p)); pvLabel(p, `${fmt(Math.abs(p.x - a.x), 3)} × ${fmt(Math.abs(p.y - a.y), 3)}`); } }
        };
      }
    },
    circle: {
      label: 'Círculo', icon: 'M12 4a8 8 0 1 0 0.01 0z', aliases: ['C', 'CI', 'CIRCULO', 'CIRCLE'],
      create() {
        let c0 = null;
        const done = r => { if (r > 0) addEntities([newEntity({ type: 'circle', cx: c0.x, cy: c0.y, r })]); return 'end'; };
        return {
          prompt: () => c0 ? 'Radio (punto o número)' : 'Círculo: centro',
          base: () => c0,
          point(p) { if (!c0) { c0 = p; return; } return done(G.dist(c0.x, c0.y, p.x, p.y)); },
          value(n) { if (!c0) return false; return done(n); },
          preview(c, p) { if (c0) { const r = G.dist(c0.x, c0.y, p.x, p.y); pv({ type: 'circle', cx: c0.x, cy: c0.y, r }); pvDashed(c0, p); pvLabel(p, `R=${fmt(r, 3)}`); } }
        };
      }
    },
    arc: {
      label: 'Arco', icon: 'M4 17A9 9 0 0 1 20 17', aliases: ['A', 'ARCO', 'ARC'],
      create() {
        const pts = [];
        return {
          prompt: () => ['Arco: punto inicial', 'Segundo punto (por donde pasa)', 'Punto final'][pts.length],
          base: () => pts[pts.length - 1],
          point(p) {
            pts.push(p);
            if (pts.length === 3) { const a = G.arcFrom3(pts[0], pts[1], pts[2]); if (a) addEntities([newEntity(Object.assign({ type: 'arc' }, a))]); return 'end'; }
          },
          preview(c, p) {
            if (pts.length === 1) pvLine(pts[0], p);
            if (pts.length === 2) { const a = G.arcFrom3(pts[0], pts[1], p); if (a) pv(Object.assign({ type: 'arc' }, a)); }
          }
        };
      }
    },
    text: {
      label: 'Texto', icon: 'M5 5h14M12 5v15M9 20h6', aliases: ['T', 'TX', 'TEXTO', 'TEXT', 'DTEXT', 'MTEXT'],
      create() {
        return {
          prompt: () => 'Texto: punto de inserción',
          async point(p) {
            const r = await ask('Nuevo texto', [
              { name: 'text', label: 'Texto (varias líneas permitidas)', type: 'textarea', value: '' },
              { name: 'h', label: 'Altura', type: 'number', value: S.textH },
              { name: 'rot', label: 'Rotación (grados)', type: 'number', value: 0 }
            ]);
            if (r && r.text.trim()) {
              S.textH = +r.h || S.textH;
              addEntities([newEntity({ type: 'text', x: p.x, y: p.y, h: S.textH, rot: (+r.rot || 0) * D2R, text: r.text, align: 'left', valign: 'baseline' })]);
            }
          },
          preview(c, p) {
            pv({ type: 'text', x: p.x, y: p.y, h: S.textH, rot: 0, text: 'Texto', align: 'left', valign: 'baseline' });
          }
        };
      }
    },
    dim: {
      label: 'Cota', icon: 'M3 8v10M21 8v10M3 14h18M3 14l3-2M3 14l3 2M21 14l-3-2M21 14l-3 2', aliases: ['COT', 'ACO', 'ACOTAR', 'DIM', 'DIMALI', 'DAL'],
      create() {
        const pts = [];
        const mk = p => ({ type: 'dim', x1: pts[0].x, y1: pts[0].y, x2: pts[1].x, y2: pts[1].y, x3: p.x, y3: p.y, h: S.dimH });
        return {
          prompt: () => ['Cota: primer punto', 'Segundo punto', 'Posición de la línea de cota'][pts.length],
          base: () => pts.length === 1 ? pts[0] : null,
          point(p) {
            if (pts.length === 1 && same(pts[0], p)) return;
            pts.push(p);
            if (pts.length === 3) { addEntities([newEntity(mk(p))]); return 'end'; }
          },
          preview(c, p) {
            if (pts.length === 1) { pvLine(pts[0], p); pvLabel(p, lenAng(pts[0], p)); }
            if (pts.length === 2) pv(mk(p));
          }
        };
      }
    },
    '-2': {},
    move: {
      label: 'Desplazar', icon: 'M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3', aliases: ['M', 'DES', 'DESPLAZA', 'MOVE', 'MOVER'], needsSel: true,
      create() { return moveCopy(false); }
    },
    copy: {
      label: 'Copiar', icon: 'M8 8h12v12H8zM4 16V4h12', aliases: ['CO', 'CP', 'COPIA', 'COPIAR', 'COPY'], needsSel: true,
      create() { return moveCopy(true); }
    },
    rotate: {
      label: 'Girar', icon: 'M20 12a8 8 0 1 1-3-6.2M20 4v5h-5', aliases: ['GI', 'GIRA', 'GIRAR', 'RO', 'ROTATE'], needsSel: true,
      create() {
        let b = null;
        const done = a => { transformSelected(G.mRotate(a, b.x, b.y)); return 'end'; };
        return {
          prompt: () => b ? 'Ángulo de giro (punto o grados, antihorario)' : 'Girar: punto base',
          base: () => b,
          point(p) { if (!b) { b = p; return; } if (same(b, p)) return; return done(Math.atan2(p.y - b.y, p.x - b.x)); },
          value(n) { if (!b) return false; return done(n * D2R); },
          preview(c, p) {
            if (!b) return;
            const a = Math.atan2(p.y - b.y, p.x - b.x), m = G.mRotate(a, b.x, b.y);
            selected().slice(0, 1500).forEach(e => pv(G.transform(e, m)));
            pvDashed(b, p); pvLabel(p, `${fmt(G.normAng(a) * R2D, 2)}°`);
          }
        };
      }
    },
    scale: {
      label: 'Escala', icon: 'M4 20h7v-7H4zM11 13l9-9M14 4h6v6', aliases: ['ES', 'ESCALA', 'SC', 'SCALE'], needsSel: true,
      create() {
        let b = null, ref = null;
        const done = f => { if (f > 0) transformSelected(G.mScale(f, f, b.x, b.y)); return 'end'; };
        return {
          prompt: () => !b ? 'Escala: punto base' : !ref ? 'Factor de escala (número) o punto de referencia' : 'Nuevo punto (la distancia base→referencia pasa a base→este punto)',
          base: () => b,
          point(p) {
            if (!b) { b = p; return; }
            if (!ref) { if (!same(b, p)) ref = p; return; }
            const d0 = G.dist(b.x, b.y, ref.x, ref.y), d1 = G.dist(b.x, b.y, p.x, p.y);
            return done(d1 / d0);
          },
          value(n) { if (!b) return false; return done(n); },
          preview(c, p) {
            if (!b || !ref) { if (b) pvDashed(b, p); return; }
            const f = G.dist(b.x, b.y, p.x, p.y) / G.dist(b.x, b.y, ref.x, ref.y);
            if (f > 0) selected().slice(0, 1500).forEach(e => pv(G.transform(e, G.mScale(f, f, b.x, b.y))));
            pvDashed(b, p); pvLabel(p, `×${fmt(f, 4)}`);
          }
        };
      }
    },
    mirror: {
      label: 'Simetría', icon: 'M12 3v18M9 7L4 17h5zM15 7l5 10h-5z', aliases: ['SI', 'SIMETRIA', 'MI', 'MIRROR'], needsSel: true,
      create() {
        let a = null;
        return {
          prompt: () => a ? 'Segundo punto del eje de simetría' : 'Simetría: primer punto del eje',
          base: () => a,
          async point(p) {
            if (!a) { a = p; return; }
            if (same(a, p)) return;
            const r = await ask('Simetría', [{ name: 'keep', label: 'Conservar los objetos originales', type: 'checkbox', value: true }]);
            if (!r) return 'end';
            transformSelected(G.mMirror(a.x, a.y, p.x, p.y), r.keep);
            return 'end';
          },
          preview(c, p) {
            if (!a || same(a, p)) return;
            const m = G.mMirror(a.x, a.y, p.x, p.y);
            selected().slice(0, 1500).forEach(e => pv(G.transform(e, m)));
            pvDashed(a, p);
          }
        };
      }
    },
    offset: {
      label: 'Desfase', icon: 'M4 18C8 9 16 9 20 18M4 12C8 3 16 3 20 12', aliases: ['EQ', 'EQUIDIST', 'DESFASE', 'O', 'OFFSET'],
      create() {
        let target = null;
        return {
          pick: () => !target,
          prompt: () => S.offsetD == null ? 'Desfase: escriba la distancia y pulse Intro' : !target ? `Desfase ${fmt(S.offsetD)}: designe línea, polilínea, círculo o arco (o escriba otra distancia)` : 'Indique el lado',
          value(n) { if (n > 0) { S.offsetD = n; target = null; } return 'keep'; },
          point(p, raw) {
            if (S.offsetD == null) { toast('Escriba primero la distancia de desfase'); return; }
            if (!target) {
              const [sx, sy] = w2s(raw.x, raw.y);
              const e = pick(sx, sy);
              if (!e || !['line', 'polyline', 'circle', 'arc'].includes(e.type)) { toast('Designe una línea, polilínea, círculo o arco'); return; }
              target = e; return;
            }
            const n = offsetEntity(target, S.offsetD, p);
            if (n) addEntities([Object.assign(n, { id: nextId++, g: undefined })]);
            target = null;
          },
          preview(c, p) {
            if (target) { strokeEntity(ctx, target, ACCENT(), 2); const n = offsetEntity(target, S.offsetD, p); if (n) pv(n); }
          }
        };
      }
    },
    erase: { label: 'Borrar', icon: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', aliases: ['B', 'BO', 'BORRA', 'BORRAR', 'E', 'ERASE', 'SUPR'], action: () => deleteSelected() },
    '-3': {},
    measure: {
      label: 'Medir', icon: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2', aliases: ['DI', 'MED', 'MEDIR', 'DIST', 'DISTANCIA'],
      create() {
        let a = null;
        return {
          prompt: () => a ? 'Segundo punto' : 'Medir distancia: primer punto',
          base: () => a,
          point(p) {
            if (!a) { a = p; return; }
            const d = G.dist(a.x, a.y, p.x, p.y);
            const msg = `Distancia = ${fmt(d)}   ΔX = ${fmt(p.x - a.x)}   ΔY = ${fmt(p.y - a.y)}   Ángulo = ${fmt(G.normAng(Math.atan2(p.y - a.y, p.x - a.x)) * R2D, 3)}°`;
            toast(msg, 8000); setPrompt(msg); a = null; return 'keepmsg';
          },
          preview(c, p) { if (a) { pvDashed(a, p); pvLabel(p, lenAng(a, p)); } }
        };
      }
    }
  };
  const ALIAS = {};
  Object.keys(TOOLS).forEach(k => (TOOLS[k].aliases || []).forEach(a => { ALIAS[a] = k; }));
  Object.assign(ALIAS, { Z: '@zoom', ZOOM: '@zoom', ZE: '@zoom', U: '@undo', H: '@undo', DESHACER: '@undo', X: '@explode', DESCOMP: '@explode', EXPLODE: '@explode', REHACER: '@redo', REDO: '@redo' });

  function moveCopy(copy) {
    let b = null;
    return {
      prompt: () => b ? (copy ? 'Punto de destino (Intro para terminar)' : 'Punto de destino') : (copy ? 'Copiar' : 'Desplazar') + ': punto base',
      base: () => b,
      point(p) {
        if (!b) { b = p; return; }
        transformSelected(G.mTranslate(p.x - b.x, p.y - b.y), copy);
        if (!copy) return 'end';
      },
      preview(c, p) {
        if (!b) return;
        const m = G.mTranslate(p.x - b.x, p.y - b.y);
        selected().slice(0, 1500).forEach(e => pv(G.transform(e, m)));
        pvDashed(b, p); pvLabel(p, lenAng(b, p));
      }
    };
  }

  function offsetEntity(e, d, side) {
    switch (e.type) {
      case 'line': {
        const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = Math.hypot(dx, dy);
        if (!L) return null;
        const nx = -dy / L, ny = dx / L, sg = (side.x - e.x1) * nx + (side.y - e.y1) * ny >= 0 ? 1 : -1;
        return G.transform(e, G.mTranslate(nx * d * sg, ny * d * sg));
      }
      case 'circle': case 'arc': {
        const inside = G.dist(e.cx, e.cy, side.x, side.y) < e.r;
        const r = e.r + (inside ? -d : d);
        return r > 1e-9 ? G.clone(e, { r }) : null;
      }
      case 'polyline': {
        let pts = e.pts;
        if (pts.some(p => p.b)) { const s = G.samplePts(pts, e.closed); if (e.closed) s.pop(); pts = s.map(([x, y]) => ({ x, y, b: 0 })); }
        pts = pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
        const n = pts.length; if (n < 2) return null;
        const segs = e.closed ? n : n - 1;
        // lado: segmento más cercano
        let bi = 0, bd = Infinity;
        for (let i = 0; i < segs; i++) { const p = pts[i], q = pts[(i + 1) % n]; const dd = G.distPtSeg(side.x, side.y, p.x, p.y, q.x, q.y); if (dd < bd) { bd = dd; bi = i; } }
        const p0 = pts[bi], q0 = pts[(bi + 1) % n];
        const sg = ((q0.x - p0.x) * (side.y - p0.y) - (q0.y - p0.y) * (side.x - p0.x)) >= 0 ? 1 : -1;
        const lines = [];
        for (let i = 0; i < segs; i++) {
          const p = pts[i], q = pts[(i + 1) % n], L = Math.hypot(q.x - p.x, q.y - p.y);
          const nx = -(q.y - p.y) / L * d * sg, ny = (q.x - p.x) / L * d * sg;
          lines.push([p.x + nx, p.y + ny, q.x + nx, q.y + ny]);
        }
        const inter = (a, b) => {
          const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1], den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return { x: a[2], y: a[3] };
          const t = ((b[0] - a[0]) * sy - (b[1] - a[1]) * sx) / den;
          return { x: a[0] + t * rx, y: a[1] + t * ry };
        };
        const out = [];
        for (let i = 0; i < n; i++) {
          if (!e.closed && i === 0) { out.push({ x: lines[0][0], y: lines[0][1], b: 0 }); continue; }
          if (!e.closed && i === n - 1) { out.push({ x: lines[segs - 1][2], y: lines[segs - 1][3], b: 0 }); continue; }
          const q = inter(lines[(i - 1 + segs) % segs], lines[i % segs]);
          out.push({ x: q.x, y: q.y, b: 0 });
        }
        return G.clone(e, { pts: out });
      }
    }
    return null;
  }

  /* Herramientas de la imagen de fondo */
  const UL_TOOLS = {
    calibrate: () => {
      let a = null;
      return {
        prompt: () => a ? 'Calibrar: segundo punto de la distancia conocida' : 'Calibrar: primer punto de una distancia conocida en la imagen',
        base: () => a,
        async point(p) {
          if (!a) { a = p; return; }
          const d = G.dist(a.x, a.y, p.x, p.y);
          if (!d) return;
          const r = await ask('Calibrar escala', [{ name: 'real', label: `Distancia real entre los dos puntos (medida ahora: ${fmt(d, 3)})`, type: 'number', value: '' }]);
          if (r && +r.real > 0) {
            const f = +r.real / d, u = S.underlay;
            u.x = a.x + (u.x - a.x) * f; u.y = a.y + (u.y - a.y) * f; u.w *= f; u.h *= f;
            zoomTo(extents());
            toast(`Imagen escalada ×${fmt(f, 4)}. La distancia ahora mide ${fmt(+r.real)}.`);
          }
          return 'end';
        },
        preview(c, p) { if (a) { pvLine(a, p); pvLabel(p, lenAng(a, p)); } }
      };
    },
    moveUnderlay: () => {
      let b = null;
      return {
        prompt: () => b ? 'Imagen: punto de destino' : 'Mover imagen: punto base',
        base: () => b,
        point(p) { if (!b) { b = p; return; } S.underlay.x += p.x - b.x; S.underlay.y += p.y - b.y; invalidate(); return 'end'; },
        preview(c, p) {
          if (!b) return;
          const u = S.underlay, dx = p.x - b.x, dy = p.y - b.y;
          pv({ type: 'polyline', closed: true, pts: [[u.x, u.y], [u.x + u.w, u.y], [u.x + u.w, u.y + u.h], [u.x, u.y + u.h]].map(([x, y]) => ({ x: x + dx, y: y + dy, b: 0 })) });
          pvDashed(b, p);
        }
      };
    }
  };

  function startTool(name, factory) {
    endTool(true);
    $('#welcome').hidden = true; S.welcomeOff = true;
    const def = TOOLS[name];
    if (name === 'select' || name === 'pan') { S.mode = name; updateToolButtons(); setPrompt(name === 'pan' ? 'Mano: arrastre para desplazar la vista' : 'Listo'); return; }
    if (def && def.action) { def.action(); return; }
    if (def && def.needsSel && !S.sel.size) {
      S.pending = name; S.mode = 'select';
      setPrompt(`${def.label}: seleccione objetos y pulse Intro (o clic derecho)`);
      updateToolButtons(); return;
    }
    tool = factory ? factory() : def.create();
    tool.name = name;
    if (def) S.lastTool = name;
    S.hover = null;
    setPrompt(tool.prompt());
    updateToolButtons(); requestRender();
  }
  function endTool(silent) {
    tool = null; S.pending = null; S.snapPt = null;
    if (!silent) setPrompt('Listo');
    updateToolButtons(); requestRender();
  }
  async function feedPoint(p, raw) {
    if (!tool) return;
    const t = tool;
    const r = await t.point(p, raw || p);
    if (tool !== t) return;
    if (r === 'end') endTool();
    else if (r !== 'keepmsg') setPrompt(t.prompt());
    requestRender();
  }
  function onEnter() {
    if (tool) {
      const r = tool.enter ? tool.enter() : 'end';
      if (r === 'keep') setPrompt(tool.prompt()); else endTool();
    } else if (S.pending) {
      if (S.sel.size) startTool(S.pending); else toast('Seleccione primero algún objeto');
    } else if (S.lastTool) startTool(S.lastTool);
    requestRender();
  }
  function cancel() {
    if (tool || S.pending) { endTool(); return; }
    if (S.drag || S.box) { S.drag = null; S.box = null; S.press = null; requestRender(); return; }
    clearSel();
  }

  /* ====================== Línea de comandos ====================== */
  function parseCoord(s) {
    s = s.replace(/\s+/g, '');
    const rel = s.startsWith('@');
    const body = rel ? s.slice(1) : s;
    const N = '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?)';
    let m = body.match(new RegExp('^' + N + '<' + N + '$', 'i'));
    const b = (tool && tool.base && tool.base()) || { x: 0, y: 0 };
    if (m) {
      const d = +m[1], a = +m[2] * D2R;
      const o = rel ? b : { x: 0, y: 0 };
      return { x: o.x + d * Math.cos(a), y: o.y + d * Math.sin(a) };
    }
    m = body.match(new RegExp('^' + N + ',' + N + '$', 'i'));
    if (m) return rel ? { x: b.x + +m[1], y: b.y + +m[2] } : { x: +m[1], y: +m[2] };
    return null;
  }
  function execCmd(raw) {
    const s = raw.trim();
    cmd.value = '';
    if (!s) { onEnter(); return; }
    const up = s.toUpperCase();
    if (tool) {
      const p = parseCoord(s);
      if (p) { feedPoint(p); return; }
      if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) {
        const n = parseFloat(s);
        if (tool.value) {
          const r = tool.value(n);
          if (r !== false) { if (r === 'end') endTool(); else setPrompt(tool.prompt()); requestRender(); return; }
        }
        const b = tool.base && tool.base();
        if (b) {
          const c = curPoint();
          let dx = c.x - b.x, dy = c.y - b.y, L = Math.hypot(dx, dy);
          if (!L) { dx = 1; dy = 0; L = 1; }
          feedPoint({ x: b.x + dx / L * n, y: b.y + dy / L * n });
          return;
        }
        toast('Indique primero un punto');
        return;
      }
      if (tool.word) {
        const r = tool.word(up);
        if (r) { if (r === 'end') endTool(); else setPrompt(tool.prompt()); requestRender(); return; }
      }
    }
    const a = ALIAS[up];
    if (a === '@zoom') { zoomExtents(); return; }
    if (a === '@undo') { undo(); return; }
    if (a === '@redo') { redo(); return; }
    if (a === '@explode') { explodeSelected(); return; }
    if (a) { startTool(a); return; }
    toast(`Comando desconocido: «${s}». Pulse F1 para ver la ayuda.`);
  }

  /* ====================== Ratón y táctil ====================== */
  const pointers = new Map();
  function evPos(ev) { const r = cv.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  function updateMouse(sx, sy) {
    S.mouse.sx = sx; S.mouse.sy = sy;
    [S.mouse.x, S.mouse.y] = s2w(sx, sy);
    const wantSnap = (tool && !(tool.pick && tool.pick())) || S.drag;
    S.snapPt = wantSnap ? findSnap(sx, sy) : null;
    const p = curPoint();
    $('#coords').textContent = `X ${fmt(p.x, 3)}   Y ${fmt(p.y, 3)}`;
  }

  cv.addEventListener('pointerdown', ev => {
    cv.focus({ preventScroll: true });
    const [sx, sy] = evPos(ev);
    pointers.set(ev.pointerId, [sx, sy]);
    try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* sin captura */ }
    S.mouse.inside = true;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      S.press = null; S.box = null; S.drag = null;
      S.pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), cx: (a[0] + b[0]) / 2, cy: (a[1] + b[1]) / 2 };
      return;
    }
    if (ev.button === 1 || (ev.button === 0 && S.mode === 'pan' && !tool)) {
      ev.preventDefault();
      S.pan = { sx, sy, ox: V.ox, oy: V.oy }; S.panOffset = [0, 0]; cv.style.cursor = 'grabbing';
      return;
    }
    if (ev.button === 2) return;
    if (ev.button !== 0) return;
    updateMouse(sx, sy);
    if (tool) {
      if (ev.pointerType === 'touch') { S.touchPoint = true; return; }
      feedPoint(curPoint(), { x: S.mouse.x, y: S.mouse.y }); return;
    }
    // Pinzamientos
    const sel = selected();
    if (sel.length && sel.length <= 150) {
      for (const e of sel) {
        if (!editable(e)) continue;
        for (const g of G.grips(e)) {
          const [gx, gy] = w2s(g.x, g.y);
          if (Math.abs(gx - sx) <= 6 && Math.abs(gy - sy) <= 6) {
            S.drag = { id: e.id, k: g.k, e, sx, sy, moved: false, preview: null };
            setPrompt('Arrastre para modificar el punto');
            return;
          }
        }
      }
    }
    S.press = { sx, sy, shift: ev.shiftKey || ev.ctrlKey || ev.metaKey };
  });

  cv.addEventListener('pointermove', ev => {
    const [sx, sy] = evPos(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, [sx, sy]);
    S.mouse.inside = true;
    if (S.pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]), cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      V.ox += cx - S.pinch.cx; V.oy += cy - S.pinch.cy;
      if (S.pinch.d > 0) zoomAt(cx, cy, d / S.pinch.d);
      S.pinch = { d, cx, cy };
      invalidate(); return;
    }
    if (S.pan) {
      S.panOffset = [sx - S.pan.sx, sy - S.pan.sy];
      V.ox = S.pan.ox + S.panOffset[0]; V.oy = S.pan.oy + S.panOffset[1];
      updateMouse(sx, sy); requestRender(); return;
    }
    updateMouse(sx, sy);
    if (S.drag) {
      if (Math.abs(sx - S.drag.sx) + Math.abs(sy - S.drag.sy) > 2) S.drag.moved = true;
      if (S.drag.moved) { const p = curPoint(); S.drag.preview = G.moveGrip(S.drag.e, S.drag.k, p.x, p.y); }
      requestRender(); return;
    }
    if (S.press) {
      if (Math.abs(sx - S.press.sx) + Math.abs(sy - S.press.sy) > 4) S.box = { x0: S.press.sx, y0: S.press.sy, x1: sx, y1: sy };
      if (S.box) { S.box.x1 = sx; S.box.y1 = sy; }
      requestRender(); return;
    }
    if (!tool && ev.pointerType === 'mouse') {
      const h = S.entities.length < 200000 ? pick(sx, sy) : null;
      if (h !== S.hover) { S.hover = h; }
    }
    requestRender();
  });

  function endPointer(ev) {
    const [sx, sy] = evPos(ev);
    pointers.delete(ev.pointerId);
    if (S.pinch) { if (pointers.size < 2) S.pinch = null; return; }
    if (S.pan) {
      S.pan = null; S.panOffset = null; cv.style.cursor = ''; invalidate(); return;
    }
    if (ev.type === 'pointercancel') { S.press = S.box = S.drag = null; requestRender(); return; }
    if (S.touchPoint && tool) {
      S.touchPoint = false; updateMouse(sx, sy);
      feedPoint(curPoint(), { x: S.mouse.x, y: S.mouse.y }); return;
    }
    if (S.drag) {
      const d = S.drag; S.drag = null;
      if (d.moved && d.preview) replaceEntities(new Map([[d.id, d.preview]]));
      S.snapPt = null; setPrompt(S.pending ? TOOLS[S.pending].label + ': seleccione objetos y pulse Intro' : 'Listo');
      requestRender(); return;
    }
    if (S.box) { boxSelect(S.box, S.press && S.press.shift); S.box = null; S.press = null; return; }
    if (S.press) {
      const e = pick(S.press.sx, S.press.sy);
      if (e) selectIds(groupOf(e).map(o => o.id), S.press.shift ? 'toggle' : 'replace');
      else if (!S.press.shift) clearSel();
      S.press = null;
    }
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('pointerleave', () => { if (!S.pan && !S.drag && !S.press) { S.mouse.inside = false; S.hover = null; S.snapPt = null; requestRender(); } });
  cv.addEventListener('contextmenu', ev => { ev.preventDefault(); onEnter(); });
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const [sx, sy] = evPos(ev);
    const dy = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaY;
    zoomAt(sx, sy, Math.pow(1.0015, -dy));
    updateMouse(sx, sy);
  }, { passive: false });
  cv.addEventListener('dblclick', ev => {
    if (tool && tool.dbl) { const r = tool.dbl(); if (r === 'end') endTool(); return; }
    if (tool) return;
    const [sx, sy] = evPos(ev);
    const e = pick(sx, sy);
    if (e && e.type === 'text') editText(e);
  });

  async function editText(e) {
    const r = await ask('Editar texto', [
      { name: 'text', label: 'Texto', type: 'textarea', value: e.text },
      { name: 'h', label: 'Altura', type: 'number', value: fmt(e.h) }
    ]);
    if (r && r.text.trim()) replaceEntities(new Map([[e.id, G.clone(e, { text: r.text, h: +r.h || e.h })]]));
  }

  /* ====================== Teclado ====================== */
  document.addEventListener('keydown', ev => {
    const ae = document.activeElement;
    const inCmd = ae === cmd;
    if (document.querySelector('dialog[open]')) return;
    if (!inCmd && ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT')) return;
    const k = ev.key;
    const mod = ev.ctrlKey || ev.metaKey;
    if (mod) {
      const lk = k.toLowerCase();
      if (lk === 'z' && !ev.shiftKey) { ev.preventDefault(); undo(); return; }
      if (lk === 'y' || (lk === 'z' && ev.shiftKey)) { ev.preventDefault(); redo(); return; }
      if (lk === 's') { ev.preventDefault(); saveDXF(); return; }
      if (lk === 'o') { ev.preventDefault(); openDialog(); return; }
      if (lk === 'a' && !inCmd) { ev.preventDefault(); selectIds(S.entities.filter(editable).map(e => e.id), 'replace'); return; }
      return;
    }
    if (k === 'F1') { ev.preventDefault(); showHelp(); return; }
    if (k === 'F3') { ev.preventDefault(); toggle('snap'); return; }
    if (k === 'F7') { ev.preventDefault(); toggle('grid'); return; }
    if (k === 'F8') { ev.preventDefault(); toggle('ortho'); return; }
    if (k === 'Escape') { ev.preventDefault(); cmd.value = ''; cancel(); cv.focus({ preventScroll: true }); return; }
    if (k === 'Enter' || k === ' ') {
      ev.preventDefault(); execCmd(cmd.value); return;
    }
    if ((k === 'Delete' || (k === 'Backspace' && !inCmd)) && !cmd.value) {
      ev.preventDefault(); if (!tool) deleteSelected(); return;
    }
    if (!inCmd && k.length === 1 && /[\w@<.,\-+]/.test(k)) {
      ev.preventDefault(); cmd.focus(); cmd.value += k;
    }
  });

  function toggle(what) {
    S[what] = !S[what];
    document.querySelectorAll('[data-toggle]').forEach(b => b.classList.toggle('on', !!S[b.dataset.toggle]));
    if (what === 'grid') invalidate();
    toast({ snap: 'Referencia a objetos', ortho: 'Modo ortogonal', grid: 'Rejilla' }[what] + (S[what] ? ' activada' : ' desactivada'), 1500);
    savePrefs();
  }

  /* ====================== Paneles ====================== */
  const EYE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const LOCK = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  function renderLayers() {
    const box = $('#layers');
    const counts = new Map();
    S.entities.forEach(e => counts.set(e.layer, (counts.get(e.layer) || 0) + 1));
    box.innerHTML = '';
    S.layers.forEach(L => {
      const row = document.createElement('div');
      row.className = 'layer' + (L.name === S.cur ? ' current' : '');
      row.title = 'Clic: capa actual · Doble clic: renombrar';
      const vis = document.createElement('button');
      vis.className = 'ico' + (L.visible ? '' : ' off'); vis.innerHTML = EYE; vis.title = L.visible ? 'Ocultar capa' : 'Mostrar capa';
      vis.onclick = ev => { ev.stopPropagation(); snapshot(); L.visible = !L.visible; if (!L.visible) S.entities.forEach(e => { if (e.layer === L.name) S.sel.delete(e.id); }); changed(); };
      const lock = document.createElement('button');
      lock.className = 'ico' + (L.locked ? '' : ' off'); lock.innerHTML = LOCK; lock.title = L.locked ? 'Desbloquear capa' : 'Bloquear capa';
      lock.onclick = ev => { ev.stopPropagation(); snapshot(); L.locked = !L.locked; if (L.locked) S.entities.forEach(e => { if (e.layer === L.name) S.sel.delete(e.id); }); changed(); };
      const sw = document.createElement('input');
      sw.type = 'color'; sw.className = 'swatch';
      sw.value = L.rgb || (L.aci === 7 ? (DARK ? '#ffffff' : '#000000') : C.aciHex(L.aci, false));
      sw.title = 'Color de la capa';
      sw.onclick = ev => ev.stopPropagation();
      sw.onchange = () => { snapshot(); const aci = C.nearestAci(sw.value); L.aci = aci; L.rgb = C.aciHex(aci, false).toLowerCase() === sw.value.toLowerCase() ? undefined : sw.value; changed(); };
      const nm = document.createElement('span'); nm.className = 'name'; nm.textContent = L.name;
      const ct = document.createElement('span'); ct.className = 'count'; ct.textContent = counts.get(L.name) || '';
      row.append(vis, lock, sw, nm, ct);
      row.onclick = () => { S.cur = L.name; renderLayers(); renderProps(); };
      row.ondblclick = async () => {
        if (L.name === '0') { toast('La capa 0 no se puede renombrar'); return; }
        const r = await ask('Renombrar capa', [{ name: 'n', label: 'Nombre', type: 'text', value: L.name }]);
        const n = r && r.n.trim();
        if (!n || n === L.name) return;
        if (layerOf(n)) { toast('Ya existe una capa con ese nombre'); return; }
        snapshot();
        S.entities.forEach(e => { if (e.layer === L.name) e.layer = n; });
        if (S.cur === L.name) S.cur = n;
        L.name = n; rebuildLayerIdx(); changed();
      };
      row.oncontextmenu = ev => {
        ev.preventDefault();
        if (L.name === '0') return;
        if (counts.get(L.name)) { toast('Solo se pueden eliminar capas vacías'); return; }
        snapshot(); S.layers = S.layers.filter(x => x !== L); if (S.cur === L.name) S.cur = '0'; rebuildLayerIdx(); changed();
        toast(`Capa «${L.name}» eliminada`);
      };
      box.append(row);
    });
  }

  async function addLayer() {
    let i = 1; while (layerOf('Capa' + i)) i++;
    const r = await ask('Nueva capa', [{ name: 'n', label: 'Nombre', type: 'text', value: 'Capa' + i }, { name: 'c', label: 'Color', type: 'color', value: '#1f6feb' }]);
    const n = r && r.n.trim();
    if (!n) return;
    if (layerOf(n)) { toast('Ya existe una capa con ese nombre'); return; }
    snapshot();
    const aci = C.nearestAci(r.c);
    S.layers.push({ name: n, aci, rgb: C.aciHex(aci, false) === r.c ? undefined : r.c, visible: true, locked: false });
    rebuildLayerIdx(); S.cur = n;
    changed();
  }

  const TYPE_NAMES = { line: 'Línea', polyline: 'Polilínea', circle: 'Círculo', arc: 'Arco', text: 'Texto', point: 'Punto', dim: 'Cota', hatch: 'Sombreado' };
  const COLOR_OPTS = [[256, 'Por capa'], [1, 'Rojo'], [2, 'Amarillo'], [3, 'Verde'], [4, 'Cian'], [5, 'Azul'], [6, 'Magenta'], [7, 'Blanco / negro'], [8, 'Gris'], [9, 'Gris claro'], [30, 'Naranja'], [140, 'Azul cielo'], [250, 'Gris oscuro']];

  function renderProps() {
    const box = $('#props');
    box.innerHTML = '';
    const sel = selected();
    const add = (label, el) => { const f = document.createElement('label'); f.className = 'field'; const s = document.createElement('span'); s.textContent = label; f.append(s, el); box.append(f); return el; };
    const info = (label, val) => { const s = document.createElement('span'); s.className = 'value'; s.textContent = val; add(label, s); };
    const numIn = (label, val, onset) => {
      const i = document.createElement('input'); i.type = 'number'; i.step = 'any'; i.value = fmt(val);
      i.onchange = () => { const v = parseFloat(i.value); if (Number.isFinite(v)) onset(v); };
      return add(label, i);
    };
    const layerSel = (value, onset) => {
      const s = document.createElement('select');
      if (value === null) s.append(new Option('— varias —', '', true, true));
      S.layers.forEach(L => s.append(new Option(L.name, L.name, false, L.name === value)));
      s.onchange = () => s.value && onset(s.value);
      return add('Capa', s);
    };

    if (!sel.length) {
      const p = document.createElement('p'); p.className = 'info';
      const ext = extents(false);
      p.innerHTML = `${S.entities.length} objetos · ${S.layers.length} capas` + (ext ? `<br>Extensión: ${fmt(ext[2] - ext[0], 2)} × ${fmt(ext[3] - ext[1], 2)}` : '') +
        '<br><br>Seleccione objetos para ver y cambiar sus propiedades. Las nuevas entidades se crean en la capa actual.';
      box.append(p);
      layerSel(S.cur, v => { S.cur = v; renderLayers(); });
      return;
    }

    const types = [...new Set(sel.map(e => TYPE_NAMES[e.type]))];
    const h = document.createElement('p'); h.className = 'info';
    const groups = new Set(sel.filter(e => e.g).map(e => e.g));
    h.textContent = sel.length === 1 ? types[0] : `${sel.length} objetos (${types.join(', ')})`;
    if (groups.size) h.textContent += ` · ${groups.size} bloque(s)`;
    box.append(h);

    const apply = fn => replaceEntities(new Map(sel.map(e => [e.id, fn(G.clone(e))])));
    const layers = [...new Set(sel.map(e => e.layer))];
    layerSel(layers.length === 1 ? layers[0] : null, v => apply(e => Object.assign(e, { layer: v })));

    const colors = [...new Set(sel.map(e => e.rgb || e.color))];
    const cs = document.createElement('select');
    const curC = colors.length === 1 ? colors[0] : null;
    if (curC === null) cs.append(new Option('— varios —', '', true, true));
    COLOR_OPTS.forEach(([v, n]) => cs.append(new Option(n, v, false, v === curC)));
    if (curC !== null && !COLOR_OPTS.some(([v]) => v === curC)) cs.append(new Option(typeof curC === 'string' ? curC : 'Color ' + curC, String(curC), false, true));
    cs.append(new Option('Otro color…', 'custom'));
    cs.onchange = () => {
      if (cs.value === 'custom') {
        const ci = document.createElement('input'); ci.type = 'color';
        ci.onchange = () => { const aci = C.nearestAci(ci.value); apply(e => Object.assign(e, { color: aci, rgb: ci.value })); };
        ci.click(); return;
      }
      if (cs.value === '') return;
      const v = +cs.value;
      apply(e => { e.color = v; delete e.rgb; return e; });
    };
    add('Color', cs);

    if (sel.length === 1) {
      const e = sel[0];
      const set = patch => replaceEntities(new Map([[e.id, G.clone(e, patch)]]));
      switch (e.type) {
        case 'line': {
          numIn('Inicio X', e.x1, v => set({ x1: v })); numIn('Inicio Y', e.y1, v => set({ y1: v }));
          numIn('Fin X', e.x2, v => set({ x2: v })); numIn('Fin Y', e.y2, v => set({ y2: v }));
          const L = G.length(e), a = Math.atan2(e.y2 - e.y1, e.x2 - e.x1);
          numIn('Longitud', L, v => set({ x2: e.x1 + v * Math.cos(a), y2: e.y1 + v * Math.sin(a) }));
          numIn('Ángulo (°)', G.normAng(a) * R2D, v => set({ x2: e.x1 + L * Math.cos(v * D2R), y2: e.y1 + L * Math.sin(v * D2R) }));
          break;
        }
        case 'circle':
          numIn('Centro X', e.cx, v => set({ cx: v })); numIn('Centro Y', e.cy, v => set({ cy: v }));
          numIn('Radio', e.r, v => v > 0 && set({ r: v })); numIn('Diámetro', e.r * 2, v => v > 0 && set({ r: v / 2 }));
          info('Perímetro', fmt(G.length(e))); info('Área', fmt(G.area(e)));
          break;
        case 'arc':
          numIn('Centro X', e.cx, v => set({ cx: v })); numIn('Centro Y', e.cy, v => set({ cy: v }));
          numIn('Radio', e.r, v => v > 0 && set({ r: v }));
          numIn('Áng. inicial', G.normAng(e.a0) * R2D, v => set({ a0: v * D2R }));
          numIn('Áng. final', G.normAng(e.a1) * R2D, v => set({ a1: v * D2R }));
          info('Longitud', fmt(G.length(e)));
          break;
        case 'polyline': {
          info('Vértices', e.pts.length);
          const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!e.closed;
          cb.onchange = () => set({ closed: cb.checked });
          add('Cerrada', cb);
          info('Longitud', fmt(G.length(e)));
          if (e.closed) info('Área', fmt(G.area(e)));
          break;
        }
        case 'text': {
          const ta = document.createElement('textarea'); ta.value = e.text; ta.rows = Math.min(5, e.text.split('\n').length + 1);
          ta.onchange = () => ta.value.trim() && set({ text: ta.value });
          add('Contenido', ta);
          numIn('Altura', e.h, v => v > 0 && set({ h: v }));
          numIn('Rotación (°)', (e.rot || 0) * R2D, v => set({ rot: v * D2R }));
          const al = document.createElement('select');
          [['left', 'Izquierda'], ['center', 'Centro'], ['right', 'Derecha']].forEach(([v, n]) => al.append(new Option(n, v, false, e.align === v)));
          al.onchange = () => set({ align: al.value });
          add('Alineación', al);
          numIn('X', e.x, v => set({ x: v })); numIn('Y', e.y, v => set({ y: v }));
          break;
        }
        case 'dim':
          info('Medida', fmt(G.dimGeom(e).value));
          numIn('Altura texto', e.h, v => v > 0 && set({ h: v }));
          numIn('Decimales', e.prec == null ? 2 : e.prec, v => set({ prec: Math.max(0, Math.min(6, Math.round(v))) }));
          break;
        case 'point':
          numIn('X', e.x, v => set({ x: v })); numIn('Y', e.y, v => set({ y: v }));
          break;
        case 'hatch':
          info('Área', fmt(G.area(e)));
          break;
      }
    } else {
      const lens = sel.map(G.length).filter(v => v != null);
      const areas = sel.map(G.area).filter(v => v != null);
      if (lens.length) info('Longitud total', fmt(lens.reduce((a, b) => a + b, 0)));
      if (areas.length) info('Área total', fmt(areas.reduce((a, b) => a + b, 0)));
    }
    if (groups.size) {
      const row = document.createElement('div'); row.className = 'row';
      const b = document.createElement('button'); b.textContent = 'Descomponer bloque'; b.onclick = explodeSelected;
      row.append(b); box.append(row);
    }
  }

  function updateToolButtons() {
    const active = tool ? tool.name : (S.pending || S.mode || 'select');
    document.querySelectorAll('#toolbox button').forEach(b => b.classList.toggle('on', b.dataset.tool === active));
    cv.style.cursor = !tool && S.mode === 'pan' ? 'grab' : 'crosshair';
  }
  function updateWelcome() {
    $('#welcome').hidden = S.welcomeOff || S.entities.length > 0 || !!S.underlay;
  }
  function updateTitle() {
    $('#fileName').textContent = (S.dirty ? '● ' : '') + S.fileName;
    document.title = (S.dirty ? '● ' : '') + S.fileName + ' — Sierpes CAD';
  }

  function buildToolbox() {
    const box = $('#toolbox');
    Object.keys(TOOLS).forEach(k => {
      const t = TOOLS[k];
      if (!t.label) { const s = document.createElement('div'); s.className = 'sep'; box.append(s); return; }
      const b = document.createElement('button');
      b.dataset.tool = k;
      b.title = t.label + (t.aliases && t.aliases[0] ? ` (${t.aliases[0]})` : '');
      b.innerHTML = `<svg viewBox="0 0 24 24"><path d="${t.icon}"/></svg><span>${t.label}</span>`;
      b.onclick = () => { startTool(k); cv.focus({ preventScroll: true }); };
      box.append(b);
    });
    const tb = $('#helpCmds');
    Object.keys(TOOLS).forEach(k => {
      const t = TOOLS[k];
      if (!t.aliases || !t.aliases.length || k === 'select') return;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${t.aliases.slice(0, 3).join(', ')}</td><td>${t.label}</td>`;
      tb.append(tr);
    });
    [['Z', 'Ver todo'], ['U', 'Deshacer'], ['X', 'Descomponer bloque']].forEach(([a, n]) => {
      const tr = document.createElement('tr'); tr.innerHTML = `<td>${a}</td><td>${n}</td>`; tb.append(tr);
    });
  }

  /* ====================== Diálogo ====================== */
  function ask(title, fields) {
    return new Promise(resolve => {
      const dlg = $('#dlg'), body = $('#dlgBody');
      $('#dlgTitle').textContent = title;
      body.innerHTML = '';
      const inputs = {};
      fields.forEach(f => {
        const lab = document.createElement('label');
        let el;
        if (f.type === 'textarea') { el = document.createElement('textarea'); el.value = f.value; }
        else { el = document.createElement('input'); el.type = f.type; if (f.type === 'checkbox') el.checked = !!f.value; else el.value = f.value; if (f.type === 'number') el.step = 'any'; }
        if (f.type === 'checkbox') { lab.style.display = 'flex'; lab.style.gap = '8px'; lab.style.alignItems = 'center'; lab.append(el, document.createTextNode(f.label)); el.style.width = 'auto'; el.style.minWidth = '0'; }
        else { lab.textContent = f.label; body.append(lab); lab.after(el); }
        if (f.type === 'checkbox') body.append(lab);
        if (f.type === 'textarea') el.addEventListener('keydown', ev => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); dlg.close('ok'); } });
        inputs[f.name] = el;
      });
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        if (dlg.returnValue !== 'ok') { resolve(null); cv.focus({ preventScroll: true }); return; }
        const out = {};
        Object.keys(inputs).forEach(k => { out[k] = inputs[k].type === 'checkbox' ? inputs[k].checked : inputs[k].value; });
        resolve(out);
        cv.focus({ preventScroll: true });
      };
      dlg.addEventListener('close', onClose);
      $('#dlgCancel').onclick = () => dlg.close('cancel');
      dlg.returnValue = '';
      dlg.showModal();
      const first = body.querySelector('textarea, input:not([type=checkbox])');
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  }
  function showHelp() { $('#help').showModal(); }

  /* ====================== Archivos ====================== */
  function resetDoc(name) {
    S.entities = []; S.layers = [{ name: '0', aci: 7, visible: true, locked: false }]; S.cur = '0';
    S.sel.clear(); S.undo = []; S.redo = []; S.dirty = false; S.fileName = name || 'sin título';
    S.underlay = null; $('#underlayPanel').hidden = true;
    nextGroup = 1;
    rebuildLayerIdx();
  }

  function loadDXFText(text, name) {
    let r;
    try { r = DXF.parse(text); } catch (err) { toast('No se pudo abrir: ' + err.message, 7000); return false; }
    endTool(true);
    resetDoc(name);
    S.layers = r.layers.length ? r.layers : S.layers;
    rebuildLayerIdx();
    S.entities = r.entities.map(e => Object.assign(e, { id: nextId++ }));
    nextGroup = S.entities.reduce((m, e) => Math.max(m, (e.g || 0) + 1), 1);
    if (r.units) S.units = r.units;
    S.textH = S.dimH = defaultTextHeight();
    $('#units').value = String([0, 4, 5, 6].includes(S.units) ? S.units : 0);
    S.cur = '0';
    changed();
    zoomExtents();
    const sk = Object.entries(r.skipped);
    let msg = `Abierto «${name}»: ${S.entities.length} objetos en ${S.layers.length} capas.`;
    if (sk.length) msg += ' No se muestran: ' + sk.map(([k, v]) => `${v} ${k}`).join(', ') + '.';
    toast(msg, sk.length ? 9000 : 4000);
    return true;
  }

  /** Altura de texto razonable para el dibujo: la mediana de sus textos o 1/60 de su tamaño. */
  function defaultTextHeight() {
    const hs = S.entities.filter(e => e.type === 'text' || e.type === 'dim').map(e => e.h).sort((a, b) => a - b);
    if (hs.length) return +hs[Math.floor(hs.length / 2)].toPrecision(3);
    const b = extents(false);
    if (!b) return 2.5;
    const v = Math.max(b[2] - b[0], b[3] - b[1]) / 60, p = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 2.5, 5, 10].map(k => k * p).find(k => k >= v) || 10 * p;
  }

  async function openFile(file) {
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (ext === 'dwg' || window.DWG.isDwg(head)) { await loadDwg(file); return; }
    if (ext === 'dxf') {
      if (S.dirty && !confirm('Hay cambios sin guardar. ¿Descartarlos y abrir el archivo?')) return;
      try {
        const text = DXF.decode(await file.arrayBuffer());
        loadDXFText(text, file.name);
      } catch (err) { toast('No se pudo abrir: ' + err.message, 8000); }
      return;
    }
    if (ext === 'pdf') { await loadPdf(file); return; }
    if (/^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext) || (file.type || '').startsWith('image/')) { await loadImage(file); return; }
    toast('Formato no reconocido. Use DWG, DXF, PDF o una imagen.');
  }

  async function loadDwg(file) {
    if (S.dirty && !confirm('Hay cambios sin guardar. ¿Descartarlos y abrir el archivo?')) return;
    const first = !window.DWG.loaded;
    toast(first ? 'Abriendo DWG… (la primera vez se descarga el lector, unos segundos)' : 'Abriendo DWG…', 60000);
    try {
      const text = await window.DWG.readAsDxf(await file.arrayBuffer());
      window.DWG.loaded = true;
      if (loadDXFText(text, file.name)) {
        const t = $('#toast').textContent;
        toast(t + ' Al guardar se creará un DXF (AutoCAD lo abre y puede volver a guardarlo como DWG).', 9000);
      }
    } catch (err) { toast('No se pudo abrir el DWG: ' + err.message, 9000); }
  }

  function setUnderlay(img, wWorld, hWorld) {
    const ext = S.entities.length ? extents(true) : null;
    S.underlay = { img, x: ext ? ext[0] : 0, y: ext ? ext[1] : 0, w: wWorld, h: hWorld, opacity: +$('#ulOpacity').value };
    $('#underlayPanel').hidden = false;
    S.welcomeOff = true; updateWelcome();
    zoomExtents();
    toast('Imagen cargada como plantilla. Use «Calibrar escala» con una medida conocida y dibuje encima.', 7000);
  }

  function loadImage(file) {
    return new Promise(res => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { setUnderlay(img, img.naturalWidth, img.naturalHeight); res(); };
      img.onerror = () => { toast('No se pudo leer la imagen'); res(); };
      img.src = url;
    });
  }

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = () => rej(new Error('no se pudo descargar el lector de PDF (¿sin conexión?)'));
      document.head.append(s);
    });
  }
  async function loadPdf(file) {
    try {
      toast('Cargando PDF…', 20000);
      if (!window.pdfjsLib) {
        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      }
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      let n = 1;
      if (pdf.numPages > 1) {
        const r = await ask('PDF de varias páginas', [{ name: 'p', label: `Página a abrir (1–${pdf.numPages})`, type: 'number', value: 1 }]);
        if (!r) { $('#toast').hidden = true; return; }
        n = Math.max(1, Math.min(pdf.numPages, Math.round(+r.p) || 1));
      }
      const page = await pdf.getPage(n);
      const vp1 = page.getViewport({ scale: 1 });
      const sc = Math.min(5, 5000 / Math.max(vp1.width, vp1.height));
      const vp = page.getViewport({ scale: sc });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const cc = c.getContext('2d'); cc.fillStyle = '#fff'; cc.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: cc, viewport: vp }).promise;
      const mm = 25.4 / 72;
      setUnderlay(c, vp1.width * mm, vp1.height * mm);
      if (S.fileName === 'sin título') { S.fileName = file.name.replace(/\.pdf$/i, '') + '.dxf'; updateTitle(); }
    } catch (err) { toast('No se pudo abrir el PDF: ' + err.message, 8000); }
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  const baseName = () => S.fileName.replace(/\.(dxf|dwg|pdf|png|jpe?g)$/i, '') || 'plano';

  async function saveDXF() {
    if (tool) endTool();
    const bytes = DXF.write({ entities: S.entities, layers: S.layers, units: S.units });
    const blob = new Blob([bytes], { type: 'application/dxf' });
    const name = baseName() + '.dxf';
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Dibujo DXF', accept: { 'application/dxf': ['.dxf'] } }] });
        const w = await h.createWritable(); await w.write(blob); await w.close();
        S.fileName = h.name || name;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        download(blob, name);
      }
    } else download(blob, name);
    S.dirty = false; updateTitle();
    toast('Guardado como DXF (R12, compatible con AutoCAD, BricsCAD, LibreCAD, QCAD…)');
  }

  function buildSVG() {
    const ents = S.entities.filter(visible);
    const b = extents(true) || [0, 0, 100, 100];
    const w = b[2] - b[0] || 1, h = b[3] - b[1] || 1, pad = Math.max(w, h) * 0.03;
    const X = x => (x - b[0] + pad), Y = y => (b[3] - y + pad);
    const sw = Math.max(w, h) / 1500;
    const n = v => +v.toFixed(4);
    const col = e => {
      let c;
      if (e.rgb) c = e.rgb;
      else { let a = e.color; const L = layerOf(e.layer); if (a == null || a === 256) { if (L && L.rgb) return L.rgb; a = L ? L.aci : 7; } c = C.aciHex(a, false); }
      const [r, g, bb] = C.hexToRgb(c); return (r * 0.299 + g * 0.587 + bb * 0.114) > 235 ? '#000000' : c;
    };
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const ptsPath = (pts, closed) => {
      let d = `M${n(X(pts[0].x))} ${n(Y(pts[0].y))}`;
      const segs = closed ? pts.length : pts.length - 1;
      for (let i = 0; i < segs; i++) {
        const p = pts[i], q = pts[(i + 1) % pts.length];
        if (p.b) { const a = G.bulgeArc(p.x, p.y, q.x, q.y, p.b); if (a) { const span = Math.abs(4 * Math.atan(p.b)); d += ` A${n(a.r)} ${n(a.r)} 0 ${span > Math.PI ? 1 : 0} ${p.b > 0 ? 0 : 1} ${n(X(q.x))} ${n(Y(q.y))}`; continue; } }
        d += ` L${n(X(q.x))} ${n(Y(q.y))}`;
      }
      return d + (closed ? ' Z' : '');
    };
    const text = (t, c) => {
      const L = G.textLayout(t);
      const anchor = { left: 'start', center: 'middle', right: 'end' }[t.align] || 'start';
      return `<g transform="translate(${n(X(t.x))} ${n(Y(t.y))}) rotate(${n(-(t.rot || 0) * R2D)})" fill="${c}" stroke="none" font-family="Arial, Helvetica, sans-serif" font-size="${n(t.h / 0.72)}" text-anchor="${anchor}">` +
        L.lines.map((ln, i) => `<text x="0" y="${n(-L.ys[i])}">${esc(ln)}</text>`).join('') + '</g>';
    };
    const out = [];
    for (const e of ents) {
      const c = col(e);
      switch (e.type) {
        case 'line': out.push(`<line x1="${n(X(e.x1))}" y1="${n(Y(e.y1))}" x2="${n(X(e.x2))}" y2="${n(Y(e.y2))}" stroke="${c}"/>`); break;
        case 'polyline': out.push(`<path d="${ptsPath(e.pts, e.closed)}" stroke="${c}"${e.fill ? ` fill="${c}"` : ''}/>`); break;
        case 'hatch': out.push(`<path d="${e.loops.map(l => ptsPath(l, true)).join(' ')}" fill="${c}" fill-opacity="0.55" fill-rule="evenodd" stroke="none"/>`); break;
        case 'circle': out.push(`<circle cx="${n(X(e.cx))}" cy="${n(Y(e.cy))}" r="${n(e.r)}" stroke="${c}"/>`); break;
        case 'arc': {
          const span = G.arcSpan(e.a0, e.a1);
          const sx = e.cx + e.r * Math.cos(e.a0), sy = e.cy + e.r * Math.sin(e.a0), ex = e.cx + e.r * Math.cos(e.a1), ey = e.cy + e.r * Math.sin(e.a1);
          out.push(`<path d="M${n(X(sx))} ${n(Y(sy))} A${n(e.r)} ${n(e.r)} 0 ${span > Math.PI ? 1 : 0} 0 ${n(X(ex))} ${n(Y(ey))}" stroke="${c}"/>`); break;
        }
        case 'point': out.push(`<circle cx="${n(X(e.x))}" cy="${n(Y(e.y))}" r="${n(sw)}" fill="${c}"/>`); break;
        case 'text': out.push(text(e, c)); break;
        case 'dim': {
          const d = G.dimGeom(e);
          d.lines.forEach(l => out.push(`<line x1="${n(X(l[0]))}" y1="${n(Y(l[1]))}" x2="${n(X(l[2]))}" y2="${n(Y(l[3]))}" stroke="${c}"/>`));
          d.arrows.forEach(a => out.push(`<path d="M${a.map(p => n(X(p[0])) + ' ' + n(Y(p[1]))).join(' L')} Z" fill="${c}" stroke="none"/>`));
          out.push(text(d.text, c)); break;
        }
      }
    }
    const W = w + 2 * pad, H = h + 2 * pad;
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}">\n` +
      `<rect width="100%" height="100%" fill="#ffffff"/>\n<g fill="none" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round">\n${out.join('\n')}\n</g>\n</svg>\n`;
  }

  function exportPNG() {
    S.clean = true; drawStatic(); render();
    cv.toBlob(b => { download(b, baseName() + '.png'); S.clean = false; invalidate(); }, 'image/png');
  }
  function printView() {
    const prev = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'light'; readTheme();
    S.clean = true; drawStatic(); render();
    setTimeout(() => {
      window.print();
      if (prev) document.documentElement.dataset.theme = prev; else delete document.documentElement.dataset.theme;
      readTheme(); S.clean = false; renderLayers(); invalidate();
    }, 50);
  }

  function openDialog() { $('#fileInput').click(); }

  /* ====================== Preferencias ====================== */
  function savePrefs() {
    try { localStorage.setItem('sierpescad.prefs', JSON.stringify({ snap: S.snap, ortho: S.ortho, grid: S.grid, theme: document.documentElement.dataset.theme || '' })); } catch (e) { /* sin almacenamiento */ }
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('sierpescad.prefs') || '{}');
      ['snap', 'ortho', 'grid'].forEach(k => { if (typeof p[k] === 'boolean') S[k] = p[k]; });
      if (p.theme) document.documentElement.dataset.theme = p.theme;
    } catch (e) { /* sin almacenamiento */ }
  }

  /* ====================== Acciones de la interfaz ====================== */
  const ACTIONS = {
    new: () => {
      if (S.dirty && !confirm('Hay cambios sin guardar. ¿Empezar un dibujo nuevo?')) return;
      endTool(true); resetDoc(); S.welcomeOff = true; changed(); zoomTo(null); setPrompt('Listo');
    },
    open: openDialog,
    sample: () => { if (window.SAMPLE_DXF) loadDXFText(window.SAMPLE_DXF, 'vivienda-ejemplo.dxf'); },
    save: saveDXF,
    'export-svg': () => download(new Blob([buildSVG()], { type: 'image/svg+xml' }), baseName() + '.svg'),
    'export-png': exportPNG,
    print: printView,
    undo, redo,
    delete: deleteSelected,
    explode: explodeSelected,
    'zoom-ext': zoomExtents,
    theme: () => {
      const root = document.documentElement;
      const nowDark = DARK;
      root.dataset.theme = nowDark ? 'light' : 'dark';
      readTheme(); renderLayers(); invalidate(); savePrefs();
    },
    help: showHelp,
    side: () => document.body.classList.toggle('side-open'),
    'add-layer': addLayer,
    calibrate: () => S.underlay && startTool('calibrate', UL_TOOLS.calibrate),
    'move-underlay': () => S.underlay && startTool('moveUnderlay', UL_TOOLS.moveUnderlay),
    'remove-underlay': () => { S.underlay = null; $('#underlayPanel').hidden = true; invalidate(); updateWelcome(); }
  };

  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]');
    if (b && ACTIONS[b.dataset.act]) { ACTIONS[b.dataset.act](); if (b.closest('.menu')) b.blur(); }
    const t = ev.target.closest('[data-toggle]');
    if (t) toggle(t.dataset.toggle);
  });
  $('#fileInput').addEventListener('change', ev => { openFile(ev.target.files[0]); ev.target.value = ''; });
  $('#ulOpacity').addEventListener('input', ev => { if (S.underlay) { S.underlay.opacity = +ev.target.value; invalidate(); } });
  $('#units').addEventListener('change', ev => { S.units = +ev.target.value; S.dirty = true; updateTitle(); });

  const wrap = $('#canvasWrap');
  ['dragenter', 'dragover'].forEach(t => wrap.addEventListener(t, ev => { ev.preventDefault(); $('#dropHint').hidden = false; }));
  ['dragleave', 'drop'].forEach(t => wrap.addEventListener(t, ev => { ev.preventDefault(); if (t === 'drop' || ev.target === wrap || ev.target === cv) $('#dropHint').hidden = true; }));
  wrap.addEventListener('drop', ev => { const f = ev.dataTransfer.files[0]; if (f) openFile(f); });

  window.addEventListener('beforeunload', ev => { if (S.dirty) { ev.preventDefault(); ev.returnValue = ''; } });
  window.addEventListener('resize', resize);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { readTheme(); renderLayers(); invalidate(); });

  /* ====================== Inicio ====================== */
  loadPrefs();
  readTheme();
  rebuildLayerIdx();
  buildToolbox();
  document.querySelectorAll('[data-toggle]').forEach(b => b.classList.toggle('on', !!S[b.dataset.toggle]));
  $('#units').value = String(S.units);
  S.mode = 'select';
  updateToolButtons();
  resize();
  zoomTo(null);
  changed();

  // API mínima para pruebas automatizadas y depuración
  window.SierpesCAD = {
    state: S, view: V,
    load: (text, name) => loadDXFText(text, name || 'prueba.dxf'),
    dxf: () => DXF.write({ entities: S.entities, layers: S.layers, units: S.units }),
    svg: buildSVG,
    exec: execCmd,
    w2s, s2w
  };
})();
