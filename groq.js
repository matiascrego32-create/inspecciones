// Transcripción con Whisper large-v3 en Groq (nivel gratuito), a través del intermediario (Cloudflare Worker)
// que guarda la clave. La app manda el audio tal cual lo grabó Safari (mp4/webm); no hace falta convertirlo.

export const MODELOS_GROQ = {
  'whisper-large-v3': { titulo: 'Whisper large-v3', detalle: 'El más preciso. Unos 2 segundos por audio.' },
  'whisper-large-v3-turbo': { titulo: 'Whisper large-v3-turbo', detalle: 'Casi igual de preciso, más rápido.' },
};
export const MODELO_GROQ_POR_DEFECTO = 'whisper-large-v3';

export class ErrorTranscripcion extends Error {
  constructor(tipo, mensaje, extra = {}) {
    super(mensaje);
    this.tipo = tipo;       // 'red' | 'config' | 'clave' | 'limite' | 'tamano' | 'servidor' | 'otro'
    Object.assign(this, extra);
  }
  /** ¿Conviene reintentar solo más tarde (sin marcar el hallazgo en error)? */
  get transitorio() { return this.tipo === 'red' || this.tipo === 'limite' || this.tipo === 'servidor'; }
}

function nombreArchivo(mime) {
  const m = (mime || '').toLowerCase();
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'audio.m4a';
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  return 'audio.m4a';
}

/**
 * @param {object} o
 * @param {Blob} o.blob            audio grabado
 * @param {string} o.url           dirección del intermediario (o de Groq directo)
 * @param {string} [o.codigo]      código de acceso del intermediario, si lo configuraste
 * @param {string} [o.apiKey]      clave de Groq, solo si se llama a Groq directo (no recomendado)
 * @param {string} [o.modelo]      whisper-large-v3 | whisper-large-v3-turbo
 * @param {string} [o.prompt]      términos (nombres de locales, vocabulario) para orientar la transcripción
 * @returns {Promise<string>} texto
 */
export async function transcribirRemoto({ blob, url, codigo, apiKey, modelo = MODELO_GROQ_POR_DEFECTO, prompt = '' }) {
  if (!url) throw new ErrorTranscripcion('config', 'Falta configurar la dirección del servicio de transcripción en Ajustes.');
  if (navigator.onLine === false) throw new ErrorTranscripcion('red', 'Sin conexión. Se transcribe cuando vuelva la señal.');
  if (blob.size > 25 * 1024 * 1024) throw new ErrorTranscripcion('tamano', 'El audio supera los 25 MB que acepta el servicio.');

  const form = new FormData();
  form.append('file', blob, nombreArchivo(blob.type));
  form.append('model', modelo);
  form.append('language', 'es');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const p = (prompt || '').trim();
  if (p) form.append('prompt', p.slice(0, 600));

  const headers = {};
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
  if (codigo) headers['X-App-Code'] = codigo;

  let resp;
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), 90000);
  try {
    resp = await fetch(url, { method: 'POST', headers, body: form, signal: control.signal });
  } catch (e) {
    clearTimeout(timeout);
    if (e && e.name === 'AbortError') throw new ErrorTranscripcion('red', 'El servicio tardó demasiado en responder. Se reintenta.');
    // Error de red o CORS: el navegador no deja ver cuál.
    throw new ErrorTranscripcion('red', navigator.onLine === false
      ? 'Sin conexión. Se transcribe cuando vuelva la señal.'
      : 'No se pudo conectar con el servicio de transcripción. Si tenés señal, revisá la dirección en Ajustes.');
  }
  clearTimeout(timeout);

  if (!resp.ok) {
    let detalle = '';
    try { const j = await resp.json(); detalle = (j && j.error && (j.error.message || j.error)) || JSON.stringify(j); } catch (_) { try { detalle = await resp.text(); } catch (_2) {} }
    detalle = String(detalle || '').slice(0, 200);
    if (resp.status === 401 || resp.status === 403) throw new ErrorTranscripcion('clave', `El servicio rechazó el acceso (${resp.status}). Revisá la clave o el código de acceso en Ajustes. ${detalle}`.trim());
    if (resp.status === 429) {
      const ra = parseInt(resp.headers.get('retry-after') || '', 10);
      throw new ErrorTranscripcion('limite', 'Límite del nivel gratuito alcanzado por ahora. Se reintenta más tarde.', { esperarSegundos: isNaN(ra) ? 300 : Math.max(10, ra) });
    }
    if (resp.status === 413) throw new ErrorTranscripcion('tamano', 'El audio es demasiado grande para el servicio.');
    if (resp.status >= 500) throw new ErrorTranscripcion('servidor', `El servicio no está disponible (${resp.status}). Se reintenta.`);
    throw new ErrorTranscripcion('otro', `El servicio devolvió un error ${resp.status}. ${detalle}`.trim());
  }

  let datos;
  try { datos = await resp.json(); } catch (_) { throw new ErrorTranscripcion('otro', 'La respuesta del servicio no se pudo leer.'); }
  return String(datos && datos.text ? datos.text : '').trim();
}

/** Audio WAV de un segundo en silencio, para probar la conexión sin gastar casi nada. */
export function wavDePrueba() {
  const tasa = 16000, muestras = tasa;
  const buf = new ArrayBuffer(44 + muestras * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + muestras * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, tasa, true);
  v.setUint32(28, tasa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, muestras * 2, true);
  // Un tono muy bajo para que no sea silencio absoluto (algunos servicios lo rechazan).
  for (let i = 0; i < muestras; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 300), true);
  return new Blob([buf], { type: 'audio/wav' });
}
