// =============================================
// ASS v2.0 — Notas del Turno (expiran en 24h)
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/notas — Notas del turno del usuario actual
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, tipo, contenido, created_at FROM notas_turno
       WHERE usuario_id = $1 AND expira_at > NOW()
       ORDER BY created_at DESC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo notas' });
  }
});

// POST /api/notas — Guardar nota del turno
router.post('/', authMiddleware, async (req, res) => {
  const { tipo, contenido } = req.body;
  if (!tipo || !contenido) {
    return res.status(400).json({ error: 'tipo y contenido requeridos' });
  }
  try {
    const result = await db.query(
      `INSERT INTO notas_turno (usuario_id, tipo, contenido)
       VALUES ($1, $2, $3) RETURNING id, tipo, created_at`,
      [req.user.id, tipo, contenido]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error guardando nota' });
  }
});

// DELETE /api/notas/:id — Eliminar nota específica
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

// DELETE /api/notas — Limpiar todas las notas del turno actual
router.delete('/', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM notas_turno WHERE usuario_id = $1', [req.user.id]);
    res.json({ message: 'Turno limpiado' });
  } catch (e) {
    res.status(500).json({ error: 'Error limpiando turno' });
  }
});

module.exports = router;
