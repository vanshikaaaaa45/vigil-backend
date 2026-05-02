require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { pool } = require('../config/db');

async function run() {
  const client = await pool.connect();
  try {
    // Create tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id       SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        ran_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const dir   = __dirname;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM _migrations WHERE filename = $1', [file]
      );
      if (rows.length) {
        console.log(`  skip  ${file}`);
        continue;
      }
      console.log(`  run   ${file}`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
      console.log(`  done  ${file}`);
    }

    console.log('\n✅ All migrations complete\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run();