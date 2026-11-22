/*
 * Apertura de archivos DWG (AutoCAD R14 a 2018 y posteriores) en el navegador.
 *
 * Usa LibreDWG compilado a WebAssembly (@mlightcad/libredwg-web, licencia GPL-3.0), que se descarga
 * bajo demanda la primera vez que se abre un DWG. La base de datos leída se traduce a DXF para que la
 * interprete el mismo lector que los archivos DXF (capas, bloques, cotas, sombreados...).
 */
(function (global) {
  'use strict';
  const VERSION = '0.8.7';
  const URL_LIB = `https://cdn.jsdelivr.net/npm/@mlightcad/libredwg-web@${VERSION}/dist/libredwg-web.js`;
  const R2D = 180 / Math.PI;
  let libPromise = null;

  function loadLib() {
    if (!libPromise) {
      libPromise = import(URL_LIB)
        .then(m => m.LibreDwg.create().then(lib => ({ lib, types: m.Dwg_File_Type })))
        .catch(err => { libPromise = null; throw new Error('no se pudo descargar el lector de DWG (¿sin conexión?): ' + (err && err.message)); });
    }
    return libPromise;
  }

  const isDwg = bytes => bytes.length > 6 && String.fromCharCode(...bytes.slice(0, 4)) === 'AC10' && /^AC10\d\d/.test(String.fromCharCode(...bytes.slice(0, 6)));

  /** Traduce la base de datos de libredwg-web a texto DXF. */
  function toDxf(db) {
    const o = [];
    const clean = v => String(v == null ? '' : v).replace(/\r?\n/g, ' ');
    const p = (c, v) => { o.push(String(c), clean(v)); };
    const n = v => (Number.isFinite(+v) ? String(+v) : '0');
    const pt = (c, P) => { p(c, n(P && P.x)); p(c + 10, n(P && P.y)); };
    const deg = a => n((+a || 0) * R2D);
    const skipped = new Set(['VIEWPORT', 'XLINE', 'RAY', '3DSOLID', 'REGION', 'BODY', 'WIPEOUT', 'IMAGE', 'OLE2FRAME', 'OLEFRAME', 'ACAD_TABLE', 'PROXY', 'SECTION']);

    const common = (type, e) => {
      p(0, type);
      p(8, e.layer || '0');
      if (e.colorIndex != null && e.colorIndex !== 256) p(62, e.colorIndex);
      else if (e.colorIndex == null && Number.isFinite(e.color)) p(420, e.color);
      if (e.isVisible === false) p(60, 1);
      if (e.extrusionDirection && e.extrusionDirection.z < 0) { p(210, 0); p(220, 0); p(230, -1); }
    };
    const textBase = (t, isAttrib) => {
      pt(10, t.startPoint);
      p(40, n(t.textHeight || 1));
      p(1, t.text);
      if (t.rotation) p(50, deg(t.rotation));
      if (t.halign) p(72, t.halign);
      if (t.halign || t.valign) pt(11, t.endPoint);
      if (t.valign) p(isAttrib ? 74 : 73, t.valign);
    };
    const verts = (list, closed) => {
      const vs = (list || []).filter(v => !((v.flag || 0) & 16));
      p(90, vs.length); p(70, closed ? 1 : 0);
      vs.forEach(v => { pt(10, v); if (v.bulge) p(42, n(v.bulge)); });
    };

    function entity(e) {
      switch (e.type) {
        case 'LINE': common('LINE', e); pt(10, e.startPoint); pt(11, e.endPoint); break;
        case 'POINT': common('POINT', e); pt(10, e.position); break;
        case 'CIRCLE': common('CIRCLE', e); pt(10, e.center); p(40, n(e.radius)); break;
        case 'ARC': common('ARC', e); pt(10, e.center); p(40, n(e.radius)); p(50, deg(e.startAngle)); p(51, deg(e.endAngle)); break;
        case 'LWPOLYLINE': common('LWPOLYLINE', e); verts(e.vertices, (e.flag || 0) & 1); break;
        case 'POLYLINE2D': case 'POLYLINE3D':
          if ((e.flag || 0) & (16 | 64)) { p(0, 'POLYLINE'); p(8, e.layer || '0'); p(70, e.flag); p(0, 'SEQEND'); break; }
          common('LWPOLYLINE', e); verts(e.vertices, (e.flag || 0) & 1); break;
        case 'ELLIPSE':
          common('ELLIPSE', e); pt(10, e.center); pt(11, e.majorAxisEndPoint); p(40, n(e.axisRatio)); p(41, n(e.startAngle)); p(42, n(e.endAngle)); break;
        case 'SPLINE':
          common('SPLINE', e); p(70, e.flag || 0); p(71, e.degree || 3);
          (e.knots || []).forEach(k => p(40, n(k)));
          (e.weights || []).forEach(w => p(41, n(w)));
          (e.controlPoints || []).forEach(c => pt(10, c));
          (e.fitPoints || []).forEach(c => pt(11, c));
          break;
        case 'TEXT': common('TEXT', e); textBase(e, false); break;
        case 'MTEXT': {
          common('MTEXT', e); pt(10, e.insertionPoint); p(40, n(e.textHeight || 1)); p(71, e.attachmentPoint || 1);
          const d = e.direction;
          if (d && (d.x || d.y)) pt(11, d); else if (e.rotation) p(50, deg(e.rotation));
          p(1, String(e.text || '').replace(/\r?\n/g, '\\P'));
          break;
        }
        case 'INSERT': {
          common('INSERT', e); p(2, e.name); pt(10, e.insertionPoint);
          p(41, n(e.xScale == null ? 1 : e.xScale)); p(42, n(e.yScale == null ? 1 : e.yScale));
          if (e.rotation) p(50, deg(e.rotation));
          if (e.columnCount > 1) { p(70, e.columnCount); p(44, n(e.columnSpacing)); }
          if (e.rowCount > 1) { p(71, e.rowCount); p(45, n(e.rowSpacing)); }
          const at = (e.attribs || []).filter(a => a && a.text);
          if (at.length) {
            p(66, 1);
            at.forEach(a => { common('ATTRIB', a); textBase(a.text, true); p(2, a.tag || ''); p(70, a.flags || 0); });
            p(0, 'SEQEND'); p(8, e.layer || '0');
          }
          break;
        }
        case 'DIMENSION':
          common('DIMENSION', e); p(2, e.name || ''); pt(10, e.definitionPoint); pt(13, e.subDefinitionPoint1); pt(14, e.subDefinitionPoint2);
          p(70, e.dimensionType || 0); if (e.text) p(1, e.text);
          break;
        case 'SOLID': case 'TRACE': case '3DFACE':
          common(e.type, e);
          pt(10, e.corner1); pt(11, e.corner2); pt(12, e.corner3); pt(13, e.corner4 || e.corner3);
          break;
        case 'HATCH': {
          common('HATCH', e); p(2, e.patternName || ''); p(70, e.solidFill ? 1 : 0); p(71, 0);
          const paths = e.boundaryPaths || [];
          p(91, paths.length);
          paths.forEach(bp => {
            const flag = bp.boundaryPathTypeFlag || 0;
            p(92, flag);
            if (flag & 2) {
              const vs = bp.vertices || [];
              p(72, bp.hasBulge ? 1 : 0); p(73, bp.isClosed ? 1 : 0); p(93, vs.length);
              vs.forEach(v => { pt(10, v); if (bp.hasBulge) p(42, n(v.bulge)); });
            } else {
              const ed = bp.edges || [];
              p(93, ed.length);
              ed.forEach(g => {
                p(72, g.type);
                const ccw = g.isCCW === false ? 0 : 1;
                if (g.type === 1) { pt(10, g.start); pt(11, g.end); }
                else if (g.type === 2) { pt(10, g.center); p(40, n(g.radius)); p(50, deg(g.startAngle)); p(51, deg(g.endAngle)); p(73, ccw); }
                else if (g.type === 3) { pt(10, g.center); pt(11, g.end); p(40, n(g.lengthOfMinorAxis)); p(50, deg(g.startAngle)); p(51, deg(g.endAngle)); p(73, ccw); }
                else if (g.type === 4) {
                  const k = g.knots || [], c = g.controlPoints || [];
                  p(94, g.degree || 3); p(73, 0); p(74, g.isPeriodic ? 1 : 0); p(95, k.length); p(96, c.length);
                  k.forEach(v => p(40, n(v))); c.forEach(v => pt(10, v));
                }
              });
            }
            p(97, 0);
          });
          break;
        }
        default:
          if (!skipped.has(e.type)) { p(0, e.type || 'DESCONOCIDO'); p(8, e.layer || '0'); }
      }
    }

    const brs = (db.tables && db.tables.BLOCK_RECORD && db.tables.BLOCK_RECORD.entries) || [];
    const model = brs.find(b => /^\*model_space$/i.test(b.name));
    const modelEnts = model && model.entities ? model.entities
      : (db.entities || []).filter(e => !e.isInPaperSpace && (!model || e.ownerBlockRecordSoftId === model.handle));

    p(0, 'SECTION'); p(2, 'HEADER');
    p(9, '$INSUNITS'); p(70, (db.header && db.header.INSUNITS) || 0);
    p(0, 'ENDSEC');

    p(0, 'SECTION'); p(2, 'TABLES'); p(0, 'TABLE'); p(2, 'LAYER');
    ((db.tables && db.tables.LAYER && db.tables.LAYER.entries) || []).forEach(L => {
      const ci = Math.abs(L.colorIndex || 7) || 7;
      // El indicador "locked" de libredwg-web no es fiable (marca todas las capas): se abren desbloqueadas.
      p(0, 'LAYER'); p(2, L.name); p(70, L.frozen ? 1 : 0); p(62, L.off ? -ci : ci);
    });
    p(0, 'ENDTAB'); p(0, 'ENDSEC');

    p(0, 'SECTION'); p(2, 'BLOCKS');
    brs.forEach(b => {
      if (/^\*(model|paper)_space/i.test(b.name)) return;
      p(0, 'BLOCK'); p(2, b.name); pt(10, b.basePoint);
      (b.entities || []).forEach(entity);
      p(0, 'ENDBLK');
    });
    p(0, 'ENDSEC');

    p(0, 'SECTION'); p(2, 'ENTITIES');
    modelEnts.forEach(entity);
    p(0, 'ENDSEC'); p(0, 'EOF');
    return o.join('\n');
  }

  /** Lee un DWG (ArrayBuffer) y devuelve su contenido como texto DXF. */
  async function readAsDxf(buffer) {
    const { lib, types } = await loadLib();
    let data;
    try { data = lib.dwg_read_data(buffer, types.DWG); }
    catch (e) { throw new Error('el archivo DWG está dañado o su versión no es compatible'); }
    if (!data) throw new Error('el archivo DWG está dañado o su versión no es compatible');
    try { return toDxf(lib.convert(data)); }
    finally { try { lib.dwg_free(data); } catch (e) { /* ya liberado */ } }
  }

  global.DWG = { readAsDxf, toDxf, isDwg, loadLib };
})(window);
