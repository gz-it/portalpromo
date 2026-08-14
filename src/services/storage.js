const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const multer = require('multer');
const mime = require('mime-types');
const sanitize = require('sanitize-filename');
const config = require('../config');
const db = require('../db');

fs.mkdirSync(config.storagePath, { recursive: true });

function extensionAllowed(file) {
  const ext = path.extname(file.originalname).replace('.', '').toLowerCase();
  const byMime = mime.extension(file.mimetype);
  return config.allowedExtensions.includes(ext) && (!byMime || config.allowedExtensions.includes(String(byMime).toLowerCase()) || file.mimetype === 'application/octet-stream');
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const eventPart = req.params.eventId || 'system';
    const dir = path.join(config.storagePath, eventPart);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    cb(null, `${randomUUID()}-${sanitize(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSizeMb * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!extensionAllowed(file)) return cb(new Error('Formato de archivo no permitido'));
    cb(null, true);
  },
});

async function saveAttachment({ file, eventId, moduleKey, userId }) {
  const relative = path.relative(config.storagePath, file.path).replace(/\\/g, '/');
  const result = await db.query(
    `insert into attachments (event_id,module_key,original_name,internal_name,storage_key,mime_type,size_bytes,uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [eventId || null, moduleKey || null, file.originalname, file.filename, relative, file.mimetype, file.size, userId],
  );
  return result.rows[0];
}

function resolveAttachment(row) {
  const target = path.resolve(config.storagePath, row.storage_key);
  if (!target.startsWith(config.storagePath)) throw new Error('Ruta invalida');
  return target;
}

module.exports = { upload, saveAttachment, resolveAttachment };
