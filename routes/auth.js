// =============================================
// ASS v2.0 — Rutas de Autenticación
// =============================================
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { documento, password } = req.body;
  if (!documento || !password) {
    return res.status(400).json({ error: 'Documento y contraseña requeridos' });
  }
  try {
    const result = await db.query(
      'SELECT * FROM usuarios WHERE documento = $1 AND activo = true',
      [documento.trim()]
    );
    if (!result.rows.length) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    const usuario = result.rows[0];
    const valid = await bcrypt.compare(password, usuario.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    // Actualizar last_login
    await db.query('UPDATE usuarios SET last_login = NOW() WHERE id = $1', [usuario.id]);
    // Generar token
    const token = jwt.sign(
      { id: usuario.id, documento: usuario.documento, nombre: usuario.nombre, rol: usuario.rol },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );
    res.json({
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, documento: usuario.documento, rol: usuario.rol }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// GET /api/auth/me — Verificar token y obtener datos del usuario
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, documento, nombre, email, rol, last_login FROM usuarios WHERE id = $1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// PUT /api/auth/password — Cambiar contraseña propia
router.put('/password', authMiddleware, async (req, res) => {
  const { password_actual, password_nuevo } = req.body;
  if (!password_actual || !password_nuevo || password_nuevo.length < 6) {
    return res.status(400).json({ error: 'Contraseña nueva debe tener mínimo 6 caracteres' });
  }
  try {
    const result = await db.query('SELECT password_hash FROM usuarios WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(password_actual, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    const hash = await bcrypt.hash(password_nuevo, 10);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (e) {
    res.status(500).json({ error: 'Error del servidor' });
  }
});

module.exports = router;
