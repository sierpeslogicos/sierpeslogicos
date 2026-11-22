# Sierpes CAD

Editor CAD 2D en el navegador para **abrir planos, modificarlos y volver a guardarlos en DXF**.
No necesita instalación, servidor ni conexión (salvo para abrir PDF): basta con abrir `index.html`.

## Cómo usarlo

1. Abra `cad/index.html` en Chrome, Edge o Firefox (doble clic o arrastrándolo al navegador).
   También se puede publicar tal cual con GitHub Pages o en cualquier servidor web.
2. Pulse **Abrir…** o arrastre un archivo sobre el lienzo:
   - **DXF** (R12 a 2018, ASCII): se abre como dibujo editable.
   - **PDF** o **imagen** (PNG, JPG…): se coloca como plantilla de fondo para calcar.
     Use **Calibrar escala** con una medida conocida para ponerla a escala real.
3. Modifique y guarde con **Guardar DXF** (Ctrl+S).

Hay un plano de ejemplo en `ejemplos/vivienda-ejemplo.dxf` (también accesible con el botón *Ver plano de ejemplo*).

> **DWG:** es un formato cerrado de Autodesk y no puede leerse directamente en el navegador.
> Guárdelo como DXF desde su programa CAD o conviértalo con el conversor gratuito *ODA File Converter*.

## Funciones

| Área | Qué incluye |
|---|---|
| Abrir | DXF con capas, colores, bloques (incluidos girados, escalados, simétricos y en matriz), atributos, líneas, polilíneas con arcos, círculos, arcos, elipses, splines, textos, MTEXT, cotas, sólidos y sombreados sólidos. PDF e imágenes como plantilla. |
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
- Los sombreados con patrón no se dibujan (los sólidos sí); al abrir el archivo se indica cuántos objetos se han omitido.
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
├── js/app.js           editor: vista, herramientas, paneles, archivos
├── js/sample.js        plano de ejemplo incrustado
└── ejemplos/           planos de ejemplo
```

Sin dependencias ni compilación. Para abrir PDF se descarga bajo demanda [pdf.js](https://mozilla.github.io/pdf.js/) desde cdnjs.
