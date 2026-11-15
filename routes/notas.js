// =============================================
// ASS v2.0 — Notas del Turno
// - Expiran SIEMPRE a las 24 horas. No se guarda información de pacientes.
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// GET /api/notas — Notas del turno ACTIVO (las que aún no expiraron)
router.get('/', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM notas_turno WHERE expira_at < NOW()').catch(() => {});
    const result = await db.query(
      `SELECT id, tipo, contenido, paciente, documento, tipo_documento, created_at, expira_at, retencion_indefinida
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
      // Se convierte cada created_at a hora de Bogotá antes de extraer el
      // DATE. De lo contrario, PostgreSQL agrupa en UTC y toda nota generada
      // después de las 7pm hora Colombia cuenta como del día siguiente.
      `SELECT DATE(created_at AT TIME ZONE 'America/Bogota') AS fecha, COUNT(*) AS total
       FROM notas_turno
       WHERE usuario_id = $1 AND retencion_indefinida = true
         AND created_at >= ($2::date AT TIME ZONE 'America/Bogota')
         AND created_at <  (($3::date + INTERVAL '1 day') AT TIME ZONE 'America/Bogota')
       GROUP BY DATE(created_at AT TIME ZONE 'America/Bogota')`,
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
      // Filtra por día calendario en hora de Bogotá (ver comentario en /calendario)
      `SELECT id, tipo, contenido, paciente, documento, tipo_documento, created_at
       FROM notas_turno
       WHERE usuario_id = $1 AND retencion_indefinida = true
         AND DATE(created_at AT TIME ZONE 'America/Bogota') = $2
       ORDER BY created_at ASC`,
      [req.user.id, fecha]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo notas del día' });
  }
});

// POST /api/notas — Guardar nota del turno
// Determina a qué INGRESO (episodio_id) pertenece una nota nueva:
// - Si viene un episodio_id_forzado (el médico entró directo a un ingreso
//   viejo desde la Ficha del Paciente y agregó una nota ahí), se usa ESE
//   sin importar cuánto tiempo haya pasado — eso "reabre" el ingreso.
// - Si no, se busca la nota más reciente de ese documento (de cualquier
//   tipo). Si fue hace menos de 24 horas, se reutiliza su episodio_id
//   (sigue siendo la misma atención). Si no hay ninguna, o la última fue
//   hace 24 horas o más, se genera un episodio_id nuevo (nuevo ingreso).
router.post('/', authMiddleware, async (req, res) => {
  const { tipo, contenido } = req.body;
  if (!tipo) return res.status(400).json({ error: 'tipo requerido' });
  try {
    // Nunca se guardan datos de pacientes (nombre/documento) y la nota
    // siempre expira a las 24 horas.
    const result = await db.query(
      `INSERT INTO notas_turno (usuario_id, tipo, contenido, paciente, documento, tipo_documento, expira_at, retencion_indefinida, episodio_id)
       VALUES ($1, $2, $3, '', '', '', NOW() + INTERVAL '24 hours', false, NULL)
       RETURNING id, tipo, contenido, paciente, documento, tipo_documento, created_at, expira_at, retencion_indefinida, episodio_id`,
      [req.user.id, tipo, contenido || '']
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
       RETURNING id, tipo, contenido, paciente, documento, tipo_documento, created_at, expira_at`,
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
