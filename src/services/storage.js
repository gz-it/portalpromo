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
    fs.statfs(config.storagePath, (error, stats) => {
      if (error) return cb(error);
      const reserve = (config.maxUploadSizeMb + 512) * 1024 * 1024;
      if (Number(stats.bavail) * Number(stats.bsize) < reserve) return cb(Object.assign(new Error('Espacio insuficiente para una carga segura.'), { status: 503 }));
      fs.mkdir(dir, { recursive: true }, mkdirError => cb(mkdirError, dir));
    });
  },
  filename(req, file, cb) {
    cb(null, `${randomUUID()}-${sanitize(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: config.maxUploadSizeMb * 1024 * 1024, files: 1, fields: 500, parts: 501, fieldSize: 64 * 1024 },
  fileFilter(req, file, cb) {
    if (!extensionAllowed(file)) return cb(new Error('Formato de archivo no permitido'));
    cb(null, true);
  },
});

async function saveAttachment({ file, eventId, moduleKey, userId }) {
  const handle = await fs.promises.open(file.path, 'r');
  const header = Buffer.alloc(4096);
  const { bytesRead } = await handle.read(header, 0, header.length, 0).finally(() => handle.close());
  const ext = path.extname(file.originalname).slice(1).toLowerCase();
  const signatures = {
    pdf: () => header.subarray(0, 5).toString() === '%PDF-',
    png: () => header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    jpg: () => header[0] === 255 && header[1] === 216 && header[2] === 255,
    jpeg: () => header[0] === 255 && header[1] === 216 && header[2] === 255,
    webp: () => header.subarray(0, 4).toString() === 'RIFF' && header.subarray(8, 12).toString() === 'WEBP',
    xlsx: () => header.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')),
    docx: () => header.subarray(0, 4).equals(Buffer.from('504b0304', 'hex')),
    xls: () => header.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')),
    doc: () => header.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')),
    csv: () => !header.subarray(0, bytesRead).includes(0) && !/<(?:script|html|iframe)\b/i.test(header.subarray(0, bytesRead).toString()),
  };
  if (!bytesRead || !signatures[ext]?.()) {
    await fs.promises.unlink(file.path);
    throw Object.assign(new Error('El contenido no coincide con el formato permitido.'), { status: 400 });
  }
  const relative = path.relative(config.storagePath, file.path).replace(/\\/g, '/');
  const result = await db.query(
    `insert into attachments (event_id,module_key,original_name,internal_name,storage_key,mime_type,size_bytes,uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [eventId || null, moduleKey || null, sanitize(file.originalname), file.filename, relative, mime.lookup(file.originalname) || 'application/octet-stream', file.size, userId],
  );
  return result.rows[0];
}

function resolveAttachment(row) {
  const target = path.resolve(config.storagePath, row.storage_key);
  const relative = path.relative(config.storagePath, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Ruta invalida');
  return target;
}

module.exports = { upload, saveAttachment, resolveAttachment };
