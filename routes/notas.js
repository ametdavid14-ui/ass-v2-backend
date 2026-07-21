// =============================================
// ASS v2.0 — Notas del Turno
// - Por defecto expiran en 24h (comportamiento de siempre).
// - Si el usuario es admin, o si el admin activó la retención indefinida
//   para los usuarios (config_modulos: 'notas_retencion_indefinida_usuarios'),
//   la nota queda guardada indefinidamente hasta que se borre a mano.
// - Guarda el nombre del paciente (PACIENTE_GLOBAL del frontend) para poder
//   identificar la nota en el Calendario Médico.
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

async function retencionIndefinidaHabilitada() {
  try {
    const r = await db.query(`SELECT valor FROM config_modulos WHERE clave = 'notas_retencion_indefinida_usuarios'`);
    const v = r.rows[0]?.valor;
    return v === true || v === 'true';
  } catch (e) {
    return false;
  }
}

// GET /api/notas — Notas del turno ACTIVO (las que aún no expiraron)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, tipo, contenido, paciente, created_at, expira_at, retencion_indefinida
       FROM notas_turno
       WHERE usuario_id = $1 AND expira_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo notas' });
  }
});

// GET /api/notas/calendario?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Cuenta cuántas notas de retención indefinida hay por día, para pintar los
// puntos en el Calendario Médico.
router.get('/calendario', authMiddleware, async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'desde y hasta son requeridos' });
  try {
    const result = await db.query(
      `SELECT DATE(created_at) AS fecha, COUNT(*) AS total
       FROM notas_turno
       WHERE usuario_id = $1 AND retencion_indefinida = true
         AND created_at >= $2 AND created_at < ($3::date + INTERVAL '1 day')
       GROUP BY DATE(created_at)`,
      [req.user.id, desde, hasta]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo calendario de notas' });
  }
});

// GET /api/notas/dia?fecha=YYYY-MM-DD
// Todas las notas de retención indefinida de ESE día (para el Calendario Médico)
router.get('/dia', authMiddleware, async (req, res) => {
  const { fecha } = req.query;
  if (!fecha) return res.status(400).json({ error: 'fecha requerida' });
  try {
    const result = await db.query(
      `SELECT id, tipo, contenido, paciente, created_at
       FROM notas_turno
       WHERE usuario_id = $1 AND retencion_indefinida = true AND DATE(created_at) = $2
       ORDER BY created_at ASC`,
      [req.user.id, fecha]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo notas del día' });
  }
});

// POST /api/notas — Guardar nota del turno
router.post('/', authMiddleware, async (req, res) => {
  const { tipo, contenido, paciente } = req.body;
  if (!tipo) {
    return res.status(400).json({ error: 'tipo requerido' });
  }
  try {
    const esAdmin = req.user.rol === 'admin';
    const indefinida = esAdmin || await retencionIndefinidaHabilitada();
    const expiraSql = indefinida ? `NOW() + INTERVAL '100 years'` : `NOW() + INTERVAL '24 hours'`;
    const result = await db.query(
      `INSERT INTO notas_turno (usuario_id, tipo, contenido, paciente, expira_at, retencion_indefinida)
       VALUES ($1, $2, $3, $4, ${expiraSql}, $5)
       RETURNING id, tipo, contenido, paciente, created_at, expira_at, retencion_indefinida`,
      [req.user.id, tipo, contenido || '', paciente || '', indefinida]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error guardando nota' });
  }
});

// PUT /api/notas/:id — Editar nota existente (mientras no haya expirado)
router.put('/:id', authMiddleware, async (req, res) => {
  const { contenido } = req.body;
  if (contenido === undefined) return res.status(400).json({ error: 'contenido requerido' });
  try {
    const result = await db.query(
      `UPDATE notas_turno SET contenido = $1
       WHERE id = $2 AND usuario_id = $3 AND expira_at > NOW()
       RETURNING id, tipo, contenido, paciente, created_at, expira_at`,
      [contenido, req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Nota no encontrada o ya expiró' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error editando nota' });
  }
});

// DELETE /api/notas/:id — Eliminar nota específica (el admin usa esto para
// borrar manualmente notas de retención indefinida desde el Calendario Médico)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM notas_turno WHERE id = $1 AND usuario_id = $2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Nota eliminada' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando nota' });
  }
});

// DELETE /api/notas — Limpiar todas las notas del turno actual (solo las
// de expiración normal; las de retención indefinida se conservan a propósito
// y se borran una por una desde el Calendario Médico)
router.delete('/', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM notas_turno WHERE usuario_id = $1 AND retencion_indefinida = false', [req.user.id]);
    res.json({ message: 'Turno limpiado' });
  } catch (e) {
    res.status(500).json({ error: 'Error limpiando turno' });
  }
});

module.exports = router;
