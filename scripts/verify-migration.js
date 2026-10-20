// Read-only integrity check of the destination against its authenticated snapshot.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Pool } = require('/opt/portalpromo/node_modules/pg');
const recovery = require('/opt/portalpromo/scripts/recovery-backup');
async function main() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-verify-'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let checked = 0;
  try {
    const manifest = await recovery.unpack({ directory: stage, input: process.argv[2], keyFile: process.argv[3] });
    for (const [relative, expected] of Object.entries(manifest.hashes)) {
      if (!relative.startsWith('uploads/') && !relative.startsWith('code/src/')) continue;
      const target = relative.startsWith('uploads/') ? path.join('/var/lib/portalpromo', relative) : path.join('/opt/portalpromo', relative.slice(5));
      const hash = crypto.createHash('sha256');
      for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
      if (hash.digest('hex') !== expected) throw new Error('Un archivo no coincide con el respaldo');
      checked++;
    }
    const attachments = (await pool.query('select storage_key,size_bytes from attachments')).rows;
    for (const file of attachments) {
      if (fs.statSync(path.join('/var/lib/portalpromo/uploads', file.storage_key)).size !== Number(file.size_bytes)) throw new Error('Adjunto incompleto');
    }
    console.log(JSON.stringify({ verified: true, checkedFiles: checked, attachments: attachments.length }));
  } finally { await pool.end(); fs.rmSync(stage, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
