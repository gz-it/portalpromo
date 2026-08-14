const archiver = require('archiver');
const db = require('../db');
const { MODULES } = require('../constants');
const { modulePdf } = require('./pdf');
const { resolveAttachment } = require('./storage');

function slug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
}

async function streamEventZip(res, event, settings) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(res);
  const root = `${slug(event.name)}-${slug(event.artist)}/`;
  for (const module of MODULES) {
    const folder = `${root}${String(module.order).padStart(2, '0')}-${slug(module.name)}/`;
    const pdf = await modulePdf(event, module.key, settings);
    archive.append(pdf, { name: `${folder}${slug(module.name)}.pdf` });
    const files = await db.query('select * from attachments where event_id=$1 and module_key=$2 and deleted_at is null', [event.id, module.key]);
    for (const file of files.rows) archive.file(resolveAttachment(file), { name: `${folder}Archivos-originales/${file.original_name}` });
  }
  await archive.finalize();
}

module.exports = { streamEventZip };
