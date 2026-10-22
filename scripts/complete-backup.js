// Root-only recovery drill: all restores target a uniquely named temporary database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');
const archiver = require('archiver');
const sanitize = require('sanitize-filename');
const recovery = require('./recovery-backup');

function csvCell(value) {
  let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(rows, columns) {
  return '\ufeff' + [columns.map(csvCell).join(';'), ...rows.map(row => columns.map(key => csvCell(row[key])).join(';'))].join('\r\n');
}

function backupPaths(output) {
  if (!output?.endsWith('.zip')) throw new Error('Indicar un destino .zip');
  return { consultation: path.resolve(output), recovery: path.resolve(output.slice(0, -4) + '-recuperacion.zip') };
}

async function writeZip(directory, output, password) {
  if (!password || password.length < 24) throw new Error('La clave ZIP debe tener al menos 24 caracteres');
  if (!archiver.isRegisteredFormat('zip-encrypted')) archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
  const archive = archiver.create('zip-encrypted', { zlib: { level: 8 }, encryptionMethod: 'aes256', password });
  const stream = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      stream.on('close', resolve);
      stream.on('error', reject);
      archive.on('error', reject);
      archive.on('warning', reject);
      archive.pipe(stream);
      archive.directory(directory, false);
      archive.finalize().catch(reject);
    });
  } catch (error) {
    archive.abort();
    stream.destroy();
    // Only remove the file opened by this call, never an existing backup.
    if (stream.fd !== null || stream.bytesWritten > 0) fs.rmSync(output, { force: true });
    throw error;
  }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Ejecutar como root en Linux');
  const [output, keyFile, zipKeyFile] = process.argv.slice(2);
  const destinations = backupPaths(output);
  if (!keyFile || !zipKeyFile || Object.values(destinations).some(file => fs.existsSync(file))) throw new Error('Uso: complete-backup.js nuevo.zip clave-ppr clave-zip; ambos destinos deben ser nuevos');
  const config = require('../src/config');
  const database = `portal_drill_${crypto.randomBytes(12).toString('hex')}`;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-complete-'));
  let created = false;
  let pool;
  function command(program, args, options = {}) {
    const result = spawnSync(program, args, { encoding: 'utf8', timeout: 180000, ...options });
    if (result.error || result.status !== 0) throw new Error(`${program}: fallo en la prueba de recuperacion`);
    return result.stdout;
  }
  process.umask(0o077);
  try {
    if (!fs.existsSync(zipKeyFile)) fs.writeFileSync(zipKeyFile, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    const content = path.join(temp, 'contenido');
    const staging = path.join(temp, 'snapshot');
    const restored = path.join(temp, 'restauracion');
    for (const dir of [content, staging, restored]) fs.mkdirSync(dir, { mode: 0o700 });
    const ppr = path.join(temp, 'recuperacion-completa.ppr');
    await recovery.create({ directory: staging, output: ppr, envFile: '/etc/portalpromo.env', keyFile });
    const target = new URL(config.databaseUrl);
    const owner = decodeURIComponent(target.username);
    command('sudo', ['-u', 'postgres', 'createdb', '--owner', owner, database]);
    created = true;
    target.pathname = `/${database}`;
    const uploads = path.join(temp, 'uploads-recuperados');
    const code = path.join(temp, 'codigo-recuperado');
    const env = path.join(temp, 'configuracion-recuperada.env');
    const snapshot = await recovery.restore({ directory: restored, input: ppr, keyFile, databaseUrl: target.toString(), uploads, restoredEnv: env, code, confirmation: 'RESTAURAR' });
    pool = new Pool({ connectionString: target.toString() });
    const counts = {};
    const data = path.join(content, 'Datos');
    fs.mkdirSync(data);
    // Export business information only; credentials and sessions stay inside the encrypted recovery bundle.
    const tables = (await pool.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows;
    const excluded = new Set(['session', 'sessions', 'system_settings', 'password_reset_tokens', 'user_invitation_tokens', 'email_verification_tokens', 'audit_logs', 'backup_runs']);
    for (const { tablename } of tables) {
      if (excluded.has(tablename) || /token|session|migration/.test(tablename)) continue;
      if (!/^[a-z_]+$/.test(tablename)) throw new Error('Nombre de tabla inesperado');
      const result = await pool.query(`select * from "${tablename}"`);
      const columns = result.fields.map(field => field.name).filter(name => !/password|secret|token/i.test(name));
      counts[tablename] = result.rows.length;
      fs.writeFileSync(path.join(data, `${tablename}.csv`), csv(result.rows, columns));
    }
    const files = (await pool.query('select a.*,e.name event_name from attachments a left join events e on e.id=a.event_id')).rows;
    let verified = 0;
    for (const file of files) {
      const source = path.resolve(uploads, file.storage_key);
      if (!source.startsWith(uploads + path.sep) || !fs.existsSync(source)) throw new Error('Falta un adjunto recuperado');
      const digest = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
      if (digest(source) !== digest(path.join(staging, 'uploads', file.storage_key))) throw new Error('El adjunto recuperado difiere del respaldo');
      const folder = path.join(content, 'Documentos', `${sanitize(file.event_name || 'Sin evento').slice(0, 70)}_${file.event_id || 'general'}`, sanitize(file.module_key || 'general'));
      fs.mkdirSync(folder, { recursive: true });
      fs.copyFileSync(source, path.join(folder, `${file.id}_${sanitize(file.original_name) || 'archivo'}`));
      verified++;
    }
    // Start recovered code against the restored database, without server.js schedulers.
    fs.symlinkSync(path.join(config.root, 'node_modules'), path.join(code, 'node_modules'), 'dir');
    const check = `const app=require('./src/app');const db=require('./src/db');const s=app.listen(0,'127.0.0.1',async()=>{try{const r=await fetch('http://127.0.0.1:'+s.address().port+'/login');if(r.status!==200)throw Error('login');console.log('RESTORED_APP_OK');}catch(e){process.exitCode=1;}finally{s.close();await db.pool.end();}});`;
    const result = command(process.execPath, ['-e', check], { cwd: code, env: { ...process.env, DATABASE_URL: target.toString(), STORAGE_PATH: uploads, BACKUP_PATH: path.join(temp, 'backups'), SESSION_SECURE: 'false', APP_URL: 'http://127.0.0.1' } });
    if (!result.includes('RESTORED_APP_OK')) throw new Error('No inicio el portal recuperado');
    const recoveryZip = path.join(temp, 'recuperacion.zip');
    await writeZip(staging, recoveryZip, fs.readFileSync(zipKeyFile, 'utf8').trim());
    const report = { format: 'consulta-v1', snapshotAt: snapshot.createdAt, recoveryFilename: path.basename(destinations.recovery), recoverySha256: crypto.createHash('sha256').update(fs.readFileSync(recoveryZip)).digest('hex'), createdAt: new Date().toISOString(), restoredDatabaseVerified: true, restoredAppVerified: true, attachmentsVerified: verified, counts };
    fs.writeFileSync(path.join(content, 'Verificacion.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(content, 'LEER-PRIMERO.txt'), 'COPIA DE CONSULTA DEL PORTAL\n\nDatos: archivos CSV para consultar con Excel o LibreOffice.\nDocumentos: archivos originales ordenados por evento y modulo.\n\nEste ZIP NO instala ni restaura el portal. No contiene codigo, credenciales, sesiones ni base tecnica.\nPara recuperar el sistema utilice el ZIP terminado en -recuperacion.zip desde Sistemas > Restaurar sistema, en una instalacion compatible.\nAmbas copias corresponden a la misma captura de la base de datos.\n\nAbra este ZIP AES-256 con 7-Zip o una herramienta compatible; no requiere instalar el portal.\nLa clave se guarda por separado de los archivos.\nVerificacion.json identifica el respaldo de recuperacion asociado y las comprobaciones realizadas.\n');
    const zip = path.join(temp, 'consulta.zip');
    await writeZip(content, zip, fs.readFileSync(zipKeyFile, 'utf8').trim());
    let publishedRecovery = false;
    try {
      fs.copyFileSync(recoveryZip, destinations.recovery, fs.constants.COPYFILE_EXCL);
      publishedRecovery = true;
      fs.copyFileSync(zip, destinations.consultation, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (publishedRecovery) fs.unlinkSync(destinations.recovery);
      throw error;
    }
    console.log(JSON.stringify({ ok: true, output: destinations.consultation, recoveryOutput: destinations.recovery, bytes: fs.statSync(destinations.consultation).size, recoveryBytes: fs.statSync(destinations.recovery).size, ...report }));
  } finally {
    if (pool) await pool.end();
    if (created) command('sudo', ['-u', 'postgres', 'dropdb', '--force', database]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { csvCell, csv, writeZip, backupPaths };
