const nodemailer = require('nodemailer');
const config = require('../config');

let transporter;

function enabled() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
}

function getTransporter() {
  if (!enabled()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    });
  }
  return transporter;
}

async function sendMail(to, subject, text) {
  const mailer = getTransporter();
  if (!mailer) {
    console.info(`[email disabled] ${subject} -> ${to}`);
    return false;
  }
  await mailer.sendMail({ from: config.smtp.from, to, subject, text });
  return true;
}

module.exports = { sendMail, enabled };
