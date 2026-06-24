// =============================================
// ASS v2.0 — Rutas de Plantillas Clínicas
// =============================================
const router = require('express').Router();
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// GET /api/plantillas — Todas las plantillas activas
router.get('/', authMiddleware, async (req, res) => {
  const { tipo } = req.query;
  try {
    let query = 'SELECT * FROM plantillas WHERE activo = true';
    const params = [];
    if (tipo) { params.push(tipo); query += ` AND tipo = $${params.length}`; }
    query += ' ORDER BY tipo, nombre';
    const result = await db.query(query, params);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo plantillas' });
  }
});

// GET /api/plantillas/:id — Una plantilla
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM plantillas WHERE id = $1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Plantilla no encontrada' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo plantilla' });
  }
});

// POST /api/plantillas — Crear plantilla (ADMIN)
router.post('/', authMiddleware, adminMiddleware, async (req, res) => {
  const { tipo, nombre, descripcion, contenido, secciones, es_sistema } = req.body;
  if (!tipo || !nombre || !contenido) {
    return res.status(400).json({ error: 'tipo, nombre y contenido son requeridos' });
  }
  try {
    const result = await db.query(
      `INSERT INTO plantillas (tipo, nombre, descripcion, contenido, secciones, es_sistema, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [tipo, nombre, descripcion, contenido, secciones ? JSON.stringify(secciones) : null,
       es_sistema || false, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error creando plantilla' });
  }
});

// PUT /api/plantillas/:id — Editar plantilla (ADMIN)
router.put('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { nombre, descripcion, contenido, secciones, activo } = req.body;
  try {
    // Las plantillas del sistema SÍ se pueden editar (solo no se pueden eliminar)
    const result = await db.query(
      `UPDATE plantillas SET nombre=$1, descripcion=$2, contenido=$3,
       secciones=$4, activo=$5, updated_at=NOW() WHERE id=$6 RETURNING *`,
      [nombre, descripcion, contenido,
       secciones ? JSON.stringify(secciones) : null, activo ?? true, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando plantilla' });
  }
});

// DELETE /api/plantillas/:id — Desactivar (ADMIN, soft delete)
router.delete('/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const check = await db.query('SELECT es_sistema FROM plantillas WHERE id = $1', [req.params.id]);
    if (check.rows[0]?.es_sistema) {
      return res.status(403).json({ error: 'No se pueden eliminar plantillas del sistema' });
    }
    await db.query('UPDATE plantillas SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Plantilla desactivada' });
  } catch (e) {
    res.status(500).json({ error: 'Error desactivando plantilla' });
  }
});

module.exports = router;
