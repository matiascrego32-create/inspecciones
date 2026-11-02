// Worker de transcripción: corre Whisper en el teléfono con Transformers.js.
// La interfaz no se traba mientras se transcribe.

// Versión fija: una actualización del CDN no puede cambiar el comportamiento de la app.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.min.js';
import { MODELOS } from './modelos.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let transcriptor = null;
let modeloCargado = null;   // clave de MODELOS
let dispositivo = null;     // 'webgpu' | 'wasm'
let cargando = null;        // Promise en curso

function enviar(msg) { self.postMessage(msg); }

async function hayWebGPU() {
  try {
    if (!('gpu' in navigator)) return false;
    const adaptador = await navigator.gpu.requestAdapter();
    return !!adaptador;
  } catch (_) {
    return false;
  }
}

async function cargar(clave) {
  if (transcriptor && modeloCargado === clave) {
    enviar({ type: 'ready', modelo: clave, dispositivo });
    return;
  }
  const def = MODELOS[clave];
  if (!def) throw new Error('Modelo desconocido: ' + clave);

  // Libera el anterior antes de cargar otro (memoria).
  if (transcriptor) {
    try { await transcriptor.dispose(); } catch (_) {}
    transcriptor = null;
    modeloCargado = null;
  }

  const intentos = [];
  if (await hayWebGPU()) intentos.push({ device: 'webgpu', dtype: def.dtype.webgpu });
  intentos.push({ device: 'wasm', dtype: def.dtype.wasm });

  let ultimoError = null;
  for (const intento of intentos) {
    try {
      enviar({ type: 'estado', texto: `Cargando ${def.titulo} (${intento.device})…` });
      transcriptor = await pipeline('automatic-speech-recognition', def.id, {
        device: intento.device,
        dtype: intento.dtype,
        progress_callback: p => {
          if (p && (p.status === 'progress' || p.status === 'download' || p.status === 'done')) {
            enviar({ type: 'progress', file: p.file, progress: p.progress, loaded: p.loaded, total: p.total, status: p.status });
          }
        },
      });
      modeloCargado = clave;
      dispositivo = intento.device;
      enviar({ type: 'ready', modelo: clave, dispositivo });
      return;
    } catch (e) {
      ultimoError = e;
      transcriptor = null;
      enviar({ type: 'estado', texto: `No cargó con ${intento.device}: ${e && e.message ? e.message : e}` });
    }
  }
  throw ultimoError || new Error('No se pudo cargar el modelo');
}

async function transcribir(id, audio) {
  if (!transcriptor) throw new Error('El modelo no está cargado');
  const salida = await transcriptor(audio, {
    language: 'spanish',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: false,
  });
  const texto = (salida && salida.text ? salida.text : '').trim();
  return texto;
}

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (m.type === 'load') {
      if (cargando) await cargando;
      cargando = cargar(m.modelo);
      await cargando;
      cargando = null;
    } else if (m.type === 'transcribe') {
      if (cargando) await cargando;
      const texto = await transcribir(m.id, m.audio);
      enviar({ type: 'result', id: m.id, texto });
    } else if (m.type === 'unload') {
      if (transcriptor) { try { await transcriptor.dispose(); } catch (_) {} }
      transcriptor = null;
      modeloCargado = null;
      enviar({ type: 'unloaded' });
    }
  } catch (err) {
    cargando = null;
    enviar({ type: 'error', id: m.id, modelo: m.modelo, message: err && err.message ? err.message : String(err) });
  }
};
