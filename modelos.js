// Modelos de Whisper disponibles. Se descargan una vez desde Hugging Face y el navegador los guarda.
// Lo usan el worker (para cargar) y la app (para mostrar).
//
// Cada modelo tiene una lista de intentos, en orden. Si uno falla (memoria, WebGPU), se prueba el siguiente;
// si fallan todos, la app pasa al siguiente modelo de CADENA_DE_RESPALDO.

export const MODELOS = {
  'large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    titulo: 'Whisper large-v3-turbo',
    detalle: 'La mayor precisión. Entre 0,5 y 1,5 GB según lo que soporte el teléfono. Si Safari se reinicia, la app baja sola a medium.',
    tamano: '0,5 a 1,5 GB',
    intentos: [
      // Codificador en fp16 (1,2 GB) + decodificador en 4 bits: la mejor calidad. Solo con GPU.
      { device: 'webgpu', dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, etiqueta: 'GPU, calidad máxima' },
      // Todo en 4 bits (~450 MB): algo menos preciso, mucho más liviano en memoria.
      { device: 'webgpu', dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, etiqueta: 'GPU, comprimido' },
    ],
  },
  'medium': {
    id: 'Xenova/whisper-medium',
    titulo: 'Whisper medium',
    detalle: 'Buena precisión en español, más liviano. Unos 800 MB.',
    tamano: '~800 MB',
    intentos: [
      { device: 'webgpu', dtype: 'q8', etiqueta: 'GPU' },
      { device: 'wasm', dtype: 'q8', etiqueta: 'CPU' },
    ],
  },
  'small': {
    id: 'Xenova/whisper-small',
    titulo: 'Whisper small',
    detalle: 'Rápido y liviano (unos 250 MB). Se equivoca más con ruido y jerga. Ideal para probar.',
    tamano: '~250 MB',
    intentos: [
      { device: 'webgpu', dtype: 'q8', etiqueta: 'GPU' },
      { device: 'wasm', dtype: 'q8', etiqueta: 'CPU' },
    ],
  },
  'base': {
    id: 'Xenova/whisper-base',
    titulo: 'Whisper base',
    detalle: 'Solo para probar que todo funciona. Unos 80 MB. Precisión baja.',
    tamano: '~80 MB',
    intentos: [
      { device: 'webgpu', dtype: 'q8', etiqueta: 'GPU' },
      { device: 'wasm', dtype: 'q8', etiqueta: 'CPU' },
    ],
  },
};

export const MODELO_POR_DEFECTO = 'large-v3-turbo';

// Orden de intentos si el modelo elegido no carga (falta de memoria, WebGPU no disponible, etc.).
export const CADENA_DE_RESPALDO = ['large-v3-turbo', 'medium', 'small'];

export function siguienteModelo(clave) {
  const i = CADENA_DE_RESPALDO.indexOf(clave);
  return i >= 0 && i + 1 < CADENA_DE_RESPALDO.length ? CADENA_DE_RESPALDO[i + 1] : null;
}
