const crypto = require('crypto');
const nodemailer = require('nodemailer');
const config = require('../config');
const db = require('../db');

let transporter;
let transporterKey;

function encryptionKey() {
  return crypto.createHash('sha256').update(`${config.sessionSecret}:smtp`).digest();
}

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSecret(value) {
  if (!value) return '';
  if (!value.startsWith('v1:')) return value;
  const [, iv, tag, encrypted] = value.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString('utf8');
}

async function getMailSettings() {
  let stored = {};
  try {
    const rows = await db.query("select key,value from system_settings where key like 'smtp_%'");
    stored = Object.fromEntries(rows.rows.map((row) => [row.key, row.value || '']));
  } catch (error) {
    if (error.code !== '42P01') throw error;
  }
  const useStored = Boolean(stored.smtp_host);
  return {
    host: useStored ? stored.smtp_host : config.smtp.host || '',
    port: Number(useStored ? stored.smtp_port || 587 : config.smtp.port || 587),
    secure: useStored ? stored.smtp_secure === 'true' : Boolean(config.smtp.secure),
    user: useStored ? stored.smtp_user : config.smtp.user || '',
    password: useStored && stored.smtp_password_encrypted ? decryptSecret(stored.smtp_password_encrypted) : config.smtp.password || '',
    from: useStored ? stored.smtp_from || config.smtp.from : config.smtp.from,
    hasStoredPassword: Boolean(stored.smtp_password_encrypted),
  };
}

async function saveMailSettings(values, userId) {
  const current = await getMailSettings();
  const settings = {
    smtp_host: values.host || '',
    smtp_port: String(values.port || 587),
    smtp_secure: values.secure ? 'true' : 'false',
    smtp_user: values.user || '',
    smtp_from: values.from || '',
  };
  if (values.password) settings.smtp_password_encrypted = encryptSecret(values.password);
  else if (!current.hasStoredPassword && config.smtp.password) settings.smtp_password_encrypted = encryptSecret(config.smtp.password);
  await db.tx(async (client) => {
    for (const [key, value] of Object.entries(settings)) {
      await client.query(`insert into system_settings (key,value,updated_by,updated_at) values ($1,$2,$3,now())
        on conflict (key) do update set value=$2,updated_by=$3,updated_at=now()`, [key, value, userId]);
    }
  });
  transporter = undefined;
  transporterKey = undefined;
}

async function getTransporter() {
  const settings = await getMailSettings();
  if (!settings.host || !settings.user || !settings.password) return { mailer: null, settings };
  const key = JSON.stringify([settings.host, settings.port, settings.secure, settings.user, settings.password]);
  if (!transporter || transporterKey !== key) {
    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
    });
    transporterKey = key;
  }
  return { mailer: transporter, settings };
}

async function enabled() {
  return Boolean((await getTransporter()).mailer);
}

async function verifyMail() {
  const { mailer } = await getTransporter();
  if (!mailer) throw new Error('Complete servidor, usuario y contraseña SMTP.');
  await mailer.verify();
  return true;
}

async function sendMail(to, subject, text, options = {}) {
  if (!to) return false;
  const { mailer, settings } = await getTransporter();
  if (!mailer) {
    console.info(`[email disabled] ${subject} -> ${to}`);
    return false;
  }
  await mailer.sendMail({ from: settings.from, to, subject, text, ...options });
  return true;
}

module.exports = { sendMail, enabled, verifyMail, getMailSettings, saveMailSettings };
