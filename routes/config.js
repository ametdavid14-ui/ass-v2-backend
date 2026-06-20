// =============================================
// ASS v2.0 — Rutas de Configuración de Módulos
// Guarda/lee la config de categorías y orden del inicio
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// GET /api/config/:clave — Leer una configuración (cualquier usuario logueado)
router.get('/:clave', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT valor FROM config_modulos WHERE clave = $1', [req.params.clave]);
    if (!result.rows.length) return res.json(null);
    res.json(result.rows[0].valor);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo configuración' });
  }
});

// PUT /api/config/:clave — Guardar/actualizar una configuración (solo admin)
router.put('/:clave', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ error: 'Falta el campo valor' });
    await db.query(`
      INSERT INTO config_modulos (clave, valor, actualizado_por)
      VALUES ($1, $2, $3)
      ON CONFLICT (clave) DO UPDATE SET valor = $2, actualizado_por = $3, updated_at = NOW()
    `, [req.params.clave, JSON.stringify(valor), req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando configuración' });
  }
});

module.exports = router;
