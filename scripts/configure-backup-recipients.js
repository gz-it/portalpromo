const { getBackupSettings, saveBackupSettings, createBackup } = require('../src/services/backups');
const config = require('../src/config');
const db = require('../src/db');
async function main() {
  if (config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar en el definitivo');
  const current = await getBackupSettings();
  await saveBackupSettings({ ...current, enabled: true, frequency: 'twice_weekly',
    emails: ['booking@estadiohuracan.com', 'gabriel.cason@akemusic.com'],
    statusEmails: ['gestion@gzit.com.ar'], sendFile: true }, null);
  const settings = await getBackupSettings();
  console.log(JSON.stringify({ frequency: settings.frequency, weekdays: settings.weekdays, time: settings.time, timezone: settings.timezone, emails: settings.emails, statusEmails: settings.statusEmails }));
  if (process.argv.includes('--test')) {
    const backup = await createBackup({ source: 'EMAIL_SETUP', notify: true });
    console.log(JSON.stringify({ backup: backup.filename, size: backup.size, deliveries: backup.deliveries }));
    if (backup.deliveries.some(item => !item.sent)) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
