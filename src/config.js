const path = require('path');
require('dotenv').config();

const root = path.resolve(__dirname, '..');
const int = (value, fallback) => Number.parseInt(value || `${fallback}`, 10);
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 3000),
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  databaseUrl: process.env.DATABASE_URL,
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-change-me',
  sessionSecure: bool(process.env.SESSION_SECURE, false),
  maxUploadSizeMb: int(process.env.MAX_UPLOAD_SIZE_MB, 200),
  allowedExtensions: (process.env.ALLOWED_FILE_EXTENSIONS || 'pdf,jpg,jpeg,png,webp,xls,xlsx,csv,doc,docx').split(',').map((x) => x.trim().toLowerCase()),
  storageDriver: process.env.STORAGE_DRIVER || 'local',
  storagePath: path.resolve(root, process.env.STORAGE_PATH || './storage/uploads'),
  backupPath: path.resolve(root, process.env.BACKUP_PATH || './storage/backups'),
  smtp: {
    host: process.env.SMTP_HOST,
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false),
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    from: process.env.SMTP_FROM || 'Portal de Productores <no-reply@example.com>',
  },
  git: {
    repository: process.env.GIT_REPOSITORY,
    branch: process.env.GIT_BRANCH || 'production',
    workdir: process.env.UPDATE_WORKDIR || root,
  },
  pgDumpBin: process.env.PG_DUMP_BIN || 'pg_dump',
  npmBin: process.env.NPM_BIN || 'pnpm',
  root,
};

if (!config.databaseUrl && config.env !== 'test') {
  console.warn('DATABASE_URL no configurado. Configure PostgreSQL antes de iniciar en desarrollo/produccion.');
}

module.exports = config;
