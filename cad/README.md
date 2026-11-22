# Sierpes CAD

Editor CAD 2D en el navegador para **abrir planos DWG o DXF, modificarlos y volver a guardarlos en DXF**.
No necesita instalación ni servidor: basta con abrir `index.html` (abrir DWG o PDF requiere conexión la primera vez, para descargar el lector).

## Cómo usarlo

1. Abra `cad/index.html` en Chrome, Edge o Firefox (doble clic o arrastrándolo al navegador).
   También se puede publicar tal cual con GitHub Pages o en cualquier servidor web.
2. Pulse **Abrir…** o arrastre un archivo sobre el lienzo:
   - **DWG** (AutoCAD R14 a 2018 y posteriores) y **DXF** (R12 a 2018, ASCII): se abren como dibujo editable.
   - **PDF** o **imagen** (PNG, JPG…): se coloca como plantilla de fondo para calcar.
     Use **Calibrar escala** con una medida conocida para ponerla a escala real.
3. Modifique y guarde con **Guardar DXF** (Ctrl+S).

Hay un plano de ejemplo en `ejemplos/vivienda-ejemplo.dxf` (también accesible con el botón *Ver plano de ejemplo*).

> **DWG:** se lee con [LibreDWG](https://www.gnu.org/software/libredwg/) compilado a WebAssembly
> ([@mlightcad/libredwg-web](https://www.npmjs.com/package/@mlightcad/libredwg-web)), que se descarga de jsDelivr
> (unos MB) la primera vez que se abre un DWG. Los cambios se guardan en **DXF**: AutoCAD lo abre directamente y
> puede volver a guardarlo como DWG. LibreDWG tiene licencia **GPL-3.0**; téngalo en cuenta si redistribuye la aplicación.

## Funciones

| Área | Qué incluye |
|---|---|
| Abrir | DWG y DXF con capas, colores, bloques (incluidos girados, escalados, simétricos y en matriz), atributos, líneas, polilíneas con arcos, círculos, arcos, elipses, splines, textos, MTEXT, cotas, sólidos y sombreados sólidos. PDF e imágenes como plantilla. |
| Dibujar | Línea, polilínea, rectángulo, círculo, arco por 3 puntos, texto, cota alineada. |
| Modificar | Desplazar, copiar, girar, escalar, simetría, desfase (equidistancia), borrar, descomponer bloques, pinzamientos (arrastrar puntos), edición numérica en el panel de propiedades. |
| Precisión | Referencias a objetos (punto final, medio, centro, cuadrante, intersección), modo ortogonal, entrada de coordenadas absolutas `100,50`, relativas `@100,0`, polares `@250<45` y distancia directa. |
| Consultar | Medir distancias y ángulos; longitud y área de los objetos seleccionados. |
| Capas | Mostrar/ocultar, bloquear, color, renombrar (doble clic), capa actual, borrar capas vacías (clic derecho). |
| Guardar | DXF R12 (el más compatible: AutoCAD, BricsCAD, LibreCAD, QCAD, DraftSight…), SVG, PNG e impresión/PDF. |
| Otros | Deshacer/rehacer, fondo claro u oscuro, uso táctil (pellizcar para zoom). |

Los comandos se pueden escribir en la barra inferior con nombres en español o los alias habituales de AutoCAD
(`L`, `PL`, `C`, `M`, `CO`, `RO`, `MI`, `O`…). Pulse **F1** o *Ayuda* para ver la lista completa.

## Limitaciones conocidas

- Se trabaja en 2D (la coordenada Z se ignora). Las mallas 3D no se muestran.
- Los sombreados con patrón no se dibujan (los sólidos sí), ni las multilíneas, directrices múltiples, tablas o tolerancias; al abrir el archivo se indica cuántos objetos se han omitido.
- No se guarda en DWG (la versión web de LibreDWG no incluye escritura DWG): se guarda en DXF.
- En los DWG, el bloqueo de capas no se conserva (se abren todas desbloqueadas).
- Al guardar, los bloques quedan descompuestos en sus piezas (siguen agrupados mientras se edita) y las cotas se guardan como líneas, flechas y texto.
- Los nombres de capa se guardan en mayúsculas y sin acentos, por compatibilidad con el formato R12.
- Todavía no hay recortar/alargar ni empalme.

## Estructura

```
cad/
├── index.html          interfaz
├── styles.css          estilos (tema claro y oscuro)
├── js/aci.js           colores de AutoCAD (ACI)
├── js/geometry.js      geometría, transformaciones, medidas
├── js/dxf-parser.js    lector DXF
├── js/dxf-writer.js    escritor DXF R12
├── js/dwg.js           lectura de DWG (LibreDWG en WebAssembly, bajo demanda)
├── js/app.js           editor: vista, herramientas, paneles, archivos
├── js/sample.js        plano de ejemplo incrustado
└── ejemplos/           planos de ejemplo
```

Sin dependencias ni compilación. Se descargan bajo demanda: [pdf.js](https://mozilla.github.io/pdf.js/) (cdnjs) al abrir un PDF y LibreDWG (jsDelivr) al abrir un DWG.
