const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { pgEnvironment } = require('../utils/pg-environment');
const { notifyBackup } = require('./backup-notifications');
const {
  DEFAULT_TIMEZONE,
  isBackupDue,
  normalizeEmails,
  normalizeTime,
  normalizeWeekdays,
} = require('../utils/backup-schedule');

fs.mkdirSync(config.backupPath, { recursive: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env: pgEnvironment(config.databaseUrl) });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 240000);
    child.stdout.resume();
    child.stderr.resume();
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('No se pudo completar la operacion de base de datos.')); });
  });
}

async function getBackupSettings() {
  const rows = await db.query("select key,value from system_settings where key like 'backup_%'");
  const values = Object.fromEntries(rows.rows.map((row) => [row.key, row.value || '']));
  const frequency = ['daily', 'weekly', 'twice_weekly'].includes(values.backup_frequency) ? values.backup_frequency : 'daily';
  const emails = normalizeEmails(values.backup_email);
  return {
    enabled: values.backup_enabled === 'true',
    frequency,
    emails,
    statusEmails: normalizeEmails(values.backup_status_email),
    email: emails.join(', '),
    weekdays: normalizeWeekdays(values.backup_weekdays),
    time: normalizeTime(values.backup_time),
    timezone: values.backup_timezone || DEFAULT_TIMEZONE,
    sendFile: values.backup_send_file === 'true',
    retentionDays: Math.max(1, Number(values.backup_retention_days) || 30),
  };
}

async function saveBackupSettings(values, userId) {
  const frequency = ['daily', 'weekly', 'twice_weekly'].includes(values.frequency) ? values.frequency : 'twice_weekly';
  const emails = normalizeEmails(values.emails || values.email);
  const settings = {
    backup_enabled: values.enabled ? 'true' : 'false',
    backup_frequency: frequency,
    backup_email: emails.join(','),
    backup_weekdays: normalizeWeekdays(values.weekdays).join(','),
    backup_time: normalizeTime(values.time),
    backup_timezone: values.timezone || DEFAULT_TIMEZONE,
    backup_send_file: values.sendFile ? 'true' : 'false',
    backup_retention_days: String(Math.max(1, Number(values.retentionDays) || 30)),
  };
  if (values.statusEmails !== undefined) settings.backup_status_email = normalizeEmails(values.statusEmails).join(',');
  await db.tx(async (client) => {
    for (const [key, value] of Object.entries(settings)) {
      await client.query(`insert into system_settings (key,value,updated_by,updated_at) values ($1,$2,$3,now())
        on conflict (key) do update set value=$2,updated_by=$3,updated_at=now()`, [key, value, userId]);
    }
  });
}

function backupFilename() {
  return `portal-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
}

async function pruneBackups(retentionDays) {
  const cutoff = Date.now() - retentionDays * 86400000;
  const rows = await db.query("select id,storage_path from backup_runs where status='SUCCESS' and created_at < now() - ($1::text || ' days')::interval", [retentionDays]);
  for (const row of rows.rows) {
    if (!row.storage_path) continue;
    const target = path.resolve(row.storage_path);
    const relative = path.relative(config.backupPath, target);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && fs.existsSync(target) && fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
  }
  await db.query("delete from backup_runs where created_at < now() - ($1::text || ' days')::interval and status in ('SUCCESS','FAILED')", [retentionDays]);
}

async function createBackup({ source = 'MANUAL', userId = null, notify = true } = {}) {
  const filename = backupFilename();
  const target = path.join(config.backupPath, filename);
  const record = (await db.query('insert into backup_runs (filename,storage_path,source,status,requested_by) values ($1,$2,$3,$4,$5) returning id', [filename, target, source, 'RUNNING', userId])).rows[0];
  let size;
  try {
    await run(config.pgDumpBin, ['--format=custom', '--file', target]);
    size = fs.statSync(target).size;
    await db.query("update backup_runs set status='SUCCESS',size_bytes=$2,finished_at=now() where id=$1", [record.id, size]);
    const settings = await getBackupSettings();
    await pruneBackups(settings.retentionDays);
  } catch (error) {
    await db.query("update backup_runs set status='FAILED',detail=$2,finished_at=now() where id=$1", [record.id, error.message]);
    const settings = await getBackupSettings().catch(() => ({ emails: [] }));
    if (notify) await notifyBackup(settings, { ok: false, filename }).catch(() => {});
    throw error;
  }
  let deliveries = [];
  if (notify) {
    const settings = await getBackupSettings();
    deliveries = await notifyBackup(settings, { ok: true, filename, target, size });
    if (deliveries.some(delivery => !delivery.sent)) {
      await db.query('update backup_runs set detail=$2 where id=$1', [record.id, 'Respaldo creado; no se pudo enviar uno o más avisos por correo.']);
    }
  }
  return { id: record.id, filename, target, size, deliveries };
}

const backupUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      fs.statfs(config.backupPath, (error, stats) => {
        if (error) return cb(error);
        if (Number(stats.bavail) * Number(stats.bsize) < 1536 * 1024 ** 2) return cb(Object.assign(new Error('Espacio insuficiente.'), { status: 503 }));
        cb(null, config.backupPath);
      });
    },
    filename(req, file, cb) { cb(null, `subido-${randomUUID()}.dump`); },
  }),
  limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 2, parts: 3, fieldSize: 4096 },
  fileFilter(req, file, cb) { cb(null, path.extname(file.originalname).toLowerCase() === '.dump'); },
});

async function registerUploadedBackup(file, userId) {
  try {
    await run(config.pgRestoreBin, ['--list', file.path]);
    return (await db.query(`insert into backup_runs (filename,storage_path,source,status,size_bytes,requested_by,finished_at)
      values ($1,$2,'UPLOAD','UPLOADED',$3,$4,now()) returning *`, [sanitize(file.originalname), file.path, file.size, userId])).rows[0];
  } catch (error) { await fs.promises.unlink(file.path).catch(() => {}); throw error; }
}

async function resolveBackup(id) {
  const row = (await db.query('select * from backup_runs where id=$1', [id])).rows[0];
  if (!row?.storage_path) return null;
  const target = path.resolve(row.storage_path);
  const relative = path.relative(config.backupPath, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(target)) return null;
  return { ...row, target };
}

async function restoreBackup(row, userId) {
  await run(config.pgRestoreBin, ['--list', row.target]);
  let release = await require('./restore-maintenance').acquire();
  let previous;
  let changed = false;
  const args = ['--clean', '--if-exists', '--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges', '--dbname', new URL(config.databaseUrl).pathname.slice(1)];
  try {
    const deadline = Date.now() + 15000;
    while (schedulerRunning && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (schedulerRunning) throw new Error('Hay un respaldo en curso. Intente nuevamente.');
    previous = await createBackup({ source: 'PRE_RESTORE', userId, notify: false });
    await run(config.pgRestoreBin, [...args, row.target]);
    changed = true;
    await db.tx(async client => {
      const systems = await client.query("select 1 from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where u.status='ACTIVO' and r.name='SISTEMAS' limit 1");
      if (!systems.rowCount) throw new Error('El respaldo no contiene una cuenta activa de Sistemas.');
      const files = (await client.query('select storage_key,size_bytes from attachments')).rows;
      const { resolveAttachment } = require('./storage');
      for (const file of files) if (!fs.existsSync(resolveAttachment(file)) || fs.statSync(resolveAttachment(file)).size !== Number(file.size_bytes)) throw new Error('Faltan documentos. Use un ZIP de recuperacion completo.');
      await require('../utils/email').getMailSettings();
      await client.query('delete from session');
      for (const table of ['password_reset_tokens','user_invitation_tokens','email_verification_tokens']) await client.query(`update ${table} set used_at=now() where used_at is null`);
      await client.query("delete from system_settings where key='security_alert_outbox' or left(key,11)='auth_guard_'");
      await client.query("update system_settings set value='false' where key='backup_enabled'");
    });
  } catch (error) {
    if (changed) {
      try { await run(config.pgRestoreBin, [...args, previous.target]); }
      catch {
        release = null;
        throw new Error('Se requiere intervencion tecnica. El portal permanece en mantenimiento con copia previa.');
      }
    }
    throw error;
  } finally { if (release) release(); }
}

let schedulerTimer;
let schedulerRunning = false;

async function schedulerTick() {
  if (require('./restore-maintenance').isRestoring()) return;
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const settings = await getBackupSettings();
    if (!settings.enabled) return;
    const last = (await db.query("select created_at from backup_runs where source='AUTO' and status='SUCCESS' order by created_at desc limit 1")).rows[0];
    if (isBackupDue(settings, last?.created_at)) await createBackup({ source: 'AUTO' });
  } catch (error) {
    console.error('Backup automático:', error.message);
  } finally {
    schedulerRunning = false;
  }
}

function startBackupScheduler() {
  if (schedulerTimer) return;
  setTimeout(schedulerTick, 15000).unref();
  schedulerTimer = setInterval(schedulerTick, 60 * 60 * 1000);
  schedulerTimer.unref();
}

module.exports = {
  backupUpload,
  createBackup,
  getBackupSettings,
  registerUploadedBackup,
  resolveBackup,
  restoreBackup,
  saveBackupSettings,
  startBackupScheduler,
  isBackupSchedulerRunning: () => schedulerRunning,
};
