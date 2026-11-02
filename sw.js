// Service worker: deja la app usable sin conexión.
// - Archivos propios y librerías de CDN: se guardan en caché la primera vez.
// - Modelos de Whisper (huggingface.co): los guarda Transformers.js por su cuenta en el Cache Storage del navegador.

const VERSION = 'inspecciones-v2';
const PROPIOS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './db.js',
  './audio.js',
  './modelos.js',
  './worker.js',
  './clasificador.js',
  './pdf.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './lib/jspdf.umd.min.js',
  './lib/jszip.min.js',
];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'unpkg.com'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION).then(c => Promise.allSettled(PROPIOS.map(u => c.add(u)))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k.startsWith('inspecciones-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const propio = url.origin === self.location.origin;
  const esCDN = CDN.includes(url.hostname);
  if (!propio && !esCDN) return; // huggingface y otros: red directa (Transformers.js cachea los modelos)

  if (propio) {
    // Archivos de la app: red primero (para recibir actualizaciones), caché si no hay conexión.
    e.respondWith(
      fetch(req).then(r => {
        if (r && r.ok) caches.open(VERSION).then(c => c.put(req, r.clone()));
        return r;
      }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
  } else {
    // Librerías versionadas: caché primero.
    e.respondWith(
      caches.match(req).then(r => r || fetch(req).then(resp => {
        if (resp && resp.ok) caches.open(VERSION).then(c => c.put(req, resp.clone()));
        return resp;
      }))
    );
  }
});
