const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const multer = require('multer');
const sanitize = require('sanitize-filename');
const config = require('../config');
const db = require('../db');
const { sendMail } = require('../utils/email');

fs.mkdirSync(config.backupPath, { recursive: true });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: process.platform === 'win32' });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(errorText.trim() || `${command} finalizó con código ${code}`)));
  });
}

async function getBackupSettings() {
  const rows = await db.query("select key,value from system_settings where key like 'backup_%'");
  const values = Object.fromEntries(rows.rows.map((row) => [row.key, row.value || '']));
  return {
    enabled: values.backup_enabled === 'true',
    frequency: values.backup_frequency === 'weekly' ? 'weekly' : 'daily',
    email: values.backup_email || '',
    sendFile: values.backup_send_file === 'true',
    retentionDays: Math.max(1, Number(values.backup_retention_days) || 30),
  };
}

async function saveBackupSettings(values, userId) {
  const settings = {
    backup_enabled: values.enabled ? 'true' : 'false',
    backup_frequency: values.frequency === 'weekly' ? 'weekly' : 'daily',
    backup_email: values.email || '',
    backup_send_file: values.sendFile ? 'true' : 'false',
    backup_retention_days: String(Math.max(1, Number(values.retentionDays) || 30)),
  };
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
    if (target.startsWith(config.backupPath) && fs.existsSync(target) && fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
  }
  await db.query("delete from backup_runs where created_at < now() - ($1::text || ' days')::interval and status in ('SUCCESS','FAILED')", [retentionDays]);
}

async function createBackup({ source = 'MANUAL', userId = null, notify = true } = {}) {
  const filename = backupFilename();
  const target = path.join(config.backupPath, filename);
  const record = (await db.query('insert into backup_runs (filename,storage_path,source,status,requested_by) values ($1,$2,$3,$4,$5) returning id', [filename, target, source, 'RUNNING', userId])).rows[0];
  try {
    await run(config.pgDumpBin, ['--format=custom', '--file', target, config.databaseUrl]);
    const size = fs.statSync(target).size;
    await db.query("update backup_runs set status='SUCCESS',size_bytes=$2,finished_at=now() where id=$1", [record.id, size]);
    const settings = await getBackupSettings();
    await pruneBackups(settings.retentionDays);
    if (notify && settings.email) {
      const link = `${config.appUrl}/systems/backups`;
      const attachments = settings.sendFile && size <= 20 * 1024 * 1024 ? [{ filename, path: target }] : undefined;
      const note = settings.sendFile && !attachments ? '\nEl archivo supera 20 MB y no se adjuntó al email.' : '';
      await sendMail(settings.email, 'Backup correcto - Portal de Productores', `Se creó ${filename} correctamente.${note}\n\nAdministrar backups: ${link}`, { attachments });
    }
    return { id: record.id, filename, target, size };
  } catch (error) {
    await db.query("update backup_runs set status='FAILED',detail=$2,finished_at=now() where id=$1", [record.id, error.message]);
    const settings = await getBackupSettings().catch(() => ({ email: '' }));
    if (settings.email) await sendMail(settings.email, 'Falló el backup - Portal de Productores', error.message).catch(() => {});
    throw error;
  }
}

const backupUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { cb(null, config.backupPath); },
    filename(req, file, cb) { cb(null, `subido-${Date.now()}-${sanitize(file.originalname)}`); },
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter(req, file, cb) { cb(null, path.extname(file.originalname).toLowerCase() === '.dump'); },
});

async function registerUploadedBackup(file, userId) {
  return (await db.query(`insert into backup_runs (filename,storage_path,source,status,size_bytes,requested_by,finished_at)
    values ($1,$2,'UPLOAD','UPLOADED',$3,$4,now()) returning *`, [file.originalname, file.path, file.size, userId])).rows[0];
}

async function resolveBackup(id) {
  const row = (await db.query('select * from backup_runs where id=$1', [id])).rows[0];
  if (!row?.storage_path) return null;
  const target = path.resolve(row.storage_path);
  if (!target.startsWith(config.backupPath) || !fs.existsSync(target)) return null;
  return { ...row, target };
}

async function restoreBackup(row, userId) {
  await createBackup({ source: 'PRE_RESTORE', userId, notify: false });
  await run(config.pgRestoreBin, ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', config.databaseUrl, row.target]);
}

let schedulerTimer;
let schedulerRunning = false;

async function schedulerTick() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const settings = await getBackupSettings();
    if (!settings.enabled) return;
    const hours = settings.frequency === 'weekly' ? 168 : 24;
    const last = (await db.query("select created_at from backup_runs where source='AUTO' and status='SUCCESS' order by created_at desc limit 1")).rows[0];
    if (!last || Date.now() - new Date(last.created_at).getTime() >= hours * 3600000) await createBackup({ source: 'AUTO' });
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
};
