/*
 * Geometría 2D para el editor.
 *
 * Modelo de entidades (coordenadas de mundo, eje Y hacia arriba, ángulos en radianes):
 *   line     {x1,y1,x2,y2}
 *   polyline {pts:[{x,y,b}], closed, fill}   b = curvatura (bulge) del tramo que sale del vértice
 *   circle   {cx,cy,r}
 *   arc      {cx,cy,r,a0,a1}                 siempre en sentido antihorario de a0 a a1
 *   text     {x,y,h,rot,text,align,valign}   align: left|center|right, valign: baseline|bottom|middle|top
 *   point    {x,y}
 *   dim      {x1,y1,x2,y2,x3,y3,h}           cota alineada; (x3,y3) fija la posición de la línea de cota
 *   hatch    {loops:[[{x,y,b}]]}             sombreado sólido
 * Campos comunes: id, type, layer, color (ACI, 256 = por capa), rgb (opcional), g (grupo/bloque).
 */
(function (global) {
  'use strict';
  const TAU = Math.PI * 2;
  const G = {};
  G.TAU = TAU;

  G.normAng = a => { a %= TAU; return a < 0 ? a + TAU : a; };
  G.arcSpan = (a0, a1) => { const s = G.normAng(a1 - a0); return s < 1e-12 ? TAU : s; };
  G.dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);

  G.distPtSeg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  G.segInt = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
    const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
    if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
    return { x: ax + t * rx, y: ay + t * ry };
  };

  /** Arco equivalente a un tramo de polilínea con curvatura b. */
  G.bulgeArc = (x1, y1, x2, y2, b) => {
    const dx = x2 - x1, dy = y2 - y1;
    if (!dx && !dy) return null;
    const s = (1 - b * b) / (4 * b);
    const cx = (x1 + x2) / 2 - s * dy, cy = (y1 + y2) / 2 + s * dx;
    const r = Math.hypot(dx, dy) * (1 + b * b) / (4 * Math.abs(b));
    return { cx, cy, r, a0: Math.atan2(y1 - cy, x1 - cx), a1: Math.atan2(y2 - cy, x2 - cx), ccw: b > 0 };
  };

  /** Puntos de un arco; span con signo (positivo = antihorario). */
  G.sampleArc = (cx, cy, r, a0, span, out) => {
    const n = Math.max(2, Math.ceil(Math.abs(span) / (TAU / 72)));
    for (let i = 0; i <= n; i++) {
      const a = a0 + span * i / n;
      out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
    return out;
  };

  /** Puntos de una cadena de vértices con curvaturas. */
  G.samplePts = (pts, closed) => {
    const out = [];
    const n = pts.length;
    if (!n) return out;
    const segs = closed ? n : n - 1;
    out.push([pts[0].x, pts[0].y]);
    for (let i = 0; i < segs; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      if (p.b) {
        const a = G.bulgeArc(p.x, p.y, q.x, q.y, p.b);
        if (a) {
          const span = 4 * Math.atan(p.b);
          const tmp = G.sampleArc(a.cx, a.cy, a.r, a.a0, span, []);
          for (let k = 1; k < tmp.length; k++) out.push(tmp[k]);
          continue;
        }
      }
      out.push([q.x, q.y]);
    }
    return out;
  };

  G.arcFrom3 = (p1, p2, p3) => {
    const ax = p1.x, ay = p1.y, bx = p2.x, by = p2.y, cx = p3.x, cy = p3.y;
    const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
    const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
    const r = Math.hypot(ax - ux, ay - uy);
    let a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
    if (G.normAng(am - a0) > G.normAng(a1 - a0)) { const t = a0; a0 = a1; a1 = t; }
    return { cx: ux, cy: uy, r, a0, a1 };
  };

  /* ---------- Texto ---------- */
  G.measure = s => s.length * 0.62; // anchura por unidad de altura; la app la sustituye por una medida real
  G.LINE_GAP = 1.6;

  G.textLayout = e => {
    const lines = String(e.text).split('\n');
    const n = lines.length, h = e.h, gap = h * G.LINE_GAP;
    const H = h + (n - 1) * gap;
    const ys = lines.map((_, i) => {
      if (e.valign === 'top') return -(h + i * gap);
      if (e.valign === 'middle') return H / 2 - h - i * gap;
      return (n - 1 - i) * gap;
    });
    const W = Math.max(...lines.map(l => G.measure(l))) * h;
    return { lines, ys, W, H };
  };

  G.textBox = e => {
    const L = G.textLayout(e);
    const x0 = e.align === 'center' ? -L.W / 2 : e.align === 'right' ? -L.W : 0;
    const y0 = Math.min(...L.ys) - 0.25 * e.h, y1 = Math.max(...L.ys) + e.h;
    const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
    return [[x0, y0], [x0 + L.W, y0], [x0 + L.W, y1], [x0, y1]].map(([u, v]) => [e.x + u * c - v * s, e.y + u * s + v * c]);
  };

  /* ---------- Cotas ---------- */
  G.dimGeom = e => {
    const dx = e.x2 - e.x1, dy = e.y2 - e.y1, L = Math.hypot(dx, dy) || 1e-9;
    const ux = dx / L, uy = dy / L, nx = -uy, ny = ux;
    const off = (e.x3 - e.x1) * nx + (e.y3 - e.y1) * ny;
    const sg = off >= 0 ? 1 : -1, h = e.h;
    const ax = e.x1 + nx * off, ay = e.y1 + ny * off, bx = e.x2 + nx * off, by = e.y2 + ny * off;
    const gap = h * 0.4, ext = h * 0.6;
    const lines = [
      [ax, ay, bx, by],
      [e.x1 + nx * gap * sg, e.y1 + ny * gap * sg, ax + nx * ext * sg, ay + ny * ext * sg],
      [e.x2 + nx * gap * sg, e.y2 + ny * gap * sg, bx + nx * ext * sg, by + ny * ext * sg]
    ];
    if (Math.abs(off) < gap) lines.length = 1;
    const al = h * 1.2, aw = h * 0.35;
    const arrows = [
      [[ax, ay], [ax + ux * al + nx * aw, ay + uy * al + ny * aw], [ax + ux * al - nx * aw, ay + uy * al - ny * aw]],
      [[bx, by], [bx - ux * al + nx * aw, by - uy * al + ny * aw], [bx - ux * al - nx * aw, by - uy * al - ny * aw]]
    ];
    let rot = Math.atan2(uy, ux);
    if (rot > Math.PI / 2 + 1e-9 || rot <= -Math.PI / 2 + 1e-9) rot += Math.PI;
    const tnx = -Math.sin(rot), tny = Math.cos(rot);
    const text = {
      x: (ax + bx) / 2 + tnx * h * 0.4, y: (ay + by) / 2 + tny * h * 0.4,
      h, rot, align: 'center', valign: 'bottom', text: G.fmt(L, e.prec == null ? 2 : e.prec)
    };
    return { lines, arrows, text, value: L };
  };

  G.fmt = (v, prec) => {
    const s = (Math.round(v * 10 ** prec) / 10 ** prec).toFixed(prec);
    return prec > 0 ? s.replace(/\.?0+$/, '') || '0' : s;
  };

  /* ---------- Trayectorias (para selección, límites, enganches) ---------- */
  G.paths = e => {
    switch (e.type) {
      case 'line': return [[[e.x1, e.y1], [e.x2, e.y2]]];
      case 'point': return [[[e.x, e.y], [e.x, e.y]]];
      case 'polyline': {
        const p = G.samplePts(e.pts, e.closed);
        if (e.closed && p.length) p.push(p[0]);
        return [p];
      }
      case 'circle': return [G.sampleArc(e.cx, e.cy, e.r, 0, TAU, [])];
      case 'arc': return [G.sampleArc(e.cx, e.cy, e.r, e.a0, G.arcSpan(e.a0, e.a1), [])];
      case 'text': { const b = G.textBox(e); b.push(b[0]); return [b]; }
      case 'dim': {
        const d = G.dimGeom(e);
        const out = d.lines.map(l => [[l[0], l[1]], [l[2], l[3]]]);
        d.arrows.forEach(a => out.push([a[0], a[1], a[2], a[0]]));
        const b = G.textBox(d.text); b.push(b[0]); out.push(b);
        return out;
      }
      case 'hatch': return e.loops.map(l => { const p = G.samplePts(l, true); p.push(p[0]); return p; });
    }
    return [];
  };

  G.bbox = e => {
    if (e._bb) return e._bb;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    if (e.type === 'circle') { x0 = e.cx - e.r; x1 = e.cx + e.r; y0 = e.cy - e.r; y1 = e.cy + e.r; }
    else {
      for (const p of G.paths(e)) for (const [x, y] of p) {
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    const bb = [x0, y0, x1, y1];
    Object.defineProperty(e, '_bb', { value: bb, enumerable: false, configurable: true, writable: true });
    return bb;
  };

  G.pointInPoly = (x, y, p) => {
    let inside = false;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const [xi, yi] = p[i], [xj, yj] = p[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /** Distancia del punto (x,y) a la entidad. */
  G.hitDist = (e, x, y) => {
    if (e.type === 'circle') return Math.abs(Math.hypot(x - e.cx, y - e.cy) - e.r);
    const ps = G.paths(e);
    if (e.type === 'text' && G.pointInPoly(x, y, ps[0])) return 0;
    if ((e.type === 'hatch' || (e.type === 'polyline' && e.fill)) && ps.some(p => G.pointInPoly(x, y, p))) return 0;
    let best = Infinity;
    for (const p of ps) {
      if (p.length === 1) best = Math.min(best, Math.hypot(x - p[0][0], y - p[0][1]));
      for (let i = 1; i < p.length; i++) {
        const d = G.distPtSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]);
        if (d < best) best = d;
      }
    }
    return best;
  };

  /** ¿Cruza o está dentro del rectángulo? (selección por captura) */
  G.crossesRect = (e, x0, y0, x1, y1) => {
    const inR = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    for (const p of G.paths(e)) {
      for (let i = 0; i < p.length; i++) {
        if (inR(p[i][0], p[i][1])) return true;
        if (i) {
          const [ax, ay] = p[i - 1], [bx, by] = p[i];
          if (G.segInt(ax, ay, bx, by, x0, y0, x1, y0) || G.segInt(ax, ay, bx, by, x1, y0, x1, y1) ||
              G.segInt(ax, ay, bx, by, x1, y1, x0, y1) || G.segInt(ax, ay, bx, by, x0, y1, x0, y0)) return true;
        }
      }
      if (e.type === 'hatch' || e.type === 'text' || (e.type === 'polyline' && e.closed)) {
        if (G.pointInPoly(x0, y0, p)) return true;
      }
    }
    return false;
  };

  /* ---------- Puntos de enganche ---------- */
  G.snapPoints = e => {
    const out = [];
    const add = (x, y, k) => out.push({ x, y, k });
    switch (e.type) {
      case 'line':
        add(e.x1, e.y1, 'end'); add(e.x2, e.y2, 'end'); add((e.x1 + e.x2) / 2, (e.y1 + e.y2) / 2, 'mid'); break;
      case 'polyline': {
        const n = e.pts.length, segs = e.closed ? n : n - 1;
        e.pts.forEach(p => add(p.x, p.y, 'end'));
        for (let i = 0; i < segs; i++) {
          const p = e.pts[i], q = e.pts[(i + 1) % n];
          if (p.b) {
            const a = G.bulgeArc(p.x, p.y, q.x, q.y, p.b);
            if (a) {
              const am = a.a0 + 2 * Math.atan(p.b);
              add(a.cx + a.r * Math.cos(am), a.cy + a.r * Math.sin(am), 'mid');
              add(a.cx, a.cy, 'cen');
              continue;
            }
          }
          add((p.x + q.x) / 2, (p.y + q.y) / 2, 'mid');
        }
        break;
      }
      case 'circle':
        add(e.cx, e.cy, 'cen');
        for (let k = 0; k < 4; k++) add(e.cx + e.r * Math.cos(k * Math.PI / 2), e.cy + e.r * Math.sin(k * Math.PI / 2), 'quad');
        break;
      case 'arc': {
        add(e.cx, e.cy, 'cen');
        add(e.cx + e.r * Math.cos(e.a0), e.cy + e.r * Math.sin(e.a0), 'end');
        add(e.cx + e.r * Math.cos(e.a1), e.cy + e.r * Math.sin(e.a1), 'end');
        const am = e.a0 + G.arcSpan(e.a0, e.a1) / 2;
        add(e.cx + e.r * Math.cos(am), e.cy + e.r * Math.sin(am), 'mid');
        break;
      }
      case 'text': case 'point': add(e.x, e.y, 'node'); break;
      case 'dim': {
        const d = G.dimGeom(e);
        add(e.x1, e.y1, 'end'); add(e.x2, e.y2, 'end');
        add(d.lines[0][0], d.lines[0][1], 'end'); add(d.lines[0][2], d.lines[0][3], 'end');
        break;
      }
      case 'hatch': e.loops.forEach(l => l.forEach(p => add(p.x, p.y, 'end'))); break;
    }
    return out;
  };

  /* ---------- Pinzamientos (edición directa de puntos) ---------- */
  G.grips = e => {
    switch (e.type) {
      case 'line': return [{ x: e.x1, y: e.y1, k: 'p1' }, { x: e.x2, y: e.y2, k: 'p2' }, { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2, k: 'mv' }];
      case 'polyline': return e.pts.map((p, i) => ({ x: p.x, y: p.y, k: i }));
      case 'circle': return [{ x: e.cx, y: e.cy, k: 'mv' }, { x: e.cx + e.r, y: e.cy, k: 'r' }, { x: e.cx, y: e.cy + e.r, k: 'r' }, { x: e.cx - e.r, y: e.cy, k: 'r' }, { x: e.cx, y: e.cy - e.r, k: 'r' }];
      case 'arc': {
        const am = e.a0 + G.arcSpan(e.a0, e.a1) / 2;
        return [
          { x: e.cx + e.r * Math.cos(e.a0), y: e.cy + e.r * Math.sin(e.a0), k: 's' },
          { x: e.cx + e.r * Math.cos(am), y: e.cy + e.r * Math.sin(am), k: 'm' },
          { x: e.cx + e.r * Math.cos(e.a1), y: e.cy + e.r * Math.sin(e.a1), k: 'e' },
          { x: e.cx, y: e.cy, k: 'mv' }
        ];
      }
      case 'text': case 'point': return [{ x: e.x, y: e.y, k: 'mv' }];
      case 'dim': return [{ x: e.x1, y: e.y1, k: 'p1' }, { x: e.x2, y: e.y2, k: 'p2' }, { x: e.x3, y: e.y3, k: 'p3' }];
    }
    return [];
  };

  G.clone = (e, patch) => {
    const n = JSON.parse(JSON.stringify(e));
    return patch ? Object.assign(n, patch) : n;
  };

  G.moveGrip = (e, k, x, y) => {
    const gr = G.grips(e).find(g => g.k === k);
    if (k === 'mv' && gr) return G.transform(e, G.mTranslate(x - gr.x, y - gr.y));
    switch (e.type) {
      case 'line': return G.clone(e, k === 'p1' ? { x1: x, y1: y } : { x2: x, y2: y });
      case 'polyline': { const n = G.clone(e); n.pts[k].x = x; n.pts[k].y = y; return n; }
      case 'circle': return G.clone(e, { r: Math.max(1e-9, Math.hypot(x - e.cx, y - e.cy)) });
      case 'arc': {
        const g = G.grips(e), P = { s: g[0], m: g[1], e: g[2] };
        P[k] = { x, y };
        const a = G.arcFrom3(P.s, P.m, P.e);
        return a ? G.clone(e, a) : e;
      }
      case 'dim': {
        const map = { p1: ['x1', 'y1'], p2: ['x2', 'y2'], p3: ['x3', 'y3'] }[k];
        return G.clone(e, { [map[0]]: x, [map[1]]: y });
      }
    }
    return e;
  };

  /* ---------- Matrices afines [a,b,c,d,e,f]: x' = a·x + c·y + e, y' = b·x + d·y + f ---------- */
  G.I = [1, 0, 0, 1, 0, 0];
  G.mMul = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
  ];
  G.mTranslate = (tx, ty) => [1, 0, 0, 1, tx, ty];
  G.mRotate = (a, cx = 0, cy = 0) => {
    const c = Math.cos(a), s = Math.sin(a);
    return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
  };
  G.mScale = (sx, sy, cx = 0, cy = 0) => [sx, 0, 0, sy, cx - sx * cx, cy - sy * cy];
  G.mMirror = (x1, y1, x2, y2) => {
    const a = Math.atan2(y2 - y1, x2 - x1), c = Math.cos(2 * a), s = Math.sin(2 * a);
    return G.mMul(G.mTranslate(x1, y1), G.mMul([c, s, s, -c, 0, 0], G.mTranslate(-x1, -y1)));
  };
  G.apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  G.isIdentity = m => m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;

  function toPolyline(e) {
    const p = G.paths(e)[0];
    const closed = e.type === 'circle';
    if (closed) p.pop();
    return Object.assign(G.clone(e), { type: 'polyline', pts: p.map(([x, y]) => ({ x, y, b: 0 })), closed, cx: undefined, cy: undefined, r: undefined, a0: undefined, a1: undefined });
  }

  /** Devuelve una copia transformada de la entidad. */
  G.transform = (e, m) => {
    const det = m[0] * m[3] - m[1] * m[2];
    const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
    const uniform = Math.abs(sx - sy) <= 1e-9 * Math.max(sx, sy) && Math.abs(m[0] * m[2] + m[1] * m[3]) <= 1e-9 * sx * sy;
    const sc = Math.sqrt(Math.abs(det));
    const n = G.clone(e);
    const P = (o, kx, ky) => { const r = G.apply(m, o[kx], o[ky]); o[kx] = r[0]; o[ky] = r[1]; };
    switch (e.type) {
      case 'line': P(n, 'x1', 'y1'); P(n, 'x2', 'y2'); return n;
      case 'point': P(n, 'x', 'y'); return n;
      case 'polyline': case 'hatch': {
        const fix = pts => {
          if (!uniform && pts.some(p => p.b)) {
            pts = G.samplePts(pts, false).map(([x, y]) => ({ x, y, b: 0 }));
          }
          return pts.map(p => { const r = G.apply(m, p.x, p.y); return { x: r[0], y: r[1], b: det < 0 ? -(p.b || 0) : (p.b || 0) }; });
        };
        if (e.type === 'hatch') n.loops = n.loops.map(l => {
          if (!uniform && l.some(p => p.b)) { const s = G.samplePts(l, true); s.pop(); l = s.map(([x, y]) => ({ x, y, b: 0 })); }
          return fix(l);
        });
        else {
          if (!uniform && e.pts.some(p => p.b)) {
            const s = G.samplePts(e.pts, e.closed);
            if (e.closed) s.pop();
            n.pts = s.map(([x, y]) => ({ x, y, b: 0 }));
          }
          n.pts = fix(n.pts);
        }
        return n;
      }
      case 'circle':
        if (!uniform) return G.transform(toPolyline(e), m);
        P(n, 'cx', 'cy'); n.r *= sx; return n;
      case 'arc': {
        if (!uniform) return G.transform(toPolyline(e), m);
        const s = G.apply(m, e.cx + e.r * Math.cos(e.a0), e.cy + e.r * Math.sin(e.a0));
        const f = G.apply(m, e.cx + e.r * Math.cos(e.a1), e.cy + e.r * Math.sin(e.a1));
        P(n, 'cx', 'cy'); n.r *= sx;
        let a0 = Math.atan2(s[1] - n.cy, s[0] - n.cx), a1 = Math.atan2(f[1] - n.cy, f[0] - n.cx);
        if (det < 0) { const t = a0; a0 = a1; a1 = t; }
        n.a0 = a0; n.a1 = a1; return n;
      }
      case 'text': {
        P(n, 'x', 'y');
        const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
        let rot = Math.atan2(m[1] * c + m[3] * s, m[0] * c + m[2] * s);
        if (det < 0 && Math.cos(rot) < -1e-6) {
          rot += Math.PI;
          n.align = e.align === 'left' ? 'right' : e.align === 'right' ? 'left' : e.align;
        }
        n.rot = rot; n.h *= sc; return n;
      }
      case 'dim': P(n, 'x1', 'y1'); P(n, 'x2', 'y2'); P(n, 'x3', 'y3'); n.h *= sc; return n;
    }
    return n;
  };

  /* ---------- Medidas ---------- */
  G.length = e => {
    if (e.type === 'line') return G.dist(e.x1, e.y1, e.x2, e.y2);
    if (e.type === 'circle') return TAU * e.r;
    if (e.type === 'arc') return e.r * G.arcSpan(e.a0, e.a1);
    if (e.type === 'polyline') {
      let L = 0; const n = e.pts.length, segs = e.closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const p = e.pts[i], q = e.pts[(i + 1) % n], c = G.dist(p.x, p.y, q.x, q.y);
        if (p.b) { const th = 4 * Math.atan(Math.abs(p.b)); L += c / (2 * Math.sin(th / 2)) * th; } else L += c;
      }
      return L;
    }
    return null;
  };

  G.loopArea = pts => {
    let A = 0; const n = pts.length;
    for (let i = 0; i < n; i++) {
      const p = pts[i], q = pts[(i + 1) % n];
      A += (p.x * q.y - q.x * p.y) / 2;
      if (p.b) {
        const th = 4 * Math.atan(Math.abs(p.b)), c = G.dist(p.x, p.y, q.x, q.y);
        const r = c / (2 * Math.sin(th / 2));
        A += Math.sign(p.b) * r * r / 2 * (th - Math.sin(th));
      }
    }
    return A;
  };

  G.area = e => {
    if (e.type === 'circle') return Math.PI * e.r * e.r;
    if (e.type === 'polyline' && e.closed) return Math.abs(G.loopArea(e.pts));
    if (e.type === 'hatch') {
      const a = e.loops.map(l => Math.abs(G.loopArea(l))).sort((x, y) => y - x);
      return a.length ? a[0] - a.slice(1).reduce((s, v) => s + v, 0) : 0;
    }
    return null;
  };

  global.Geo = G;
})(window);
