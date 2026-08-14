const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { pool } = require('../src/db');

async function main() {
  await pool.query(`create table if not exists schema_migrations (
    id serial primary key,
    filename text unique not null,
    executed_at timestamptz not null default now()
  )`);
  const dir = path.resolve(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await pool.query('select 1 from schema_migrations where filename=$1', [file]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await pool.query('begin');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (filename) values ($1)', [file]);
      await pool.query('commit');
      console.log(`Migrated ${file}`);
    } catch (error) {
      await pool.query('rollback');
      throw error;
    }
  }
}

main().then(() => pool.end()).catch((error) => {
  console.error(error);
  pool.end().finally(() => process.exit(1));
});
