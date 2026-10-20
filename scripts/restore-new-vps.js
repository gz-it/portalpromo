// Run once, as root, on the freshly prepared destination. Never targets the source VPS.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = '/opt/portalpromo';
const { Pool } = require(path.join(root, 'node_modules/pg'));
const dotenv = require(path.join(root, 'node_modules/dotenv'));
const recovery = require(path.join(root, 'scripts/recovery-backup'));

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Ejecutar como root en destino');
  const [input, keyFile] = process.argv.slice(2);
  if (!input || !keyFile || fs.existsSync('/etc/portalpromo.env')) throw new Error('Destino ya configurado o faltan backup y clave');
  const password = crypto.randomBytes(32).toString('hex');
  const databaseUrl = `postgres://portalpromo:${password}@127.0.0.1:5432/portalpromo`;
  const result = spawnSync('sudo', ['-u', 'postgres', 'psql', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1'], {
    input: `CREATE ROLE portalpromo LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';\nCREATE DATABASE portalpromo OWNER portalpromo;\n`, encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('No se pudo crear una base nueva; no se sobrescriben bases existentes');
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-migration-'));
  fs.chmodSync(stage, 0o700);
  const restoredEnv = '/root/portal-migration/source.env';
  try {
    const manifest = await recovery.restore({ directory: stage, input, keyFile, databaseUrl,
      uploads: '/var/lib/portalpromo/uploads', restoredEnv,
      code: '/root/portal-migration/source-code', confirmation: 'RESTAURAR' });
    // Preserve the actually deployed source, including changes not reflected in its Git HEAD.
    const source = '/root/portal-migration/source-code';
    for (const name of fs.readdirSync(source)) fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
    const settings = dotenv.parse(fs.readFileSync(restoredEnv));
    Object.assign(settings, { NODE_ENV: 'production', PORT: '3000',
      APP_URL: 'https://portalproductores.estadiohuracan.com', DATABASE_URL: databaseUrl,
      SESSION_SECURE: 'true', STORAGE_PATH: '/var/lib/portalpromo/uploads',
      BACKUP_PATH: '/var/lib/portalpromo/backups', UPDATE_WORKDIR: root });
    fs.writeFileSync('/etc/portalpromo.env', Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query('delete from session');
      await pool.query("insert into system_settings(key,value) values('backup_enabled','false') on conflict(key) do update set value='false'");
      const counts = (await pool.query(`select (select count(*) from users)::int users,
        (select count(*) from events)::int events,
        (select count(*) from attachments)::int attachments,
        (select count(*) from event_modules)::int modules`)).rows[0];
      console.log(JSON.stringify({ restored: true, version: manifest.version, counts, scheduler: 'paused-until-cutover' }));
    } finally { await pool.end(); }
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
