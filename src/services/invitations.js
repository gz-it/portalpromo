const db = require('../db');
const config = require('../config');
const { makeToken, hashToken, hashPassword } = require('../utils/security');
const { sendMail } = require('../utils/email');

async function sendInvitation(user) {
  const token = makeToken();
  await db.query(`insert into user_invitation_tokens (user_id,token_hash,expires_at)
    values ($1,$2,now()+interval '48 hours')`, [user.id, hashToken(token)]);
  const sent = await sendMail(user.email, 'Invitación al Portal de Productores',
    `El administrador creó tu acceso al portal.\n\nCreá tu contraseña desde este enlace: ${config.appUrl}/invitation/${token}\n\nTu usuario es ${user.email}. El enlace vence en 48 horas y se puede usar una sola vez.`);
  if (!sent) throw new Error('Configurá el correo SMTP para enviar la invitación.');
}

async function acceptInvitation(token, password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) throw new Error('La contraseña debe tener al menos 12 caracteres y no superar 72 bytes.');
  const passwordHash = await hashPassword(password);
  return db.tx(async (client) => {
    const invite = (await client.query(`select t.id,t.user_id from user_invitation_tokens t
      join users u on u.id=t.user_id where t.token_hash=$1 and t.used_at is null
      and t.expires_at>now() and u.invitation_pending and u.status='PENDIENTE'
      for update of u,t`, [hashToken(token)])).rows[0];
    if (!invite) return null;
    const user = (await client.query(`update users set password_hash=$2,status='ACTIVO',
      invitation_pending=false,email_verified_at=now(),updated_at=now() where id=$1 returning id,email`,
    [invite.user_id, passwordHash])).rows[0];
    await client.query('update user_invitation_tokens set used_at=now() where user_id=$1 and used_at is null', [invite.user_id]);
    return user;
  });
}

module.exports = { sendInvitation, acceptInvitation };
