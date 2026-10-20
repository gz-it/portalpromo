// Prepare non-secret SMTP settings only. Does not send messages or accept passwords.
const { getMailSettings, saveMailSettings } = require('../src/utils/email');
const db = require('../src/db');

async function main() {
  const current = await getMailSettings();
  if (current.password) throw new Error('Ya existe una credencial SMTP; revisar antes de cambiar el remitente.');
  await saveMailSettings({ host: 'smtp.gmail.com', port: 465, secure: true,
    user: 'productores@estadiohuracan.com',
    from: 'Portal de Productores - Estadio Huracán <productores@estadiohuracan.com>' }, null);
  const settings = await getMailSettings();
  console.log(JSON.stringify({ host: settings.host, port: settings.port, secure: settings.secure,
    user: settings.user, credentialConfigured: Boolean(settings.password), sent: false }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
