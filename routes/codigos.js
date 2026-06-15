// =============================================
// ASS v2.0 — Rutas de Códigos (Labs, RX, CUPS)
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// GET /api/codigos — Obtener todos (con filtro por tipo)
router.get('/', authMiddleware, async (req, res) => {
  const { tipo, categoria } = req.query;
  try {
    let query = 'SELECT * FROM codigos WHERE activo = true';
    const params = [];
    if (tipo) { params.push(tipo); query += ` AND tipo = $${params.length}`; }
    if (categoria) { params.push(`%${categoria}%`); query += ` AND categoria ILIKE $${params.length}`; }
    query += ' ORDER BY tipo, categoria, nombre';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo códigos' });
  }
});

// GET /api/codigos/buscar — Búsqueda global
router.get('/buscar', authMiddleware, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json([]);
  try {
    const result = await db.query(
      `SELECT * FROM codigos WHERE activo = true AND (
        nombre ILIKE $1 OR codigo ILIKE $1 OR categoria ILIKE $1
      ) ORDER BY tipo, nombre LIMIT 50`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error en búsqueda' });
  }
});

// POST /api/codigos — Agregar nuevo código (ADMIN)
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  const { tipo, categoria, nombre, codigo, grupo_cups } = req.body;
  if (!tipo || !categoria || !nombre || !codigo) {
    return res.status(400).json({ error: 'tipo, categoria, nombre y codigo son requeridos' });
  }
  try {
    const result = await db.query(
      `INSERT INTO codigos (tipo, categoria, nombre, codigo, grupo_cups, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [tipo, categoria, nombre.toUpperCase(), codigo, grupo_cups || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error creando código' });
  }
});

// PUT /api/codigos/:id — Editar código (ADMIN)
router.put('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { tipo, categoria, nombre, codigo, grupo_cups, activo } = req.body;
  try {
    const result = await db.query(
      `UPDATE codigos SET tipo=$1, categoria=$2, nombre=$3, codigo=$4,
       grupo_cups=$5, activo=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [tipo, categoria, nombre?.toUpperCase(), codigo, grupo_cups, activo ?? true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Código no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando código' });
  }
});

// DELETE /api/codigos/:id — Desactivar código (ADMIN, soft delete)
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await db.query('UPDATE codigos SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Código desactivado' });
  } catch (e) {
    res.status(500).json({ error: 'Error desactivando código' });
  }
});

module.exports = router;
