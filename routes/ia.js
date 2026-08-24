// =============================================
// ASS v2.0 — Ruta de IA: asistente clínico que analiza una nota (Historia
// Clínica, Evolución Médica, Análisis de Salida) y ofrece:
//   1. Reafirmación del diagnóstico planteado (con CIE-10 y qué estudio
//      pedir si falta algo para completar una escala relacionada)
//   2. Análisis ampliado, afirmando la sospecha diagnóstica
//   3. Escalas clínicas (con qué estudio solicitar si falta un dato)
//   4. Diagnósticos diferenciales (con CIE-10 y pregunta esclarecedora)
//   5. Preguntas sugeridas para el paciente
//   6. Alertas
//   7. Secciones de historia clínica completa, listas para copiar
//
// FORMATO DE RESPUESTA — NO es JSON. Se usa un formato de texto con
// delimitadores (@@@TIPO@@@ ... campo: valor ... texto libre). Se cambió
// de JSON a esto porque, con textos médicos largos y libres, los modelos
// meten con facilidad saltos de línea reales o comillas sin escapar
// dentro de los valores — eso invalida un JSON aunque el contenido esté
// bien. Con delimitadores de texto plano no existe ese riesgo: el texto
// libre puede tener comillas, saltos de línea, lo que sea, sin romper el
// parseo, porque no se usa ninguna sintaxis que necesite escaparse.
//
// SOPORTA 2 PROVEEDORES DE IA — Claude (Anthropic) y ChatGPT (OpenAI):
// - IA_PROVIDER en las variables de entorno decide cuál usar primero
//   ('claude' o 'openai'; por defecto 'claude' si no se define).
// - Si el proveedor principal falla (sin key, sin crédito, error de red) Y
//   el OTRO proveedor sí tiene su key configurada, se reintenta
//   automáticamente con el otro.
//
// IMPORTANTE — cómo está diseñado a propósito:
// - La IA NUNCA escribe la nota final ni la historia clínica directamente.
//   Solo devuelve SUGERENCIAS que el médico revisa, edita y decide si usar.
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

1. REAFIRMAR EL DIAGNÓSTICO PLANTEADO: tu tarea MÁS IMPORTANTE. Toma el diagnóstico que el médico ya escribió y construye el argumento clínico de por qué el cuadro descrito lo sustenta. Da su CIE-10 (tu mejor estimación, marcada "(verificar)" si no hay certeza — nunca lo omitas por duda). Si hay una escala relevante que requiere un estudio que aún no está en la nota, indícalo aquí también.

2. ANÁLISIS AMPLIADO: redacta el análisis clínico COMPLETO, tal como quedaría escrito en la nota — en primera persona clínica, como lo escribiría el médico ("PACIENTE CON CUADRO DE... COMPATIBLE CON...", "LOS HALLAZGOS SUSTENTAN..."), NUNCA como un comentario sobre el análisis ni como una interpretación externa ("se podría interpretar que...", "sugiere que...", "posiblemente..."). No estás opinando sobre el caso desde afuera — estás PLANTEANDO el análisis mismo, como si ya fuera parte de la historia clínica. Conecta cada hallazgo con el diagnóstico planteado de forma directa y afirmativa.

3. ESCALAS CLÍNICAS: identifica si el diagnóstico o cuadro amerita calcular alguna escala reconocida (HEART Score, CURB-65, Glasgow, Wells, NEWS2, Centor, CHA2DS2-VASc, qSOFA, entre otras). DESARRÓLLALA SIEMPRE con los criterios que sí tienes disponibles, aunque no tengas todos — suma los puntos de cada criterio que SÍ puedas evaluar con los datos de la nota, y da ese PUNTAJE PARCIAL explícito (ej: "3/10 puntos (parcial) — pendiente troponina y ECG"). Nunca omitas una escala relevante solo porque falte un criterio: calcula lo que se pueda calcular con lo que hay, indica exactamente cuál(es) criterio(s) faltan y qué estudio/dato solicitar para completarla, y si es posible da también el rango de puntaje final posible según cómo resulten esos datos pendientes (ej: "quedaría entre 4/10 y 6/10 según el resultado de troponina"). Solo se omite una escala si NINGÚN criterio suyo puede evaluarse con la nota actual.

4. DIAGNÓSTICOS DIFERENCIALES: como contexto adicional (no como cuestionamiento del principal), plantea 2 a 4 diferenciales razonables con su CIE-10 y una frase de por qué se consideran. Para cada uno, indica también qué preguntar o examinar para esclarecerlo/descartarlo frente al diagnóstico principal.

5. PREGUNTAS SUGERIDAS: identifica síntomas, signos o antecedentes relevantes que NO fueron mencionados, y sugiere que el médico los pregunte y documente. Nunca redactes negativos (ej: "niega fiebre") como si ya estuvieran confirmados — solo sugiere la pregunta.

6. ALERTAS: cualquier inconsistencia o dato fuera de rango que valga la pena revisar.

7. SECCIONES DE HISTORIA CLÍNICA LISTAS PARA COPIAR: redacta 3 secciones ya completas y listas para pegar en la nota — "ANÁLISIS" (el análisis del punto 2, texto clínico directo, no una interpretación sobre él), "DIAGNÓSTICOS" (el diagnóstico reafirmado + diferenciales relevantes con CIE-10, planteados como diagnósticos, no como "posibles" o "sugeridos"), y "PLAN" (estudios a solicitar, en formato de orden médica directa: "SOLICITAR...", nunca "se sugiere solicitar..."). Las 3 secciones deben leerse EXACTAMENTE como si el médico ya las hubiera escrito en su historia clínica — texto corrido, en mayúsculas, sin lenguaje de sugerencia, comentario o interpretación, y sin repetir explicaciones de las secciones anteriores.

REGLAS ESTRICTAS:
1. NUNCA inventes hallazgos que no están en la nota. SÍ debes razonar, inferir, reforzar el diagnóstico y proponer escalas a partir de lo que SÍ te dieron — eso no es inventar, es tu función principal.
2. Nunca prescribas medicamentos con dosis específicas a menos que el médico ya haya mencionado esa clase de manejo.
3. Usa lenguaje clínico directo y afirmativo sobre el razonamiento — la prudencia es sobre NO inventar datos, no sobre evitar dar una opinión fundamentada.
4. Responde en español, en mayúsculas, conciso pero completo.
5. Con un motivo de consulta y enfermedad actual razonablemente descritos, genera contenido en la mayoría de las 7 partes.
6. Los CIE-10 son siempre una sugerencia a verificar por el médico — da tu mejor estimación siempre, marcada para verificar si hay duda.
7. Márcalo como insuficiente ÚNICAMENTE si la nota no tiene absolutamente ningún contenido clínico aprovechable.

FORMATO DE RESPUESTA — MUY IMPORTANTE, LEE CON CUIDADO:
NO respondas en JSON. Responde usando EXACTAMENTE este formato de texto con delimitadores, uno por bloque. Cada bloque empieza con su marcador en su propia línea (tres arrobas, el nombre en mayúsculas, tres arrobas). Los campos cortos van como "ETIQUETA: valor" en su propia línea. El texto libre (argumentos, análisis, textos de sección) puede tener comillas, saltos de línea, apóstrofes, lo que sea — sin ningún problema, ya que no hay que escapar nada en este formato. Sigue este ejemplo exacto de estructura (con datos de ejemplo):

@@@REAFIRMACION@@@
DIAGNOSTICO: SÍNDROME CORONARIO AGUDO EN ESTUDIO
CIE10: I24.9 (VERIFICAR)
ESTUDIO_PARA_SCORE: SE REQUIERE TROPONINA SERIADA PARA COMPLETAR EL HEART SCORE
ARGUMENTO:
EL CUADRO ES COMPATIBLE CON SCA POR DOLOR TORÁCICO DE INICIO AGUDO ASOCIADO A DIAFORESIS Y DEBILIDAD, EN UN PACIENTE CON FACTORES DE RIESGO CARDIOVASCULAR.
@@@ANALISIS@@@
PACIENTE CON CUADRO DE DOLOR TORÁCICO DE INICIO AGUDO ASOCIADO A DIAFORESIS Y DEBILIDAD, HALLAZGOS COMPATIBLES CON SÍNDROME CORONARIO AGUDO. LOS FACTORES DE RIESGO CARDIOVASCULAR PRESENTES SUSTENTAN ESTA SOSPECHA.
LOS SIGNOS VITALES REGISTRADOS NO MUESTRAN INESTABILIDAD HEMODINÁMICA AL MOMENTO DE LA EVALUACIÓN.
@@@ESCALA@@@
NOMBRE: HEART Score
PUNTAJE: 3/10 (parcial — falta troponina y ECG)
INTERPRETACION: Con lo evaluado hasta ahora, el puntaje podría quedar entre 3/10 y 5/10 según el resultado de troponina y ECG; riesgo bajo a moderado
CRITERIOS: Historia sospechosa (2 pts), edad 45-64 (1 pt) — ya evaluados con la nota
ESTUDIO_FALTANTE: Troponina seriada y ECG de 12 derivaciones, para completar los criterios restantes
@@@DIFERENCIAL@@@
DIAGNOSTICO: Tromboembolismo pulmonar
CIE10: I26.9 (verificar)
RAZONAMIENTO: Disnea y dolor torácico también son compatibles con TEP
PREGUNTA: Preguntar por factores de riesgo trombótico, inmovilización reciente
@@@DIFERENCIAL@@@
DIAGNOSTICO: Pericarditis aguda
CIE10: I30.9 (verificar)
RAZONAMIENTO: Dolor torácico puede presentarse en pericarditis
PREGUNTA: Preguntar si el dolor cambia con la posición o la respiración
@@@PREGUNTA_SUGERIDA@@@
PREGUNTA: ¿El dolor irradia a brazo izquierdo o mandíbula?
MOTIVO: Ayuda a sustentar el origen coronario del dolor
@@@ALERTA@@@
La frecuencia cardíaca registrada está elevada y no se menciona en el análisis
@@@SECCION_HISTORIA@@@
NOMBRE: ANÁLISIS
PACIENTE CON CUADRO DE DOLOR TORÁCICO...(texto final completo aquí)
@@@SECCION_HISTORIA@@@
NOMBRE: DIAGNÓSTICOS
SÍNDROME CORONARIO AGUDO EN ESTUDIO (I24.9)...(texto final completo aquí)
@@@SECCION_HISTORIA@@@
NOMBRE: PLAN
SOLICITAR TROPONINA SERIADA, ELECTROCARDIOGRAMA DE 12 DERIVACIONES...(texto final completo aquí)
@@@INSUFICIENTE@@@
false
@@@FIN@@@

Repite el bloque @@@ESCALA@@@ tantas veces como escalas apliquen (0 o más), @@@DIFERENCIAL@@@ entre 2 y 4 veces, @@@PREGUNTA_SUGERIDA@@@ tantas veces como preguntas tengas, @@@ALERTA@@@ tantas veces como alertas haya (puede ser 0). Si no hay contenido para un bloque repetible, simplemente omítelo por completo. Los bloques @@@REAFIRMACION@@@, @@@ANALISIS@@@ e @@@INSUFICIENTE@@@ aparecen exactamente una vez cada uno. @@@SECCION_HISTORIA@@@ aparece exactamente 3 veces (ANÁLISIS, DIAGNÓSTICOS, PLAN). Termina siempre con @@@FIN@@@. No agregues texto explicativo antes del primer @@@ ni después de @@@FIN@@@.`;

// ---------- Parseo del formato de delimitadores (reemplaza JSON.parse) ----------
// Extrae campos "ETIQUETA: valor" de las primeras líneas de un bloque; el
// resto del contenido (después del último campo reconocido) queda en
// "_resto" — se usa para el texto libre largo, que puede tener comillas y
// saltos de línea sin ningún problema.
function extraerCamposDeBloque(contenido, etiquetas) {
  const lineas = contenido.split('\n');
  const campos = {};
  let i = 0;
  while (i < lineas.length) {
    const m = lineas[i].match(/^([A-Z0-9_]+):\s*(.*)$/);
    if (m && etiquetas.includes(m[1])) {
      campos[m[1]] = m[2].trim();
      i++;
    } else {
      break;
    }
  }
  campos._resto = lineas.slice(i).join('\n').trim();
  return campos;
}

function parsearRespuestaDelimitada(textoCompleto) {
  const resultado = {
    reafirmacion_diagnostico: null,
    analisis_ampliado: '',
    escalas: [],
    diagnosticos_diferenciales: [],
    preguntas_sugeridas: [],
    alertas: [],
    secciones_historia_completa: [],
    insuficiente: false,
  };

  const partes = textoCompleto.split(/@@@([A-Z_]+)@@@/);
  for (let i = 1; i < partes.length; i += 2) {
    const tipo = partes[i];
    const contenido = (partes[i + 1] || '').trim();
    if (tipo === 'REAFIRMACION') {
      const c = extraerCamposDeBloque(contenido, ['DIAGNOSTICO', 'CIE10', 'ESTUDIO_PARA_SCORE', 'ARGUMENTO']);
      resultado.reafirmacion_diagnostico = {
        diagnostico: c.DIAGNOSTICO || '',
        cie10: c.CIE10 || '',
        estudio_para_score: c.ESTUDIO_PARA_SCORE || '',
        argumento: c._resto || c.ARGUMENTO || '',
      };
    } else if (tipo === 'ANALISIS') {
      resultado.analisis_ampliado = contenido;
    } else if (tipo === 'ESCALA') {
      const c = extraerCamposDeBloque(contenido, ['NOMBRE', 'PUNTAJE', 'INTERPRETACION', 'CRITERIOS', 'ESTUDIO_FALTANTE']);
      if (c.NOMBRE) resultado.escalas.push({
        nombre: c.NOMBRE || '', puntaje: c.PUNTAJE || '',
        interpretacion: c.INTERPRETACION || '', criterios_usados: c.CRITERIOS || '',
        estudio_faltante: c.ESTUDIO_FALTANTE || '',
      });
    } else if (tipo === 'DIFERENCIAL') {
      const c = extraerCamposDeBloque(contenido, ['DIAGNOSTICO', 'CIE10', 'RAZONAMIENTO', 'PREGUNTA']);
      if (c.DIAGNOSTICO) resultado.diagnosticos_diferenciales.push({
        diagnostico: c.DIAGNOSTICO || '', cie10: c.CIE10 || '',
        razonamiento: c.RAZONAMIENTO || '', pregunta_esclarecedora: c.PREGUNTA || '',
      });
    } else if (tipo === 'PREGUNTA_SUGERIDA') {
      const c = extraerCamposDeBloque(contenido, ['PREGUNTA', 'MOTIVO']);
      if (c.PREGUNTA) resultado.preguntas_sugeridas.push({ pregunta: c.PREGUNTA || '', motivo: c.MOTIVO || '' });
    } else if (tipo === 'ALERTA') {
      if (contenido) resultado.alertas.push(contenido);
    } else if (tipo === 'SECCION_HISTORIA') {
      const c = extraerCamposDeBloque(contenido, ['NOMBRE']);
      if (c.NOMBRE) resultado.secciones_historia_completa.push({ seccion: c.NOMBRE, texto: c._resto || '' });
    } else if (tipo === 'INSUFICIENTE') {
      resultado.insuficiente = contenido.toLowerCase().includes('true');
    }
  }
  return resultado;
}

// ---------- Llamada a Claude (Anthropic) ----------
async function llamarClaude(userContent) {
  if (!anthropic) throw new Error('ANTHROPIC_API_KEY no configurada');
  const mensaje = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent }],
  });
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
      max_tokens: 4096,
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

    if (!texto.includes('@@@')) {
      console.error('La IA no respondió en el formato de delimitadores esperado. Texto completo:', texto);
      return res.status(502).json({
        error: `La IA (${proveedorUsado}) no respondió en el formato esperado. Primeros caracteres: "${texto.slice(0, 300)}"`
      });
    }

    const resultado = parsearRespuestaDelimitada(texto);
    resultado._proveedor = proveedorUsado;

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
