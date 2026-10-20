const db = require('../db');
const { hashPassword, makeToken } = require('../utils/security');
async function removeUser(actorId, userId) {
  if (actorId === userId) throw Object.assign(new Error('No puede eliminar su propia cuenta.'), { status: 400 });
  const passwordHash = await hashPassword(makeToken());
  return db.tx(async client => {
    await client.query("select pg_advisory_xact_lock(hashtext('portal-user-removal'))");
    const user = (await client.query('select id,status from users where id=$1 for update', [userId])).rows[0];
    if (!user) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });
    const admins = (await client.query("select distinct u.id from users u join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id where r.name='ADMINISTRADOR' and u.status='ACTIVO'")).rows;
    if (admins.some(admin => admin.id === userId) && admins.length <= 1) throw Object.assign(new Error('No puede eliminar al último administrador activo.'), { status: 400 });
    await client.query("update users set status='DESHABILITADO',password_hash=$2,invitation_pending=false,updated_at=now() where id=$1", [userId, passwordHash]);
    await client.query("delete from session where sess->>'userId'=$1", [userId]);
    await client.query('update password_reset_tokens set used_at=now() where user_id=$1 and used_at is null', [userId]);
    await client.query('update user_invitation_tokens set used_at=now() where user_id=$1 and used_at is null', [userId]);
    await client.query("insert into audit_logs(user_id,action,entity_type,entity_id,detail) values($1,'eliminar_usuario','users',$2,$3)", [actorId, userId, { reversible: true, historyPreserved: true }]);
    return user;
  });
}
module.exports = { removeUser };
