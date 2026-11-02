// Informe de la visita en Word (.docx), editable. Generado en el teléfono con la librería docx (lib/docx.iife.js).
// Mismo contenido que el PDF: encabezado, tabla de hallazgos nuevos (con responsable y fotos) y pendientes.

import { CATEGORIAS, SEVERIDADES } from './clasificador.js';

function titulo(lista, id) {
  const x = lista.find(e => e.id === id);
  return x ? x.titulo : '';
}
const fechaLarga = ms => new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'long', year: 'numeric' });
const hora = ms => new Date(ms).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
const fechaCorta = ms => new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' });

const COLOR_SEV = { leve: '1D4ED8', grave: 'B45309', urgente: 'B42318' };
const GRIS = '5B6470';

/** Foto reducida a JPEG para el documento: { data: ArrayBuffer, w, h } en píxeles de pantalla. */
async function fotoParaWord(blob, anchoMax = 220) {
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
    const w = Math.min(anchoMax, img.width);
    const h = Math.round(img.height * (w / img.width));
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
    Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell,
    WidthType, ImageRun, AlignmentType, ShadingType, BorderStyle,
  } = d;

  const p = (text, opts = {}) => new Paragraph({
    spacing: { after: opts.after ?? 60 },
    alignment: opts.align,
    children: [new TextRun({ text: String(text ?? ''), bold: opts.bold, color: opts.color, size: opts.size, italics: opts.italics })],
  });

  const borde = { style: BorderStyle.SINGLE, size: 4, color: 'D1D5DB' };
  const bordes = { top: borde, bottom: borde, left: borde, right: borde };
  const celdaEnc = (text, ancho) => new TableCell({
    width: { size: ancho, type: WidthType.PERCENTAGE },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'EEF0F3' },
    borders: bordes,
    children: [p(text, { bold: true, size: 18, after: 0 })],
  });
  const celda = (children, ancho) => new TableCell({
    width: { size: ancho, type: WidthType.PERCENTAGE },
    borders: bordes,
    children: Array.isArray(children) ? children : [children],
  });

  const hijos = [];

  // Encabezado
  hijos.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { after: 80 }, children: [new TextRun({ text: `Inspección · ${local ? local.nombre : ''}`, bold: true })] }));
  hijos.push(p(`${fechaLarga(visita.inicio)} · ${hora(visita.inicio)}${visita.cierre ? ` a ${hora(visita.cierre)}` : ''}`, { color: GRIS, size: 20 }));
  if (local && local.direccion) hijos.push(p(local.direccion, { color: GRIS, size: 20 }));
  hijos.push(p(`${nuevos.length} hallazgos nuevos · ${resueltos.length} pendientes resueltos · ${siguenAbiertos.length} siguen abiertos`, { color: GRIS, size: 20, after: 240 }));

  // Hallazgos nuevos: tabla
  hijos.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 120, after: 120 }, children: [new TextRun({ text: 'Hallazgos nuevos', bold: true })] }));
  if (nuevos.length === 0) {
    hijos.push(p('Sin hallazgos en esta visita.', { color: GRIS }));
  } else {
    const filas = [new TableRow({
      tableHeader: true,
      children: [celdaEnc('#', 5), celdaEnc('Hallazgo', 42), celdaEnc('Categoría', 18), celdaEnc('Severidad', 12), celdaEnc('Responsable', 23)],
    })];
    for (let i = 0; i < nuevos.length; i++) {
      const h = nuevos[i];
      const contenido = [p(h.descripcion || h.transcripcion || `Hallazgo ${h.orden}`, { bold: true, after: 40 })];
      if (h.transcripcion) contenido.push(p(`“${h.transcripcion}”`, { italics: true, color: GRIS, size: 18, after: 40 }));
      if (h.fotoId) {
        try {
          const b = await blobDe(h.fotoId);
          if (b) {
            const f = await fotoParaWord(b);
            contenido.push(new Paragraph({ spacing: { after: 40 }, children: [new ImageRun({ type: 'jpg', data: f.data, transformation: { width: f.w, height: f.h } })] }));
          }
        } catch (_) { /* sin foto si falla */ }
      }
      filas.push(new TableRow({
        cantSplit: true,
        children: [
          celda(p(String(i + 1), { bold: true, after: 0 }), 5),
          celda(contenido, 42),
          celda(p(titulo(CATEGORIAS, h.categoria) || '—', { after: 0, size: 20 }), 18),
          celda(p(titulo(SEVERIDADES, h.severidad) || '—', { after: 0, bold: true, size: 20, color: COLOR_SEV[h.severidad] }), 12),
          celda(p(h.responsable || '—', { after: 0, size: 20 }), 23),
        ],
      }));
    }
    hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: filas }));
  }

  // Pendientes de visitas anteriores
  hijos.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 360, after: 120 }, children: [new TextRun({ text: 'Pendientes de visitas anteriores', bold: true })] }));
  if (resueltos.length === 0 && siguenAbiertos.length === 0) {
    hijos.push(p('No había pendientes.', { color: GRIS }));
  } else {
    const filas = [new TableRow({
      tableHeader: true,
      children: [celdaEnc('Hallazgo', 50), celdaEnc('Desde', 14), celdaEnc('Responsable', 20), celdaEnc('Estado', 16)],
    })];
    const fila = (h, estado, color) => new TableRow({
      cantSplit: true,
      children: [
        celda(p(h.descripcion || h.transcripcion || 'Hallazgo', { after: 0 }), 50),
        celda(p(h.visita ? fechaCorta(h.visita.inicio) : '—', { after: 0, size: 20 }), 18),
        celda(p(h.responsable || '—', { after: 0, size: 20 }), 20),
        celda(p(estado, { after: 0, bold: true, size: 20, color }), 16),
      ],
    });
    for (const h of resueltos) filas.push(fila(h, 'Resuelto', '166534'));
    for (const h of siguenAbiertos) filas.push(fila(h, 'Sigue abierto', 'B42318'));
    hijos.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: filas }));
  }

  hijos.push(p('', { after: 240 }));
  hijos.push(p('Observaciones:', { bold: true }));
  hijos.push(p(''));

  const doc = new Document({
    creator: 'Inspecciones',
    title: `Inspección ${local ? local.nombre : ''} ${fechaLarga(visita.inicio)}`,
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } },
      children: hijos,
    }],
  });
  return Packer.toBlob(doc);
}
