/* Tabla de colores AutoCAD (ACI) y utilidades de color. */
(function (global) {
  'use strict';
  const ACI = new Array(256);
  const base = {
    0: [0, 0, 0], 1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255],
    5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192]
  };
  Object.keys(base).forEach(k => { ACI[k] = base[k]; });

  function hsv(h, s, v) {
    const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  const vals = [1, 0.8, 0.6, 0.5, 0.3];
  for (let i = 10; i < 250; i++) {
    const hue = (Math.floor(i / 10) - 1) * 15;
    const sub = i % 10;
    ACI[i] = hsv(hue, sub % 2 ? 0.5 : 1, vals[Math.floor(sub / 2)]);
  }
  [51, 80, 105, 130, 190, 255].forEach((g, k) => { ACI[250 + k] = [g, g, g]; });

  const toHex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  const HEX = ACI.map(toHex);

  function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  global.Colors = {
    /** Color hex de un índice ACI. El 7 es blanco sobre fondo oscuro y negro sobre claro. */
    aciHex(aci, darkBg) {
      if (aci === 7 || aci === 0 || aci == null || aci < 0 || aci > 255) return darkBg ? '#ffffff' : '#000000';
      return HEX[aci];
    },
    /** Índice ACI más próximo a un color hex. */
    nearestAci(hex) {
      const [r, g, b] = hexToRgb(hex);
      let best = 7, bd = Infinity;
      for (let i = 1; i < 256; i++) {
        const c = ACI[i];
        const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    },
    /** Multiplica la luminosidad de un color por f (limitado a 0..255). */
    mix(hex, f) {
      return toHex(hexToRgb(hex).map(v => Math.max(0, Math.min(255, Math.round(v * f)))));
    },
    trueColorHex(n) { return '#' + (n & 0xffffff).toString(16).padStart(6, '0'); },
    hexToRgb
  };
})(window);
