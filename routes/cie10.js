// =============================================
// ASS v2.0 — Ruta de búsqueda del catálogo CIE-10 completo (14.212
// códigos). Requiere haber corrido sql/12-cie10-completo.sql antes.
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { llamarIAConRespaldo } = require('../utils/iaProveedor');

// Búsqueda indiferente a tildes y mayúsculas: se normaliza el texto de la
// BD (sin necesitar extensiones) y el texto buscado, y se exige que TODAS
// las palabras escritas aparezcan en la descripción.
const NORM_SQL = "translate(lower(descripcion), 'áéíóúüñàèìòù', 'aeiouunaeiou')";
function normalizarBusqueda(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function condicionPalabras(texto, desdeParam) {
  const palabras = normalizarBusqueda(texto).split(/[^a-z0-9]+/).filter(p => p.length >= 2).slice(0, 8).map(p => p.length > 3 ? p.replace(/(es|s)$/, '') : p);
  if (!palabras.length) return { sql: 'TRUE', params: [] };
  return { sql: palabras.map((_, i) => `${NORM_SQL} LIKE $${desdeParam + i}`).join(' AND '), params: palabras.map(p => `%${p}%`) };
}

// GET /api/cie10/buscar?q=texto — busca por código o por descripción.
// Si el texto parece un código (empieza con letra+número, ej "I21" o
// "i21.9"), prioriza coincidencia por código; si no, busca por texto
// completo en la descripción (más rápido que ILIKE con 14.000 filas).
router.get('/buscar', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);
  try {
    const pareceCodigo = /^[a-zA-Z]\d/.test(q);
    let resultado;
    if (pareceCodigo) {
      resultado = await db.query(
        `SELECT replace(codigo, '.', '') AS codigo, descripcion FROM cie10_codigos
         WHERE replace(codigo, '.', '') ILIKE $1
         ORDER BY codigo LIMIT 50`,
        [`${q.replace(/\./g, '').toUpperCase()}%`]
      );
    } else {
      const cond = condicionPalabras(q, 1);
      resultado = await db.query(
        `SELECT replace(codigo, '.', '') AS codigo, descripcion FROM cie10_codigos
         WHERE ${cond.sql}
         ORDER BY length(descripcion) ASC, codigo LIMIT 50`,
        cond.params
      );
    }
    res.json(resultado.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error buscando en el catálogo CIE-10' });
  }
});

// ---------- Búsqueda SINDROMÁTICA (por síntoma) ----------
// Ej: buscas "dolor torácico" (un síntoma, no un diagnóstico) y te
// devuelve diagnósticos ESPECÍFICOS que lo explicarían (angina, IAM,
// derrame pleural, etc.), cada uno con su código real del catálogo.
// Una búsqueda de texto simple no puede hacer esto — "dolor torácico"
// nunca aparece escrito dentro de la descripción de "Angina de pecho".
// Por eso se usa la IA para plantear los diagnósticos específicos, y
// LUEGO se busca el código real de cada uno en el catálogo (la IA nunca
// inventa el código directamente, se valida contra la tabla real).
const PROMPT_SINDROMATICO = `Eres un asistente clínico. Dado un síntoma o síndrome que escribe un médico de urgencias, lista entre 6 y 12 diagnósticos ESPECÍFICOS (nunca el síntoma mismo) que se consideran como causa de esa presentación en un servicio de urgencias, del más frecuente/importante al menos frecuente.

Responde ÚNICAMENTE con un diagnóstico por línea, sin numeración, sin viñetas, sin explicación adicional — solo el nombre del diagnóstico tal como aparecería en una clasificación médica estándar, uno por línea. Nada de texto antes ni después de la lista.

Ejemplo — si el síntoma es "dolor torácico", tu respuesta completa sería:
Angina de pecho
Infarto agudo del miocardio
Derrame pleural
Neumotórax
Pericarditis aguda
Reflujo gastroesofágico
Costocondritis
Tromboembolismo pulmonar
Disección aórtica
Espasmo esofágico`;

// GET /api/cie10/buscar-sindromatico?q=síntoma
router.get('/buscar-sindromatico', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 3) {
    return res.status(400).json({ error: 'Escribe un síntoma o síndrome más específico (mínimo 3 letras)' });
  }
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'La IA no está configurada en el servidor (falta ANTHROPIC_API_KEY y/o OPENAI_API_KEY)' });
  }
  try {
    const { texto, proveedorUsado } = await llamarIAConRespaldo(PROMPT_SINDROMATICO, `Síntoma/síndrome: ${q}`, 1024);
    const diagnosticos = texto.split('\n').map(l => l.trim().replace(/^[-•\d.)\s]+/, '')).filter(Boolean).slice(0, 12);

    if (!diagnosticos.length) {
      return res.status(502).json({ error: 'La IA no devolvió ningún diagnóstico para ese síntoma. Intenta de nuevo.' });
    }

    // Por cada diagnóstico que propuso la IA, se busca su código REAL en
    // el catálogo — así el código nunca sale directo de la IA, siempre
    // se valida contra la tabla oficial.
    const resultados = [];
    for (const dx of diagnosticos) {
      const cond = condicionPalabras(dx, 1);
      const r = await db.query(
        `SELECT replace(codigo, '.', '') AS codigo, descripcion FROM cie10_codigos
         WHERE ${cond.sql}
         ORDER BY length(descripcion) ASC
         LIMIT 1`,
        cond.params
      );
      resultados.push({
        diagnostico: dx,
        codigo: r.rows[0]?.codigo || null,
        descripcion_catalogo: r.rows[0]?.descripcion || null,
      });
    }
    res.json({ sintoma: q, proveedor: proveedorUsado, resultados });
  } catch (e) {
    console.error('Error en búsqueda sindromática CIE-10:', e.message);
    res.status(502).json({ error: 'No se pudo conectar con la IA para esta búsqueda — verifica las API keys y el crédito disponible' });
  }
});

module.exports = router;

