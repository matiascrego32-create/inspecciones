// Modelos de Whisper disponibles. Se descargan una vez desde Hugging Face y el navegador los guarda.
// Lo usan el worker (para cargar) y la app (para mostrar).

export const MODELOS = {
  'large-v3-turbo': {
    id: 'onnx-community/whisper-large-v3-turbo',
    titulo: 'Whisper large-v3-turbo',
    detalle: 'La mayor precisión. Unos 1,5 GB. Necesita un iPhone reciente; si Safari se queda sin memoria, bajá a medium.',
    tamano: '~1,5 GB',
    // Con WebGPU: codificador en fp16 y decodificador cuantizado a 4 bits. Sin WebGPU: todo a 8 bits.
    dtype: { webgpu: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, wasm: 'q8' },
  },
  'medium': {
    id: 'Xenova/whisper-medium',
    titulo: 'Whisper medium',
    detalle: 'Buena precisión en español, mucho más liviano. Unos 800 MB.',
    tamano: '~800 MB',
    dtype: { webgpu: 'q8', wasm: 'q8' },
  },
  'small': {
    id: 'Xenova/whisper-small',
    titulo: 'Whisper small',
    detalle: 'Rápido y liviano (unos 250 MB). Se equivoca más con ruido y jerga.',
    tamano: '~250 MB',
    dtype: { webgpu: 'q8', wasm: 'q8' },
  },
  'base': {
    id: 'Xenova/whisper-base',
    titulo: 'Whisper base',
    detalle: 'Solo para probar que todo funciona. Unos 80 MB. Precisión baja.',
    tamano: '~80 MB',
    dtype: { webgpu: 'q8', wasm: 'q8' },
  },
};

export const MODELO_POR_DEFECTO = 'large-v3-turbo';

// Orden de intentos si el modelo elegido no carga (falta de memoria, WebGPU no disponible, etc.).
export const CADENA_DE_RESPALDO = ['large-v3-turbo', 'medium', 'small'];
