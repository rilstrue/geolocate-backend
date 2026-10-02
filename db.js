const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';

const pool = new Pool({
  connectionString: url,
  // Внутренний адрес Railway работает без SSL, публичный — с SSL
  ssl: url.includes('railway.internal') ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS analyses (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image_name TEXT,
      result     JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS analyses_user_id_idx ON analyses(user_id);
  `);
  console.log('DB ready: users, analyses');
}

module.exports = { pool, initDb };
