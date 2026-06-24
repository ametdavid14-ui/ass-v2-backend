// =============================================
// ASS v2.0 — Servidor Principal
// Optimizado para Render.com (100% gratis)
// =============================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes     = require('./routes/auth');
const codigosRoutes  = require('./routes/codigos');
const plantillasRoutes = require('./routes/plantillas');
const notasRoutes    = require('./routes/notas');
const favoritosRoutes = require('./routes/favoritos');
const adminRoutes    = require('./routes/admin');
const configRoutes   = require('./routes/config');
const configPersonalRoutes = require('./routes/config-personal');
const setupRoutes    = require('./routes/setup');  // ← Wizard instalación
const { db }         = require('./db');

const app  = express();
const PORT = process.env.PORT || 3001;

// =============================================
// MIDDLEWARES
// =============================================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true
}));
app.use(express.json({ limit: '2mb' }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Demasiadas solicitudes, intente más tarde' }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login' }
});

// =============================================
// KEEP-ALIVE para Render.com gratuito
// Render duerme el servicio tras 15 min sin tráfico.
// Este ping cada 14 min lo mantiene despierto.
// =============================================
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
setInterval(() => {
  fetch(`${SELF_URL}/api/health`)
    .then(() => console.log('[KEEP-ALIVE] ping OK'))
    .catch(e => console.log('[KEEP-ALIVE] ping error:', e.message));
}, 14 * 60 * 1000); // cada 14 minutos

// =============================================
// RUTAS
// =============================================
app.use('/api/auth',       loginLimiter, authRoutes);
app.use('/api/setup',      setupRoutes);   // ← Sin auth, solo funciona sin usuarios
app.use('/api/codigos',    codigosRoutes);
app.use('/api/plantillas', plantillasRoutes);
app.use('/api/notas',      notasRoutes);
app.use('/api/favoritos',  favoritosRoutes);
app.use('/api/admin',      adminRoutes);
app.use('/api/config',     configRoutes);
app.use('/api/config-personal', configPersonalRoutes);

// Health check — usado por keep-alive y Render
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '2.0.0', app: 'ASS — AMET Suite Assist' });
});

// =============================================
// LIMPIEZA AUTOMÁTICA NOTAS CADA HORA
// =============================================
setInterval(async () => {
  try {
    await db.query('SELECT borrar_notas_vencidas()');
    console.log('[CRON] Notas vencidas eliminadas');
  } catch (e) {
    console.error('[CRON] Error limpiando notas:', e.message);
  }
}, 60 * 60 * 1000);

// =============================================
// INICIO
// =============================================
app.listen(PORT, () => {
  console.log(`✅ ASS v2.0 Backend corriendo en puerto ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Keep-alive: ${SELF_URL}/api/health`);
});

module.exports = app;
