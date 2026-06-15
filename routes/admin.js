// =============================================
// ASS v2.0 — Rutas de Administrador
// Solo accesible con rol 'admin'
// =============================================
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// Todos los endpoints requieren autenticación Y rol admin
router.use(authMiddleware, adminMiddleware);

// =============================================
// GESTIÓN DE USUARIOS
// =============================================

// GET /api/admin/usuarios — Listar todos los usuarios
router.get('/usuarios', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, documento, nombre, email, rol, activo, created_at, last_login FROM usuarios ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo usuarios' });
  }
});

// POST /api/admin/usuarios — Crear nuevo usuario
router.post('/usuarios', async (req, res) => {
  const { documento, nombre, email, password, rol } = req.body;
  if (!documento || !nombre || !password) {
    return res.status(400).json({ error: 'documento, nombre y password son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO usuarios (documento, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, documento, nombre, email, rol, activo, created_at`,
      [documento.trim(), nombre, email || null, hash, rol || 'medico']
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'El documento ya está registrado' });
    res.status(500).json({ error: 'Error creando usuario' });
  }
});

// PUT /api/admin/usuarios/:id — Editar usuario
router.put('/usuarios/:id', async (req, res) => {
  const { nombre, email, rol, activo, password } = req.body;
  try {
    let query, params;
    if (password && password.length >= 6) {
      const hash = await bcrypt.hash(password, 10);
      query = 'UPDATE usuarios SET nombre=$1, email=$2, rol=$3, activo=$4, password_hash=$5 WHERE id=$6 RETURNING id, documento, nombre, email, rol, activo';
      params = [nombre, email, rol, activo, hash, req.params.id];
    } else {
      query = 'UPDATE usuarios SET nombre=$1, email=$2, rol=$3, activo=$4 WHERE id=$5 RETURNING id, documento, nombre, email, rol, activo';
      params = [nombre, email, rol, activo, req.params.id];
    }
    const result = await db.query(query, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando usuario' });
  }
});

// DELETE /api/admin/usuarios/:id — Desactivar usuario (no eliminar)
router.delete('/usuarios/:id', async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'No puede desactivar su propia cuenta' });
  }
  try {
    await db.query('UPDATE usuarios SET activo = false WHERE id = $1', [req.params.id]);
    res.json({ message: 'Usuario desactivado' });
  } catch (e) {
    res.status(500).json({ error: 'Error desactivando usuario' });
  }
});

// =============================================
// ESTADÍSTICAS DEL SISTEMA
// =============================================
router.get('/estadisticas', async (req, res) => {
  try {
    const [usuarios, codigos, plantillas, notas, favoritos] = await Promise.all([
      db.query('SELECT COUNT(*) FROM usuarios WHERE activo = true'),
      db.query('SELECT COUNT(*), tipo FROM codigos WHERE activo = true GROUP BY tipo'),
      db.query('SELECT COUNT(*), tipo FROM plantillas WHERE activo = true GROUP BY tipo'),
      db.query('SELECT COUNT(*) FROM notas_turno WHERE expira_at > NOW()'),
      db.query('SELECT COUNT(*) FROM favoritos'),
    ]);
    res.json({
      usuarios_activos: parseInt(usuarios.rows[0].count),
      codigos: codigos.rows,
      plantillas: plantillas.rows,
      notas_activas: parseInt(notas.rows[0].count),
      favoritos_total: parseInt(favoritos.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo estadísticas' });
  }
});

// =============================================
// LOG DE ACTIVIDAD
// =============================================
router.get('/log', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT al.*, u.nombre, u.documento
       FROM activity_log al
       LEFT JOIN usuarios u ON al.usuario_id = u.id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo log' });
  }
});

module.exports = router;
