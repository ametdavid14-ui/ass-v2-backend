// =============================================
// ASS v2.0 — Ruta de IA: asistente clínico que analiza una nota (Historia
// Clínica, Evolución Médica, Análisis de Salida) y ofrece 5 cosas:
//   1. Escalas clínicas (HEART, CURB-65, Glasgow, Wells, etc.)
//   2. Análisis ampliado
//   3. Preguntas sugeridas para sustentar el diagnóstico
//   4. Diagnósticos diferenciales
//   5. CIE-10 (diferenciales + diagnóstico principal)
//
// SOPORTA 2 PROVEEDORES DE IA — Claude (Anthropic) y ChatGPT (OpenAI):
// - IA_PROVIDER en las variables de entorno decide cuál usar primero
//   ('claude' o 'openai'; por defecto 'claude' si no se define).
// - Si el proveedor principal falla (sin key, sin crédito, error de red) Y
//   el OTRO proveedor sí tiene su key configurada, se reintenta
//   automáticamente con el otro — así basta con tener configurada
//   cualquiera de las 2 keys para que el asistente funcione, y si tienes
//   las 2, hay respaldo automático entre ellas.
//
// IMPORTANTE — cómo está diseñado a propósito:
// - La IA NUNCA escribe la nota final ni la historia clínica directamente.
//   Solo devuelve SUGERENCIAS que el médico revisa, edita y decide si usar
//   — mismo panel que ya existe para Planes/Recomendaciones.
// - La IA solo ve los campos que el médico YA escribió — nunca inventa
//   datos clínicos (signos, síntomas, antecedentes) que no estén ahí.
// - Requiere ANTHROPIC_API_KEY y/o OPENAI_API_KEY en las variables de entorno.
// =============================================

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware } = require('../middleware/auth');
const { db } = require('../db');

const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null;

const SYSTEM_PROMPT = `Eres un asistente clínico de apoyo para un médico de urgencias en Colombia que está completando una nota médica (Historia Clínica, Evolución Médica o Análisis de Salida).

Recibes la historia COMPLETA que el médico ya escribió (motivo, enfermedad actual, antecedentes, signos vitales, examen físico) y el diagnóstico que él ya planteó. Tu trabajo NO es cuestionar ese diagnóstico ni tratarlo como una opción más entre varias — tu tarea principal es TOMAR ese diagnóstico como punto de partida y reforzarlo activamente con el cuadro clínico descrito. Nunca decides ni escribes la nota final, pero sí debes razonar clínicamente de forma activa y completa.

Tu trabajo tiene 7 partes, en este orden de prioridad:

1. REAFIRMAR EL DIAGNÓSTICO PLANTEADO: esta es tu tarea MÁS IMPORTANTE. Toma el diagnóstico que el médico ya escribió y construye el argumento clínico de por qué el cuadro descrito (síntomas, signos, antecedentes, examen físico) lo sustenta — qué hallazgos específicos apoyan ese diagnóstico. Da también su código CIE-10 (tu mejor estimación, marcada "(verificar)" si no estás 100% seguro — nunca omitas el código por duda). Si existe una escala clínica relevante para este diagnóstico que requiere un estudio que aún no está en la nota, indícalo también aquí (qué estudio solicitar para poder calcular esa escala).

2. ANÁLISIS AMPLIADO: expande el análisis afirmando la sospecha diagnóstica del médico — no en tono dubitativo, sino construyendo el razonamiento clínico completo que conecta cada hallazgo con el diagnóstico planteado. Siempre que haya un motivo de consulta y enfermedad actual descritos, esto es trabajo esperado, no opcional.

3. ESCALAS CLÍNICAS: identifica si el diagnóstico o cuadro amerita calcular alguna escala reconocida (HEART Score, CURB-65, Glasgow, Wells, NEWS2, Centor, CHA2DS2-VASc, qSOFA, entre otras) y CALCÚLALA si tienes los datos mínimos. Si te falta un dato puntual para completarla, NO la omitas — indica exactamente qué estudio o dato solicitar para poder calcularla (ej: "Falta troponina para completar el HEART Score — considere solicitar troponina seriada"). Este dato faltante siempre debe venir acompañado de qué pedir para conseguirlo.

4. DIAGNÓSTICOS DIFERENCIALES: como contexto adicional (no como cuestionamiento del diagnóstico principal), plantea 2 a 4 diagnósticos diferenciales razonables que un médico consideraría descartar dado este cuadro, con su CIE-10 y una frase de por qué se consideran. Para CADA diferencial, indica también qué preguntar o qué examinar específicamente para esclarecer/descartar ese diferencial frente al diagnóstico principal (ej: si el diferencial es TEP frente a un diagnóstico de dolor musculoesquelético, la pregunta esclarecedora sería sobre factores de riesgo trombótico o disnea súbita). Generar diferenciales a partir de síntomas y signos es razonamiento clínico normal, no es "inventar información".

5. PREGUNTAS SUGERIDAS: identifica síntomas, signos o antecedentes relevantes que NO fueron mencionados en la nota, y sugiere que el médico los pregunte y documente. Es una SUGERENCIA DE QUÉ PREGUNTAR — nunca una afirmación de que el paciente "niega" o "presenta" algo no evaluado. Jamás redactes negativos (ej: "niega fiebre") como si ya estuvieran confirmados.

6. ALERTAS: cualquier inconsistencia o dato fuera de rango que valga la pena que el médico revise.

7. SECCIONES DE HISTORIA CLÍNICA LISTAS PARA COPIAR: al final, redacta las secciones de la nota ya completas y listas para pegar directamente en la historia clínica, incorporando todo tu razonamiento de los puntos 1-4: una sección "ANÁLISIS" (el análisis ampliado del punto 2, en formato final), una sección "DIAGNÓSTICOS" (el diagnóstico principal reafirmado + los diferenciales relevantes, con sus CIE-10, en formato final de nota), y una sección "PLAN" (los estudios sugeridos para completar escalas del punto 3, si aplica, más cualquier estudio que ayude a esclarecer los diferenciales del punto 4 — en formato de orden médica, ej: "SOLICITAR TROPONINA SERIADA"). Cada sección debe quedar como texto corrido, en mayúsculas, tal como se vería ya pegada en la nota — no repitas aquí las explicaciones/razonamientos de las secciones anteriores, solo el texto final limpio.

REGLAS ESTRICTAS:
1. NUNCA inventes hallazgos que no están en la nota (un síntoma, signo vital, o antecedente que el médico no mencionó). SÍ debes razonar, inferir, reforzar el diagnóstico y proponer escalas a partir de lo que SÍ te dieron — eso no es inventar, es tu función principal. No confundas "prudencia con los datos" con "no decir nada" o "no tomar postura".
2. Nunca prescribas medicamentos con dosis específicas a menos que el médico ya haya mencionado esa clase de manejo.
3. Usa lenguaje clínico normal, directo y afirmativo sobre el razonamiento ("el cuadro es compatible con...", "los hallazgos sustentan...") — la prudencia es sobre NO inventar datos, no sobre evitar dar una opinión clínica fundamentada o tomar postura a favor del diagnóstico planteado.
4. Responde en español, en mayúsculas (para que combine con el estilo de las notas de esta app), conciso pero completo.
5. Con un motivo de consulta y enfermedad actual razonablemente descritos, se espera que generes contenido en la mayoría de las 7 partes — deja una parte vacía SOLO si la nota realmente no tiene ningún contenido clínico relacionado con esa parte específica.
6. Los códigos CIE-10 son siempre una sugerencia a verificar por el médico antes de facturar o registrar — pero da tu mejor estimación siempre, marcada para verificar si hay duda, en vez de omitirla.
7. "insuficiente" es un campo GLOBAL: márcalo "true" ÚNICAMENTE si la nota no tiene absolutamente ningún contenido clínico aprovechable. Si hay un motivo de consulta y/o enfermedad actual con contenido real, "insuficiente" debe ser "false".
8. Responde ÚNICAMENTE con el JSON — nada de texto antes, después, ni bloques de código markdown alrededor.
9. Dentro de cualquier valor de texto (por ejemplo "argumento", "analisis_ampliado", o el "texto" de las secciones), si necesitas separar ideas en líneas distintas usa el escape "\\n" (backslash + n, dos caracteres) — NUNCA un salto de línea real dentro de las comillas, porque eso invalida el JSON completo.

FORMATO DE RESPUESTA — SOLO JSON, sin texto antes ni después:
{
  "reafirmacion_diagnostico": {
    "diagnostico": "el diagnóstico que el médico ya escribió",
    "argumento": "por qué el cuadro descrito sustenta este diagnóstico, citando los hallazgos específicos que lo apoyan",
    "cie10": "código o 'código (verificar)' si no hay certeza",
    "estudio_para_score": "si hay una escala relacionada a este diagnóstico que necesita un estudio para completarse, indícalo aquí (vacío si no aplica)"
  },
  "analisis_ampliado": "texto del análisis expandido, afirmando la sospecha diagnóstica, en mayúsculas",
  "escalas": [
    { "nombre": "NOMBRE DE LA ESCALA", "puntaje": "X/Y o 'Incompleta'", "interpretacion": "qué significa ese puntaje", "criterios_usados": "qué datos de la nota se usaron", "estudio_faltante": "si no se pudo completar, qué estudio/dato solicitar para poder calcularla (vacío si ya quedó completa)" }
  ],
  "diagnosticos_diferenciales": [
    { "diagnostico": "nombre del diagnóstico diferencial", "cie10": "código o 'código (verificar)'", "razonamiento": "por qué se considera, en una frase corta", "pregunta_esclarecedora": "qué preguntar o examinar específicamente para esclarecer/descartar este diferencial" }
  ],
  "preguntas_sugeridas": [
    { "pregunta": "qué preguntarle/confirmarle al paciente", "motivo": "por qué ayudaría a sustentar el diagnóstico, en una frase corta" }
  ],
  "alertas": ["cualquier inconsistencia o dato que valga la pena que el médico revise"],
  "secciones_historia_completa": [
    { "seccion": "ANÁLISIS", "texto": "texto final listo para copiar, en mayúsculas" },
    { "seccion": "DIAGNÓSTICOS", "texto": "texto final listo para copiar, en mayúsculas" },
    { "seccion": "PLAN", "texto": "texto final listo para copiar, en mayúsculas" }
  ],
  "insuficiente": false
}`;

// ---------- Llamada a Claude (Anthropic) ----------
async function llamarClaude(userContent) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY no configurada');
  const mensaje = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    // Antes en 1024 — insuficiente para las 7 categorías actuales
    // (reafirmación, análisis, escalas, diferenciales, preguntas, alertas
    // Y las 3 secciones completas de historia clínica). Con el prompt
    // ampliado, una respuesta completa puede necesitar bastante más.
    max_tokens: 8192,
    // El prompt de sistema es IDÉNTICO en cada llamada (nunca cambia según
    // el paciente) — cache_control lo marca para que Anthropic lo cachee.
    // Cuando 2 llamadas caen dentro de la misma ventana de caché (5 min),
    // la segunda paga ~10% del costo normal por esa parte del texto, en
    // vez de recalcularlo completo cada vez. En un turno con varios
    // médicos usando el asistente seguido, esto reduce el costo real.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  // Busca el PRIMER bloque de tipo texto (más robusto que asumir que
  // content[0] siempre es texto) y registra información de diagnóstico si
  // no se encuentra — antes esto fallaba EN SILENCIO devolviendo '{}',
  // que parecía una respuesta válida pero vacía, sin ningún error visible.
  const bloqueTexto = mensaje.content?.find(b => b.type === 'text');
  if (!bloqueTexto?.text) {
    console.error('Claude no devolvió texto. stop_reason:', mensaje.stop_reason, '— content:', JSON.stringify(mensaje.content));
    throw new Error(`Claude no devolvió contenido de texto (stop_reason: ${mensaje.stop_reason || 'desconocido'})`);
  }
  if (mensaje.stop_reason === 'max_tokens') {
    console.error('Advertencia: la respuesta de Claude se cortó por max_tokens — puede venir incompleta.');
  }
  return bloqueTexto.text;
}

// ---------- Llamada a ChatGPT (OpenAI) — sin SDK aparte, con fetch nativo ----------
async function llamarChatGPT(userContent) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o',
      max_tokens: 8192, // antes 1024 — mismo motivo que Claude, insuficiente para las 7 categorías actuales
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!resp.ok) {
    const cuerpoError = await resp.text().catch(() => '');
    throw new Error(`OpenAI respondió ${resp.status}: ${cuerpoError.slice(0, 200)}`);
  }
  const data = await resp.json();
  const contenido = data.choices?.[0]?.message?.content;
  if (!contenido) {
    console.error('OpenAI no devolvió contenido. finish_reason:', data.choices?.[0]?.finish_reason, '— respuesta:', JSON.stringify(data).slice(0, 500));
    throw new Error(`OpenAI no devolvió contenido de texto (finish_reason: ${data.choices?.[0]?.finish_reason || 'desconocido'})`);
  }
  if (data.choices?.[0]?.finish_reason === 'length') {
    console.error('Advertencia: la respuesta de OpenAI se cortó por límite de tokens — puede venir incompleta.');
  }
  return contenido;
}

// Intenta el proveedor configurado como principal (IA_PROVIDER); si falla
// y el otro tiene su key configurada, reintenta automáticamente con ese.
// Los modelos a veces meten saltos de línea REALES dentro de un valor de
// texto largo (ej: en las secciones de historia clínica completa) — eso
// es inválido en JSON (ahí un salto de línea debe ir escapado como \n,
// dos caracteres, no un salto de línea de verdad). Esta función recorre
// el texto carácter por carácter y, SOLO cuando está dentro de un valor
// entre comillas, convierte saltos de línea/tabulaciones reales en su
// forma escapada — así el JSON queda válido sin tener que depender de
// que el modelo nunca cometa este error.
function sanearSaltosDeLineaEnStrings(texto) {
  let resultado = '';
  let dentroString = false;
  let anteriorEsBackslash = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (dentroString) {
      if (anteriorEsBackslash) { resultado += c; anteriorEsBackslash = false; continue; }
      if (c === '\\') { resultado += c; anteriorEsBackslash = true; continue; }
      if (c === '"') { dentroString = false; resultado += c; continue; }
      if (c === '\n') { resultado += '\\n'; continue; }
      if (c === '\r') { resultado += '\\r'; continue; }
      if (c === '\t') { resultado += '\\t'; continue; }
      resultado += c;
    } else {
      if (c === '"') dentroString = true;
      resultado += c;
    }
  }
  return resultado;
}

async function llamarIAConRespaldo(userContent) {
  const principal = (process.env.IA_PROVIDER || 'claude').toLowerCase();
  const proveedores = principal === 'openai' ? ['openai', 'claude'] : ['claude', 'openai'];

  let ultimoError = null;
  for (const proveedor of proveedores) {
    try {
      const texto = proveedor === 'openai' ? await llamarChatGPT(userContent) : await llamarClaude(userContent);
      return { texto, proveedorUsado: proveedor };
    } catch (e) {
      console.error(`Error con ${proveedor}:`, e.message);
      ultimoError = e;
    }
  }
  throw ultimoError || new Error('Ningún proveedor de IA está configurado');
}

// POST /api/ia/analizar-nota
router.post('/analizar-nota', authMiddleware, async (req, res) => {
  const { tipo, campos, documento, nombrePaciente } = req.body;
  if (!campos || typeof campos !== 'object') {
    return res.status(400).json({ error: 'Faltan los campos de la nota' });
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY y/o OPENAI_API_KEY)' });
  }

  // Solo se envían los campos con contenido real — no tiene sentido
  // mandarle a la IA campos vacíos o con "___"
  const camposConContenido = Object.entries(campos)
    .filter(([_, v]) => v && String(v).trim() && String(v).trim() !== '___')
    .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
    .join('\n\n');

  if (!camposConContenido) {
    return res.status(400).json({ error: 'Escribe al menos el motivo de consulta o la enfermedad actual antes de analizar' });
  }

  const userContent = `Tipo de nota: ${tipo || 'Historia Clínica'}\n\nLo que el médico ya escribió:\n\n${camposConContenido}`;

  try {
    const { texto, proveedorUsado } = await llamarIAConRespaldo(userContent);
    // Extracción robusta: se queda con todo desde la primera "{" hasta la
    // última "}" — así ignora cualquier texto explicativo que el modelo
    // haya agregado antes/después del JSON, además de quitar los ```json.
    let jsonLimpio = texto.replace(/```json|```/g, '').trim();
    const inicioJson = jsonLimpio.indexOf('{');
    const finJson = jsonLimpio.lastIndexOf('}');
    if (inicioJson !== -1 && finJson !== -1 && finJson > inicioJson) {
      jsonLimpio = jsonLimpio.slice(inicioJson, finJson + 1);
    }
    jsonLimpio = sanearSaltosDeLineaEnStrings(jsonLimpio);
    let resultado;
    try {
      resultado = JSON.parse(jsonLimpio);
    } catch (e) {
      // Se registra el texto completo en el log del servidor, y se manda
      // un fragmento REAL al frontend — específicamente alrededor del
      // punto exacto donde falló el parseo (no solo el inicio), y se
      // detecta si la respuesta parece haberse cortado antes de terminar.
      console.error('No se pudo parsear la respuesta de la IA. Texto completo recibido:', texto);
      const posMatch = e.message.match(/position (\d+)/);
      const pos = posMatch ? parseInt(posMatch[1], 10) : null;
      let fragmento;
      if (pos !== null) {
        const inicio = Math.max(0, pos - 200);
        const fin = Math.min(jsonLimpio.length, pos + 100);
        fragmento = `${inicio > 0 ? '...' : ''}${jsonLimpio.slice(inicio, fin)}${fin < jsonLimpio.length ? '...' : ''}`;
      } else {
        fragmento = jsonLimpio.slice(-400); // sin posición: mostrar el FINAL, para ver si se cortó ahí
      }
      const pareceCortado = !jsonLimpio.trim().endsWith('}');
      return res.status(502).json({
        error: `La IA (${proveedorUsado}) respondió en un formato inesperado.${pareceCortado ? ' La respuesta PARECE HABERSE CORTADO antes de terminar (no termina en "}").' : ''} Detalle: ${e.message}. Texto alrededor del problema: "${fragmento}"`
      });
    }
    resultado._proveedor = proveedorUsado; // informativo — el frontend puede mostrarlo si quiere

    // Se guarda SIEMPRE, automáticamente — incluye lo que se envió y la
    // respuesta completa, aunque el médico después no use ninguna
    // sugerencia. Si falla el guardado, no se bloquea la respuesta al
    // médico (el análisis ya lo tiene en pantalla); solo se registra el
    // error en el log del servidor.
    try {
      await db.query(
        `INSERT INTO analisis_ia (usuario_id, documento_paciente, nombre_paciente, tipo_formulario, campos_enviados, respuesta_ia, proveedor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [req.user.id, documento || null, nombrePaciente || null, tipo || 'Historia Clínica', JSON.stringify(campos), JSON.stringify(resultado), proveedorUsado]
      );
    } catch (errorGuardado) {
      console.error('No se pudo guardar el análisis de IA en el historial:', errorGuardado.message);
    }

    res.json(resultado);
  } catch (e) {
    console.error('Error llamando a la IA (ambos proveedores fallaron o ninguno está configurado):', e.message);
    res.status(502).json({ error: 'No se pudo conectar con ningún proveedor de IA — verifica las API keys y el crédito disponible' });
  }
});

// GET /api/ia/historial/:documento — historial de análisis de un paciente
router.get('/historial/:documento', authMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.documento_paciente, a.tipo_formulario, a.campos_enviados, a.respuesta_ia, a.proveedor, a.created_at, u.nombre AS medico
       FROM analisis_ia a
       LEFT JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.documento_paciente = $1
       ORDER BY a.created_at DESC`,
      [req.params.documento]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo el historial de análisis' });
  }
});

module.exports = router;
