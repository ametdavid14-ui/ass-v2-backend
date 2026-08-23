// =============================================
// ASS v2.0 — Ruta de IA: asistente clínico que analiza una nota (Historia
// Clínica, Evolución Médica, Análisis de Salida) y ofrece 3 cosas:
//   1. Calcula escalas clínicas relevantes según el cuadro (HEART, CURB-65,
//      Glasgow, Wells, etc.) — solo si hay datos suficientes para calcularlas.
//   2. Sugiere un análisis más completo y mejor argumentado.
//   3. Sugiere qué preguntar/confirmar con el paciente para sustentar mejor
//      el diagnóstico — NUNCA inventa negativos ("niega fiebre") que el
//      médico no haya preguntado realmente; solo sugiere la pregunta.
//
// IMPORTANTE — cómo está diseñado a propósito:
// - Claude NUNCA escribe la nota final ni la historia clínica directamente.
//   Solo devuelve SUGERENCIAS que el médico revisa, edita y decide si usar
//   — mismo panel que ya existe para Planes/Recomendaciones.
// - Claude solo ve los campos que el médico YA escribió — nunca inventa
//   datos clínicos (signos, síntomas, antecedentes) que no estén ahí.
// - Requiere ANTHROPIC_API_KEY configurada en las variables de entorno.
// =============================================

const router = require('express').Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware } = require('../middleware/auth');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
6. Si la información dada es insuficiente para sugerir algo útil en alguna de las 5 partes, dilo claramente en esa parte (array vacío) en vez de inventar contenido para rellenar.
7. Los códigos CIE-10 son SIEMPRE una sugerencia a verificar por el médico antes de facturar o registrar — nunca se presentan como definitivos.

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

// POST /api/ia/analizar-nota
router.post('/analizar-nota', authMiddleware, async (req, res) => {
  const { tipo, campos } = req.body;
  if (!campos || typeof campos !== 'object') {
    return res.status(400).json({ error: 'Faltan los campos de la nota' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY)' });
  }

  // Solo se envían los campos con contenido real — no tiene sentido
  // mandarle a Claude campos vacíos o con "___"
  const camposConContenido = Object.entries(campos)
    .filter(([_, v]) => v && String(v).trim() && String(v).trim() !== '___')
    .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
    .join('\n\n');

  if (!camposConContenido) {
    return res.status(400).json({ error: 'Escribe al menos el motivo de consulta o la enfermedad actual antes de analizar' });
  }

  try {
    const mensaje = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Tipo de nota: ${tipo || 'Historia Clínica'}\n\nLo que el médico ya escribió:\n\n${camposConContenido}` }
      ],
    });

    const textoRespuesta = mensaje.content[0]?.text || '{}';
    // Claude a veces envuelve el JSON en ```json ... ``` pese a la instrucción — se limpia por si acaso
    const jsonLimpio = textoRespuesta.replace(/```json|```/g, '').trim();
    let resultado;
    try {
      resultado = JSON.parse(jsonLimpio);
    } catch (e) {
      return res.status(502).json({ error: 'La IA respondió en un formato inesperado. Intenta de nuevo.' });
    }

    res.json(resultado);
  } catch (e) {
    console.error('Error llamando a Claude:', e.message);
    res.status(502).json({ error: 'No se pudo conectar con la IA — verifica la API key y el crédito disponible' });
  }
});

module.exports = router;
