// Controlled handover of the existing privileged identities; preserves history IDs.
const db = require('../src/db');
const config = require('../src/config');
const { hashPassword, makeToken } = require('../src/utils/security');
const { sendInvitation } = require('../src/services/invitations');
const { verifyMail } = require('../src/utils/email');
const { createBackup } = require('../src/services/backups');
const { audit } = require('../src/utils/audit');
const accounts = [
  { old: 'admin', email: 'booking@estadiohuracan.com', first: 'Booking', last: 'Estadio Huracán', role: 'ADMINISTRADOR' },
  { old: 'sistemas', email: 'gestion@gzit.com.ar', first: 'Sistemas', last: 'GzIT', role: 'SISTEMAS' },
];
async function inspect(client, account, lock = false) {
  const rows = (await client.query(`select id,username,email,status,invitation_pending from users where username=$1 or email=$2${lock ? ' for update' : ''}`, [account.old, account.email])).rows;
  if (rows.length !== 1) throw new Error('Cuenta ausente o duplicada: requiere revision sin sobrescribir');
  const roles = (await client.query('select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1', [rows[0].id])).rows;
  if (roles.length !== 1 || roles[0].name !== account.role) throw new Error('Los roles no coinciden con el traspaso autorizado');
  return rows[0];
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar como root solo en el definitivo');
  for (const account of accounts) await inspect(db, account);
  if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ ready: true, accounts: accounts.map(({ email, role }) => ({ email, role })) }));
    return;
  }
  await verifyMail();
  await createBackup({ source: 'PRE_ACCESS_HANDOVER', notify: false });
  const changed = await db.tx(async client => {
    const updated = [];
    for (const account of accounts) {
      const user = await inspect(client, account, true);
      if (user.email === account.email && user.username === account.email) continue;
      await client.query(`update users set first_name=$2,last_name=$3,email=$4,username=$4,password_hash=$5,
        status='PENDIENTE',invitation_pending=true,email_verification_required=true,email_verified_at=null,updated_at=now() where id=$1`,
      [user.id, account.first, account.last, account.email, await hashPassword(makeToken())]);
      await client.query("delete from session where sess->>'userId'=$1", [user.id]);
      await client.query('update password_reset_tokens set used_at=now() where user_id=$1 and used_at is null', [user.id]);
      await client.query('update user_invitation_tokens set used_at=now() where user_id=$1 and used_at is null', [user.id]);
      updated.push({ id: user.id, email: account.email, role: account.role });
    }
    return updated;
  });
  for (const user of changed) {
    await audit(null, 'reemplazar_acceso_demo', 'users', user.id, { email: user.email, role: user.role, operator: 'root-cli' });
    try {
      await sendInvitation(user);
      console.log(JSON.stringify({ email: user.email, role: user.role, invitationSent: true, status: 'PENDIENTE', demoAccessRemoved: true }));
    } catch {
      console.log(JSON.stringify({ email: user.email, invitationSent: false, status: 'PENDIENTE', requiresResend: true }));
      process.exitCode = 1;
    }
  }
  const remaining = (await db.query("select count(*)::int n from users where username in ('admin','sistemas')")).rows[0].n;
  if (remaining) throw new Error('Queda un acceso de prueba sin retirar');
  console.log(JSON.stringify({ oldUsernamesRemaining: remaining, passwords: 'randomized-awaiting-user-setup', historyPreserved: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
