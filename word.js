// Informe de la visita en Word (.docx), editable, con el mismo formato que el PDF (pdf.js):
// título, datos de la visita en gris, línea negra, lista numerada de hallazgos con la severidad a la
// derecha y separadores grises, pendientes con su estado a la derecha y "Página N" al pie.

import { CATEGORIAS, SEVERIDADES } from './clasificador.js';

function titulo(lista, id) {
  const x = lista.find(e => e.id === id);
  return x ? x.titulo : '';
}
const fechaLarga = ms => new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'long', year: 'numeric' });
const hora = ms => new Date(ms).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
const fechaCorta = ms => new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' });

// Mismos colores que el PDF
const COLOR = {
  leve: '1D4ED8',
  grave: 'B45309',
  urgente: 'B42318',
  resuelto: '166534',
  gris: '5B6470',
  oscuro: '282828',
  separador: 'D9D9D9',
};
const FUENTE = 'Arial';             // el PDF usa Helvetica; Arial es su equivalente en Word
const pt = n => Math.round(n * 2);  // docx mide la letra en medios puntos

/** Foto reducida a JPEG, del mismo tamaño que en el PDF: hasta 140 pt de ancho y 90 de alto. */
async function fotoParaWord(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const escalaArchivo = Math.min(1, 900 / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escalaArchivo);
    c.height = Math.round(img.height * escalaArchivo);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const jpeg = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
    // Puntos → píxeles de Word (96 por pulgada = 1,333 por punto)
    const escala = Math.min(140 / img.width, 90 / img.height);
    const w = Math.round(img.width * escala * 1.333);
    const h = Math.round(img.height * escala * 1.333);
    return { data: await jpeg.arrayBuffer(), w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @returns {Promise<Blob>} documento .docx
 */
export async function generarWord({ visita, local, nuevos, resueltos, siguenAbiertos, blobDe }) {
  const d = window.docx;
  if (!d) throw new Error('No se cargó la librería de Word');
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, ImageRun,
    AlignmentType, BorderStyle, Footer, PageNumber, VerticalAlign, TableLayoutType,
  } = d;

  // Texto con el estilo del PDF
  const run = (text, { size = 11, bold = false, color = '000000', italics = false } = {}) =>
    new TextRun({ text: String(text ?? ''), size: pt(size), bold, color, italics, font: FUENTE });
  const parrafo = (text, opts = {}) => new Paragraph({
    spacing: { before: opts.antes ?? 0, after: opts.despues ?? 80, line: 260 },
    alignment: opts.alineacion,
    border: opts.borde,
    children: [run(text, opts)],
  });

  const sinBorde = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const separador = { style: BorderStyle.SINGLE, size: 4, color: COLOR.separador };
  const bordesCelda = { top: sinBorde, left: sinBorde, right: sinBorde, bottom: separador };
  const celda = (children, anchoPct) => new TableCell({
    width: { size: anchoPct, type: WidthType.PERCENTAGE },
    borders: bordesCelda,
    verticalAlign: VerticalAlign.TOP,
    margins: { top: 60, bottom: 100, left: 0, right: 80 },
    children: Array.isArray(children) ? children : [children],
  });
  const tabla = filas => new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    borders: { top: sinBorde, bottom: sinBorde, left: sinBorde, right: sinBorde, insideHorizontal: sinBorde, insideVertical: sinBorde },
    rows: filas,
  });

  const hijos = [];

  // Encabezado: igual que el PDF
  hijos.push(parrafo(`Inspección · ${local ? local.nombre : ''}`, { size: 20, bold: true, despues: 100 }));
  hijos.push(parrafo(`${fechaLarga(visita.inicio)} · ${hora(visita.inicio)}${visita.cierre ? ` a ${hora(visita.cierre)}` : ''}`, { color: COLOR.gris, despues: 40 }));
  if (local && local.direccion) hijos.push(parrafo(local.direccion, { color: COLOR.gris, despues: 40 }));
  hijos.push(parrafo(`${nuevos.length} hallazgos nuevos · ${resueltos.length} pendientes resueltos · ${siguenAbiertos.length} siguen abiertos`, {
    color: COLOR.gris,
    despues: 240,
    borde: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '000000', space: 8 } },
  }));

  // Hallazgos nuevos
  hijos.push(parrafo('HALLAZGOS NUEVOS', { size: 12, bold: true, antes: 120, despues: 120 }));
  if (nuevos.length === 0) {
    hijos.push(parrafo('Sin hallazgos en esta visita.', { color: COLOR.gris }));
  } else {
    const filas = [];
    for (let i = 0; i < nuevos.length; i++) {
      const h = nuevos[i];
      const contenido = [parrafo(h.descripcion || h.transcripcion || `Hallazgo ${h.orden}`, { bold: true, despues: 40 })];
      const meta = [titulo(CATEGORIAS, h.categoria), h.responsable ? `Responsable: ${h.responsable}` : ''].filter(Boolean).join(' · ');
      if (meta) contenido.push(parrafo(meta, { size: 9.5, color: COLOR.oscuro, despues: 40 }));
      if (h.transcripcion) contenido.push(parrafo(`“${h.transcripcion}”`, { size: 9.5, color: COLOR.gris, despues: 40 }));
      if (h.fotoId) {
        try {
          const b = await blobDe(h.fotoId);
          if (b) {
            const f = await fotoParaWord(b);
            contenido.push(new Paragraph({ spacing: { before: 40, after: 40 }, children: [new ImageRun({ type: 'jpg', data: f.data, transformation: { width: f.w, height: f.h } })] }));
          }
        } catch (_) { /* sin foto si falla */ }
      }
      filas.push(new TableRow({
        cantSplit: true,
        children: [
          celda(parrafo(String(i + 1), { bold: true, despues: 0 }), 5),
          celda(contenido, 80),
          celda(new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 0 },
            children: [run(titulo(SEVERIDADES, h.severidad), { size: 10, bold: true, color: COLOR[h.severidad] || '000000' })],
          }), 15),
        ],
      }));
    }
    hijos.push(tabla(filas));
  }

  // Pendientes de visitas anteriores
  hijos.push(parrafo('PENDIENTES DE VISITAS ANTERIORES', { size: 12, bold: true, antes: 360, despues: 120 }));
  if (resueltos.length === 0 && siguenAbiertos.length === 0) {
    hijos.push(parrafo('No había pendientes.', { color: COLOR.gris }));
  } else {
    const fila = (h, estado, color) => {
      const origen = (h.visita ? ` (${fechaCorta(h.visita.inicio)})` : '') + (h.responsable ? ` · ${h.responsable}` : '');
      return new TableRow({
        cantSplit: true,
        children: [
          celda(parrafo((h.descripcion || h.transcripcion || 'Hallazgo') + origen, { despues: 0 }), 80),
          celda(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 0 }, children: [run(estado, { size: 10, bold: true, color })] }), 20),
        ],
      });
    };
    hijos.push(tabla([
      ...resueltos.map(h => fila(h, 'Resuelto', COLOR.resuelto)),
      ...siguenAbiertos.map(h => fila(h, 'Sigue abierto', COLOR.urgente)),
    ]));
  }

  const pie = new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.RIGHT,
      children: [new TextRun({ children: ['Página ', PageNumber.CURRENT], size: pt(9), color: '969696', font: FUENTE })],
    })],
  });

  const doc = new Document({
    creator: 'Inspecciones',
    title: `Inspección ${local ? local.nombre : ''} ${fechaLarga(visita.inicio)}`,
    styles: { default: { document: { run: { font: FUENTE, size: pt(11) } } } },
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838 },                         // A4, como el PDF
          margin: { top: 880, bottom: 880, left: 880, right: 880, footer: 440 }, // 44 pt, como el PDF
        },
      },
      footers: { default: pie },
      children: hijos,
    }],
  });
  return Packer.toBlob(doc);
}
