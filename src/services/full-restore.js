const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const multer = require('multer');
const dotenv = require('dotenv');
const config = require('../config');
const db = require('../db');
const { pgEnvironment } = require('../utils/pg-environment');
const { encryptSecret } = require('../utils/email');
const { acquire } = require('./restore-maintenance');

const directory = path.join(config.backupPath, 'restauraciones');
fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const fullRestoreUpload = multer({
  storage: multer.diskStorage({ destination(req, file, cb) {
    fs.statfs(directory, (error, stats) => {
      if (error) return cb(error);
      if (Number(stats.bavail) * Number(stats.bsize) < 1536 * 1024 ** 2) return cb(new Error('Espacio insuficiente para subir un respaldo'));
      cb(null, directory);
    });
  }, filename(req, file, cb) { cb(null, `${crypto.randomUUID()}.zip`); } }),
  limits: { fileSize: 1024 ** 3, files: 1, fields: 4, parts: 5, fieldSize: 4096 },
  fileFilter(req, file, cb) { cb(null, file.originalname.toLowerCase().endsWith('.zip')); },
});

function run(program, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { shell: false, env: pgEnvironment(config.databaseUrl), stdio: ['pipe', 'ignore', 'ignore'] });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('No se pudo completar la validacion o restauracion del respaldo')); });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}

function rewrapMailSecret(value, oldSecret) {
  if (!value) return '';
  if (!oldSecret) throw new Error('Falta la clave de configuracion original');
  let plain = value;
  if (value.startsWith('v1:')) {
    const [, iv, tag, encrypted] = value.split(':');
    const key = crypto.createHash('sha256').update(`${oldSecret}:smtp`).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString();
  }
  return encryptSecret(plain);
}

function validateCompatibility(staging) {
  const manifest = JSON.parse(fs.readFileSync(path.join(staging, 'manifest.json'), 'utf8'));
  if (manifest.version !== fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim()) throw new Error('Instale primero la misma version del portal que contiene el respaldo');
  const installed = fs.readdirSync(path.join(config.root, 'migrations')).filter(name => name.endsWith('.sql')).sort();
  const saved = Object.keys(manifest.hashes).filter(name => name.startsWith('code/migrations/') && name.endsWith('.sql')).map(name => path.basename(name)).sort();
  if (JSON.stringify(installed) !== JSON.stringify(saved)) throw new Error('Las versiones de base de datos no coinciden');
  for (const name of installed) {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(config.root, 'migrations', name))).digest('hex');
    if (manifest.hashes[`code/migrations/${name}`] !== digest) throw new Error('Las migraciones no coinciden con la instalacion');
  }
  return manifest;
}

async function restoreFullBackup(file, password, actor = {}) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Ingrese la clave del respaldo de recuperacion');
  const job = fs.mkdtempSync(path.join(directory, 'trabajo-'));
  const staging = path.join(job, 'validado');
  fs.mkdirSync(staging, { mode: 0o700 });
  let release;
  let previous;
  let switched = false;
  let databaseChanged = false;
  try {
    await run(process.env.RESTORE_PYTHON || '/opt/portal-backup-tools/verify-env/bin/python', [path.join(config.root, 'scripts/unpack-recovery-zip.py'), file.path, staging], JSON.stringify({ password }));
    const manifest = validateCompatibility(staging);
    await run(config.pgRestoreBin, ['--list', path.join(staging, 'database.dump')]);
    const oldEnv = dotenv.parse(fs.readFileSync(path.join(staging, 'portal.env')));
    const stats = fs.statfsSync(config.storagePath);
    // Keep room for the existing files, rollback dump and the extracted replacement.
    const uploadsSize = (await db.query('select coalesce(sum(size_bytes),0) size from attachments')).rows[0].size;
    if (Number(stats.bavail) * Number(stats.bsize) < Number(uploadsSize) + 1024 ** 3) throw new Error('Espacio insuficiente para una restauracion con copia previa');
    release = await acquire();
    const deadline = Date.now() + 15000;
    while (require('./backups').isBackupSchedulerRunning() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (require('./backups').isBackupSchedulerRunning()) throw new Error('Hay un backup en curso. Intente nuevamente.');
    previous = path.join(job, 'copia-previa');
    fs.mkdirSync(previous, { mode: 0o700 });
    const rollbackDump = path.join(previous, 'database.dump');
    await run(config.pgDumpBin, ['--format=custom', '--file', rollbackDump]);
    const previousUploads = path.join(previous, 'uploads');
    fs.renameSync(config.storagePath, previousUploads);
    try { fs.renameSync(path.join(staging, 'uploads'), config.storagePath); }
    catch (error) { fs.renameSync(previousUploads, config.storagePath); throw error; }
    switched = true;
    await run(config.pgRestoreBin, ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', new URL(config.databaseUrl).pathname.slice(1), path.join(staging, 'database.dump')]);
    databaseChanged = true;
    await db.tx(async client => {
      const systems = await client.query("select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where u.status='ACTIVO' and r.name='SISTEMAS' limit 1");
      if (!systems.rowCount) throw new Error('El respaldo no contiene una cuenta activa de Sistemas');
      const files = await client.query('select storage_key,size_bytes from attachments');
      for (const file of files.rows) {
        const target = path.resolve(config.storagePath, file.storage_key);
        if (!target.startsWith(config.storagePath + path.sep) || !fs.existsSync(target) || fs.statSync(target).size !== Number(file.size_bytes)) throw new Error('El respaldo no contiene todos los documentos de la base');
      }
      const mail = (await client.query("select value from system_settings where key='smtp_password_encrypted'")).rows[0]?.value;
      if (mail) await client.query("update system_settings set value=$1 where key='smtp_password_encrypted'", [rewrapMailSecret(mail, oldEnv.SESSION_SECRET)]);
      await client.query('delete from session');
      await client.query("update system_settings set value='false' where key='backup_enabled'");
      await client.query("delete from system_settings where key='security_alert_outbox'");
      await client.query("insert into audit_logs(action,entity_type,detail) values('restaurar_sistema','backups',$1)", [{ requested_by_email:actor.email || null, snapshot_at:manifest.createdAt }]);
    });
    fs.writeFileSync(path.join(previous, 'LEER.txt'), 'Copia previa a restauracion: database.dump y uploads. Mantener privada. No se elimina automaticamente.\n', { mode: 0o600 });
    await require('./security-alerts').safelyQueue('RESTORE', { actorId: actor.id });
    return { version: manifest.version, rollback: previous };
  } catch (error) {
    try {
      if (databaseChanged) await run(config.pgRestoreBin, ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', new URL(config.databaseUrl).pathname.slice(1), path.join(previous, 'database.dump')]);
      if (switched) {
        fs.renameSync(config.storagePath, path.join(job, 'uploads-descartados'));
        fs.renameSync(path.join(previous, 'uploads'), config.storagePath);
      }
    } catch (rollbackError) {
      // Stay in maintenance; avoid exposing a partially recovered installation.
      release = null;
      throw new Error('La recuperacion requiere intervencion tecnica. Se mantiene mantenimiento y se conserva la copia previa.');
    }
    throw error;
  } finally {
    if (release) release();
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(file.path, { force: true });
  }
}

module.exports = { fullRestoreUpload, restoreFullBackup, validateCompatibility, rewrapMailSecret };
