// =============================================
// ASS v2.0 — Ruta de Instalación (Setup Wizard)
// Solo funciona si no hay usuarios en la BD
// Después del primer uso queda deshabilitada
// =============================================
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { db } = require('../db');

// Verificar si ya está instalado
async function yaInstalado() {
  try {
    const r = await db.query('SELECT COUNT(*) FROM usuarios');
    return parseInt(r.rows[0].count) > 0;
  } catch (e) {
    return false; // Tabla no existe aún
  }
}

// =============================================
// GET /api/setup/status
// Devuelve el estado actual de la instalación
// =============================================
router.get('/status', async (req, res) => {
  try {
    // Verificar si las tablas existen
    const tablas = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('usuarios','codigos','plantillas','notas_turno','favoritos')
    `);
    const tablasExistentes = tablas.rows.map(r => r.table_name);
    const tablasRequeridas = ['usuarios','codigos','plantillas','notas_turno','favoritos'];
    const todasCreadas = tablasRequeridas.every(t => tablasExistentes.includes(t));

    if (!todasCreadas) {
      return res.json({ estado: 'sin_instalar', tablas: tablasExistentes });
    }

    const instalado = await yaInstalado();
    res.json({
      estado: instalado ? 'instalado' : 'tablas_ok_sin_admin',
      tablas: tablasExistentes,
      version: '2.0.0'
    });
  } catch (e) {
    res.json({ estado: 'error_bd', error: e.message });
  }
});

// =============================================
// POST /api/setup/instalar
// Crea las tablas y el usuario administrador
// Solo funciona si no hay usuarios aún
// =============================================
router.post('/instalar', async (req, res) => {
  // Protección: si ya hay usuarios, bloquear
  if (await yaInstalado()) {
    return res.status(403).json({
      error: 'El sistema ya está instalado. Esta ruta está deshabilitada.'
    });
  }

  const { documento, nombre, email, password, institucion } = req.body;

  if (!documento || !nombre || !password) {
    return res.status(400).json({ error: 'documento, nombre y password son requeridos' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener mínimo 6 caracteres' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // PASO 1: Crear extensión UUID
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

    // PASO 2: Crear tablas
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        documento VARCHAR(20) UNIQUE NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        rol VARCHAR(20) NOT NULL DEFAULT 'medico',
        activo BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_login TIMESTAMPTZ,
        CONSTRAINT rol_valido CHECK (rol IN ('admin', 'medico'))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS codigos (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tipo VARCHAR(30) NOT NULL,
        categoria VARCHAR(100) NOT NULL,
        nombre VARCHAR(255) NOT NULL,
        codigo VARCHAR(50) NOT NULL,
        grupo_cups VARCHAR(100),
        activo BOOLEAN DEFAULT true,
        creado_por UUID REFERENCES usuarios(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT tipo_valido CHECK (tipo IN ('lab','rx','noquir','cups'))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS plantillas (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        tipo VARCHAR(30) NOT NULL,
        nombre VARCHAR(100) NOT NULL,
        descripcion VARCHAR(255),
        contenido TEXT NOT NULL,
        secciones JSONB,
        activo BOOLEAN DEFAULT true,
        es_sistema BOOLEAN DEFAULT false,
        creado_por UUID REFERENCES usuarios(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT tipo_plantilla_valido CHECK (tipo IN ('evolucion','historia','examen','plan','triage','remision','recomendacion'))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notas_turno (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo VARCHAR(50) NOT NULL,
        contenido TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expira_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '24 hours')
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS favoritos (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        nombre VARCHAR(100) NOT NULL,
        tipo VARCHAR(50),
        contenido TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracion (
        clave VARCHAR(50) PRIMARY KEY,
        valor TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        usuario_id UUID REFERENCES usuarios(id),
        accion VARCHAR(100) NOT NULL,
        detalle JSONB,
        ip VARCHAR(45),
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // PASO 3: Crear índices
    await client.query('CREATE INDEX IF NOT EXISTS idx_codigos_tipo ON codigos(tipo)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_plantillas_tipo ON plantillas(tipo)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_notas_usuario ON notas_turno(usuario_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_notas_expira ON notas_turno(expira_at)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_favoritos_usuario ON favoritos(usuario_id)');

    // PASO 4: Función de limpieza automática
    await client.query(`
      CREATE OR REPLACE FUNCTION borrar_notas_vencidas()
      RETURNS void AS $$
      BEGIN DELETE FROM notas_turno WHERE expira_at < NOW(); END;
      $$ LANGUAGE plpgsql
    `);

    // PASO 5: Guardar configuración
    await client.query(`
      INSERT INTO configuracion (clave, valor) VALUES
        ('institucion', $1),
        ('version', '2.0.0'),
        ('instalado_en', NOW()::text)
      ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor
    `, [institucion || 'ASS — AMET Suite Assist']);

    // PASO 6: Crear usuario administrador
    const hash = await bcrypt.hash(password, 10);
    const adminResult = await client.query(`
      INSERT INTO usuarios (documento, nombre, email, password_hash, rol)
      VALUES ($1, $2, $3, $4, 'admin')
      RETURNING id, documento, nombre, rol
    `, [documento.trim(), nombre, email || null, hash]);

    await client.query('COMMIT');

    res.json({
      ok: true,
      mensaje: '✅ ASS v2.0 instalado correctamente',
      admin: adminResult.rows[0],
      version: '2.0.0'
    });

  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error en instalación:', e);
    res.status(500).json({ error: 'Error durante la instalación: ' + e.message });
  } finally {
    client.release();
  }
});

// =============================================
// GET /api/setup/config — Obtener configuración
// =============================================
router.get('/config', async (req, res) => {
  try {
    const r = await db.query('SELECT clave, valor FROM configuracion');
    const config = {};
    r.rows.forEach(row => { config[row.clave] = row.valor; });
    res.json(config);
  } catch (e) {
    res.json({});
  }
});

module.exports = router;
