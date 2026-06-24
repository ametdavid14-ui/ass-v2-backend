// =============================================
// ASS v2.0 — Rutas de Configuración PERSONAL
// Preferencias propias de cada usuario: modo oscuro,
// ediciones temporales de EF/Evolución, exámenes ocultos,
// triage personalizado. Reemplaza LocalStorage por completo.
// Cualquier usuario logueado puede leer/escribir SU PROPIA config.
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/config-personal/:clave — Leer una preferencia propia
router.get('/:clave', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT valor FROM config_personal WHERE usuario_id = $1 AND clave = $2',
      [req.user.id, req.params.clave]
    );
    if (!result.rows.length) return res.json(null);
    res.json(result.rows[0].valor);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo configuración personal' });
  }
});

// PUT /api/config-personal/:clave — Guardar una preferencia propia
router.put('/:clave', authMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ error: 'Falta el campo valor' });
    await db.query(`
      INSERT INTO config_personal (usuario_id, clave, valor)
      VALUES ($1, $2, $3)
      ON CONFLICT (usuario_id, clave) DO UPDATE SET valor = $3, updated_at = NOW()
    `, [req.user.id, req.params.clave, JSON.stringify(valor)]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando configuración personal' });
  }
});

module.exports = router;
