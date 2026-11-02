// Grabación de audio con MediaRecorder y conversión a PCM 16 kHz mono (lo que Whisper necesita).

export class Grabadora {
  constructor() {
    this.recorder = null;
    this.stream = null;
    this.partes = [];
    this.inicio = 0;
    this.timer = null;
    this.onTick = null;      // (segundos) => void
    this.onNivel = null;     // (0..1) => void
    this.duracionMaxima = 90;
    this.analizador = null;
    this.ctx = null;
  }

  static mimePreferido() {
    const candidatos = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
    if (typeof MediaRecorder === 'undefined') return null;
    for (const m of candidatos) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  get grabando() {
    return !!this.recorder && this.recorder.state === 'recording';
  }

  async iniciar() {
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Este navegador no permite grabar audio. Usá Safari actualizado.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mime = Grabadora.mimePreferido();
    this.recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    this.partes = [];
    this.recorder.ondataavailable = e => { if (e.data && e.data.size > 0) this.partes.push(e.data); };

    // Medidor de nivel para animar el botón.
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const fuente = this.ctx.createMediaStreamSource(this.stream);
      this.analizador = this.ctx.createAnalyser();
      this.analizador.fftSize = 512;
      fuente.connect(this.analizador);
    } catch (_) {
      this.analizador = null;
    }

    this.recorder.start(250);
    this.inicio = Date.now();
    this.timer = setInterval(() => {
      const seg = (Date.now() - this.inicio) / 1000;
      if (this.onTick) this.onTick(seg);
      if (this.analizador && this.onNivel) {
        const datos = new Uint8Array(this.analizador.fftSize);
        this.analizador.getByteTimeDomainData(datos);
        let suma = 0;
        for (let i = 0; i < datos.length; i++) { const v = (datos[i] - 128) / 128; suma += v * v; }
        const rms = Math.sqrt(suma / datos.length);
        this.onNivel(Math.min(1, rms * 4));
      }
      if (seg >= this.duracionMaxima) this.detener();
    }, 100);
  }

  /** Devuelve { blob, duracion } o null si no había grabación. */
  detener() {
    return new Promise(resolve => {
      clearInterval(this.timer);
      this.timer = null;
      const r = this.recorder;
      if (!r) { resolve(null); return; }
      const duracion = (Date.now() - this.inicio) / 1000;
      const mime = r.mimeType || Grabadora.mimePreferido() || 'audio/mp4';
      r.onstop = () => {
        const blob = new Blob(this.partes, { type: mime });
        this._limpiar();
        resolve({ blob, duracion });
      };
      if (r.state !== 'inactive') r.stop(); else r.onstop();
    });
  }

  async cancelar() {
    await this.detener();
  }

  _limpiar() {
    if (this.stream) this.stream.getTracks().forEach(t => t.stop());
    if (this.ctx) { try { this.ctx.close(); } catch (_) {} }
    this.stream = null;
    this.recorder = null;
    this.ctx = null;
    this.analizador = null;
  }
}

/**
 * Convierte un Blob de audio (mp4/webm/wav) a Float32Array mono a 16 kHz.
 * Usa el decodificador del navegador y remuestrea con OfflineAudioContext.
 */
export async function blobAPcm16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const buffer = await blob.arrayBuffer();
  const ctx = new AC();
  let decodificado;
  try {
    decodificado = await new Promise((resolve, reject) => {
      // Firma con callbacks: Safari viejo no devuelve promesa.
      const p = ctx.decodeAudioData(buffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    try { ctx.close(); } catch (_) {}
  }
  const tasa = 16000;
  const largo = Math.ceil(decodificado.duration * tasa);
  const offline = new OfflineAudioContext(1, largo, tasa);
  const fuente = offline.createBufferSource();
  fuente.buffer = decodificado;
  fuente.connect(offline.destination);
  fuente.start(0);
  const salida = await offline.startRendering();
  return salida.getChannelData(0);
}
