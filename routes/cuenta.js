// =============================================
// ASS v2.0 — Rutas de Cuenta: recuperación de contraseña
// Flujo: pregunta de seguridad → solicitud → aprobación del admin.
//
// NOTA: el cambio de contraseña NORMAL (con sesión activa, sabiendo la
// actual) ya existe en routes/auth.js (PUT /api/auth/password) — no se
// repite aquí para no duplicar funcionalidad.
//
// Verificado contra el esquema real del proyecto (usuarios: id, documento,
// password_hash, rol, nombre — bcryptjs — authMiddleware/adminMiddleware
// en ../middleware/auth). Requiere haber corrido antes
// sql/00-instalacion-completa.sql (agrega pregunta_seguridad,
// respuesta_seguridad_hash y la tabla solicitudes_cambio_contrasena).
// =============================================

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const { authMiddleware, adminMiddleware } = require('../middleware/auth');

// PUT /api/cuenta/pregunta-seguridad
// Establece o actualiza la pregunta/respuesta de seguridad del usuario con
// sesión activa (se ofrece junto a "Cambiar contraseña" en Ajustes, para
// que cada quien configure la suya antes de necesitarla).
router.put('/pregunta-seguridad', authMiddleware, async (req, res) => {
  const { pregunta, respuesta } = req.body;
  if (!pregunta || !respuesta) {
    return res.status(400).json({ error: 'Falta la pregunta o la respuesta' });
  }
  try {
    const hashRespuesta = await bcrypt.hash(respuesta.trim().toLowerCase(), 10);
    await db.query(
      'UPDATE usuarios SET pregunta_seguridad = $1, respuesta_seguridad_hash = $2 WHERE id = $3',
      [pregunta.trim(), hashRespuesta, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error guardando la pregunta de seguridad' });
  }
});

// GET /api/cuenta/pregunta-seguridad?documento=XXX
// Pública (sin sesión — es justo para cuando no se puede iniciar sesión).
// Devuelve la pregunta de seguridad de ese usuario, para mostrarla en
// "Olvidé mi contraseña".
router.get('/pregunta-seguridad', async (req, res) => {
  const documento = (req.query.documento || '').trim();
  if (!documento) return res.status(400).json({ error: 'Falta el número de documento' });
  try {
    const r = await db.query('SELECT pregunta_seguridad FROM usuarios WHERE documento = $1', [documento]);
    if (!r.rows[0] || !r.rows[0].pregunta_seguridad) {
      return res.status(404).json({ error: 'No hay pregunta de seguridad configurada para este usuario. Contacta al administrador.' });
    }
    res.json({ pregunta: r.rows[0].pregunta_seguridad });
  } catch (e) {
    res.status(500).json({ error: 'Error buscando la pregunta de seguridad' });
  }
});

// POST /api/cuenta/solicitar-cambio
// Pública — se envía la respuesta a la pregunta de seguridad. Si
// coincide, se crea una SOLICITUD pendiente que el admin verá al iniciar
// sesión. Esto NO cambia la contraseña directamente — solo notifica al
// admin, que es quien decide y establece la nueva contraseña.
router.post('/solicitar-cambio', async (req, res) => {
  const { documento, respuesta } = req.body;
  if (!documento || !respuesta) {
    return res.status(400).json({ error: 'Falta el documento o la respuesta' });
  }
  try {
    const r = await db.query('SELECT id, respuesta_seguridad_hash FROM usuarios WHERE documento = $1', [documento]);
    const usuario = r.rows[0];
    if (!usuario || !usuario.respuesta_seguridad_hash) {
      return res.status(404).json({ error: 'No se pudo verificar. Contacta al administrador directamente.' });
    }
    const coincide = await bcrypt.compare(respuesta.trim().toLowerCase(), usuario.respuesta_seguridad_hash);
    if (!coincide) {
      return res.status(401).json({ error: 'La respuesta no coincide con la registrada. Contacta al administrador directamente.' });
    }
    await db.query(
      `INSERT INTO solicitudes_cambio_contrasena (usuario_id, estado) VALUES ($1, 'pendiente')`,
      [usuario.id]
    );
    res.json({ ok: true, mensaje: 'Solicitud enviada. El administrador la verá al iniciar sesión y se pondrá en contacto contigo.' });
  } catch (e) {
    res.status(500).json({ error: 'Error enviando la solicitud' });
  }
});

// GET /api/cuenta/solicitudes-pendientes — solo admin
router.get('/solicitudes-pendientes', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT s.id, s.created_at, u.id AS usuario_id, u.nombre, u.documento
       FROM solicitudes_cambio_contrasena s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.estado = 'pendiente'
       ORDER BY s.created_at ASC`
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Error obteniendo las solicitudes pendientes' });
  }
});

// POST /api/cuenta/resolver-solicitud/:id — solo admin, establece la nueva contraseña
router.post('/resolver-solicitud/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { nueva_contrasena } = req.body;
  if (!nueva_contrasena || nueva_contrasena.length < 6) {
    return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' });
  }
  try {
    const r = await db.query(
      `SELECT usuario_id FROM solicitudes_cambio_contrasena WHERE id = $1 AND estado = 'pendiente'`,
      [req.params.id]
    );
    const solicitud = r.rows[0];
    if (!solicitud) return res.status(404).json({ error: 'Solicitud no encontrada o ya resuelta' });

    const nuevoHash = await bcrypt.hash(nueva_contrasena, 10);
    await db.query('UPDATE usuarios SET password_hash = $1 WHERE id = $2', [nuevoHash, solicitud.usuario_id]);
    await db.query(
      `UPDATE solicitudes_cambio_contrasena SET estado = 'resuelta', resuelta_at = NOW(), resuelta_por = $1 WHERE id = $2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error resolviendo la solicitud' });
  }
});

// POST /api/cuenta/rechazar-solicitud/:id — solo admin, descarta sin cambiar la contraseña
router.post('/rechazar-solicitud/:id', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    await db.query(
      `UPDATE solicitudes_cambio_contrasena SET estado = 'rechazada', resuelta_at = NOW(), resuelta_por = $1 WHERE id = $2 AND estado = 'pendiente'`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error rechazando la solicitud' });
  }
});

module.exports = router;
