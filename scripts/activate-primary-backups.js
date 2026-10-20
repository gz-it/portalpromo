const config = require('../src/config');
const db = require('../src/db');
const { createBackup, getBackupSettings } = require('../src/services/backups');
const { setSetting } = require('../src/services/settings');
async function main() {
  if (config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar solo en el portal definitivo');
  const backup = await createBackup({ source: 'CUTOVER', notify: false });
  await setSetting('backup_enabled', 'true', null);
  const settings = await getBackupSettings();
  console.log(JSON.stringify({ backup: backup.filename, size: backup.size, enabled: settings.enabled,
    frequency: settings.frequency, weekdays: settings.weekdays, emailsConfigured: settings.emails.length }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
