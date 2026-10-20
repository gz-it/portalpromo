const { sendMail } = require('../utils/email');
const config = require('../config');

async function notifyBackup(settings, result, mail = sendMail) {
  const recipients = new Map();
  for (const email of settings.emails || []) recipients.set(email, true);
  for (const email of settings.statusEmails || []) recipients.set(email, false);
  const deliveries = [];
  for (const [email, receivesFile] of recipients) {
    const attachments = result.ok && receivesFile && settings.sendFile && result.size <= 20 * 1024 * 1024
      ? [{ filename: result.filename, path: result.target }] : undefined;
    const subject = `${result.ok ? 'Backup correcto' : 'Falló el backup'} - Portal de Productores`;
    let text = result.ok ? `Se creó correctamente el respaldo de la base de datos: ${result.filename}.`
      : 'No se pudo crear el respaldo de la base de datos. Revise el estado en Sistemas.';
    if (result.ok && receivesFile && settings.sendFile && !attachments) text += '\nSupera 20 MB y no se adjuntó. Descárguelo desde Sistemas.';
    if (result.ok && !receivesFile) text += '\nAviso de control, sin adjunto.';
    text += `\nFecha: ${new Date().toLocaleString('es-AR', { timeZone: settings.timezone || 'America/Argentina/Buenos_Aires' })}\n${config.appUrl}/systems`;
    try {
      const sent = await mail(email, subject, text, attachments ? { attachments } : {});
      deliveries.push({ email, sent: Boolean(sent), attached: Boolean(attachments) });
    } catch {
      deliveries.push({ email, sent: false, attached: Boolean(attachments) });
    }
  }
  return deliveries;
}
module.exports = { notifyBackup };
