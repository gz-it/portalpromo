// Revoke only the explicitly named demo producer; preserve referenced event data.
const config = require('../src/config');
const db = require('../src/db');
const { hashPassword, makeToken } = require('../src/utils/security');
const { createBackup } = require('../src/services/backups');
const { audit } = require('../src/utils/audit');
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar como root en el definitivo');
  const user = (await db.query("select id,status from users where username='productor'")).rows[0];
  if (!user) { console.log(JSON.stringify({ demoProducerAbsent: true })); return; }
  const roles = (await db.query('select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1', [user.id])).rows;
  if (roles.length !== 1 || roles[0].name !== 'PRODUCTOR') throw new Error('El usuario tiene otro rol; no se modifica');
  if (user.status !== 'DESHABILITADO') await createBackup({ source: 'PRE_RETIRE_DEMO', notify: false });
  const hash = await hashPassword(makeToken());
  await db.tx(async client => {
    await client.query("update users set status='DESHABILITADO',password_hash=$2,invitation_pending=false,updated_at=now() where id=$1", [user.id, hash]);
    await client.query("delete from session where sess->>'userId'=$1", [user.id]);
    await client.query('update user_invitation_tokens set used_at=now() where user_id=$1 and used_at is null', [user.id]);
    await client.query('update password_reset_tokens set used_at=now() where user_id=$1 and used_at is null', [user.id]);
  });
  await audit(null, 'retirar_productor_demo', 'users', user.id, { operator: 'root-cli', historyPreserved: true });
  const counts = (await db.query('select (select count(*) from events where owner_user_id=$1)::int events,(select count(*) from attachments where uploaded_by=$1)::int attachments', [user.id])).rows[0];
  console.log(JSON.stringify({ username: 'productor', status: 'DESHABILITADO', sessionsRevoked: true, preserved: counts }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
