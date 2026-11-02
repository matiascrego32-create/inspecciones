// Inspecciones · app web. Todo corre en el teléfono: grabación, transcripción (Whisper), PDF y datos.

import { db, uuid, cargarLocalesSiHaceFalta } from './db.js';
import { Grabadora, blobAPcm16k } from './audio.js';
import { MODELOS, MODELO_POR_DEFECTO, CADENA_DE_RESPALDO } from './modelos.js';
import { clasificar, resumir, CATEGORIAS, SEVERIDADES } from './clasificador.js';
import { generarInforme } from './pdf.js';

const app = document.getElementById('app');
const UMBRAL_METROS = 200;

const estado = {
  modelo: { fase: 'sinCargar', texto: 'Sin cargar', progreso: {}, clave: null, dispositivo: null, error: null },
  gps: { pos: null, error: null, permiso: 'desconocido' },
  cola: { corriendo: false, enProceso: null, pendientes: 0 },
  vista: null,
  localElegido: null,
  siguenPendientes: new Set(),
};

// ---------------------------------------------------------------- utilidades

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = {
  fechaLarga: ms => new Date(ms).toLocaleDateString('es-UY', { weekday: 'long', day: 'numeric', month: 'long' }),
  fechaCorta: ms => new Date(ms).toLocaleDateString('es-UY', { day: 'numeric', month: 'short' }),
  mesAnio: ms => new Date(ms).toLocaleDateString('es-UY', { month: 'long', year: 'numeric' }),
  hora: ms => new Date(ms).toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' }),
  duracion: s => { const t = Math.round(s || 0); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; },
  metros: m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`,
  bytes: b => b > 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${Math.round(b / 1e3)} KB`,
  capitalizar: s => s ? s[0].toUpperCase() + s.slice(1) : s,
};
function tituloDe(lista, id) { const x = lista.find(e => e.id === id); return x ? x.titulo : ''; }
function distanciaM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function badgeSeveridad(sev) {
  if (!sev) return `<span class="badge badge-gris">Sin severidad</span>`;
  return `<span class="badge badge-${esc(sev)}">${esc(tituloDe(SEVERIDADES, sev))}</span>`;
}
function badgeCategoria(cat) {
  return `<span class="badge badge-gris">${esc(cat ? tituloDe(CATEGORIAS, cat) : 'Sin categoría')}</span>`;
}
function etiquetaProceso(h) {
  const esperandoModelo = h.estadoProceso === 'transcribiendo' && estado.modelo.fase !== 'listo';
  const m = {
    grabado: ['⏱', 'En cola', ''],
    transcribiendo: ['', esperandoModelo ? (estado.modelo.fase === 'descargando' ? 'Descargando modelo…' : 'Preparando modelo…') : 'Transcribiendo…', 'proc'],
    listo: ['✓', 'Transcrito', 'ok'],
    manual: ['✓', 'Manual', 'ok'],
    error: ['!', 'Error', 'err'],
  }[h.estadoProceso] || ['', h.estadoProceso, ''];
  const spinner = h.estadoProceso === 'transcribiendo' ? '<span class="spinner"></span>' : `<span>${m[0]}</span>`;
  return `<span class="proceso ${m[2]}">${spinner} ${esc(m[1])}</span>`;
}
function tituloHallazgo(h) {
  if (h.descripcion) return h.descripcion;
  if (h.transcripcion) return h.transcripcion.slice(0, 80);
  return `Hallazgo ${h.orden}`;
}
async function urlBlob(id) {
  const b = await db.blob(id);
  return b ? URL.createObjectURL(b) : null;
}
function toast(msg, tipo = '') {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = 'visible ' + tipo;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.className = ''; }, 3500);
}

// ---------------------------------------------------------------- modelo (worker)

let worker = null;
const esperando = new Map();   // id de transcripción → {resolve, reject}
let cargaActual = null;        // {resolve, reject} de la carga en curso
let ultimoMensajeWorker = 0;   // para detectar un worker colgado

function matarWorker(motivo) {
  if (worker) { try { worker.terminate(); } catch (_) {} }
  worker = null;
  const err = new Error(motivo);
  if (cargaActual) { cargaActual.reject(err); cargaActual = null; }
  for (const [, p] of esperando) p.reject(err);
  esperando.clear();
}

function asegurarWorker() {
  if (worker) return worker;
  worker = new Worker('./worker.js', { type: 'module' });
  worker.onmessage = e => {
    ultimoMensajeWorker = Date.now();
    const m = e.data || {};
    if (m.type === 'progress') {
      if (m.file) estado.modelo.progreso[m.file] = { loaded: m.loaded || 0, total: m.total || 0, progress: m.progress || 0 };
      const archivos = Object.values(estado.modelo.progreso);
      const total = archivos.reduce((a, x) => a + (x.total || 0), 0);
      const bajado = archivos.reduce((a, x) => a + (x.loaded || 0), 0);
      estado.modelo.fase = 'descargando';
      estado.modelo.texto = total > 0 ? `Descargando modelo… ${fmt.bytes(bajado)} de ${fmt.bytes(total)}` : 'Descargando modelo…';
      emitir('modelo');
    } else if (m.type === 'estado') {
      estado.modelo.texto = m.texto;
      if (estado.modelo.fase !== 'descargando') estado.modelo.fase = 'cargando';
      emitir('modelo');
    } else if (m.type === 'ready') {
      estado.modelo.fase = 'listo';
      estado.modelo.clave = m.modelo;
      estado.modelo.dispositivo = m.dispositivo;
      estado.modelo.texto = `Listo · ${MODELOS[m.modelo].titulo} (${m.dispositivo === 'webgpu' ? 'GPU' : 'CPU'})`;
      estado.modelo.error = null;
      if (cargaActual) { cargaActual.resolve(m.modelo); cargaActual = null; }
      emitir('modelo');
    } else if (m.type === 'result') {
      const p = esperando.get(m.id); if (p) { esperando.delete(m.id); p.resolve(m.texto); }
    } else if (m.type === 'error') {
      if (m.id && esperando.has(m.id)) {
        const p = esperando.get(m.id); esperando.delete(m.id); p.reject(new Error(m.message));
      } else if (cargaActual) {
        cargaActual.reject(new Error(m.message)); cargaActual = null;
      } else {
        estado.modelo.fase = 'error'; estado.modelo.texto = 'Error: ' + m.message; estado.modelo.error = m.message; emitir('modelo');
      }
    }
  };
  worker.onerror = e => {
    // Casi siempre: no pudo bajar el motor de transcripción (sin conexión la primera vez).
    const msg = navigator.onLine === false
      ? 'Sin conexión. La primera vez hace falta internet para descargar el motor de transcripción.'
      : 'No se pudo cargar el motor de transcripción. Revisá la conexión y reintentá.';
    estado.modelo.fase = 'error'; estado.modelo.texto = 'Error: ' + msg; estado.modelo.error = msg; emitir('modelo');
    matarWorker(msg);
    motorRoto = true;
  };
  return worker;
}
let motorRoto = false;

/** Espera la carga; si el worker no da señales de vida por un rato, lo da por colgado. */
function esperarCarga(clavePromesa) {
  return new Promise((resolve, reject) => {
    let terminado = false;
    const vigilante = setInterval(() => {
      if (terminado) return;
      if (Date.now() - ultimoMensajeWorker > 120000) {
        clearInterval(vigilante);
        terminado = true;
        matarWorker('La descarga del modelo no avanza. Revisá la conexión y reintentá.');
      }
    }, 5000);
    clavePromesa.then(v => { terminado = true; clearInterval(vigilante); resolve(v); },
                      e => { terminado = true; clearInterval(vigilante); reject(e); });
  });
}

let cargaEnCurso = null;
/** Carga el modelo elegido; si falla, prueba los de respaldo. Devuelve la clave cargada. */
function asegurarModelo() {
  if (estado.modelo.fase === 'listo') return Promise.resolve(estado.modelo.clave);
  if (cargaEnCurso) return cargaEnCurso;
  cargaEnCurso = (async () => {
    const elegido = await db.ajuste('modelo', MODELO_POR_DEFECTO);
    const orden = [elegido, ...CADENA_DE_RESPALDO.filter(k => k !== elegido)];
    let ultimo = null;
    motorRoto = false;
    for (const clave of orden) {
      if (motorRoto) break; // sin motor no tiene sentido probar otros modelos
      try {
        estado.modelo.fase = 'cargando'; estado.modelo.progreso = {}; estado.modelo.texto = `Cargando ${MODELOS[clave].titulo}…`; emitir('modelo');
        const w = asegurarWorker();
        ultimoMensajeWorker = Date.now();
        const clavePromesa = new Promise((resolve, reject) => { cargaActual = { resolve, reject }; });
        w.postMessage({ type: 'load', modelo: clave });
        await esperarCarga(clavePromesa);
        if (clave !== elegido) {
          toast(`${MODELOS[elegido].titulo} no cargó en este teléfono; se usa ${MODELOS[clave].titulo}.`, 'aviso');
          await db.setAjuste('modelo', clave);
        }
        return clave;
      } catch (e) {
        ultimo = e;
        estado.modelo.texto = `${MODELOS[clave].titulo}: ${e.message}`;
        emitir('modelo');
      }
    }
    estado.modelo.fase = 'error';
    estado.modelo.error = ultimo ? ultimo.message : 'No cargó ningún modelo';
    estado.modelo.texto = 'Error: ' + estado.modelo.error;
    emitir('modelo');
    throw ultimo || new Error('No cargó ningún modelo');
  })().finally(() => { cargaEnCurso = null; });
  return cargaEnCurso;
}

async function cambiarModelo(clave) {
  await db.setAjuste('modelo', clave);
  if (worker) worker.postMessage({ type: 'unload' });
  estado.modelo.fase = 'sinCargar'; estado.modelo.clave = null; estado.modelo.texto = 'Sin cargar'; estado.modelo.progreso = {};
  emitir('modelo');
}

function transcribirPcm(pcm) {
  const id = uuid();
  const w = asegurarWorker();
  return new Promise((resolve, reject) => {
    esperando.set(id, { resolve, reject });
    w.postMessage({ type: 'transcribe', id, audio: pcm }, [pcm.buffer]);
  });
}

// ---------------------------------------------------------------- cola de procesamiento

async function procesarPendientes() {
  if (estado.cola.corriendo) return;
  estado.cola.corriendo = true;
  try {
    let lista = await db.hallazgosPendientesDeProceso();
    estado.cola.pendientes = lista.length;
    while (lista.length > 0) {
      const h = lista[0];
      await procesarHallazgo(h);
      lista = await db.hallazgosPendientesDeProceso();
      estado.cola.pendientes = lista.length;
    }
  } finally {
    estado.cola.corriendo = false;
    estado.cola.enProceso = null;
    emitir('cola');
  }
}

async function procesarHallazgo(h) {
  estado.cola.enProceso = h.id;
  h.estadoProceso = 'transcribiendo';
  h.errorMensaje = null;
  await db.guardar('hallazgos', h);
  emitir('hallazgo', h);
  try {
    await asegurarModelo();
    const blob = await db.blob(h.audioId);
    if (!blob) throw new Error('No se encontró el audio');
    const pcm = await blobAPcm16k(blob);
    const texto = await transcribirPcm(pcm);
    if (!texto) throw new Error('No se reconoció voz en el audio');
    // Puede haber sido borrado mientras se transcribía.
    const actual = await db.uno('hallazgos', h.id);
    if (!actual) return;
    actual.transcripcion = texto;
    const sug = clasificar(texto);
    if (!actual.descripcion) actual.descripcion = sug.descripcion;
    if (!actual.categoria) { actual.categoria = sug.categoria; actual.categoriaSugerida = true; }
    if (!actual.severidad) { actual.severidad = sug.severidad; actual.severidadSugerida = true; }
    actual.estadoProceso = 'listo';
    actual.errorMensaje = null;
    await db.guardar('hallazgos', actual);
    emitir('hallazgo', actual);
  } catch (e) {
    const actual = await db.uno('hallazgos', h.id);
    if (!actual) return;
    actual.estadoProceso = 'error';
    actual.errorMensaje = e && e.message ? e.message : String(e);
    await db.guardar('hallazgos', actual);
    emitir('hallazgo', actual);
  }
}

async function reintentar(h) {
  h.estadoProceso = 'grabado';
  h.errorMensaje = null;
  await db.guardar('hallazgos', h);
  emitir('hallazgo', h);
  procesarPendientes();
}

// ---------------------------------------------------------------- eventos internos

const oyentes = {};
function on(ev, fn) { (oyentes[ev] = oyentes[ev] || []).push(fn); }
function emitir(ev, dato) { (oyentes[ev] || []).forEach(fn => { try { fn(dato); } catch (e) { console.error(e); } }); }

// ---------------------------------------------------------------- GPS

let gpsWatch = null;
function iniciarGPS() {
  if (!('geolocation' in navigator) || gpsWatch !== null) return;
  gpsWatch = navigator.geolocation.watchPosition(
    p => { estado.gps.pos = { lat: p.coords.latitude, lon: p.coords.longitude, precision: p.coords.accuracy }; estado.gps.error = null; estado.gps.permiso = 'ok'; emitir('gps'); },
    e => { estado.gps.error = e.message; estado.gps.permiso = e.code === 1 ? 'denegado' : 'error'; emitir('gps'); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 },
  );
}
function candidatos(locales) {
  if (!estado.gps.pos) return [];
  return locales.map(l => ({ local: l, distancia: distanciaM(estado.gps.pos, l) })).sort((a, b) => a.distancia - b.distancia);
}
function localDetectado(locales) {
  const cerca = candidatos(locales).filter(c => c.distancia <= UMBRAL_METROS);
  return cerca.length === 1 ? cerca[0] : null;
}

// ---------------------------------------------------------------- router

const rutas = {
  '': vistaInicio,
  'pendientes': vistaPendientes,
  'grabacion': vistaGrabacion,
  'revision': vistaRevision,
  'informe': vistaInforme,
  'historial': vistaHistorial,
  'locales': vistaLocales,
  'ajustes': vistaAjustes,
};
function ir(ruta) { location.hash = '#/' + ruta; }
function rutaActual() {
  const h = location.hash.replace(/^#\/?/, '');
  const [nombre, ...resto] = h.split('/');
  return { nombre: nombre || '', param: resto.join('/') || null };
}
let renderizando = false;
async function render() {
  const { nombre, param } = rutaActual();
  const vista = rutas[nombre] || vistaInicio;
  if (grabadora && grabadora.grabando && nombre !== 'grabacion') {
    await grabadora.cancelar();
  }
  renderizando = true;
  try {
    estado.vista = nombre;
    app.innerHTML = await vista(param);
    window.scrollTo(0, 0);
    if (vista.montar) await vista.montar(param);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="pantalla"><h1>Algo falló</h1><p class="sec">${esc(e.message || e)}</p><button class="btn btn-sec" data-accion="volver-inicio">Volver al inicio</button></div>`;
  } finally {
    renderizando = false;
  }
}
window.addEventListener('hashchange', render);

// ---------------------------------------------------------------- vistas

const ICONO = {
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11a7 7 0 0 0-14 0c0 4.8 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  reloj: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  edificio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6"/></svg>',
  ajustes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
  atras: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  camara: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  basura: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  compartir: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 12v8h14v-8"/></svg>',
  doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/></svg>',
};

function encabezado(titulo, { atras = null, sub = '' } = {}) {
  return `
    <div class="enc">
      ${atras ? `<a class="atras" href="#/${esc(atras.ruta)}">${ICONO.atras}<span>${esc(atras.texto)}</span></a>` : ''}
      <h1>${esc(titulo)}</h1>
      ${sub ? `<p class="sec">${sub}</p>` : ''}
    </div>`;
}

// ---- Inicio

async function vistaInicio() {
  const locales = await db.localesActivos();
  const visitas = await db.todos('visitas');
  const enCurso = visitas.filter(v => v.estado !== 'confirmada').sort((a, b) => b.inicio - a.inicio)[0];
  const det = localDetectado(locales);
  const localActual = estado.localElegido || (det ? det.local : null);

  let tarjetaLocal;
  if (localActual) {
    const esDet = det && det.local.id === localActual.id && !estado.localElegido;
    tarjetaLocal = `
      <div class="fila-local">
        <div class="icono-circulo">${ICONO.pin}</div>
        <div>
          <div class="etiqueta">${estado.localElegido ? 'LOCAL ELEGIDO' : 'LOCAL DETECTADO'}</div>
          <div class="t20">${esc(localActual.nombre)}</div>
          <div class="sec">${esDet ? `Detectado por GPS · a ${fmt.metros(det.distancia)}` : esc(localActual.direccion)}</div>
        </div>
      </div>`;
  } else {
    let msg;
    if (estado.gps.permiso === 'denegado') msg = 'Sin permiso de ubicación. Elegí el local a mano.';
    else {
      const cerca = candidatos(locales).filter(c => c.distancia <= UMBRAL_METROS);
      msg = cerca.length > 1 ? `Hay ${cerca.length} locales cerca: elegí cuál es.` : (estado.gps.pos ? 'Ningún local a menos de 200 m.' : 'Buscando tu ubicación…');
    }
    tarjetaLocal = `
      <div class="fila-local">
        <div class="icono-circulo">${ICONO.pin}</div>
        <div>
          <div class="etiqueta">LOCAL</div>
          <div class="sec">${esc(msg)}</div>
        </div>
      </div>`;
  }

  let bloqueVisita;
  if (enCurso) {
    const local = await db.uno('locales', enCurso.localId);
    const hs = await db.hallazgosDeVisita(enCurso.id);
    bloqueVisita = `
      <div class="card">
        <div class="etiqueta acento">VISITA EN CURSO</div>
        <div class="t20">${esc(local ? local.nombre : '')}</div>
        <div class="sec">Iniciada ${fmt.hora(enCurso.inicio)} · ${hs.length} hallazgos</div>
        <button class="btn btn-pri" data-accion="ir" data-ruta="${enCurso.estado === 'enCurso' ? 'grabacion' : 'revision'}/${enCurso.id}">${enCurso.estado === 'enCurso' ? 'Continuar visita' : 'Revisar visita'}</button>
        <button class="btn btn-texto rojo" data-accion="descartar-visita" data-id="${enCurso.id}">Descartar visita</button>
      </div>`;
  } else {
    bloqueVisita = `
      <div class="card">
        ${tarjetaLocal}
        <button class="btn btn-sec" data-accion="elegir-local">${localActual ? 'Cambiar local' : 'Elegir local'}</button>
      </div>
      <button class="btn btn-pri grande" data-accion="iniciar-visita" ${localActual ? '' : 'disabled'}>Iniciar visita</button>`;
  }

  let pendientes = '';
  if (localActual) {
    const abiertos = await db.hallazgosAbiertosDeLocal(localActual.id);
    const visitasLocal = (await db.visitasDeLocal(localActual.id)).filter(v => v.estado === 'confirmada').sort((a, b) => b.inicio - a.inicio);
    const conteo = {};
    abiertos.forEach(h => { if (h.severidad) conteo[h.severidad] = (conteo[h.severidad] || 0) + 1; });
    pendientes = `
      <div class="card">
        <div class="entre">
          <div class="t17">${abiertos.length === 0 ? 'Sin pendientes en este local' : `${abiertos.length} hallazgos abiertos`}</div>
          ${visitasLocal[0] ? `<div class="sec peq">Visita del ${fmt.fechaCorta(visitasLocal[0].inicio)}</div>` : ''}
        </div>
        ${abiertos.length ? `<div class="badges">${SEVERIDADES.map(s => conteo[s.id] ? `<span class="badge badge-${s.id}">${conteo[s.id]} ${s.titulo.toLowerCase()}${conteo[s.id] > 1 && s.id !== 'leve' ? 's' : ''}</span>` : '').join('')}</div>
        <div class="sec">Se verifican al iniciar la visita.</div>` : ''}
      </div>`;
  }

  return `
    <div class="pantalla">
      <div class="enc">
        <h1 class="grande">Inspecciones</h1>
        <p class="sec">${esc(fmt.capitalizar(fmt.fechaLarga(Date.now())))}</p>
      </div>
      ${bloqueVisita}
      ${pendientes}
      <div class="lista">
        <a class="item" href="#/historial">${ICONO.reloj}<span>Historial de visitas</span>${ICONO.chevron}</a>
        <a class="item" href="#/locales">${ICONO.edificio}<span>Locales</span>${ICONO.chevron}</a>
        <a class="item" href="#/ajustes">${ICONO.ajustes}<span>Ajustes y respaldo</span>${ICONO.chevron}</a>
      </div>
      <div class="espacio"></div>
      <p class="pie">Todo se guarda en este iPhone. Sin cuenta, sin servidor.<br>${modeloResumen()}</p>
    </div>`;
}
function modeloResumen() {
  const m = estado.modelo;
  if (m.fase === 'listo') return `Transcripción: ${esc(MODELOS[m.clave].titulo)}`;
  if (m.fase === 'sinCargar') return 'Transcripción: el modelo se carga al empezar a grabar';
  return esc(m.texto);
}

async function elegirLocalDialogo() {
  const locales = await db.localesActivos();
  const cands = candidatos(locales);
  const opciones = cands.length ? cands : locales.map(l => ({ local: l, distancia: null }));
  const hoja = document.createElement('div');
  hoja.className = 'hoja';
  hoja.innerHTML = `
    <div class="hoja-panel">
      <div class="hoja-enc"><strong>Elegir local</strong><button class="btn-texto" data-cerrar>Cancelar</button></div>
      <div class="lista">
        ${opciones.map(o => `<button class="item" data-local="${o.local.id}"><span><span class="t16">${esc(o.local.nombre)}</span><br><span class="sec peq">${esc(o.local.direccion)}</span></span>${o.distancia != null ? `<span class="sec peq">${fmt.metros(o.distancia)}</span>` : ''}</button>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(hoja);
  hoja.addEventListener('click', e => {
    const b = e.target.closest('[data-local]');
    if (b) { estado.localElegido = locales.find(l => l.id === b.dataset.local); hoja.remove(); render(); return; }
    if (e.target.closest('[data-cerrar]') || e.target === hoja) hoja.remove();
  });
}

async function iniciarVisita() {
  const locales = await db.localesActivos();
  const det = localDetectado(locales);
  const local = estado.localElegido || (det ? det.local : null);
  if (!local) return;
  const visita = { id: uuid(), localId: local.id, inicio: Date.now(), cierre: null, estado: 'enCurso', pdfId: null };
  await db.guardar('visitas', visita);
  estado.localElegido = null;
  estado.siguenPendientes = new Set();
  const abiertos = await db.hallazgosAbiertosDeLocal(local.id);
  ir((abiertos.length ? 'pendientes/' : 'grabacion/') + visita.id);
}

// ---- Pendientes

async function vistaPendientes(id) {
  const visita = await db.uno('visitas', id);
  if (!visita) return vistaInicio();
  const local = await db.uno('locales', visita.localId);
  const abiertos = (await db.hallazgosAbiertosDeLocal(visita.localId)).filter(h => h.visitaId !== visita.id);
  const resueltos = await db.hallazgosResueltosEnVisita(visita.id);
  const total = abiertos.length + resueltos.length;
  const verificados = resueltos.length + abiertos.filter(h => estado.siguenPendientes.has(h.id)).length;

  const tarjeta = (h, resuelto) => `
    <div class="card" data-hid="${h.id}">
      <div class="fila">
        <div class="foto-thumb" data-foto="${h.fotoId || ''}">${ICONO.camara}</div>
        <div class="col">
          <div class="t16">${esc(tituloHallazgo(h))}</div>
          <div class="badges">${badgeSeveridad(h.severidad)}${badgeCategoria(h.categoria)}</div>
          ${h.visita ? `<div class="sec peq">Visita del ${fmt.fechaCorta(h.visita.inicio)}</div>` : ''}
        </div>
      </div>
      <div class="dos">
        <button class="btn ${resuelto ? 'btn-ok-activo' : 'btn-sec'}" data-accion="resuelto" data-id="${h.id}" data-visita="${visita.id}">Resuelto</button>
        <button class="btn ${!resuelto && estado.siguenPendientes.has(h.id) ? 'btn-aviso-activo' : 'btn-sec'}" data-accion="sigue" data-id="${h.id}" data-visita="${visita.id}">Sigue pendiente</button>
      </div>
    </div>`;

  return `
    <div class="pantalla con-pie">
      ${encabezado('Pendientes del local', { atras: { ruta: '', texto: 'Inicio' }, sub: `${esc(local ? local.nombre : '')} · ${total} abiertos` })}
      ${resueltos.map(h => tarjeta(h, true)).join('')}
      ${abiertos.map(h => tarjeta(h, false)).join('')}
      ${total === 0 ? '<p class="sec centrado">No hay pendientes de visitas anteriores.</p>' : ''}
    </div>
    <div class="pie-fijo">
      <div class="sec centrado peq">${verificados} de ${total} verificados</div>
      <button class="btn btn-pri grande" data-accion="ir" data-ruta="grabacion/${visita.id}">Continuar al recorrido</button>
    </div>`;
}
vistaPendientes.montar = cargarFotosThumb;

async function cargarFotosThumb() {
  for (const el of app.querySelectorAll('[data-foto]')) {
    const id = el.dataset.foto;
    if (!id) continue;
    const url = await urlBlob(id);
    if (url) { el.innerHTML = `<img src="${url}" alt="">`; el.classList.add('con-foto'); }
  }
}

// ---- Grabación

let grabadora = null;
let visitaGrabando = null;

async function vistaGrabacion(id) {
  const visita = await db.uno('visitas', id);
  if (!visita) return vistaInicio();
  if (visita.estado === 'confirmada') return vistaInforme(id);
  visitaGrabando = visita;
  const local = await db.uno('locales', visita.localId);
  const hs = (await db.hallazgosDeVisita(visita.id)).sort((a, b) => b.orden - a.orden);
  const ultimo = hs[0];
  return `
    <div class="pantalla con-pie" id="pantalla-grabacion">
      <div class="enc fila-sup">
        <div>
          <div class="etiqueta acento">VISITA EN CURSO</div>
          <h1>${esc(local ? local.nombre : '')}</h1>
          <p class="sec" id="grab-sub">Iniciada ${fmt.hora(visita.inicio)} · ${hs.length} hallazgos</p>
        </div>
        <div class="pill" id="pill-modelo">${pillModelo()}</div>
      </div>
      <div class="card panel-grab">
        <button class="boton-grabar" id="btn-grabar" aria-label="Grabar nuevo hallazgo">
          <span class="halo" id="halo"></span>
          <span class="circulo" id="circulo">${ICONO.mic}</span>
        </button>
        <div class="t17" id="grab-titulo">Nuevo hallazgo</div>
        <div class="sec" id="grab-ayuda">Tocá para grabar, tocá de nuevo para parar</div>
        <div class="sec rojo" id="grab-error"></div>
        ${ultimo ? `<label class="btn btn-sec chico">${ICONO.camara}<span>${ultimo.fotoId ? 'Cambiar foto del último' : 'Agregar foto al último'}</span><input type="file" accept="image/*" capture="environment" hidden data-foto-para="${ultimo.id}"></label>` : ''}
      </div>
      ${hs.length ? `<div class="etiqueta">GRABADOS EN ESTA VISITA</div><div id="lista-grabados">${hs.map(filaGrabado).join('')}</div>` : '<div id="lista-grabados"></div>'}
    </div>
    <div class="pie-fijo">
      <button class="btn btn-pri grande" id="btn-cerrar-visita" data-accion="cerrar-visita" data-id="${visita.id}">Cerrar visita y revisar</button>
    </div>`;
}
function pillModelo() {
  const listo = estado.modelo.fase === 'listo';
  return `<span class="punto ${listo ? 'ok' : 'aviso'}"></span><span>${listo ? 'Transcripción lista' : esc(estado.modelo.texto)}</span>`;
}
function filaGrabado(h) {
  const principal = h.transcripcion ? tituloHallazgo(h) : `${fmt.duracion(h.duracion)}${h.fotoId ? ' · con foto' : ''}`;
  return `
    <div class="card fila-grabado" data-hid="${h.id}">
      <span class="num">${h.orden}</span>
      <div class="col">
        <div class="t15 una-linea">${esc(principal)}</div>
        <div class="sec peq">${etiquetaProceso(h)}${h.transcripcion ? ` · ${fmt.duracion(h.duracion)}` : ''}${h.fotoId && h.transcripcion ? ' · 📷' : ''}</div>
        ${h.estadoProceso === 'error' && h.errorMensaje ? `<div class="sec peq rojo">${esc(h.errorMensaje)}</div>` : ''}
      </div>
      ${h.estadoProceso === 'error'
        ? `<button class="btn btn-sec chico" data-accion="reintentar" data-id="${h.id}">Reintentar</button>`
        : `<button class="btn-icono rojo" data-accion="borrar-hallazgo" data-id="${h.id}" aria-label="Borrar hallazgo ${h.orden}">${ICONO.basura}</button>`}
    </div>`;
}
vistaGrabacion.montar = async () => {
  grabadora = grabadora || new Grabadora();
  const btn = document.getElementById('btn-grabar');
  const halo = document.getElementById('halo');
  const titulo = document.getElementById('grab-titulo');
  const ayuda = document.getElementById('grab-ayuda');
  const err = document.getElementById('grab-error');
  const circulo = document.getElementById('circulo');

  grabadora.onTick = seg => { titulo.textContent = `Grabando · ${fmt.duracion(seg)}`; };
  grabadora.onNivel = n => { halo.style.transform = `scale(${1 + n * 0.35})`; };

  btn.onclick = async () => {
    err.textContent = '';
    if (grabadora.grabando) {
      const r = await grabadora.detener();
      circulo.innerHTML = ICONO.mic;
      titulo.textContent = 'Nuevo hallazgo';
      ayuda.textContent = 'Tocá para grabar, tocá de nuevo para parar';
      halo.style.transform = '';
      document.getElementById('btn-cerrar-visita').disabled = false;
      if (!r || r.duracion < 1) return;
      await guardarGrabacion(r.blob, r.duracion);
    } else {
      try {
        await grabadora.iniciar();
        circulo.innerHTML = ICONO.stop;
        ayuda.textContent = 'Tocá de nuevo para parar';
        document.getElementById('btn-cerrar-visita').disabled = true;
        asegurarModelo().catch(() => {});
      } catch (e) {
        err.textContent = e.name === 'NotAllowedError' ? 'Sin permiso de micrófono. Activalo en Ajustes → Safari → Micrófono.' : (e.message || 'No se pudo grabar');
      }
    }
  };
  // Precalienta el modelo mientras el jefe empieza a recorrer.
  asegurarModelo().catch(() => {});
};

async function guardarGrabacion(blob, duracion) {
  const visita = visitaGrabando;
  const hs = await db.hallazgosDeVisita(visita.id);
  const orden = (hs.reduce((m, h) => Math.max(m, h.orden), 0)) + 1;
  const audioId = await db.guardarBlob(blob, 'audio');
  const h = {
    id: uuid(), visitaId: visita.id, orden, audioId, duracion, transcripcion: null, descripcion: '',
    categoria: null, severidad: null, fotoId: null, estadoProceso: 'grabado', estado: 'abierto', creado: Date.now(),
  };
  await db.guardar('hallazgos', h);
  await refrescarListaGrabados();
  procesarPendientes();
}

async function refrescarListaGrabados() {
  if (estado.vista !== 'grabacion' || !visitaGrabando) return;
  const hs = (await db.hallazgosDeVisita(visitaGrabando.id)).sort((a, b) => b.orden - a.orden);
  const cont = document.getElementById('lista-grabados');
  if (cont) cont.innerHTML = hs.map(filaGrabado).join('');
  const sub = document.getElementById('grab-sub');
  if (sub) sub.textContent = `Iniciada ${fmt.hora(visitaGrabando.inicio)} · ${hs.length} hallazgos`;
  // Botón de foto: apunta siempre al último.
  const label = app.querySelector('[data-foto-para]');
  if (hs[0]) {
    if (label) { label.dataset.fotoPara = hs[0].id; label.previousElementSibling.textContent = hs[0].fotoId ? 'Cambiar foto del último' : 'Agregar foto al último'; }
    else render();
  }
}

async function guardarFoto(hid, archivo) {
  if (!archivo) return;
  const h = await db.uno('hallazgos', hid);
  if (!h) return;
  const blob = await redimensionarImagen(archivo, 1600);
  await db.borrarBlob(h.fotoId);
  h.fotoId = await db.guardarBlob(blob, 'foto');
  await db.guardar('hallazgos', h);
  toast('Foto guardada');
  emitir('hallazgo', h);
  if (estado.vista === 'grabacion') refrescarListaGrabados();
  if (estado.vista === 'revision') render();
}
async function redimensionarImagen(archivo, ladoMax) {
  try {
    const bmp = await createImageBitmap(archivo);
    const escala = Math.min(1, ladoMax / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * escala); c.height = Math.round(bmp.height * escala);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.82));
  } catch (_) {
    return archivo;
  }
}

async function cerrarVisita(id) {
  if (grabadora && grabadora.grabando) return;
  const v = await db.uno('visitas', id);
  if (!v) return;
  v.cierre = Date.now();
  v.estado = 'pendienteRevision';
  await db.guardar('visitas', v);
  ir('revision/' + id);
}

// ---- Revisión

async function vistaRevision(id) {
  const visita = await db.uno('visitas', id);
  if (!visita) return vistaInicio();
  const local = await db.uno('locales', visita.localId);
  const hs = await db.hallazgosDeVisita(visita.id);
  const resueltos = await db.hallazgosResueltosEnVisita(visita.id);
  const enProceso = hs.filter(h => h.estadoProceso === 'grabado' || h.estadoProceso === 'transcribiendo').length;
  return `
    <div class="pantalla con-pie" id="pantalla-revision">
      ${encabezado('Revisar visita', { atras: visita.estado === 'confirmada' ? { ruta: 'informe/' + visita.id, texto: 'Informe' } : { ruta: 'grabacion/' + visita.id, texto: 'Grabación' } })}
      <p class="sec" style="margin-top:-8px">${esc(local ? local.nombre : '')} · ${fmt.fechaCorta(visita.inicio)} · ${hs.length} hallazgos · ${resueltos.length} pendientes resueltos</p>
      <div class="sec peq" id="rev-proceso">${enProceso ? `<span class="spinner"></span> ${enProceso} en proceso: transcribiendo` : ''}</div>
      <div id="lista-revision">${hs.map(tarjetaRevision).join('')}</div>
      <button class="btn btn-sec" data-accion="agregar-manual" data-visita="${visita.id}">+ Agregar hallazgo manual</button>
    </div>
    <div class="pie-fijo">
      <button class="btn btn-pri grande" data-accion="confirmar-visita" data-id="${visita.id}">${visita.estado === 'confirmada' ? 'Guardar cambios y regenerar informe' : 'Confirmar visita'}</button>
    </div>`;
}
function tarjetaRevision(h) {
  const chipsCat = CATEGORIAS.map(c => `<button class="chip ${h.categoria === c.id ? 'activo' : ''}" data-accion="categoria" data-id="${h.id}" data-valor="${c.id}">${c.titulo}</button>`).join('');
  const seg = SEVERIDADES.map(s => `<button class="seg ${h.severidad === s.id ? 'activo-' + s.id : ''}" data-accion="severidad" data-id="${h.id}" data-valor="${s.id}">${s.titulo}</button>`).join('');
  return `
    <div class="card tarjeta-rev" data-hid="${h.id}">
      <div class="entre">
        <span class="sec peq">Hallazgo ${h.orden}${h.audioId ? ` · ${fmt.duracion(h.duracion)}` : ' · manual'}</span>
        <button class="btn-icono rojo" data-accion="borrar-hallazgo" data-id="${h.id}" aria-label="Borrar hallazgo">${ICONO.basura}</button>
      </div>
      <label class="campo">
        <span class="etiqueta-campo">Descripción</span>
        <textarea rows="2" data-campo="descripcion" data-id="${h.id}" placeholder="Describí el problema en una frase">${esc(h.descripcion)}</textarea>
      </label>
      ${h.transcripcion
        ? `<div class="campo"><span class="etiqueta-campo">Transcripción</span><div class="transcripcion">“${esc(h.transcripcion)}”</div></div>`
        : (h.audioId ? `<div class="sec peq">${etiquetaProceso(h)}${h.estadoProceso === 'error' ? ` <button class="btn-texto" data-accion="reintentar" data-id="${h.id}">Reintentar</button>` : ''}${h.errorMensaje ? `<div class="rojo">${esc(h.errorMensaje)}</div>` : ''}</div>` : '')}
      <div class="campo">
        <span class="etiqueta-campo">Categoría${h.categoriaSugerida ? ' <span class="sug">sugerida</span>' : ''}</span>
        <div class="chips">${chipsCat}</div>
      </div>
      <div class="campo">
        <span class="etiqueta-campo">Severidad${h.severidadSugerida ? ' <span class="sug">sugerida</span>' : ''}</span>
        <div class="segmentos">${seg}</div>
        ${!h.severidad ? '<div class="sec peq aviso-txt">Sin clasificar: elegí una.</div>' : ''}
      </div>
      <div class="fila">
        <div class="foto-thumb chica" data-foto="${h.fotoId || ''}">${ICONO.camara}</div>
        <span class="sec">${h.fotoId ? 'Con foto' : 'Sin foto'}</span>
        <span class="espacio"></span>
        <label class="btn btn-sec chico"><span>${h.fotoId ? 'Cambiar' : 'Agregar foto'}</span><input type="file" accept="image/*" capture="environment" hidden data-foto-para="${h.id}"></label>
      </div>
    </div>`;
}
vistaRevision.montar = cargarFotosThumb;

async function agregarManual(visitaId) {
  const texto = prompt('Descripción del hallazgo (se agrega sin audio):');
  if (!texto || !texto.trim()) return;
  const hs = await db.hallazgosDeVisita(visitaId);
  const orden = hs.reduce((m, h) => Math.max(m, h.orden), 0) + 1;
  await db.guardar('hallazgos', {
    id: uuid(), visitaId, orden, audioId: null, duracion: 0, transcripcion: null, descripcion: texto.trim(),
    categoria: null, severidad: null, fotoId: null, estadoProceso: 'manual', estado: 'abierto', creado: Date.now(),
  });
  render();
}

async function confirmarVisita(id) {
  const visita = await db.uno('visitas', id);
  if (!visita) return;
  const hs = await db.hallazgosDeVisita(id);
  const enProceso = hs.filter(h => h.estadoProceso === 'grabado' || h.estadoProceso === 'transcribiendo').length;
  if (enProceso > 0 && !confirm(`${enProceso} hallazgos todavía se están transcribiendo. ¿Confirmar igual? Van al informe tal como están.`)) return;
  for (const h of hs) {
    if (!h.descripcion) { h.descripcion = tituloHallazgo(h); await db.guardar('hallazgos', h); }
  }
  visita.estado = 'confirmada';
  if (!visita.cierre) visita.cierre = Date.now();
  await db.guardar('visitas', visita);
  try {
    await regenerarPDF(visita);
  } catch (e) {
    toast('No se pudo generar el PDF: ' + (e.message || e), 'error');
  }
  ir('informe/' + id);
}

async function regenerarPDF(visita) {
  const local = await db.uno('locales', visita.localId);
  const nuevos = await db.hallazgosDeVisita(visita.id);
  const resueltos = await db.hallazgosResueltosEnVisita(visita.id);
  const vmap = Object.fromEntries((await db.todos('visitas')).map(v => [v.id, v]));
  resueltos.forEach(h => { h.visita = vmap[h.visitaId]; });
  const siguenAbiertos = (await db.hallazgosAbiertosDeLocal(visita.localId)).filter(h => h.visitaId !== visita.id);
  const pdf = await generarInforme({ visita, local, nuevos, resueltos, siguenAbiertos, blobDe: id => db.blob(id) });
  await db.borrarBlob(visita.pdfId);
  visita.pdfId = await db.guardarBlob(pdf, 'pdf');
  await db.guardar('visitas', visita);
  return pdf;
}

// ---- Informe

async function vistaInforme(id) {
  const visita = await db.uno('visitas', id);
  if (!visita) return vistaInicio();
  const local = await db.uno('locales', visita.localId);
  const url = visita.pdfId ? await urlBlob(visita.pdfId) : null;
  const nuevos = await db.hallazgosDeVisita(visita.id);
  const resueltos = await db.hallazgosResueltosEnVisita(visita.id);
  const vmap = Object.fromEntries((await db.todos('visitas')).map(v => [v.id, v]));
  const siguenAbiertos = (await db.hallazgosAbiertosDeLocal(visita.localId)).filter(h => h.visitaId !== visita.id);
  const fechaLarga = new Date(visita.inicio).toLocaleDateString('es-UY', { day: 'numeric', month: 'long', year: 'numeric' });
  const rango = `${fechaLarga} · ${fmt.hora(visita.inicio)}${visita.cierre ? ` a ${fmt.hora(visita.cierre)}` : ''}`;

  const filaNuevo = (h, i) => `
    <div class="inf-fila">
      <span class="inf-num">${i + 1}</span>
      <div class="col">
        <div class="t15">${esc(tituloHallazgo(h))}</div>
        <div class="sec peq">${esc(tituloDe(CATEGORIAS, h.categoria) || 'Sin categoría')}${h.transcripcion ? ` · “${esc(h.transcripcion)}”` : ''}</div>
        ${h.fotoId ? `<div class="foto-thumb inf-foto" data-foto="${h.fotoId}">${ICONO.camara}</div>` : ''}
      </div>
      ${badgeSeveridad(h.severidad)}
    </div>`;
  const filaPend = (h, estadoTxt, clase) => {
    const v = vmap[h.visitaId];
    return `<div class="inf-fila"><div class="col"><div class="t15">${esc(tituloHallazgo(h))}</div>${v ? `<div class="sec peq">Visita del ${fmt.fechaCorta(v.inicio)}</div>` : ''}</div><span class="badge ${clase}">${estadoTxt}</span></div>`;
  };

  return `
    <div class="pantalla con-pie sin-pad-abajo">
      ${encabezado('Informe de visita', { atras: { ruta: '', texto: 'Inicio' }, sub: `${esc(local ? local.nombre : '')} · ${fmt.fechaCorta(visita.inicio)} · PDF generado en el teléfono` })}
      <div class="card informe">
        <div class="inf-enc">
          <div class="t20">Inspección · ${esc(local ? local.nombre : '')}</div>
          <div class="sec peq">${esc(rango)}</div>
          ${local && local.direccion ? `<div class="sec peq">${esc(local.direccion)}</div>` : ''}
          <div class="sec peq">${nuevos.length} hallazgos nuevos · ${resueltos.length} pendientes resueltos · ${siguenAbiertos.length} siguen abiertos</div>
        </div>
        <div class="etiqueta">Hallazgos nuevos</div>
        ${nuevos.length ? nuevos.map(filaNuevo).join('') : '<p class="sec peq">Sin hallazgos en esta visita.</p>'}
        <div class="etiqueta" style="margin-top:8px">Pendientes de visitas anteriores</div>
        ${resueltos.length || siguenAbiertos.length
          ? resueltos.map(h => filaPend(h, 'Resuelto', 'badge-ok')).join('') + siguenAbiertos.map(h => filaPend(h, 'Sigue abierto', 'badge-urgente')).join('')
          : '<p class="sec peq">No había pendientes.</p>'}
      </div>
      ${url ? `<a class="btn btn-sec" href="${url}" target="_blank" rel="noopener">${ICONO.doc}<span>Abrir el PDF</span></a>` : '<p class="sec centrado peq">Todavía no se generó el PDF de esta visita.</p>'}
    </div>
    <div class="pie-fijo dos">
      <button class="btn btn-sec" data-accion="regenerar-pdf" data-id="${visita.id}">Volver a generar</button>
      <button class="btn btn-pri" data-accion="compartir-pdf" data-id="${visita.id}" ${url ? '' : 'disabled'}>${ICONO.compartir}<span>Compartir PDF</span></button>
    </div>
    <div class="pie-fijo-extra"><a class="btn btn-texto" href="#/revision/${visita.id}">Corregir hallazgos</a></div>`;
}
vistaInforme.montar = cargarFotosThumb;

async function compartirPDF(id) {
  const visita = await db.uno('visitas', id);
  const local = await db.uno('locales', visita.localId);
  const blob = await db.blob(visita.pdfId);
  if (!blob) { toast('No hay PDF', 'error'); return; }
  const nombre = `Inspeccion_${(local ? local.nombre : 'local').replace(/\s+/g, '_')}_${new Date(visita.inicio).toISOString().slice(0, 10)}.pdf`;
  const archivo = new File([blob], nombre, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
    try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  descargar(blob, nombre);
}
function descargar(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = nombre; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---- Historial

let filtroLocal = null;
async function vistaHistorial() {
  const visitas = (await db.todos('visitas')).filter(v => v.estado === 'confirmada').sort((a, b) => b.inicio - a.inicio);
  const locales = (await db.todos('locales')).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const lmap = Object.fromEntries(locales.map(l => [l.id, l]));
  const filtradas = filtroLocal ? visitas.filter(v => v.localId === filtroLocal) : visitas;
  const grupos = new Map();
  for (const v of filtradas) {
    const k = fmt.capitalizar(fmt.mesAnio(v.inicio));
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(v);
  }
  const filas = [];
  for (const [mes, lista] of grupos) {
    filas.push(`<div class="etiqueta">${esc(mes)}</div>`);
    for (const v of lista) {
      const hs = await db.hallazgosDeVisita(v.id);
      const abiertos = hs.filter(h => h.estado === 'abierto').length;
      const conteo = {};
      hs.forEach(h => { if (h.severidad) conteo[h.severidad] = (conteo[h.severidad] || 0) + 1; });
      filas.push(`
        <a class="card fila-visita" href="#/informe/${v.id}">
          <div class="col">
            <div class="t16">${esc(lmap[v.localId] ? lmap[v.localId].nombre : '')}</div>
            <div class="sec peq">${fmt.fechaCorta(v.inicio)} · ${hs.length} hallazgos · ${abiertos ? `${abiertos} pendientes abiertos` : 'sin pendientes'}</div>
            <div class="badges">${SEVERIDADES.map(s => conteo[s.id] ? `<span class="badge badge-${s.id}">${conteo[s.id]} ${s.titulo.toLowerCase()}${conteo[s.id] > 1 && s.id !== 'leve' ? 's' : ''}</span>` : '').join('')}</div>
          </div>
          <span class="icono acento">${ICONO.doc}</span>
        </a>`);
    }
  }
  return `
    <div class="pantalla">
      ${encabezado('Historial', { atras: { ruta: '', texto: 'Inicio' } })}
      <div class="chips scroll">
        <button class="chip ${filtroLocal ? '' : 'activo'}" data-accion="filtro-local" data-valor="">Todos</button>
        ${locales.map(l => `<button class="chip ${filtroLocal === l.id ? 'activo' : ''}" data-accion="filtro-local" data-valor="${l.id}">${esc(l.nombre)}</button>`).join('')}
      </div>
      ${filas.length ? filas.join('') : '<p class="sec centrado">Las visitas confirmadas aparecen acá.</p>'}
    </div>`;
}

// ---- Locales

async function vistaLocales() {
  const locales = (await db.todos('locales')).sort((a, b) => a.nombre.localeCompare(b.nombre));
  const filas = [];
  for (const l of locales) {
    const visitas = (await db.visitasDeLocal(l.id)).filter(v => v.estado === 'confirmada').sort((a, b) => b.inicio - a.inicio);
    const abiertos = (await db.hallazgosAbiertosDeLocal(l.id)).length;
    filas.push(`
      <button class="item" data-accion="editar-local" data-id="${l.id}">
        <span class="col">
          <span class="t16 ${l.activo === false ? 'sec' : ''}">${esc(l.nombre)}</span>
          <span class="sec peq">${esc(l.direccion)}</span>
          ${visitas[0] ? `<span class="sec peq">Última visita ${fmt.fechaCorta(visitas[0].inicio)} · ${abiertos} abiertos</span>` : ''}
        </span>
        ${l.activo === false ? '<span class="sec peq">Inactivo</span>' : ''}
        ${ICONO.chevron}
      </button>`);
  }
  return `
    <div class="pantalla">
      ${encabezado('Locales', { atras: { ruta: '', texto: 'Inicio' } })}
      <div class="lista">${filas.join('')}</div>
      <button class="btn btn-sec" data-accion="editar-local" data-id="">+ Agregar local</button>
    </div>`;
}

async function editarLocalDialogo(id) {
  const l = id ? await db.uno('locales', id) : { id: uuid(), nombre: '', direccion: '', lat: '', lon: '', activo: true, creado: Date.now() };
  const hoja = document.createElement('div');
  hoja.className = 'hoja';
  hoja.innerHTML = `
    <form class="hoja-panel">
      <div class="hoja-enc"><button type="button" class="btn-texto" data-cerrar>Cancelar</button><strong>${id ? 'Editar local' : 'Nuevo local'}</strong><button type="submit" class="btn-texto">Guardar</button></div>
      <label class="campo"><span class="etiqueta-campo">Nombre</span><input name="nombre" required value="${esc(l.nombre)}"></label>
      <label class="campo"><span class="etiqueta-campo">Dirección</span><input name="direccion" value="${esc(l.direccion)}"></label>
      <label class="campo"><span class="etiqueta-campo">Latitud</span><input name="lat" inputmode="decimal" required value="${esc(l.lat)}" placeholder="-34.88617"></label>
      <label class="campo"><span class="etiqueta-campo">Longitud</span><input name="lon" inputmode="decimal" required value="${esc(l.lon)}" placeholder="-56.16218"></label>
      <button type="button" class="btn btn-sec" data-mi-ubicacion ${estado.gps.pos ? '' : 'disabled'}>Usar mi ubicación actual</button>
      <p class="sec peq">Parado en la puerta del local, "Usar mi ubicación actual" es la forma más fácil de cargar las coordenadas.</p>
      <label class="campo fila"><input type="checkbox" name="activo" ${l.activo !== false ? 'checked' : ''}><span>Activo (aparece en el selector)</span></label>
    </form>`;
  document.body.appendChild(hoja);
  const form = hoja.querySelector('form');
  hoja.addEventListener('click', e => {
    if (e.target.closest('[data-cerrar]') || e.target === hoja) hoja.remove();
    if (e.target.closest('[data-mi-ubicacion]') && estado.gps.pos) {
      form.lat.value = estado.gps.pos.lat.toFixed(5);
      form.lon.value = estado.gps.pos.lon.toFixed(5);
    }
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const lat = parseFloat(form.lat.value), lon = parseFloat(form.lon.value);
    if (isNaN(lat) || isNaN(lon)) { alert('Latitud y longitud deben ser números, por ejemplo -34.88617 y -56.16218.'); return; }
    await db.guardar('locales', { ...l, nombre: form.nombre.value.trim(), direccion: form.direccion.value.trim(), lat, lon, activo: form.activo.checked });
    hoja.remove();
    render();
  });
}

// ---- Ajustes

async function vistaAjustes() {
  const modelo = await db.ajuste('modelo', MODELO_POR_DEFECTO);
  const visitas = (await db.todos('visitas')).filter(v => v.estado === 'confirmada').length;
  const hallazgos = (await db.todos('hallazgos')).length;
  const locales = (await db.todos('locales')).length;
  const uso = await db.tamanoAproximado();
  const webgpu = 'gpu' in navigator;
  const m = estado.modelo;
  const cargadoEste = m.fase === 'listo' && m.clave === modelo;
  return `
    <div class="pantalla">
      ${encabezado('Ajustes y respaldo', { atras: { ruta: '', texto: 'Inicio' } })}

      <div class="etiqueta">TRANSCRIPCIÓN (WHISPER, EN EL TELÉFONO)</div>
      <div class="card">
        <div class="radios">
          ${Object.entries(MODELOS).map(([k, d]) => `
            <label class="radio ${modelo === k ? 'activo' : ''}">
              <input type="radio" name="modelo" value="${k}" ${modelo === k ? 'checked' : ''} data-accion="modelo">
              <span class="col"><span class="t16">${esc(d.titulo)} <span class="sec peq">${esc(d.tamano)}</span></span><span class="sec peq">${esc(d.detalle)}</span></span>
            </label>`).join('')}
        </div>
        <div class="entre"><span>Estado</span><span class="sec" id="aj-estado">${esc(cargadoEste ? 'Listo' : m.texto)}</span></div>
        <div class="barra" id="aj-barra"></div>
        <button class="btn btn-sec" data-accion="cargar-modelo" ${cargadoEste || m.fase === 'descargando' || m.fase === 'cargando' ? 'disabled' : ''}>${cargadoEste ? 'Cargado' : 'Descargar y cargar ahora'}</button>
        <p class="sec peq">La primera descarga necesita wifi y tarda varios minutos. Después funciona sin señal mientras Safari conserve el modelo; si lo borra por falta de espacio, se vuelve a bajar solo. ${webgpu ? 'Este navegador tiene aceleración por GPU.' : 'Este navegador no tiene WebGPU: va a usar la CPU, más lento.'}</p>
      </div>

      <div class="etiqueta">CLASIFICACIÓN DE HALLAZGOS</div>
      <div class="card">
        <p class="sec">En la versión web no hay modelo de lenguaje local. La app <strong>sugiere</strong> categoría y severidad por palabras clave de la transcripción, y el jefe confirma o corrige con un toque en la revisión.</p>
      </div>

      <div class="etiqueta">COPIA DE SEGURIDAD</div>
      <div class="card">
        <p class="sec">Los datos viven en Safari, en este iPhone. Safari puede borrarlos si el teléfono se queda sin espacio o si la app no se abre por mucho tiempo: <strong>exportá un ZIP cada tanto</strong> y guardalo en Archivos o iCloud Drive.</p>
        <button class="btn btn-sec" data-accion="exportar-zip">${ICONO.compartir}<span>Exportar todo en un ZIP</span></button>
        <label class="btn btn-sec"><span>Importar un ZIP exportado</span><input type="file" accept=".zip,application/zip" hidden data-accion="importar-zip"></label>
        <div class="sec peq" id="aj-export"></div>
      </div>

      <div class="etiqueta">DATOS EN ESTE IPHONE</div>
      <div class="card grilla3">
        <div><div class="t22">${visitas}</div><div class="sec peq">visitas</div></div>
        <div><div class="t22">${hallazgos}</div><div class="sec peq">hallazgos</div></div>
        <div><div class="t22">${locales}</div><div class="sec peq">locales</div></div>
      </div>
      <p class="sec peq centrado">Espacio usado (datos y modelo): ${uso ? fmt.bytes(uso) : 'no disponible'}</p>

      <p class="pie">Nada sale del teléfono salvo el respaldo que exportás. Sin cuenta, sin servidor.</p>
    </div>`;
}

async function exportarZip() {
  const info = document.getElementById('aj-export');
  info.textContent = 'Armando el ZIP…';
  try {
    const zip = new window.JSZip();
    const datos = {
      version: 1,
      exportado: new Date().toISOString(),
      locales: await db.todos('locales'),
      visitas: await db.todos('visitas'),
      hallazgos: await db.todos('hallazgos'),
      ajustes: await db.todos('ajustes'),
    };
    zip.file('datos.json', JSON.stringify(datos, null, 2));
    const blobs = await db.todos('blobs');
    for (const b of blobs) {
      const ext = b.tipo === 'pdf' ? 'pdf' : b.tipo === 'foto' ? 'jpg' : (b.mime && b.mime.includes('webm') ? 'webm' : 'm4a');
      zip.file(`${b.tipo}s/${b.id}.${ext}`, b.blob);
      zip.file(`${b.tipo}s/${b.id}.json`, JSON.stringify({ id: b.id, tipo: b.tipo, mime: b.mime, creado: b.creado }));
    }
    const salida = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const nombre = `inspecciones_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`;
    const archivo = new File([salida], nombre, { type: 'application/zip' });
    info.textContent = `ZIP listo: ${fmt.bytes(salida.size)}`;
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: nombre }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    descargar(salida, nombre);
  } catch (e) {
    info.textContent = 'No se pudo exportar: ' + (e.message || e);
  }
}

async function importarZip(archivo) {
  if (!archivo) return;
  if (!confirm('Importar agrega lo que falte y actualiza lo que ya exista (no borra nada). ¿Continuar?')) return;
  const info = document.getElementById('aj-export');
  info.textContent = 'Importando…';
  try {
    const zip = await window.JSZip.loadAsync(archivo);
    const datos = JSON.parse(await zip.file('datos.json').async('string'));
    for (const store of ['locales', 'visitas', 'hallazgos', 'ajustes']) {
      for (const obj of datos[store] || []) await db.guardar(store, obj);
    }
    let n = 0;
    const metas = Object.keys(zip.files).filter(f => f.endsWith('.json') && f !== 'datos.json');
    for (const metaPath of metas) {
      const meta = JSON.parse(await zip.file(metaPath).async('string'));
      const base = metaPath.replace(/\.json$/, '');
      const archivoBlob = Object.keys(zip.files).find(f => f.startsWith(base + '.') && !f.endsWith('.json'));
      if (!archivoBlob) continue;
      const contenido = await zip.file(archivoBlob).async('blob');
      const blob = new Blob([contenido], { type: meta.mime || '' });
      await db.guardar('blobs', { id: meta.id, tipo: meta.tipo, mime: meta.mime, creado: meta.creado, blob });
      n++;
    }
    info.textContent = `Importado: ${(datos.visitas || []).length} visitas, ${(datos.hallazgos || []).length} hallazgos, ${n} archivos.`;
    toast('Importación lista');
    setTimeout(render, 800);
  } catch (e) {
    info.textContent = 'No se pudo importar: ' + (e.message || e);
  }
}

// ---------------------------------------------------------------- acciones (delegación)

app.addEventListener('click', async e => {
  const el = e.target.closest('[data-accion]');
  if (!el || el.tagName === 'INPUT') return;
  const a = el.dataset.accion;
  const id = el.dataset.id;
  switch (a) {
    case 'ir': ir(el.dataset.ruta); break;
    case 'volver-inicio': ir(''); break;
    case 'elegir-local': elegirLocalDialogo(); break;
    case 'iniciar-visita': iniciarVisita(); break;
    case 'descartar-visita': {
      if (!confirm('¿Descartar la visita en curso? Se borran sus audios y fotos.')) return;
      const v = await db.uno('visitas', id);
      if (v) await db.borrarVisitaCompleta(v);
      render();
      break;
    }
    case 'resuelto': {
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      h.estado = 'resuelto'; h.resueltoEnVisitaId = el.dataset.visita;
      estado.siguenPendientes.delete(h.id);
      await db.guardar('hallazgos', h);
      render();
      break;
    }
    case 'sigue': {
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      if (h.estado === 'resuelto' && h.resueltoEnVisitaId === el.dataset.visita) { h.estado = 'abierto'; delete h.resueltoEnVisitaId; await db.guardar('hallazgos', h); }
      estado.siguenPendientes.add(h.id);
      render();
      break;
    }
    case 'cerrar-visita': cerrarVisita(id); break;
    case 'borrar-hallazgo': {
      if (!confirm('¿Borrar este hallazgo?')) return;
      const h = await db.uno('hallazgos', id);
      if (h) await db.borrarHallazgoCompleto(h);
      if (estado.vista === 'grabacion') refrescarListaGrabados(); else render();
      break;
    }
    case 'reintentar': { const h = await db.uno('hallazgos', id); if (h) reintentar(h); break; }
    case 'categoria': {
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      h.categoria = el.dataset.valor; h.categoriaSugerida = false;
      await db.guardar('hallazgos', h);
      reemplazarTarjetaRevision(h);
      break;
    }
    case 'severidad': {
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      h.severidad = el.dataset.valor; h.severidadSugerida = false;
      await db.guardar('hallazgos', h);
      reemplazarTarjetaRevision(h);
      break;
    }
    case 'agregar-manual': agregarManual(el.dataset.visita); break;
    case 'confirmar-visita': confirmarVisita(id); break;
    case 'regenerar-pdf': {
      const v = await db.uno('visitas', id);
      try { await regenerarPDF(v); toast('Informe regenerado'); render(); } catch (err) { toast('No se pudo generar el PDF: ' + (err.message || err), 'error'); }
      break;
    }
    case 'compartir-pdf': compartirPDF(id); break;
    case 'filtro-local': filtroLocal = el.dataset.valor || null; render(); break;
    case 'editar-local': editarLocalDialogo(id); break;
    case 'cargar-modelo': asegurarModelo().catch(err => toast(err.message, 'error')); break;
    case 'exportar-zip': exportarZip(); break;
  }
});

app.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('[data-foto-para]')) { await guardarFoto(t.dataset.fotoPara, t.files && t.files[0]); t.value = ''; return; }
  if (t.matches('[data-accion="importar-zip"]')) { await importarZip(t.files && t.files[0]); t.value = ''; return; }
  if (t.matches('[data-accion="modelo"]')) { await cambiarModelo(t.value); render(); return; }
});

let guardadoTimer = null;
app.addEventListener('input', e => {
  const t = e.target;
  if (!t.matches('[data-campo="descripcion"]')) return;
  clearTimeout(guardadoTimer);
  guardadoTimer = setTimeout(async () => {
    const h = await db.uno('hallazgos', t.dataset.id);
    if (!h) return;
    h.descripcion = t.value;
    await db.guardar('hallazgos', h);
  }, 400);
});

async function reemplazarTarjetaRevision(h) {
  const actual = app.querySelector(`.tarjeta-rev[data-hid="${h.id}"]`);
  if (!actual) return;
  const ta = actual.querySelector('textarea');
  if (ta && document.activeElement === ta) { h.descripcion = ta.value; }
  const tmp = document.createElement('div');
  tmp.innerHTML = tarjetaRevision(h);
  const nueva = tmp.firstElementChild;
  actual.replaceWith(nueva);
  const foto = nueva.querySelector('[data-foto]');
  if (foto && foto.dataset.foto) { const url = await urlBlob(foto.dataset.foto); if (url) { foto.innerHTML = `<img src="${url}" alt="">`; foto.classList.add('con-foto'); } }
}

// ---------------------------------------------------------------- reacciones a eventos internos

on('modelo', () => {
  const pill = document.getElementById('pill-modelo');
  if (pill) pill.innerHTML = pillModelo();
  if (estado.vista === 'grabacion') refrescarListaGrabados();
  const est = document.getElementById('aj-estado');
  if (est) est.textContent = estado.modelo.fase === 'listo' ? 'Listo' : estado.modelo.texto;
  const barra = document.getElementById('aj-barra');
  if (barra) {
    const archivos = Object.values(estado.modelo.progreso);
    const total = archivos.reduce((a, x) => a + (x.total || 0), 0);
    const bajado = archivos.reduce((a, x) => a + (x.loaded || 0), 0);
    barra.style.setProperty('--p', total ? `${Math.min(100, bajado / total * 100)}%` : '0%');
    barra.classList.toggle('visible', estado.modelo.fase === 'descargando');
  }
  if (estado.vista === 'ajustes' && (estado.modelo.fase === 'listo' || estado.modelo.fase === 'error')) render();
});
on('hallazgo', h => {
  if (estado.vista === 'grabacion') refrescarListaGrabados();
  if (estado.vista === 'revision') {
    reemplazarTarjetaRevision(h);
    db.hallazgosDeVisita(h.visitaId).then(hs => {
      const n = hs.filter(x => x.estadoProceso === 'grabado' || x.estadoProceso === 'transcribiendo').length;
      const el = document.getElementById('rev-proceso');
      if (el) el.innerHTML = n ? `<span class="spinner"></span> ${n} en proceso: transcribiendo` : '';
    });
  }
});
let firmaGPS = '';
on('gps', async () => {
  if (estado.vista !== '' || renderizando) return;
  // Solo vuelve a dibujar Inicio si cambió qué locales están cerca, no en cada lectura del GPS.
  const locales = await db.localesActivos();
  const cerca = candidatos(locales).filter(c => c.distancia <= UMBRAL_METROS).map(c => c.local.id).join(',');
  const firma = `${estado.gps.permiso}|${cerca}|${estado.gps.pos ? 1 : 0}`;
  if (firma !== firmaGPS) { firmaGPS = firma; render(); }
});

// ---------------------------------------------------------------- arranque

async function arrancar() {
  await cargarLocalesSiHaceFalta();
  if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (_) {} }
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('./sw.js'); } catch (e) { console.warn('SW', e); }
  }
  iniciarGPS();
  await render();
  procesarPendientes();
}
arrancar();
