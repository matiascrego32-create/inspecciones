// Intermediario gratuito entre la app y Groq (Cloudflare Worker).
// Guarda la clave de Groq del lado del servidor, agrega los permisos CORS que Groq no da,
// y solo acepta pedidos de la app (por origen y, si lo configurás, por código de acceso).
//
// Variables a configurar en el Worker (Settings → Variables and Secrets):
//   GROQ_API_KEY     (secreto)   la clave de Groq, empieza con gsk_
//   ALLOWED_ORIGINS  (texto)     orígenes permitidos separados por coma, por ejemplo:
//                                https://matiascrego32-create.github.io
//   APP_CODE         (secreto)   opcional: un código que la app manda en cada pedido. Si lo ponés acá,
//                                tenés que poner el mismo en Ajustes de la app. Evita que un desconocido
//                                use tu cuota gratuita si descubre la dirección del Worker.

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

export default {
  async fetch(request, env) {
    const origen = request.headers.get('Origin') || '';
    const permitidos = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
    const origenOk = permitidos.length === 0 || permitidos.includes(origen);

    const cors = {
      'Access-Control-Allow-Origin': origenOk && origen ? origen : (permitidos[0] || '*'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Code',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

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
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
