// Intermediario gratuito de la app de inspecciones (Cloudflare Worker). Hace dos cosas:
//
// 1. Transcripción: reenvía los audios a Groq (Whisper large-v3) agregando la clave, que nunca está en el teléfono.
//    POST /            (o cualquier ruta que no sea /informes)
//
// 2. Informes por enlace: guarda el PDF y el Word de una visita y los sirve en un enlace para mandar por WhatsApp.
//    POST /informes            sube un archivo (solo la app)      → { url }
//    GET  /i/<id>/<nombre>     descarga el archivo (cualquiera con el enlace)
//    Los enlaces son imposibles de adivinar (128 bits al azar) y vencen solos a los DIAS_ENLACE días.
//
// Configuración del Worker (Settings → Variables and Secrets / Bindings):
//   GROQ_API_KEY     (secreto)   la clave de Groq, empieza con gsk_
//   ALLOWED_ORIGINS  (texto)     orígenes permitidos separados por coma: https://matiascrego32-create.github.io
//   APP_CODE         (secreto)   opcional: código que la app manda en cada pedido (el mismo que en Ajustes de la app)
//   INFORMES         (KV namespace binding)  almacenamiento de los informes. Sin esto, solo funciona la transcripción.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DIAS_ENLACE = 90;
const TAMANO_MAXIMO = 20 * 1024 * 1024; // 20 MB por archivo (el límite de KV es 25 MB)
const TIPOS_PERMITIDOS = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origen = request.headers.get('Origin') || '';
    const permitidos = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origenOk = permitidos.length === 0 || permitidos.includes(origen);

    const cors = {
      'Access-Control-Allow-Origin': origenOk && origen ? origen : (permitidos[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Code, X-Nombre',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    // Descarga pública de un informe (la abre quien recibe el enlace por WhatsApp).
    if (request.method === 'GET' && url.pathname.startsWith('/i/')) {
      return servirInforme(url, env);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (!origenOk) {
      return json({ error: { message: 'Origen no permitido' } }, 403, cors);
    }
    if (request.method !== 'POST') {
      return json({ error: { message: 'Solo POST' } }, 405, cors);
    }
    if (env.APP_CODE && request.headers.get('X-App-Code') !== env.APP_CODE) {
      return json({ error: { message: 'Código de acceso incorrecto' } }, 401, cors);
    }

    if (url.pathname === '/informes') {
      return guardarInforme(request, env, cors, url);
    }
    return transcribir(request, env, cors);
  },
};

async function transcribir(request, env, cors) {
  if (!env.GROQ_API_KEY) {
    return json({ error: { message: 'El Worker no tiene configurada GROQ_API_KEY' } }, 500, cors);
  }
  // Reenvía el multipart tal cual (con su boundary) y agrega la clave.
  const respuesta = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.GROQ_API_KEY,
      'Content-Type': request.headers.get('Content-Type') || 'application/octet-stream',
    },
    body: request.body,
  });
  const cabeceras = new Headers(cors);
  cabeceras.set('Content-Type', respuesta.headers.get('Content-Type') || 'application/json');
  const ra = respuesta.headers.get('retry-after');
  if (ra) {
    cabeceras.set('Retry-After', ra);
    cabeceras.set('Access-Control-Expose-Headers', 'Retry-After');
  }
  return new Response(respuesta.body, { status: respuesta.status, headers: cabeceras });
}

async function guardarInforme(request, env, cors, url) {
  if (!env.INFORMES) {
    return json({ error: { message: 'Falta conectar el almacenamiento INFORMES al Worker (KV namespace).', codigo: 'sin_almacenamiento' } }, 501, cors);
  }
  const tipo = (request.headers.get('Content-Type') || '').split(';')[0].trim();
  const ext = TIPOS_PERMITIDOS[tipo];
  if (!ext) return json({ error: { message: 'Solo se aceptan PDF y Word' } }, 415, cors);
  const datos = await request.arrayBuffer();
  if (datos.byteLength === 0) return json({ error: { message: 'Archivo vacío' } }, 400, cors);
  if (datos.byteLength > TAMANO_MAXIMO) return json({ error: { message: 'El archivo supera los 20 MB' } }, 413, cors);

  let nombre = decodeURIComponent(request.headers.get('X-Nombre') || `informe.${ext}`);
  nombre = nombre.replace(/[^\w.\-ÁÉÍÓÚÑáéíóúñ]+/g, '_').slice(0, 120);
  if (!nombre.toLowerCase().endsWith('.' + ext)) nombre += '.' + ext;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.INFORMES.put(id, datos, {
    expirationTtl: DIAS_ENLACE * 24 * 3600,
    metadata: { tipo, nombre, creado: Date.now() },
  });
  return json({ url: `${url.origin}/i/${id}/${encodeURIComponent(nombre)}`, vence: Date.now() + DIAS_ENLACE * 24 * 3600 * 1000 }, 200, cors);
}

async function servirInforme(url, env) {
  const partes = url.pathname.split('/'); // ['', 'i', id, nombre]
  const id = partes[2] || '';
  if (!env.INFORMES || !/^[0-9a-f]{32}$/.test(id)) return pagina('Enlace no válido', 404);
  const { value, metadata } = await env.INFORMES.getWithMetadata(id, { type: 'arrayBuffer' });
  if (!value) return pagina('Este informe ya no está disponible: los enlaces vencen a los ' + DIAS_ENLACE + ' días.', 404);
  const nombre = (metadata && metadata.nombre) || `informe.${TIPOS_PERMITIDOS[metadata && metadata.tipo] || 'pdf'}`;
  return new Response(value, {
    headers: {
      'Content-Type': (metadata && metadata.tipo) || 'application/octet-stream',
      // inline: el PDF se ve directo en el teléfono; el Word lo ofrece para abrir o guardar.
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(nombre)}`,
      'Cache-Control': 'private, max-age=3600',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function pagina(texto, status) {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Informe</title><body style="font-family:-apple-system,system-ui,sans-serif;padding:32px;color:#111318"><p>${texto}</p></body>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
