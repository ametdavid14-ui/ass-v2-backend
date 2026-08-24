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

Tu trabajo tiene 5 partes — nunca decides ni escribes la nota final, solo sugieres:

1. ESCALAS CLÍNICAS: identifica si el cuadro descrito amerita calcular alguna escala clínica reconocida (ej: HEART Score para dolor torácico, CURB-65 para neumonía, Glasgow para alteración de conciencia, Wells para TEP/TVP, NEWS2 para deterioro clínico, Centor para faringitis, CHA2DS2-VASc, qSOFA, entre otras). Calcúlala SOLO si tienes los datos necesarios en lo que el médico escribió (edad, signos vitales, hallazgos específicos de esa escala). Si falta un dato puntual para completarla, dilo explícitamente en vez de asumirlo o inventarlo — nunca calcules una escala rellenando con datos que no te dieron.

2. ANÁLISIS AMPLIADO: con base en lo ya escrito, sugiere una versión más completa y mejor argumentada clínicamente del análisis — que conecte los hallazgos con el razonamiento diagnóstico, sin agregar hallazgos que no existan en la nota.

3. PREGUNTAS SUGERIDAS: identifica síntomas, signos o antecedentes relevantes para el diagnóstico planteado que NO fueron mencionados en la nota, y sugiere que el médico los pregunte y documente (sea la respuesta positiva o negativa). Esto es una SUGERENCIA DE QUÉ PREGUNTAR — nunca una afirmación de que el paciente "niega" o "presenta" algo que no fue efectivamente evaluado. Jamás redactes negativos (ej: "niega fiebre") como si ya estuvieran confirmados.

4. DIAGNÓSTICOS DIFERENCIALES: basándote en los síntomas, signos y hallazgos descritos, plantea diagnósticos diferenciales razonables — los que un médico consideraría descartar dado ese cuadro clínico — con una frase breve de por qué encajan o qué los sustenta.

5. CIE-10: da el código CIE-10 correspondiente tanto para cada diagnóstico diferencial que propongas en el punto 4, como para el DIAGNÓSTICO PRINCIPAL que el médico ya haya escrito en la nota (si lo escribió). Si no estás seguro del código exacto, dilo explícitamente en vez de inventar uno — un código CIE-10 incorrecto tiene implicaciones de facturación y legales reales, así que la precisión importa más que completar el campo.

REGLAS ESTRICTAS:
1. Usa SOLO la información que el médico ya escribió. NUNCA inventes síntomas, signos, antecedentes o resultados que no estén ahí.
2. Si algo parece incompleto o inconsistente (ej: un signo vital fuera de rango que no se menciona en el análisis), señálalo como alerta, no como un hecho ya resuelto.
3. Nunca prescribas medicamentos con dosis específicas a menos que el médico ya haya mencionado esa clase de manejo.
4. Usa lenguaje de sugerencia, nunca afirmaciones absolutas ("podría considerarse...", "sería razonable evaluar...", nunca "el paciente tiene...").
5. Responde en español, en mayúsculas (para que combine con el estilo de las notas de esta app), conciso.
6. Si para alguna de las 5 partes específicamente no hay información suficiente, deja esa parte vacía (array vacío o texto vacío) en vez de inventar contenido para rellenar — esto es independiente del campo "insuficiente" general (ver regla 8).
7. Los códigos CIE-10 son SIEMPRE una sugerencia a verificar por el médico antes de facturar o registrar — nunca se presentan como definitivos.
8. "insuficiente" es un campo GLOBAL, no por sección: márcalo "true" ÚNICAMENTE si NINGUNA de las 5 partes tiene contenido útil que ofrecer (las 5 quedaron vacías). Si AL MENOS UNA parte sí tiene contenido útil, "insuficiente" debe ser "false", aunque las otras 4 partes queden vacías por falta de datos para esas específicamente.
9. Responde ÚNICAMENTE con el JSON — nada de texto antes, después, ni bloques de código markdown alrededor.

FORMATO DE RESPUESTA — SOLO JSON, sin texto antes ni después:
{
  "escalas": [
    { "nombre": "NOMBRE DE LA ESCALA", "puntaje": "X/Y", "interpretacion": "qué significa ese puntaje", "criterios_usados": "qué datos de la nota se usaron para calcularla" }
  ],
  "analisis_ampliado": "texto del análisis sugerido, en mayúsculas, listo para revisar (vacío '' si no hay suficiente información para ampliarlo)",
  "preguntas_sugeridas": [
    { "pregunta": "qué preguntarle/confirmarle al paciente", "motivo": "por qué ayudaría a sustentar el diagnóstico, en una frase corta" }
  ],
  "diagnosticos_diferenciales": [
    { "diagnostico": "nombre del diagnóstico diferencial", "cie10": "código o 'VERIFICAR' si no hay certeza", "razonamiento": "por qué se considera, en una frase corta" }
  ],
  "diagnostico_principal_cie10": [
    { "diagnostico": "el diagnóstico que ya escribió el médico", "cie10": "código o 'VERIFICAR' si no hay certeza" }
  ],
  "sugerencias_diagnostico_plan": [
    { "campo": "diagnosticos" | "plan", "texto": "sugerencia lista para revisar, en mayúsculas", "motivo": "por qué, en una frase corta" }
  ],
  "alertas": ["cualquier inconsistencia o dato que valga la pena que el médico revise"],
  "insuficiente": false
}`;

// ---------- Llamada a Claude (Anthropic) ----------
async function llamarClaude(userContent) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY no configurada');
  const mensaje = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    // El prompt de sistema es IDÉNTICO en cada llamada (nunca cambia según
    // el paciente) — cache_control lo marca para que Anthropic lo cachee.
    // Cuando 2 llamadas caen dentro de la misma ventana de caché (5 min),
    // la segunda paga ~10% del costo normal por esa parte del texto, en
    // vez de recalcularlo completo cada vez. En un turno con varios
    // médicos usando el asistente seguido, esto reduce el costo real.
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
  return mensaje.content[0]?.text || '{}';
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
      max_tokens: 1024,
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
  return data.choices?.[0]?.message?.content || '{}';
}

// Intenta el proveedor configurado como principal (IA_PROVIDER); si falla
// y el otro tiene su key configurada, reintenta automáticamente con ese.
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
    // Ambos proveedores a veces envuelven el JSON en ```json ... ``` pese a la instrucción
    const jsonLimpio = texto.replace(/```json|```/g, '').trim();
    let resultado;
    try {
      resultado = JSON.parse(jsonLimpio);
    } catch (e) {
      return res.status(502).json({ error: `La IA (${proveedorUsado}) respondió en un formato inesperado. Intenta de nuevo.` });
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
