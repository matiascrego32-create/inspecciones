// Informe PDF de una visita, generado en el teléfono con jsPDF.

import { CATEGORIAS, SEVERIDADES } from './clasificador.js';

const COLOR = {
  leve: [29, 78, 216],
  grave: [180, 83, 9],
  urgente: [180, 35, 24],
  resuelto: [22, 101, 52],
  gris: [91, 100, 112],
};

function titulo(lista, id) {
  const x = lista.find(e => e.id === id);
  return x ? x.titulo : '';
}

function fechaLarga(ms) {
  return new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'long', year: 'numeric' });
}
function hora(ms) {
  return new Date(ms).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
}
function fechaCorta(ms) {
  return new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' });
}

function blobADataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/** Redimensiona una imagen a un ancho máximo y la devuelve como dataURL JPEG, con sus dimensiones. */
async function miniatura(blob, anchoMax = 480) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const escala = Math.min(1, anchoMax / img.width);
    const c = document.createElement('canvas');
    c.width = Math.round(img.width * escala);
    c.height = Math.round(img.height * escala);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return { dataUrl: c.toDataURL('image/jpeg', 0.8), w: c.width, h: c.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {object} visita
 * @param {object} local
 * @param {object[]} nuevos  hallazgos de la visita (ordenados)
 * @param {object[]} resueltos  hallazgos de visitas anteriores resueltos en esta
 * @param {object[]} siguenAbiertos  hallazgos de visitas anteriores que siguen abiertos
 * @param {(id:string)=>Promise<Blob>} blobDe  para fotos
 * @returns {Promise<Blob>} PDF
 */
export async function generarInforme({ visita, local, nuevos, resueltos, siguenAbiertos, blobDe }) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 44;
  const ancho = W - M * 2;
  let y = M;
  let pagina = 1;

  const pie = () => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(150);
    doc.text(`Página ${pagina}`, W - M, H - M + 16, { align: 'right' });
    doc.setTextColor(0);
  };
  const asegurar = alto => {
    if (y + alto > H - M) {
      doc.addPage();
      pagina++;
      y = M;
      pie();
    }
  };
  const texto = (s, { size = 11, bold = false, color = [0, 0, 0], x = M, w = ancho } = {}) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lineas = doc.splitTextToSize(String(s || ''), w);
    const altoLinea = size * 1.25;
    asegurar(lineas.length * altoLinea + 4);
    doc.text(lineas, x, y + size);
    y += lineas.length * altoLinea + 4;
    doc.setTextColor(0);
  };
  const linea = (gris = false) => {
    asegurar(10);
    y += 4;
    doc.setDrawColor(gris ? 217 : 0);
    doc.setLineWidth(gris ? 0.5 : 0.8);
    doc.line(M, y, M + ancho, y);
    y += 8;
  };

  pie();

  // Encabezado
  texto(`Inspección · ${local ? local.nombre : ''}`, { size: 20, bold: true });
  const rango = `${fechaLarga(visita.inicio)} · ${hora(visita.inicio)}` + (visita.cierre ? ` a ${hora(visita.cierre)}` : '');
  texto(rango, { size: 11, color: COLOR.gris });
  if (local && local.direccion) texto(local.direccion, { size: 11, color: COLOR.gris });
  texto(`${nuevos.length} hallazgos nuevos · ${resueltos.length} pendientes resueltos · ${siguenAbiertos.length} siguen abiertos`, { size: 11, color: COLOR.gris });
  linea();

  // Hallazgos nuevos
  y += 6;
  texto('HALLAZGOS NUEVOS', { size: 12, bold: true });
  y += 2;
  if (nuevos.length === 0) texto('Sin hallazgos en esta visita.', { size: 11, color: COLOR.gris });

  for (let i = 0; i < nuevos.length; i++) {
    const h = nuevos[i];
    let foto = null;
    if (h.fotoId) {
      try { const b = await blobDe(h.fotoId); if (b) foto = await miniatura(b); } catch (_) {}
    }
    const altoFoto = foto ? Math.min(90, foto.h * (140 / foto.w)) : 0;
    asegurar(44 + altoFoto);
    const yInicio = y;
    // Número
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(0);
    doc.text(String(i + 1), M, y + 11);
    // Severidad a la derecha
    if (h.severidad) {
      doc.setFontSize(10);
      doc.setTextColor(...(COLOR[h.severidad] || [0, 0, 0]));
      doc.text(titulo(SEVERIDADES, h.severidad), M + ancho, y + 11, { align: 'right' });
      doc.setTextColor(0);
    }
    const xTexto = M + 24;
    const wTexto = ancho - 24 - 70;
    y = yInicio;
    texto(h.descripcion || h.transcripcion || `Hallazgo ${h.orden}`, { size: 11, bold: true, x: xTexto, w: wTexto });
    const meta = [titulo(CATEGORIAS, h.categoria), h.responsable ? `Responsable: ${h.responsable}` : ''].filter(Boolean).join(' · ');
    if (meta) texto(meta, { size: 9.5, color: [40, 40, 40], x: xTexto, w: wTexto });
    if (h.transcripcion) texto(`“${h.transcripcion}”`, { size: 9.5, color: COLOR.gris, x: xTexto, w: wTexto });
    if (foto) {
      const w = Math.min(140, foto.w);
      const hImg = foto.h * (w / foto.w);
      asegurar(hImg + 6);
      doc.addImage(foto.dataUrl, 'JPEG', xTexto, y, w, hImg);
      y += hImg + 6;
    }
    linea(true);
  }

  // Pendientes verificados
  y += 10;
  texto('PENDIENTES DE VISITAS ANTERIORES', { size: 12, bold: true });
  y += 2;
  if (resueltos.length === 0 && siguenAbiertos.length === 0) texto('No había pendientes.', { size: 11, color: COLOR.gris });
  const fila = (h, estado, color) => {
    asegurar(22);
    const yInicio = y;
    const origen = (h.visita ? ` (${fechaCorta(h.visita.inicio)})` : '') + (h.responsable ? ` · ${h.responsable}` : '');
    texto((h.descripcion || h.transcripcion || 'Hallazgo') + origen, { size: 11, w: ancho - 90 });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...color);
    doc.text(estado, M + ancho, yInicio + 11, { align: 'right' });
    doc.setTextColor(0);
  };
  for (const h of resueltos) fila(h, 'Resuelto', COLOR.resuelto);
  for (const h of siguenAbiertos) fila(h, 'Sigue abierto', COLOR.urgente);

  return doc.output('blob');
}

export { blobADataUrl };
