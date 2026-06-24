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
    const result = await db.query(`
      SELECT u.id, u.documento, u.nombre, u.email, u.rol, u.activo,
             u.fecha_vencimiento, u.paquete_id, p.nombre AS paquete_nombre,
             u.created_at, u.last_login
      FROM usuarios u
      LEFT JOIN paquetes_suscripcion p ON p.id = u.paquete_id
      ORDER BY u.created_at DESC
    `);
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
// PAQUETES DE SUSCRIPCIÓN
// =============================================

// GET /api/admin/paquetes — Listar todos los paquetes
router.get('/paquetes', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM paquetes_suscripcion ORDER BY duracion_dias ASC');
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo paquetes' });
  }
});

// POST /api/admin/paquetes — Crear nuevo paquete
router.post('/paquetes', async (req, res) => {
  const { nombre, duracion_dias } = req.body;
  if (!nombre || !duracion_dias || duracion_dias < 1) {
    return res.status(400).json({ error: 'Nombre y duración en días (mínimo 1) son requeridos' });
  }
  try {
    const result = await db.query(
      'INSERT INTO paquetes_suscripcion (nombre, duracion_dias) VALUES ($1, $2) RETURNING *',
      [nombre.trim(), parseInt(duracion_dias)]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error creando paquete' });
  }
});

// PUT /api/admin/paquetes/:id — Editar paquete
router.put('/paquetes/:id', async (req, res) => {
  const { nombre, duracion_dias, activo } = req.body;
  try {
    const result = await db.query(
      'UPDATE paquetes_suscripcion SET nombre=$1, duracion_dias=$2, activo=$3 WHERE id=$4 RETURNING *',
      [nombre, parseInt(duracion_dias), activo ?? true, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Paquete no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error actualizando paquete' });
  }
});

// DELETE /api/admin/paquetes/:id — Eliminar paquete (no afecta usuarios que ya lo tienen asignado)
router.delete('/paquetes/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM paquetes_suscripcion WHERE id = $1', [req.params.id]);
    res.json({ message: 'Paquete eliminado' });
  } catch (e) {
    res.status(500).json({ error: 'Error eliminando paquete' });
  }
});

// POST /api/admin/usuarios/:id/asignar-paquete — Asigna un paquete y activa al usuario
// con fecha de vencimiento = hoy + duracion_dias del paquete
router.post('/usuarios/:id/asignar-paquete', async (req, res) => {
  const { paquete_id } = req.body;
  if (!paquete_id) return res.status(400).json({ error: 'Falta paquete_id' });
  try {
    const paquete = await db.query('SELECT * FROM paquetes_suscripcion WHERE id = $1', [paquete_id]);
    if (!paquete.rows.length) return res.status(404).json({ error: 'Paquete no encontrado' });
    const dias = paquete.rows[0].duracion_dias;
    const result = await db.query(`
      UPDATE usuarios
      SET paquete_id = $1,
          fecha_vencimiento = (CURRENT_DATE + ($2 || ' days')::INTERVAL)::DATE,
          activo = true
      WHERE id = $3
      RETURNING id, documento, nombre, email, rol, activo, fecha_vencimiento, paquete_id
    `, [paquete_id, dias, req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error asignando paquete' });
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
