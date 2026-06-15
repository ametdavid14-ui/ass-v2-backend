// =============================================
// ASS v2.0 — Conexión a PostgreSQL
// =============================================
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Error inesperado en pool de BD:', err.message);
});

const db = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
};

// Verificar conexión al iniciar
pool.query('SELECT NOW()')
  .then(() => console.log('✅ Conectado a PostgreSQL'))
  .catch(err => console.error('❌ Error conectando a BD:', err.message));

module.exports = { db, pool };
