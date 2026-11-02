# Inspecciones — versión web

App web para registrar hallazgos de inspección por voz. Se abre en Safari, se agrega a la pantalla de
inicio del iPhone y funciona como una app más. Grabación, informe PDF y datos quedan en el teléfono.
La transcripción la hace **Whisper large-v3** (el modelo más preciso que existe) en los servidores de Groq,
usando su nivel gratuito, a través de un intermediario propio que guarda la clave. Todo gratis, sin Mac,
sin App Store, sin vencimiento.

La app ya está publicada en: **https://matiascrego32-create.github.io/inspecciones/**

## 1. Crear la cuenta de Groq y la clave (5 minutos)

1. Entrá a [console.groq.com](https://console.groq.com) y creá una cuenta gratuita (con Google o email).
2. Menú **API Keys** → **Create API Key** → ponele un nombre (por ejemplo `inspecciones`) → **Submit**.
3. Copiá la clave (empieza con `gsk_`). Se muestra una sola vez: guardala en un lugar seguro.

El nivel gratuito de Groq da unas 8 horas de audio por día para Whisper large-v3, sin tarjeta de crédito.

## 2. Crear el intermediario en Cloudflare (10 minutos, gratis)

Groq no acepta pedidos directos desde un navegador, así que la app le habla a un "Worker" de Cloudflare
que reenvía el audio y agrega la clave. La clave queda en Cloudflare, nunca en el teléfono.

1. Creá una cuenta gratuita en [dash.cloudflare.com](https://dash.cloudflare.com) (no pide tarjeta).
2. Menú izquierdo **Compute (Workers)** → **Create** → **Start with Hello World!** (o "Create Worker").
   Nombre: `inspecciones`. **Deploy**.
3. Botón **Edit code**. Borrá todo el código que aparece y pegá el contenido completo del archivo
   `proxy/cloudflare-worker.js` de este repositorio. **Deploy** (arriba a la derecha).
4. Volvé al Worker → pestaña **Settings** → **Variables and Secrets** → **Add**:
   - Tipo **Secret**, nombre `GROQ_API_KEY`, valor: la clave `gsk_…` del paso 1. **Deploy**.
   - Tipo **Text**, nombre `ALLOWED_ORIGINS`, valor: `https://matiascrego32-create.github.io`. **Deploy**.
   - (Recomendado) Tipo **Secret**, nombre `APP_CODE`, valor: una palabra o número que inventes, por
     ejemplo `dialisis2026`. Es un código de acceso: sin él nadie puede usar tu cuota aunque descubra la
     dirección del Worker. **Deploy**.
5. En la pestaña **Settings** → **Domains & Routes** (o arriba en la página del Worker) está la dirección
   del Worker, algo como `https://inspecciones.TU-USUARIO.workers.dev`. Copiala.

## 3. Configurar la app en el iPhone

1. Abrí la app → **Ajustes y respaldo**.
2. En **Dirección del servicio** pegá la dirección del Worker (la de `workers.dev`).
3. En **Código de acceso** poné el mismo valor que pusiste en `APP_CODE` (si lo configuraste).
4. Tocá **Probar conexión**. Tiene que decir "Conexión correcta".

Listo. Desde ahí, cada audio que grabes se transcribe en unos segundos. Si no hay señal en el local, los
audios quedan en cola y se transcriben solos cuando vuelve la conexión.

Para el iPhone del jefe: mismos tres pasos, con la misma dirección y el mismo código. No hace falta que
él tenga cuenta de nada.

## Instalar la app en el iPhone

1. Abrí la dirección de la app en **Safari** (no en Chrome).
2. Botón **Compartir** (cuadrado con flecha) → **Agregar a pantalla de inicio** → **Agregar**.
3. Abrila desde el ícono nuevo. La primera vez que grabes, aceptá los permisos de micrófono y ubicación.

## Cómo se usa

Inicio (detecta el local por GPS) → Pendientes del local (resuelto / sigue pendiente) → Grabación
(un audio corto por hallazgo, foto opcional) → Cerrar visita → Revisión (corregir descripción,
categoría y severidad; la app las sugiere por palabras clave) → Confirmar → Informe PDF → Compartir.

## Respaldo: importante

Los datos viven en Safari, en el teléfono. Safari puede borrarlos si el iPhone se queda sin espacio o si
la app no se abre durante semanas. En **Ajustes y respaldo** → **Exportar todo en un ZIP** cada tanto
(por ejemplo después de cada visita) y guardalo en Archivos o iCloud Drive. Ese ZIP se vuelve a importar
desde la misma pantalla si hiciera falta, en este u otro iPhone.

## Privacidad

Del teléfono salen solo los audios, hacia Groq, para transcribirlos. Los datos de visitas, hallazgos,
fotos e informes no salen nunca, salvo en el ZIP que exportás vos. Groq publica su política de datos en su
sitio; conviene leerla si los audios pueden incluir información de pacientes.

## Actualizar la app

Los archivos de este repositorio son la app. Cada cambio en la rama `main` se publica solo en GitHub
Pages en uno o dos minutos. En el iPhone, cerrar la app del todo y volver a abrirla toma la versión nueva.

## Archivos

```
index.html          Página única
app.js              Pantallas, navegación, cola de transcripción
app.css             Estilos
db.js               Base de datos local (IndexedDB) y los 8 locales iniciales
audio.js            Grabación
groq.js             Envío del audio al servicio de transcripción
clasificador.js     Sugerencia de categoría y severidad por palabras clave
pdf.js              Informe PDF
sw.js               Funcionamiento sin conexión de la propia app
manifest.webmanifest  Datos para "Agregar a pantalla de inicio"
icons/              Íconos
lib/                jsPDF y JSZip
proxy/cloudflare-worker.js   El intermediario que se pega en Cloudflare
```
