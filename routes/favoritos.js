// =============================================
// ASS v2.0 — Favoritos por Usuario
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/favoritos
router.get('/', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM favoritos WHERE usuario_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo favoritos' });
  }
});

// POST /api/favoritos
router.post('/', authMiddleware, async (req, res) => {
  const { nombre, tipo, contenido } = req.body;
  if (!nombre || !contenido) return res.status(400).json({ error: 'nombre y contenido requeridos' });
  try {
    const result = await db.query(
      'INSERT INTO favoritos (usuario_id, nombre, tipo, contenido) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, nombre, tipo || 'general', contenido]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error guardando favorito' });
  }
});

// DELETE /api/favoritos/:id
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await db.query('DELETE FROM favoritos WHERE id = $1 AND usuario_id = $2', [req.params.id, req.user.id]);
    res.json({ message: 'Favorito eliminado' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando favorito' });
  }
});

module.exports = router;
