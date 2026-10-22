const test = require('node:test');
const assert = require('node:assert/strict');
const { include } = require('../scripts/package-clean');

test('clean package includes the application and excludes data and account-specific tooling', () => {
  for (const name of ['src/app.js', 'migrations/001_initial.sql', 'scripts/seed-admin.js', 'scripts/prepare-vps.sh', 'deploy/portalpromo.service', 'INSTALACION-LIMPIA.txt']) assert.equal(include(name), true, name);
  for (const name of ['.env', '.env.production', 'storage/uploads/file.pdf', 'node_modules/pg/index.js', '.git/config', 'scripts/provision-vps.sh', 'scripts/replace-demo-access.js', 'scripts/configure-backup-recipients.js', 'scripts/seed-demo-users.js', 'visual-preview.html', 'MIGRACION-2026-10-20.txt', 'deploy/nginx-definitivo.conf']) assert.equal(include(name), false, name);
});
