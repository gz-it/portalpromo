const db = require('../db');
const config = require('../config');
const { makeToken, hashToken } = require('../utils/security');
const { sendMail } = require('../utils/email');

async function sendVerification(user) {
  const token = makeToken();
  await db.query(`insert into email_verification_tokens (user_id,token_hash,expires_at)
    values ($1,$2,now()+interval '24 hours')`, [user.id, hashToken(token)]);
  const sent = await sendMail(user.email, 'Confirmar email - Portal de Productores',
    `Confirmá tu dirección de email con este enlace: ${config.appUrl}/verify-email/${token}\n\nEl enlace vence en 24 horas. Luego el administrador deberá aprobar tu acceso.`);
  if (!sent) throw new Error('El correo todavía no está configurado.');
}

async function confirmEmail(token) {
  return db.tx(async (client) => {
    const row = (await client.query(`select * from email_verification_tokens where token_hash=$1
      and used_at is null and expires_at>now() for update`, [hashToken(token)])).rows[0];
    if (!row) return null;
    const user = (await client.query(`update users set email_verified_at=now(),updated_at=now()
      where id=$1 and email_verified_at is null returning *`, [row.user_id])).rows[0];
    await client.query('update email_verification_tokens set used_at=now() where user_id=$1 and used_at is null', [row.user_id]);
    return user;
  });
}

async function notifyRegistrationAdmins(user) {
  const title = 'Nuevo productor pendiente de aprobación';
  const message = `${user.first_name} ${user.last_name} confirmó su email: ${user.email}.`;
  const admins = (await db.query(`select distinct u.id,u.email from users u
    join user_roles ur on ur.user_id=u.id join roles r on r.id=ur.role_id
    where r.name='ADMINISTRADOR' and u.status='ACTIVO'`)).rows;
  for (const admin of admins) {
    await db.query(`insert into notifications (user_id,type,title,message,link)
      values ($1,'REGISTRO',$2,$3,'/admin/users')`, [admin.id, title, message]);
    await sendMail(admin.email, title, `${message}\n\nRevisar: ${config.appUrl}/admin/users`).catch((error) => console.error('Correo de registro:', error.message));
  }
}

module.exports = { sendVerification, confirmEmail, notifyRegistrationAdmins };
