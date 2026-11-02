// Base de datos local: IndexedDB. Todo queda en el teléfono.
// Stores: locales, visitas, hallazgos, blobs (audios, fotos, PDF), ajustes.

const DB_NOMBRE = 'inspecciones';
const DB_VERSION = 1;

let dbPromesa = null;

function abrir() {
  if (dbPromesa) return dbPromesa;
  dbPromesa = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NOMBRE, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('locales')) {
        db.createObjectStore('locales', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('visitas')) {
        const s = db.createObjectStore('visitas', { keyPath: 'id' });
        s.createIndex('localId', 'localId');
        s.createIndex('estado', 'estado');
      }
      if (!db.objectStoreNames.contains('hallazgos')) {
        const s = db.createObjectStore('hallazgos', { keyPath: 'id' });
        s.createIndex('visitaId', 'visitaId');
        s.createIndex('estadoProceso', 'estadoProceso');
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('ajustes')) {
        db.createObjectStore('ajustes', { keyPath: 'clave' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromesa;
}

function tx(store, modo, fn) {
  return abrir().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, modo);
    const s = t.objectStore(store);
    let resultado;
    try {
      resultado = fn(s);
    } catch (e) {
      reject(e);
      return;
    }
    t.oncomplete = () => {
      if (resultado && typeof resultado.then === 'function') resultado.then(resolve, reject);
      else if (resultado && 'result' in resultado) resolve(resultado.result);
      else resolve(resultado);
    };
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function pedir(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// --- Genéricos ---

export const db = {
  todos(store) {
    return tx(store, 'readonly', s => pedir(s.getAll()));
  },
  uno(store, id) {
    return tx(store, 'readonly', s => pedir(s.get(id)));
  },
  porIndice(store, indice, valor) {
    return tx(store, 'readonly', s => pedir(s.index(indice).getAll(valor)));
  },
  guardar(store, obj) {
    return tx(store, 'readwrite', s => pedir(s.put(obj))).then(() => obj);
  },
  borrar(store, id) {
    return tx(store, 'readwrite', s => pedir(s.delete(id)));
  },
  vaciar(store) {
    return tx(store, 'readwrite', s => pedir(s.clear()));
  },

  // --- Ajustes clave/valor ---
  async ajuste(clave, porDefecto) {
    const r = await this.uno('ajustes', clave);
    return r ? r.valor : porDefecto;
  },
  setAjuste(clave, valor) {
    return this.guardar('ajustes', { clave, valor });
  },

  // --- Blobs ---
  async guardarBlob(blob, tipo) {
    const id = uuid();
    await this.guardar('blobs', { id, blob, tipo, mime: blob.type, creado: Date.now() });
    return id;
  },
  async blob(id) {
    if (!id) return null;
    const r = await this.uno('blobs', id);
    return r ? r.blob : null;
  },
  async borrarBlob(id) {
    if (id) await this.borrar('blobs', id);
  },

  // --- Consultas de dominio ---
  async localesActivos() {
    const l = await this.todos('locales');
    return l.filter(x => x.activo !== false).sort((a, b) => a.nombre.localeCompare(b.nombre));
  },
  async visitasDeLocal(localId) {
    return this.porIndice('visitas', 'localId', localId);
  },
  async hallazgosDeVisita(visitaId) {
    const h = await this.porIndice('hallazgos', 'visitaId', visitaId);
    return h.sort((a, b) => a.orden - b.orden);
  },
  /** Hallazgos abiertos del local, de visitas confirmadas, urgentes primero. */
  async hallazgosAbiertosDeLocal(localId) {
    const visitas = (await this.visitasDeLocal(localId)).filter(v => v.estado === 'confirmada');
    const porVisita = await Promise.all(visitas.map(v => this.hallazgosDeVisita(v.id)));
    const peso = { urgente: 0, grave: 1, leve: 2 };
    const vmap = Object.fromEntries(visitas.map(v => [v.id, v]));
    return porVisita.flat()
      .filter(h => h.estado === 'abierto')
      .map(h => ({ ...h, visita: vmap[h.visitaId] }))
      .sort((a, b) => (peso[a.severidad] ?? 3) - (peso[b.severidad] ?? 3) || a.creado - b.creado);
  },
  /** Hallazgos de otras visitas que se marcaron resueltos en esta. */
  async hallazgosResueltosEnVisita(visitaId) {
    const todos = await this.todos('hallazgos');
    return todos.filter(h => h.resueltoEnVisitaId === visitaId);
  },
  async hallazgosPendientesDeProceso() {
    const todos = await this.todos('hallazgos');
    return todos
      .filter(h => h.estadoProceso === 'grabado' || h.estadoProceso === 'transcribiendo')
      .sort((a, b) => a.creado - b.creado);
  },
  async borrarHallazgoCompleto(h) {
    await this.borrarBlob(h.audioId);
    await this.borrarBlob(h.fotoId);
    await this.borrar('hallazgos', h.id);
  },
  async borrarVisitaCompleta(visita) {
    const hs = await this.hallazgosDeVisita(visita.id);
    for (const h of hs) await this.borrarHallazgoCompleto(h);
    await this.borrarBlob(visita.pdfId);
    // Reabre lo que se había marcado resuelto en esta visita.
    const resueltos = await this.hallazgosResueltosEnVisita(visita.id);
    for (const h of resueltos) {
      h.estado = 'abierto';
      delete h.resueltoEnVisitaId;
      await this.guardar('hallazgos', h);
    }
    await this.borrar('visitas', visita.id);
  },
  async tamanoAproximado() {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return e.usage || 0;
    }
    return 0;
  },
};

// --- Datos iniciales: los ocho locales (coordenadas de Google Maps; SEDIC, dirección del equipo) ---

export const LOCALES_INICIALES = [
  { nombre: 'CANIMEL', direccion: '18 de Julio 377, Melo, Cerro Largo', lat: -32.37500, lon: -54.16850 },
  { nombre: 'CEDINA', direccion: 'Estero Bellaco 2586, Montevideo', lat: -34.88617, lon: -56.16218 },
  { nombre: 'CENEPA', direccion: 'Pando, Canelones (confirmar calle)', lat: -34.72373, lon: -55.96271 },
  { nombre: 'DIALISIS RODO SRL', direccion: 'José Enrique Rodó 1986, Montevideo', lat: -34.90356, lon: -56.17385 },
  { nombre: 'FILSA', direccion: 'Estero Bellaco 2622, Montevideo', lat: -34.88668, lon: -56.16149 },
  { nombre: 'URUGUAYANA', direccion: 'Hermanos Gil 933, Montevideo', lat: -34.87121, lon: -56.20608 },
  { nombre: 'INU', direccion: 'Ramón y Cajal, Montevideo (confirmar número)', lat: -34.88964, lon: -56.16203 },
  { nombre: 'SEDIC', direccion: 'Av. Gral. José Garibaldi 2604, Montevideo', lat: -34.88757, lon: -56.16264 },
];

export async function cargarLocalesSiHaceFalta() {
  const existentes = await db.todos('locales');
  if (existentes.length > 0) return;
  for (const l of LOCALES_INICIALES) {
    await db.guardar('locales', { id: uuid(), activo: true, creado: Date.now(), ...l });
  }
}
