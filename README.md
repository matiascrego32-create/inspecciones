# Inspecciones — versión web

App web para registrar hallazgos de inspección por voz. Se abre en Safari, se agrega a la pantalla de
inicio del iPhone y funciona como una app más. Todo corre en el teléfono: grabación, transcripción con
Whisper, informe PDF y datos. No hay servidor, no hay cuenta, no vence y no cuesta nada.

## Publicarla gratis en GitHub Pages (una sola vez, 10 minutos, sin Mac)

1. Creá una cuenta gratuita en [github.com](https://github.com) si no tenés.
2. Arriba a la derecha, **+** → **New repository**. Nombre: `inspecciones`. Dejalo **Public**
   (Pages gratis necesita repositorio público). Marcá **Add a README file**. **Create repository**.
3. En el repositorio, botón **Add file** → **Upload files**. Arrastrá TODO el contenido de esta carpeta
   (los archivos sueltos y las carpetas `icons` y `lib`). Abajo, **Commit changes**.
   - Si la carpeta `lib` o `icons` no sube como carpeta, entrá a **Add file → Upload files** de nuevo
     y arrastrá la carpeta entera: GitHub respeta la estructura al arrastrar carpetas.
4. **Settings** (pestaña del repositorio) → menú izquierdo **Pages** → en *Build and deployment*,
   *Source*: **Deploy from a branch**; *Branch*: **main** y carpeta **/ (root)** → **Save**.
5. Esperá un minuto y recargá esa página: arriba aparece la dirección, algo como
   `https://TU-USUARIO.github.io/inspecciones/`. Esa es la app.

Para actualizar la app más adelante, repetís el paso 3 con los archivos nuevos; Pages se actualiza solo.

## Instalarla en el iPhone

1. Abrí la dirección en **Safari** (tiene que ser Safari, no Chrome).
2. Tocá el botón **Compartir** (el cuadrado con la flecha) → **Agregar a pantalla de inicio** → **Agregar**.
3. Abrila desde el ícono nuevo. Se ve a pantalla completa, sin la barra de Safari.
4. La primera vez que grabes va a pedir permiso de **micrófono** y de **ubicación**: aceptá los dos.
5. Con wifi, entrá a **Ajustes y respaldo** → **Descargar y cargar ahora**. Baja el modelo de Whisper
   (large-v3-turbo, 1,5 GB). Tarda varios minutos. Después funciona sin señal.

Si el modelo grande no carga en el teléfono (Safari se queda sin memoria), la app pasa sola a
**Whisper medium** (800 MB), que también transcribe bien en español. También se puede elegir a mano en Ajustes.

## Cómo se usa

Inicio (detecta el local por GPS) → Pendientes del local (resuelto / sigue pendiente) → Grabación
(un audio corto por hallazgo, foto opcional) → Cerrar visita → Revisión (corregir descripción,
categoría y severidad; la app las sugiere por palabras clave) → Confirmar → Informe PDF → Compartir.

La transcripción empieza apenas termina cada grabación, en segundo plano, mientras se sigue recorriendo.

## Respaldo: importante

Los datos viven en Safari, en el teléfono. Safari puede borrarlos si el iPhone se queda sin espacio o si
la app no se abre durante semanas. Por eso, en **Ajustes y respaldo** → **Exportar todo en un ZIP** cada
tanto (por ejemplo, después de cada visita o una vez por semana) y guardalo en Archivos o iCloud Drive.
Ese ZIP se vuelve a importar desde la misma pantalla si hiciera falta, en este u otro iPhone.

## Qué cambia respecto a una app nativa

- La transcripción corre en Safari con Whisper large-v3-turbo. Es el mismo modelo que usaría una app
  nativa, pero en el navegador es más lento (unos segundos por cada audio de 20 segundos) y consume más
  batería. Si no entra en memoria, baja a medium.
- No hay modelo de lenguaje para clasificar: la categoría y severidad se **sugieren** por palabras clave y
  el jefe confirma o corrige con un toque. Lleva dos segundos por hallazgo.
- El modelo de Whisper lo guarda Safari; si lo borra por falta de espacio, se vuelve a bajar solo la
  próxima vez que haya wifi.
- Nada de esto vence ni tiene costo.

## Archivos

```
index.html          Página única
app.js              Pantallas, navegación, cola de procesamiento
app.css             Estilos
db.js               Base de datos local (IndexedDB) y los 8 locales iniciales
audio.js            Grabación y conversión a 16 kHz
worker.js           Whisper con Transformers.js, en un hilo aparte
modelos.js          Modelos de Whisper disponibles
clasificador.js     Sugerencia de categoría y severidad por palabras clave
pdf.js              Informe PDF
sw.js               Funcionamiento sin conexión
manifest.webmanifest  Datos de la app para "Agregar a pantalla de inicio"
icons/              Íconos
lib/                jsPDF y JSZip (PDF y ZIP), sin depender de internet
```

Transformers.js y los modelos de Whisper se descargan de internet la primera vez (jsDelivr y Hugging Face)
y quedan guardados en el teléfono.
