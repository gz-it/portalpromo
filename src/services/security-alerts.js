const crypto = require('node:crypto');
const net = require('node:net');
const db = require('../db');
const config = require('../config');
const { sendMail } = require('../utils/email');

const KEY = 'security_alert_outbox';
const INTERVAL = 15 * 60 * 1000;
const KINDS = {
  LOGIN_FAILED: ['Varios intentos de ingreso fallidos', 10],
  LOGIN_LIMIT: ['Se bloqueo temporalmente una rafaga de intentos de ingreso', 1],
  ADMIN_NEW_IP: ['Ingreso administrativo desde una IP nueva o no registrada', 1],
  ROLE_CHANGED: ['Se modificaron permisos o accesos de usuarios', 1],
  PRIVILEGE_DENIED: ['Se bloqueo un intento de gestionar permisos de Sistemas sin autorizacion', 1],
  ACCOUNT_CHANGED: ['Se modifico una cuenta administrativa', 1],
  PASSWORD_RESET: ['Se cambio una contrasena mediante recuperacion', 1],
  MAIL_CHANGED: ['Se modifico el correo de notificaciones', 1],
  BACKUP_CHANGED: ['Se modifico la configuracion de respaldos', 1],
  RESTORE: ['Se ejecuto una restauracion', 1],
  UPLOAD_INFECTED: ['Se rechazo un archivo por deteccion del antivirus', 1],
  SCAN_UNAVAILABLE: ['No se pudo verificar un archivo: carga bloqueada', 1],
  HEALTH_FAILED: ['Un control del servidor necesita atencion', 1],
  HEALTH_RECOVERED: ['Se recupero un control del servidor', 1],
  SSH_FAILED: ['Varios intentos SSH fallidos', 10],
  SSH_BLOCKED: ['Fail2ban bloqueo un origen de conexion', 1],
  SSH_NEW_IP: ['Ingreso SSH desde una IP nueva o no registrada', 1],
  SECURITY_TEST: ['Prueba del correo de seguridad', 1],
};

function normalizeDetails(details = {}) {
  const result = {};
  for (const key of ['actorId', 'targetId']) {
    if (/^[a-f\d]{8}(-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(details[key] || '')) result[key] = details[key];
  }
  if (net.isIP(details.ip || '')) result.ip = details.ip;
  // Only server-defined fields are accepted; never mail request bodies, tokens or passwords.
  for (const key of ['component', 'state']) if (details[key]) result[key] = String(details[key]).replace(/[\r\n\t]/g, ' ').slice(0, 80);
  return result;
}

function enqueue(state, kind, details, now = Date.now(), count = 1) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('Tipo de alerta invalido');
  state.pending ||= {};
  let item = state.pending[kind];
  if (!item || (item.count < KINDS[kind][1] && now - item.firstAt >= INTERVAL)) {
    item = { id: crypto.randomUUID(), count: 0, firstAt: now };
  }
  item.count = Math.min(1000000, item.count + Math.max(1, Math.min(10000, Number(count) || 1)));
  item.lastAt = now;
  item.details = normalizeDetails(details);
  if (item.details.ip) item.origins = [...new Set([...(item.origins || []), item.details.ip])].slice(-10);
  if (item.details.component) {
    item.controls = [...(item.controls || []).filter(control => control.component !== item.details.component),
      { component: item.details.component, state: item.details.state }].slice(-32);
  }
  state.pending[kind] = item;
  return state;
}

async function mutate(key, change) {
  return db.tx(async client => {
    await client.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do nothing', [key, '{}']);
    const row = (await client.query('select value from system_settings where key=$1 for update', [key])).rows[0];
    const state = JSON.parse(row.value);
    const result = change(state);
    await client.query('update system_settings set value=$2,updated_at=now() where key=$1', [key, JSON.stringify(state)]);
    return result;
  });
}

function enabled() { return Boolean(config.securityAlertsEmail); }

async function queueAlert(kind, details = {}, count = 1) {
  if (!enabled()) return;
  await mutate(KEY, state => { enqueue(state, kind, details, Date.now(), count); });
}

async function safelyQueue(kind, details = {}, count = 1) {
  try { await queueAlert(kind, details, count); }
  catch { console.error('No se pudo registrar un aviso de seguridad.'); }
}

async function recordAdminLogin(user, ip) {
  if (!enabled() || !user.roles?.some(role => ['ADMINISTRADOR', 'SISTEMAS'].includes(role)) || !net.isIP(ip || '')) return;
  try {
    await mutate(KEY, state => {
      state.knownIps ||= {};
      const addresses = state.knownIps[user.id] || [];
      const known = addresses.includes(ip);
      state.knownIps[user.id] = [...addresses.filter(item => item !== ip), ip].slice(-10);
      if (!known) enqueue(state, 'ADMIN_NEW_IP', { actorId: user.id, ip });
    });
  } catch { console.error('No se pudo registrar el origen de acceso administrativo.'); }
}

const AUDIT_KINDS = {
  cambiar_rol_usuario: 'ROLE_CHANGED', cambiar_estado_usuario: 'ROLE_CHANGED', eliminar_usuario: 'ROLE_CHANGED',
  crear_usuario: 'ROLE_CHANGED', actualizar_cuenta_admin: 'ACCOUNT_CHANGED',
  configurar_correo: 'MAIL_CHANGED', configurar_backups: 'BACKUP_CHANGED', configurar_avisos_backup: 'BACKUP_CHANGED',
  restaurar_backup: 'RESTORE', restaurar_sistema: 'RESTORE',
};

async function alertAudit(userId, action, entityType, entityId) {
  const kind = AUDIT_KINDS[action];
  if (kind) await safelyQueue(kind, { actorId: userId, ...(entityType === 'users' ? { targetId: entityId } : {}) });
}

function claim(state, now, force = false) {
  if (state.leaseUntil > now || (!force && (state.nextAttemptAt > now || (state.lastSentAt && now - state.lastSentAt < INTERVAL)))) return null;
  const items = Object.entries(state.pending || {}).filter(([kind, item]) => KINDS[kind] && item.count >= KINDS[kind][1]);
  if (!items.length) return null;
  const token = crypto.randomUUID();
  state.leaseUntil = now + 5 * 60 * 1000;
  state.leaseToken = token;
  return { token, items: structuredClone(items) };
}

function acknowledge(state, batch, ok, now) {
  if (state.leaseToken !== batch.token) return;
  delete state.leaseToken;
  delete state.leaseUntil;
  state.lastDeliveryOk = ok;
  if (!ok) { state.nextAttemptAt = now + 5 * 60 * 1000; return; }
  state.lastSentAt = now;
  delete state.nextAttemptAt;
  for (const [kind, sent] of batch.items) {
    const item = state.pending[kind];
    if (!item || item.id !== sent.id) continue;
    item.count -= sent.count;
    if (item.count <= 0) delete state.pending[kind];
    else { item.firstAt = item.lastAt; item.id = crypto.randomUUID(); }
  }
}

async function flushSecurityAlerts({ force = false, mail = sendMail, allowMaintenance = false } = {}) {
  if (!enabled() || (!allowMaintenance && require('./restore-maintenance').isRestoring())) return { sent: false, deferred: true };
  const batch = await mutate(KEY, state => claim(state, Date.now(), force));
  if (!batch) return { sent: false, deferred: true };
  let sent = false;
  try {
    const ids = [...new Set(batch.items.flatMap(([, item]) => [item.details.actorId, item.details.targetId]).filter(Boolean))];
    const users = ids.length ? (await db.query('select id,first_name,last_name,email from users where id=any($1::uuid[])', [ids])).rows : [];
    const name = id => { const user = users.find(item => item.id === id); return user ? `${user.first_name} ${user.last_name} <${user.email}>` : id; };
    const date = timestamp => new Date(timestamp).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
    const lines = batch.items.map(([kind, item]) => {
      const d = item.details;
      return [KINDS[kind][0], `Cantidad: ${item.count}. Ultimo registro: ${date(item.lastAt)}.`,
        d.actorId && `Responsable: ${name(d.actorId)}`, d.targetId && `Cuenta afectada: ${name(d.targetId)}`,
        item.origins?.length && `IP registradas (hasta 10): ${item.origins.join(', ')}`,
        ...(item.controls || []).map(control => `Control: ${control.component}. Estado: ${control.state}`)].filter(Boolean).join('\n');
    });
    const text = `Avisos de seguridad del Portal de Productores\n\n${lines.join('\n\n')}\n\nLos eventos repetidos se agrupan; los datos corresponden al ultimo de cada tipo. Un intento bloqueado no significa que alguien haya ingresado.\nAnte un acceso que no reconozcas, revisar la cuenta y el servidor. No reenviar claves ni codigos de acceso por correo.\n${config.appUrl}/systems`;
    const messageId = crypto.createHash('sha256').update(batch.items.map(([, item]) => `${item.id}:${item.count}`).join(',')).digest('hex');
    sent = Boolean(await mail(config.securityAlertsEmail, 'Aviso de seguridad - Portal de Productores', text,
      { messageId: `<security-${messageId}@portalproductores.estadiohuracan.com>` }));
  } catch { sent = false; }
  await mutate(KEY, state => acknowledge(state, batch, sent, Date.now()));
  return { sent, events: batch.items.length };
}

let timer;
function startSecurityAlerts() {
  if (timer || !enabled()) return;
  const tick = () => flushSecurityAlerts().catch(() => console.error('No se pudo procesar el correo de seguridad.'));
  setTimeout(tick, 15000).unref();
  timer = setInterval(tick, 60000);
  timer.unref();
}

module.exports = { enqueue, claim, acknowledge, normalizeDetails, KINDS, queueAlert, safelyQueue, recordAdminLogin, alertAudit, flushSecurityAlerts, startSecurityAlerts };
