// Read-only: compare migrated business data without printing personal fields.
const { createHash } = require('node:crypto');
const { Pool } = require('/opt/portalpromo/node_modules/pg');
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await client.query('begin isolation level repeatable read read only');
      await client.query("set local time zone 'UTC'");
      const tables = (await client.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
      const output = {};
      for (const { tablename } of tables) {
        if (/audit|session|backup_runs|system_settings|system_updates/.test(tablename)) continue;
        if (!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Nombre de tabla inesperado');
        const rows = (await client.query(`select to_jsonb(t)::text row from public."${tablename}" t order by to_jsonb(t)::text`)).rows;
        const hash = createHash('sha256');
        for (const row of rows) hash.update(row.row + '\n');
        output[tablename] = { count: rows.length, sha256: hash.digest('hex') };
      }
      await client.query('commit');
      console.log(JSON.stringify(output));
    } finally { client.release(); }
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
