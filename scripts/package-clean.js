const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const archiver = require('archiver');

const root = path.resolve(__dirname, '..');
const scripts = new Set(['migrate.js', 'seed-admin.js', 'backup.js', 'update.js', 'prepare-vps.sh', 'recovery-backup.js', 'capture-recovery.sh', 'complete-backup.js', 'verify-complete-zip.py', 'unpack-recovery-zip.py', 'package-clean.js', 'review-sandbox.js', 'security-monitor.js']);
const documents = new Set(['README.md', 'RECOVERY.md', 'SECURITY.txt', 'SEGURIDAD-2026-10-22.txt', 'VERSION', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.gitignore', 'INSTALACION-LIMPIA.txt', 'RESPALDO-COMPLETO.txt', 'DRIVE-BACKUPS.txt']);

function include(name) {
  return /^(src|migrations|test)\//.test(name)
    || (name.startsWith('scripts/') && scripts.has(name.slice(8)))
    || name === 'deploy/portalpromo.service'
    || name === 'deploy/portalpromo-security.conf'
    || name === 'deploy/52portal-security-upgrades'
    || name === 'deploy/nginx-portal-limits.conf'
    || name === 'deploy/portalpromo-security-monitor.service'
    || name === 'deploy/portalpromo-security-monitor.timer'
    || name === 'ALERTAS-SEGURIDAD.txt'
    || name === 'SEGURIDAD-2026-10-23.txt'
    || name === 'nginx/portal.conf.example'
    || documents.has(name);
}

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, '-C', root, ...args], { encoding, maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('No se pudo leer la version confirmada en Git');
  return result.stdout;
}

async function main() {
  const output = path.resolve(process.argv[2] || '');
  if (!process.argv[2] || !output.endsWith('.zip') || fs.existsSync(output)) throw new Error('Indicar un ZIP nuevo fuera del proyecto');
  if (output.startsWith(root + path.sep)) throw new Error('Guardar la copia fuera del proyecto');
  const revision = git(['rev-parse', 'HEAD']).trim();
  const files = git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').filter(include);
  const contents = new Map(files.map(name => [name, git(['show', `HEAD:${name}`], null)]));
  const pkg = JSON.parse(contents.get('package.json').toString());
  for (const name of ['seed:demo', 'seed:demo-events', 'smoke:live']) delete pkg.scripts[name];
  contents.set('package.json', Buffer.from(JSON.stringify(pkg, null, 2) + '\n'));
  contents.set('.env.example', Buffer.from(`NODE_ENV=development\nPORT=3000\nAPP_URL=http://localhost:3000\nDATABASE_URL=postgres://USUARIO:CLAVE@127.0.0.1:5432/portal_nuevo\nSESSION_SECRET=REEMPLAZAR_CON_UN_SECRETO_ALEATORIO_LARGO\nSESSION_SECURE=false\nSTORAGE_PATH=./storage/uploads\nBACKUP_PATH=./storage/backups\nMAX_UPLOAD_SIZE_MB=200\nSMTP_HOST=\nSMTP_PORT=465\nSMTP_SECURE=true\nSMTP_USER=\nSMTP_PASSWORD=\nSMTP_FROM=\nINITIAL_ADMIN_EMAIL=\nINITIAL_ADMIN_USERNAME=\nINITIAL_ADMIN_PASSWORD=\nINITIAL_ADMIN_FIRST_NAME=\nINITIAL_ADMIN_LAST_NAME=\nGIT_REPOSITORY=\nGIT_BRANCH=main\nPG_DUMP_BIN=pg_dump\nNPM_BIN=pnpm\n`));
  contents.set('.env.example', Buffer.concat([contents.get('.env.example'), Buffer.from('UPLOAD_ANTIVIRUS=false\nSECURITY_ALERT_EMAIL=\n')]));
  const manifest = { type: 'codigo-limpio-sin-datos', createdAt: new Date().toISOString(), revision, version: contents.get('VERSION').toString().trim(), hashes: {} };
  for (const [name, buffer] of contents) manifest.hashes[name] = crypto.createHash('sha256').update(buffer).digest('hex');
  contents.set('MANIFIESTO.json', Buffer.from(JSON.stringify(manifest, null, 2)));
  const stream = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
  const archive = archiver('zip', { zlib: { level: 9 } });
  await new Promise((resolve, reject) => {
    stream.on('close', resolve);
    stream.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', reject);
    archive.pipe(stream);
    for (const [name, buffer] of contents) archive.append(buffer, { name: `Portal-limpio/${name}` });
    archive.finalize().catch(reject);
  });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
  fs.writeFileSync(output + '.sha256', `${sha256}  ${path.basename(output)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output, revision, entries: contents.size, bytes: fs.statSync(output).size, sha256 }));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { include };
