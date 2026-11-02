// Clasificación sugerida por palabras clave. En la web no hay modelo de lenguaje local,
// así que esto propone categoría y severidad y el jefe confirma o corrige con un toque.

export const CATEGORIAS = [
  { id: 'limpieza', titulo: 'Limpieza' },
  { id: 'seguridad', titulo: 'Seguridad' },
  { id: 'stock', titulo: 'Stock' },
  { id: 'infraestructura', titulo: 'Infraestructura' },
  { id: 'atencion', titulo: 'Atención' },
  { id: 'otro', titulo: 'Otro' },
];

export const SEVERIDADES = [
  { id: 'leve', titulo: 'Leve' },
  { id: 'grave', titulo: 'Grave' },
  { id: 'urgente', titulo: 'Urgente' },
];

const REGLAS_CATEGORIA = [
  ['seguridad', ['matafuego', 'extintor', 'incendio', 'electric', 'eléctric', 'cable', 'enchufe', 'osmosis', 'ósmosis', 'planta de agua', 'tratamiento de agua', 'conductividad', 'cloro', 'desinfecci', 'esteril', 'residuo', 'cortopunzante', 'aguja', 'salida de emergencia', 'piso mojado', 'resbal', 'caída', 'caida', 'riesgo', 'habilitaci', 'registro', 'control diario', 'planilla', 'fuga', 'pérdida de agua', 'perdida de agua', 'gas']],
  ['limpieza', ['sucio', 'sucia', 'limpieza', 'limpiar', 'basura', 'mugre', 'polvo', 'olor', 'baño', 'inodoro', 'jabón', 'jabon', 'alcohol en gel', 'papel', 'tacho', 'mancha', 'moho', 'humedad']],
  ['stock', ['falta', 'faltan', 'no hay', 'se acab', 'sin stock', 'stock', 'insumo', 'guante', 'barbijo', 'vencid', 'vencimiento', 'caducad', 'filtro', 'dializador', 'agujas', 'medicaci', 'farmacia', 'depósito', 'deposito', 'pedido']],
  ['infraestructura', ['roto', 'rota', 'rotos', 'rotas', 'no funciona', 'no anda', 'no prende', 'no enciende', 'quemad', 'sillón', 'sillon', 'silla', 'camilla', 'pared', 'techo', 'puerta', 'ventana', 'aire acondicionado', 'aire', 'luz', 'lámpara', 'lampara', 'luminaria', 'pintura', 'piso', 'azulejo', 'cartel', 'tapizado', 'heladera', 'equipo', 'máquina', 'maquina', 'monitor', 'balanza', 'bomba', 'ascensor', 'rampa', 'baranda']],
  ['atencion', ['atención', 'atencion', 'trato', 'espera', 'demora', 'paciente', 'pacientes', 'queja', 'reclamo', 'información', 'informacion', 'turno', 'horario', 'personal', 'enfermer', 'recepción', 'recepcion', 'uniforme', 'identificaci']],
];

const REGLAS_SEVERIDAD = [
  ['urgente', ['urgente', 'ya', 'peligro', 'riesgo', 'incendio', 'matafuego vencido', 'extintor vencido', 'electric', 'eléctric', 'cable pelado', 'chispa', 'humo', 'osmosis', 'ósmosis', 'planta de agua', 'conductividad', 'cloro', 'agua', 'cortopunzante', 'salida de emergencia', 'paciente', 'pacientes', 'infección', 'infeccion', 'contamina', 'habilitaci', 'inspección sanitaria', 'ministerio']],
  ['grave', ['roto', 'rota', 'no funciona', 'no anda', 'no prende', 'no enciende', 'vencid', 'falta', 'faltan', 'no hay', 'quemad', 'sin stock', 'fuga', 'pérdida', 'perdida', 'moho', 'humedad', 'caída', 'caida', 'piso mojado', 'reclamo', 'queja']],
];

function normalizar(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function puntuar(texto, palabras) {
  let n = 0;
  for (const p of palabras) {
    if (texto.includes(normalizar(p))) n++;
  }
  return n;
}

/**
 * Devuelve { categoria, severidad, descripcion, sugerido: true }.
 * La descripción es la primera oración de la transcripción, recortada.
 */
export function clasificar(transcripcion) {
  const t = normalizar(transcripcion);

  let categoria = 'otro';
  let mejor = 0;
  for (const [cat, palabras] of REGLAS_CATEGORIA) {
    const p = puntuar(t, palabras);
    if (p > mejor) { mejor = p; categoria = cat; }
  }

  let severidad = 'leve';
  for (const [sev, palabras] of REGLAS_SEVERIDAD) {
    if (puntuar(t, palabras) > 0) { severidad = sev; break; }
  }

  return { categoria, severidad, descripcion: resumir(transcripcion), sugerido: true };
}

/** Primera oración (o primeras ~12 palabras) de la transcripción, sin muletillas iniciales. */
export function resumir(transcripcion) {
  let s = (transcripcion || '').trim();
  s = s.replace(/^(eh+|este|bueno|a ver|mir[aá]|ok[ae]?y?|ehm+|mmm+)[,.\s]+/i, '');
  const corte = s.search(/[.;!?]/);
  if (corte > 15) s = s.slice(0, corte);
  const palabras = s.split(/\s+/);
  if (palabras.length > 14) s = palabras.slice(0, 14).join(' ') + '…';
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);
  return s;
}
