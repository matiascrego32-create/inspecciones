// Inspecciones · app web. Grabación, PDF y datos en el teléfono; transcripción con Whisper large-v3 en Groq
// (nivel gratuito) a través de un intermediario propio que guarda la clave.

import { db, uuid, cargarLocalesSiHaceFalta } from './db.js';
import { Grabadora } from './audio.js';
import { transcribirRemoto, wavDePrueba, MODELOS_GROQ, MODELO_GROQ_POR_DEFECTO, ErrorTranscripcion } from './groq.js';
import { clasificar, resumir, CATEGORIAS, SEVERIDADES, RESPONSABLES_POR_DEFECTO, sugerirResponsable } from './clasificador.js';
import { generarWord } from './word.js';
import { generarInforme } from './pdf.js';

const app = document.getElementById('app');
const UMBRAL_METROS = 200;

const estado = {
  // Servicio de transcripción: configurado = hay dirección; online = hay red; espera = hasta cuándo no reintentar (límite)
  servicio: { configurado: false, online: navigator.onLine !== false, esperaHasta: 0, ultimoError: null, probando: false },
  gps: { pos: null, error: null, permiso: 'desconocido' },
  cola: { corriendo: false, enProceso: null, pendientes: 0 },
  vista: null,
  localElegido: null,
  siguenPendientes: new Set(),
};

const AJUSTES_POR_DEFECTO = {
  servicioUrl: '',
  servicioCodigo: '',
  servicioClave: '',
  servicioModelo: MODELO_GROQ_POR_DEFECTO,
  terminos: 'CANIMEL, CEDINA, CENEPA, Diálisis Rodo, FILSA, Uruguayana, INU, SEDIC, hemodiálisis, ósmosis, sillón, matafuego, sala de diálisis, planta de agua',
};
let responsablesCache = null;
async function cargarResponsables() {
  responsablesCache = await db.ajuste('responsables', RESPONSABLES_POR_DEFECTO);
  return responsablesCache;
}
async function guardarResponsables(lista) {
  const limpia = [];
  for (const n of lista) {
    const t = String(n || '').trim();
    if (t && !limpia.some(x => x.toLowerCase() === t.toLowerCase())) limpia.push(t);
  }
  responsablesCache = limpia;
  await db.setAjuste('responsables', limpia);
  return limpia;
}

async function ajustesServicio() {
  const r = {};
  for (const k of Object.keys(AJUSTES_POR_DEFECTO)) r[k] = await db.ajuste(k, AJUSTES_POR_DEFECTO[k]);
  estado.servicio.configurado = !!(r.servicioUrl || '').trim();
  return r;
}

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
  let enCola = 'En cola';
  if (h.estadoProceso === 'grabado') {
    if (!estado.servicio.configurado) enCola = 'Falta configurar la transcripción';
    else if (!estado.servicio.online) enCola = 'Esperando señal';
    else if (estado.servicio.esperaHasta > Date.now()) enCola = 'Esperando (límite gratuito)';
    else if (h.errorMensaje) enCola = 'Se reintenta';
  }
  const m = {
    grabado: ['⏱', enCola, ''],
    transcribiendo: ['', 'Transcribiendo…', 'proc'],
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

// ---------------------------------------------------------------- servicio de transcripción (Groq vía intermediario)

let reintentoTimer = null;
function programarReintento(segundos) {
  clearTimeout(reintentoTimer);
  reintentoTimer = setTimeout(() => { reintentoTimer = null; procesarPendientes(); }, Math.max(5, segundos) * 1000);
}

window.addEventListener('online', () => { estado.servicio.online = true; emitir('servicio'); procesarPendientes(); });
window.addEventListener('offline', () => { estado.servicio.online = false; emitir('servicio'); });

/** Texto corto del estado del servicio, para la pastilla de Grabación y el pie de Inicio. */
function textoServicio() {
  const s = estado.servicio;
  if (!s.configurado) return { texto: 'Falta configurar la transcripción', nivel: 'err' };
  if (!s.online) return { texto: 'Sin señal: los audios esperan', nivel: 'aviso' };
  if (s.esperaHasta > Date.now()) return { texto: `Límite gratuito: reintento ${fmt.hora(s.esperaHasta)}`, nivel: 'aviso' };
  if (s.ultimoError) return { texto: s.ultimoError, nivel: 'err' };
  if (estado.cola.corriendo) return { texto: 'Transcribiendo…', nivel: 'aviso' };
  return { texto: 'Transcripción lista', nivel: 'ok' };
}

/** Prueba la conexión mandando un segundo de audio. Devuelve texto de resultado. */
async function probarServicio() {
  const a = await ajustesServicio();
  estado.servicio.probando = true;
  emitir('servicio');
  try {
    await transcribirRemoto({ blob: wavDePrueba(), url: a.servicioUrl.trim(), codigo: a.servicioCodigo.trim(), apiKey: a.servicioClave.trim(), modelo: a.servicioModelo, prompt: '' });
    estado.servicio.ultimoError = null;
    return { ok: true, texto: 'Conexión correcta: el servicio responde.' };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    if (!(e instanceof ErrorTranscripcion) || !e.transitorio) estado.servicio.ultimoError = msg;
    return { ok: false, texto: msg };
  } finally {
    estado.servicio.probando = false;
    emitir('servicio');
  }
}

// ---------------------------------------------------------------- cola de procesamiento

async function procesarPendientes() {
  if (estado.cola.corriendo) return;
  // Se marca antes de cualquier espera: dos llamadas casi simultáneas (por ejemplo, dos eventos "online")
  // no deben mandar el mismo audio dos veces.
  estado.cola.corriendo = true;
  try {
    if (estado.servicio.esperaHasta > Date.now()) { programarReintento((estado.servicio.esperaHasta - Date.now()) / 1000 + 1); return; }
    const a = await ajustesServicio();
    if (!estado.servicio.configurado) { emitir('servicio'); return; }
    if (navigator.onLine === false) { estado.servicio.online = false; emitir('servicio'); return; }
    emitir('servicio');
    let lista = await db.hallazgosPendientesDeProceso();
    estado.cola.pendientes = lista.length;
    while (lista.length > 0) {
      const h = lista[0];
      const seguir = await procesarHallazgo(h, a);
      if (!seguir) break; // sin red o límite: se reintenta después
      lista = await db.hallazgosPendientesDeProceso();
      estado.cola.pendientes = lista.length;
    }
  } finally {
    estado.cola.corriendo = false;
    estado.cola.enProceso = null;
    emitir('cola');
    emitir('servicio');
  }
}

/** Devuelve false si hay que cortar la cola (sin conexión, límite, servidor caído). */
async function procesarHallazgo(h, a) {
  estado.cola.enProceso = h.id;
  h.estadoProceso = 'transcribiendo';
  h.errorMensaje = null;
  await db.guardar('hallazgos', h);
  emitir('hallazgo', h);
  try {
    const blob = await db.blob(h.audioId);
    if (!blob) throw new ErrorTranscripcion('otro', 'No se encontró el audio');
    const texto = await transcribirRemoto({
      blob, url: a.servicioUrl.trim(), codigo: a.servicioCodigo.trim(), apiKey: a.servicioClave.trim(),
      modelo: a.servicioModelo, prompt: a.terminos,
    });
    const actual = await db.uno('hallazgos', h.id);
    if (!actual) return true; // lo borraron mientras tanto
    if (!texto) {
      actual.estadoProceso = 'error';
      actual.errorMensaje = 'No se reconoció voz en el audio.';
      await db.guardar('hallazgos', actual);
      emitir('hallazgo', actual);
      return true;
    }
    actual.transcripcion = texto;
    const sug = clasificar(texto);
    if (!actual.descripcion) actual.descripcion = sug.descripcion;
    if (!actual.categoria) { actual.categoria = sug.categoria; actual.categoriaSugerida = true; }
    if (!actual.severidad) { actual.severidad = sug.severidad; actual.severidadSugerida = true; }
    if (!actual.responsable) {
      const r = sugerirResponsable(texto, responsablesCache || await cargarResponsables());
      if (r) { actual.responsable = r; actual.responsableSugerido = true; }
    }
    actual.estadoProceso = 'listo';
    actual.errorMensaje = null;
    await db.guardar('hallazgos', actual);
    estado.servicio.ultimoError = null;
    emitir('hallazgo', actual);
    return true;
  } catch (e) {
    const actual = await db.uno('hallazgos', h.id);
    if (!actual) return true;
    const msg = e && e.message ? e.message : String(e);
    if (e instanceof ErrorTranscripcion && e.transitorio) {
      // Vuelve a la cola; se reintenta cuando haya señal o pase la espera.
      actual.estadoProceso = 'grabado';
      actual.errorMensaje = msg;
      await db.guardar('hallazgos', actual);
      emitir('hallazgo', actual);
      if (e.tipo === 'limite') { estado.servicio.esperaHasta = Date.now() + (e.esperarSegundos || 300) * 1000; programarReintento(e.esperarSegundos || 300); }
      else if (e.tipo === 'red') { if (navigator.onLine === false) estado.servicio.online = false; else programarReintento(60); }
      else programarReintento(120);
      return false;
    }
    actual.estadoProceso = 'error';
    actual.errorMensaje = msg;
    await db.guardar('hallazgos', actual);
    if (e instanceof ErrorTranscripcion && (e.tipo === 'clave' || e.tipo === 'config')) estado.servicio.ultimoError = msg;
    emitir('hallazgo', actual);
    return e instanceof ErrorTranscripcion && e.tipo !== 'clave' && e.tipo !== 'config';
  }
}

async function reintentar(h) {
  h.estadoProceso = 'grabado';
  h.errorMensaje = null;
  await db.guardar('hallazgos', h);
  estado.servicio.ultimoError = null;
  estado.servicio.esperaHasta = 0;
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

  // Aviso de configuración o de audios esperando
  await ajustesServicio();
  const enCola = (await db.hallazgosPendientesDeProceso()).length;
  let avisoServicio = '';
  if (!estado.servicio.configurado) {
    avisoServicio = `
      <a class="card aviso-card" href="#/ajustes">
        <div class="t16">Falta configurar la transcripción</div>
        <div class="sec peq">Entrá a Ajustes y pegá la dirección del servicio. Mientras tanto podés grabar: los audios quedan en cola.</div>
      </a>`;
  } else if (enCola > 0) {
    avisoServicio = `
      <div class="card">
        <div class="t16">${enCola} ${enCola === 1 ? 'audio esperando transcripción' : 'audios esperando transcripción'}</div>
        <div class="sec peq">${esc(textoServicio().texto)}</div>
        <button class="btn btn-sec chico" data-accion="procesar-ahora">Reintentar ahora</button>
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
      ${avisoServicio}
      <div class="espacio"></div>
      <p class="pie">Los datos se guardan en este iPhone. Transcripción con Whisper large-v3 en Groq (gratis).<br><span id="pie-servicio">${esc(textoServicio().texto)}</span></p>
    </div>`;
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
          ${h.visita ? `<div class="sec peq">Visita del ${fmt.fechaCorta(h.visita.inicio)}${h.responsable ? ` · ${esc(h.responsable)}` : ''}</div>` : ''}
        </div>
        ${botonBorrar(h)}
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
  const t = textoServicio();
  return `<span class="punto ${t.nivel}"></span><span>${esc(t.texto)}</span>`;
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
        : botonBorrar(h)}
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
      } catch (e) {
        err.textContent = e.name === 'NotAllowedError' ? 'Sin permiso de micrófono. Activalo en Ajustes → Safari → Micrófono.' : (e.message || 'No se pudo grabar');
      }
    }
  };
  await ajustesServicio();
  const pill = document.getElementById('pill-modelo');
  if (pill) pill.innerHTML = pillModelo();
  procesarPendientes();
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
  await cargarResponsables();
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
        ${botonBorrar(h)}
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
      <div class="campo">
        <span class="etiqueta-campo">Responsable${h.responsableSugerido ? ' <span class="sug">sugerido</span>' : ''}</span>
        <div class="chips">${chipsResponsable(h)}</div>
      </div>
      <div class="fila">
        <div class="foto-thumb chica" data-foto="${h.fotoId || ''}">${ICONO.camara}</div>
        <span class="sec">${h.fotoId ? 'Con foto' : 'Sin foto'}</span>
        <span class="espacio"></span>
        <label class="btn btn-sec chico"><span>${h.fotoId ? 'Cambiar' : 'Agregar foto'}</span><input type="file" accept="image/*" capture="environment" hidden data-foto-para="${h.id}"></label>
      </div>
    </div>`;
}
function chipsResponsable(h) {
  const lista = [...(responsablesCache || RESPONSABLES_POR_DEFECTO)];
  // Si el hallazgo tiene un responsable que ya no está en la lista, se sigue mostrando.
  if (h.responsable && !lista.includes(h.responsable)) lista.unshift(h.responsable);
  return lista.map(n => `<button class="chip ${h.responsable === n ? 'activo' : ''}" data-accion="responsable" data-id="${h.id}" data-valor="${esc(n)}">${esc(n)}</button>`).join('')
    + `<button class="chip chip-agregar" data-accion="nuevo-responsable" data-id="${h.id}">+ Otro</button>`;
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
  const pdf = await generarInforme(await datosInforme(visita));
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
        <div class="sec peq">${esc(tituloDe(CATEGORIAS, h.categoria) || 'Sin categoría')}${h.responsable ? ` · <strong>Responsable:</strong> ${esc(h.responsable)}` : ''}</div>
        ${h.transcripcion ? `<div class="sec peq">“${esc(h.transcripcion)}”</div>` : ''}
        ${h.fotoId ? `<div class="foto-thumb inf-foto" data-foto="${h.fotoId}">${ICONO.camara}</div>` : ''}
      </div>
      <div class="inf-acciones">${badgeSeveridad(h.severidad)}${botonBorrar(h, true)}</div>
    </div>`;
  const filaPend = (h, estadoTxt, clase) => {
    const v = vmap[h.visitaId];
    return `<div class="inf-fila"><div class="col"><div class="t15">${esc(tituloHallazgo(h))}</div>${v ? `<div class="sec peq">Visita del ${fmt.fechaCorta(v.inicio)}${h.responsable ? ` · ${esc(h.responsable)}` : ''}</div>` : ''}</div><span class="badge ${clase}">${estadoTxt}</span></div>`;
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
      <div class="dos">
        ${url ? `<a class="btn btn-sec" href="${url}" target="_blank" rel="noopener">${ICONO.doc}<span>Ver PDF</span></a>` : ''}
        <button class="btn btn-sec" data-accion="regenerar-pdf" data-id="${visita.id}">Volver a generar</button>
      </div>
      <a class="btn btn-texto" href="#/revision/${visita.id}">Corregir hallazgos</a>
    </div>
    <div class="pie-fijo dos">
      <button class="btn btn-sec" data-accion="compartir-word" data-id="${visita.id}">${ICONO.doc}<span>Word</span></button>
      <button class="btn btn-pri" data-accion="compartir-pdf" data-id="${visita.id}" ${url ? '' : 'disabled'}>${ICONO.compartir}<span>PDF</span></button>
    </div>`;
}
// Los archivos se preparan apenas se abre el informe. En iPhone, Safari solo abre el menú de compartir
// si se llama en el mismo instante del toque: si antes hay que esperar a armar el archivo, lo bloquea
// y WhatsApp nunca aparece.
const archivosListos = { visitaId: null, pdf: null, word: null, preparando: null };

function nombreArchivo(local, visita, ext) {
  return `Inspeccion_${(local ? local.nombre : 'local').replace(/[^\wÁÉÍÓÚÑáéíóúñ-]+/g, '_')}_${new Date(visita.inicio).toISOString().slice(0, 10)}.${ext}`;
}

async function prepararArchivos(visitaId) {
  archivosListos.visitaId = visitaId;
  archivosListos.pdf = null;
  archivosListos.word = null;
  const tarea = (async () => {
    const visita = await db.uno('visitas', visitaId);
    if (!visita) return;
    const datos = await datosInforme(visita);
    const pdfBlob = await db.blob(visita.pdfId);
    if (archivosListos.visitaId !== visitaId) return;
    if (pdfBlob) archivosListos.pdf = new File([pdfBlob], nombreArchivo(datos.local, visita, 'pdf'), { type: 'application/pdf' });
    try {
      const wordBlob = await generarWord(datos);
      if (archivosListos.visitaId !== visitaId) return;
      archivosListos.word = new File([wordBlob], nombreArchivo(datos.local, visita, 'docx'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    } catch (e) {
      console.warn('Word', e);
    }
  })();
  archivosListos.preparando = tarea;
  await tarea;
  marcarBotonesListos();
}

function marcarBotonesListos() {
  for (const tipo of ['pdf', 'word']) {
    const b = app.querySelector(`[data-accion="compartir-${tipo}"]`);
    if (!b) continue;
    const listo = !!archivosListos[tipo];
    b.disabled = !listo;
    const etiqueta = b.querySelector('span:last-child');
    if (etiqueta) etiqueta.textContent = listo ? (tipo === 'pdf' ? 'PDF' : 'Word') : 'Preparando…';
  }
}

vistaInforme.montar = async id => {
  cargarFotosThumb();
  marcarBotonesListos();
  prepararArchivos(id); // sin esperar: la pantalla queda usable mientras se arman
};

/** Se llama sin ninguna espera previa, directo desde el toque. */
function compartirArchivo(tipo, id) {
  const archivo = archivosListos.visitaId === id ? archivosListos[tipo] : null;
  if (!archivo) { toast('El archivo todavía se está preparando. Probá de nuevo en un segundo.'); return; }
  // Solo el archivo, sin título ni texto: con texto, WhatsApp en iPhone a veces manda solo el texto.
  if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [archivo] }))) {
    navigator.share({ files: [archivo] }).catch(e => {
      if (e && e.name === 'AbortError') return;
      if (e && e.name === 'NotAllowedError') { ofrecerCompartir(archivo); return; }
      descargar(archivo, archivo.name);
    });
    return;
  }
  descargar(archivo, archivo.name);
}

/** Plan B si iOS rechazó el primer intento: un botón nuevo, que es un toque nuevo. */
function ofrecerCompartir(archivo) {
  const hoja = document.createElement('div');
  hoja.className = 'hoja';
  hoja.innerHTML = `
    <div class="hoja-panel">
      <div class="hoja-enc"><strong>${esc(archivo.name)}</strong><button class="btn-texto" data-cerrar>Cerrar</button></div>
      <button class="btn btn-pri grande" data-compartir>${ICONO.compartir}<span>Compartir</span></button>
      <button class="btn btn-sec" data-guardar>Guardar en Archivos</button>
    </div>`;
  document.body.appendChild(hoja);
  hoja.addEventListener('click', e => {
    if (e.target.closest('[data-compartir]')) {
      navigator.share({ files: [archivo] }).then(() => hoja.remove()).catch(err => { if (err && err.name !== 'AbortError') descargar(archivo, archivo.name); });
      return;
    }
    if (e.target.closest('[data-guardar]')) { descargar(archivo, archivo.name); hoja.remove(); return; }
    if (e.target.closest('[data-cerrar]') || e.target === hoja) hoja.remove();
  });
}

async function datosInforme(visita) {
  const local = await db.uno('locales', visita.localId);
  const nuevos = await db.hallazgosDeVisita(visita.id);
  const resueltos = await db.hallazgosResueltosEnVisita(visita.id);
  const vmap = Object.fromEntries((await db.todos('visitas')).map(v => [v.id, v]));
  resueltos.forEach(h => { h.visita = vmap[h.visitaId]; });
  const siguenAbiertos = (await db.hallazgosAbiertosDeLocal(visita.localId)).filter(h => h.visitaId !== visita.id);
  return { visita, local, nuevos, resueltos, siguenAbiertos, blobDe: id => db.blob(id) };
}

// ---- Borrar hallazgos al toque, con "Deshacer"

let ultimoBorrado = null;   // { hallazgo, blobs: [registros], timer }

async function borrarConDeshacer(h) {
  // Guarda una copia completa (registro + audio + foto) antes de borrar.
  const blobs = [];
  for (const bid of [h.audioId, h.fotoId]) {
    if (!bid) continue;
    const r = await db.uno('blobs', bid);
    if (r) blobs.push(r);
  }
  // Un borrado anterior que ya no se puede deshacer queda definitivo.
  if (ultimoBorrado) clearTimeout(ultimoBorrado.timer);
  ultimoBorrado = { hallazgo: { ...h }, blobs };
  // Si estaba marcado como resuelto en otra visita, no hace falta tocar nada más: se borra y listo.
  await db.borrarHallazgoCompleto(h);
  await refrescarTrasCambio(h);
  mostrarDeshacer(`Hallazgo borrado: ${tituloHallazgo(h).slice(0, 40)}`);
  ultimoBorrado.timer = setTimeout(() => { ultimoBorrado = null; ocultarDeshacer(); }, 6000);
}

async function deshacerBorrado() {
  const b = ultimoBorrado;
  if (!b) return;
  clearTimeout(b.timer);
  ultimoBorrado = null;
  ocultarDeshacer();
  for (const r of b.blobs) await db.guardar('blobs', r);
  const { visita, ...registro } = b.hallazgo; // "visita" puede venir agregado en memoria; no se guarda
  await db.guardar('hallazgos', registro);
  await refrescarTrasCambio(registro);
  toast('Hallazgo recuperado');
  if (registro.estadoProceso === 'grabado' || registro.estadoProceso === 'transcribiendo') {
    registro.estadoProceso = 'grabado';
    await db.guardar('hallazgos', registro);
    procesarPendientes();
  }
}

/** Vuelve a dibujar lo que corresponda después de borrar o recuperar un hallazgo. */
async function refrescarTrasCambio(h) {
  if (estado.vista === 'grabacion') { refrescarListaGrabados(); return; }
  if (estado.vista === 'informe') {
    // El PDF y el Word tienen que reflejar el cambio.
    const v = await db.uno('visitas', rutaActual().param);
    if (v && v.estado === 'confirmada') { try { await regenerarPDF(v); } catch (_) {} }
  }
  render();
}

function mostrarDeshacer(texto) {
  let barra = document.getElementById('deshacer');
  if (!barra) {
    barra = document.createElement('div');
    barra.id = 'deshacer';
    barra.innerHTML = '<span class="txt"></span><button type="button">Deshacer</button>';
    barra.querySelector('button').addEventListener('click', deshacerBorrado);
    document.body.appendChild(barra);
  }
  barra.querySelector('.txt').textContent = texto;
  barra.classList.add('visible');
}
function ocultarDeshacer() {
  const barra = document.getElementById('deshacer');
  if (barra) barra.classList.remove('visible');
}

function botonBorrar(h, chico = false) {
  return `<button class="btn-borrar${chico ? ' chico' : ''}" data-accion="borrar-hallazgo" data-id="${h.id}" aria-label="Borrar hallazgo">${ICONO.basura}</button>`;
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
  const a = await ajustesServicio();
  const responsables = await cargarResponsables();
  const visitas = (await db.todos('visitas')).filter(v => v.estado === 'confirmada').length;
  const hallazgos = (await db.todos('hallazgos')).length;
  const locales = (await db.todos('locales')).length;
  const uso = await db.tamanoAproximado();
  const t = textoServicio();
  return `
    <div class="pantalla">
      ${encabezado('Ajustes y respaldo', { atras: { ruta: '', texto: 'Inicio' } })}

      <div class="etiqueta">TRANSCRIPCIÓN (WHISPER LARGE-V3 EN GROQ)</div>
      <div class="card">
        <label class="campo">
          <span class="etiqueta-campo">Dirección del servicio</span>
          <input type="url" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="https://inspecciones.TU-USUARIO.workers.dev" value="${esc(a.servicioUrl)}" data-ajuste="servicioUrl">
          <span class="sec peq">La dirección del intermediario (Cloudflare Worker) que guarda tu clave de Groq. Cómo crearlo: README del proyecto, 10 minutos, gratis.</span>
        </label>
        <label class="campo">
          <span class="etiqueta-campo">Código de acceso (opcional)</span>
          <input type="password" autocapitalize="off" autocorrect="off" placeholder="El mismo que pusiste en el Worker como APP_CODE" value="${esc(a.servicioCodigo)}" data-ajuste="servicioCodigo">
        </label>
        <div class="campo">
          <span class="etiqueta-campo">Modelo</span>
          <div class="radios">
            ${Object.entries(MODELOS_GROQ).map(([k, d]) => `
              <label class="radio ${a.servicioModelo === k ? 'activo' : ''}">
                <input type="radio" name="servicioModelo" value="${k}" ${a.servicioModelo === k ? 'checked' : ''} data-ajuste="servicioModelo">
                <span class="col"><span class="t16">${esc(d.titulo)}</span><span class="sec peq">${esc(d.detalle)}</span></span>
              </label>`).join('')}
          </div>
        </div>
        <div class="entre"><span>Estado</span><span class="sec" id="aj-estado">${esc(t.texto)}</span></div>
        <button class="btn btn-sec" data-accion="probar-servicio" ${estado.servicio.probando ? 'disabled' : ''}>${estado.servicio.probando ? 'Probando…' : 'Probar conexión'}</button>
        <div class="sec peq" id="aj-prueba"></div>
        <p class="sec peq">Cada audio se envía a Groq para transcribirlo con Whisper large-v3 (nivel gratuito: hasta 8 horas de audio por día). Si no hay señal, los audios quedan en cola y se transcriben cuando vuelve.</p>
      </div>

      <details class="card detalles">
        <summary class="t16">Avanzado: llamar a Groq directo (sin intermediario)</summary>
        <p class="sec peq">Groq no acepta pedidos directos desde el navegador en la mayoría de los casos, y la clave quedaría guardada en este teléfono. Usalo solo si sabés lo que hacés: dirección <code>https://api.groq.com/openai/v1/audio/transcriptions</code> y la clave acá.</p>
        <label class="campo">
          <span class="etiqueta-campo">Clave de Groq (gsk_…)</span>
          <input type="password" autocapitalize="off" autocorrect="off" value="${esc(a.servicioClave)}" data-ajuste="servicioClave">
        </label>
      </details>

      <div class="etiqueta">RESPONSABLES</div>
      <div class="card">
        <p class="sec peq">A quién le corresponde solucionar cada problema. Pueden ser roles (Electricista) o nombres (Juan Pérez, Empresa X). La app sugiere uno por palabras clave y se cambia con un toque en la revisión.</p>
        <div class="chips">${responsables.map(n => `<span class="chip chip-quitar">${esc(n)}<button class="x" data-accion="quitar-responsable" data-valor="${esc(n)}" aria-label="Quitar ${esc(n)}">×</button></span>`).join('') || '<span class="sec peq">La lista está vacía.</span>'}</div>
        <div class="fila">
          <input id="nuevo-responsable" type="text" placeholder="Agregar nombre o rol" autocapitalize="sentences" style="flex:1">
          <button class="btn btn-sec chico" data-accion="agregar-responsable-ajustes">Agregar</button>
        </div>
        <button class="btn-texto" data-accion="restaurar-responsables" style="align-self:flex-start">Volver a la lista original</button>
      </div>

      <div class="etiqueta">TÉRMINOS PARA LA TRANSCRIPCIÓN</div>
      <div class="card">
        <textarea rows="3" data-ajuste="terminos" placeholder="Nombres de locales y palabras internas, separados por coma">${esc(a.terminos)}</textarea>
        <p class="sec peq">Se le pasan a Whisper como contexto para que escriba bien los nombres propios y la jerga (CEDINA, SEDIC, ósmosis…).</p>
      </div>

      <div class="etiqueta">CLASIFICACIÓN DE HALLAZGOS</div>
      <div class="card">
        <p class="sec">La app <strong>sugiere</strong> categoría y severidad por palabras clave de la transcripción, y el jefe confirma o corrige con un toque en la revisión.</p>
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
      <p class="sec peq centrado">Espacio usado: ${uso ? fmt.bytes(uso) : 'no disponible'}</p>

      <p class="pie">Del teléfono solo salen los audios hacia Groq para transcribirlos, y el respaldo que exportás vos.</p>
    </div>`;
}

let ajusteTimer = null;
async function guardarAjuste(clave, valor) {
  await db.setAjuste(clave, valor);
  if (clave === 'servicioUrl' || clave === 'servicioCodigo' || clave === 'servicioClave') {
    estado.servicio.ultimoError = null;
    estado.servicio.esperaHasta = 0;
    await ajustesServicio();
    emitir('servicio');
  }
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
      const h = await db.uno('hallazgos', id);
      if (h) await borrarConDeshacer(h);
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
    case 'responsable': {
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      // Tocar el que ya está elegido lo quita.
      h.responsable = h.responsable === el.dataset.valor && !h.responsableSugerido ? null : el.dataset.valor;
      h.responsableSugerido = false;
      await db.guardar('hallazgos', h);
      reemplazarTarjetaRevision(h);
      break;
    }
    case 'nuevo-responsable': {
      const nombre = (prompt('Nombre o rol del responsable (por ejemplo: Electricista, Juan Pérez, Empresa de aire acondicionado):') || '').trim();
      if (!nombre) return;
      const lista = await cargarResponsables();
      const existente = lista.find(x => x.toLowerCase() === nombre.toLowerCase());
      if (!existente) await guardarResponsables([...lista, nombre]);
      const h = await db.uno('hallazgos', id);
      if (!h) return;
      h.responsable = existente || nombre;
      h.responsableSugerido = false;
      await db.guardar('hallazgos', h);
      // Actualiza todas las tarjetas para que el nuevo nombre aparezca en cada una.
      for (const card of app.querySelectorAll('.tarjeta-rev')) {
        const otro = await db.uno('hallazgos', card.dataset.hid);
        if (otro) reemplazarTarjetaRevision(otro);
      }
      break;
    }
    case 'quitar-responsable': {
      const lista = await cargarResponsables();
      await guardarResponsables(lista.filter(x => x !== el.dataset.valor));
      render();
      break;
    }
    case 'agregar-responsable-ajustes': {
      const input = document.getElementById('nuevo-responsable');
      const nombre = (input && input.value || '').trim();
      if (!nombre) return;
      const lista = await cargarResponsables();
      await guardarResponsables([...lista, nombre]);
      render();
      break;
    }
    case 'restaurar-responsables': {
      if (!confirm('¿Volver a la lista de responsables original? Los hallazgos ya asignados no cambian.')) return;
      await guardarResponsables(RESPONSABLES_POR_DEFECTO);
      render();
      break;
    }
    case 'compartir-word': compartirArchivo('word', id); break;
    case 'agregar-manual': agregarManual(el.dataset.visita); break;
    case 'confirmar-visita': confirmarVisita(id); break;
    case 'regenerar-pdf': {
      const v = await db.uno('visitas', id);
      try { await regenerarPDF(v); toast('Informe regenerado'); render(); } catch (err) { toast('No se pudo generar el PDF: ' + (err.message || err), 'error'); }
      break;
    }
    case 'compartir-pdf': compartirArchivo('pdf', id); break;
    case 'filtro-local': filtroLocal = el.dataset.valor || null; render(); break;
    case 'editar-local': editarLocalDialogo(id); break;
    case 'probar-servicio': {
      const info = document.getElementById('aj-prueba');
      if (info) info.textContent = 'Probando…';
      el.disabled = true;
      const r = await probarServicio();
      el.disabled = false;
      if (info) { info.textContent = r.texto; info.className = 'sec peq ' + (r.ok ? 'ok-txt' : 'rojo'); }
      break;
    }
    case 'procesar-ahora': estado.servicio.esperaHasta = 0; estado.servicio.ultimoError = null; procesarPendientes(); toast('Reintentando…'); break;
    case 'exportar-zip': exportarZip(); break;
  }
});

app.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'nuevo-responsable') {
    e.preventDefault();
    const b = app.querySelector('[data-accion="agregar-responsable-ajustes"]');
    if (b) b.click();
  }
});

app.addEventListener('change', async e => {
  const t = e.target;
  if (t.matches('[data-foto-para]')) { await guardarFoto(t.dataset.fotoPara, t.files && t.files[0]); t.value = ''; return; }
  if (t.matches('[data-accion="importar-zip"]')) { await importarZip(t.files && t.files[0]); t.value = ''; return; }
  if (t.matches('[data-ajuste]')) {
    await guardarAjuste(t.dataset.ajuste, t.type === 'checkbox' ? t.checked : t.value.trim());
    if (t.type === 'radio') render();
    return;
  }
});

let guardadoTimer = null;
app.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('[data-ajuste]') && t.type !== 'radio') {
    clearTimeout(ajusteTimer);
    ajusteTimer = setTimeout(() => guardarAjuste(t.dataset.ajuste, t.value.trim()), 400);
    return;
  }
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

on('servicio', () => {
  const pill = document.getElementById('pill-modelo');
  if (pill) pill.innerHTML = pillModelo();
  const t = textoServicio();
  const est = document.getElementById('aj-estado');
  if (est) est.textContent = t.texto;
  const pie = document.getElementById('pie-servicio');
  if (pie) pie.textContent = t.texto;
  if (estado.vista === 'grabacion') refrescarListaGrabados();
});
on('cola', () => {
  if (estado.vista === '' && !renderizando) render();
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
  await ajustesServicio();
  iniciarGPS();
  await render();
  procesarPendientes();
}
arrancar();
