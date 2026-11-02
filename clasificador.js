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

// Responsables: quién debería solucionar el problema. La lista es editable en la app;
// estos son los que vienen al instalarla.
export const RESPONSABLES_POR_DEFECTO = [
  'Electricista',
  'Técnico de ósmosis',
  'Técnico de equipos',
  'Sanitario',
  'Climatización',
  'Mantenimiento general',
  'Limpieza',
  'Compras / farmacia',
  'Encargado del local',
];

// Reglas para sugerir responsable. Solo se usan si ese nombre sigue en la lista del usuario.
const REGLAS_RESPONSABLE = [
  ['Técnico de ósmosis', ['osmosis', 'ósmosis', 'planta de agua', 'tratamiento de agua', 'conductividad', 'cloro', 'filtro de agua', 'ablandador']],
  ['Electricista', ['luz', 'luces', 'lampara', 'lámpara', 'luminaria', 'enchufe', 'toma', 'cable', 'electric', 'eléctric', 'tablero', 'llave', 'corto', 'no prende', 'no enciende', 'luz de emergencia', 'tubo']],
  ['Técnico de equipos', ['maquina', 'máquina', 'monitor', 'dializador', 'equipo', 'balanza', 'bomba', 'alarma del equipo', 'heladera', 'calibra']],
  ['Climatización', ['aire acondicionado', 'aire', 'calefacci', 'estufa', 'ventilaci', 'temperatura', 'calor', 'frio', 'frío']],
  ['Sanitario', ['canilla', 'pérdida de agua', 'perdida de agua', 'fuga', 'inodoro', 'baño', 'desagüe', 'desague', 'cañería', 'caneria', 'humedad', 'goteo', 'gotera']],
  ['Compras / farmacia', ['falta', 'faltan', 'no hay', 'stock', 'insumo', 'guante', 'barbijo', 'vencid', 'medicaci', 'farmacia', 'pedido']],
  ['Limpieza', ['sucio', 'sucia', 'limpieza', 'limpiar', 'basura', 'mugre', 'polvo', 'olor', 'mancha', 'tacho', 'residuo']],
  ['Mantenimiento general', ['roto', 'rota', 'sillon', 'sillón', 'silla', 'camilla', 'puerta', 'ventana', 'pared', 'techo', 'piso', 'pintura', 'tapizado', 'cartel', 'baranda', 'rampa', 'cerradura', 'matafuego', 'extintor']],
  ['Encargado del local', ['atención', 'atencion', 'trato', 'espera', 'demora', 'personal', 'registro', 'planilla', 'uniforme', 'horario', 'turno', 'queja', 'reclamo']],
];

/** Sugiere un responsable de la lista según la transcripción. Devuelve el nombre o null. */
export function sugerirResponsable(transcripcion, lista) {
  const t = normalizar(transcripcion);
  const disponibles = new Map((lista || []).map(n => [normalizar(n), n]));
  let mejor = null, puntos = 0;
  for (const [nombre, palabras] of REGLAS_RESPONSABLE) {
    const real = disponibles.get(normalizar(nombre));
    if (!real) continue;
    const p = puntuar(t, palabras);
    if (p > puntos) { puntos = p; mejor = real; }
  }
  return mejor;
}

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
