const db = require('../src/db');
const config = require('../src/config');
const { sendInvitation } = require('../src/services/invitations');
const { sendMail } = require('../src/utils/email');
const { makeToken, hashToken } = require('../src/utils/security');
const { audit } = require('../src/utils/audit');
async function main() {
  const email = require('zod').z.string().email().parse(process.argv[2]).toLowerCase();
  if (process.platform !== 'linux' || process.getuid() !== 0 || config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar como root en el definitivo');
  const user = (await db.query('select id,email,status,invitation_pending from users where email=$1', [email])).rows[0];
  if (!user) throw new Error('La cuenta no existe');
  let type;
  if (user.status === 'PENDIENTE' && user.invitation_pending) {
    await sendInvitation(user);
    type = 'invitation';
  } else if (user.status === 'ACTIVO' && !user.invitation_pending) {
    const token = makeToken();
    const row = (await db.query("insert into password_reset_tokens(user_id,token_hash,expires_at) values($1,$2,now()+interval '1 hour') returning id", [user.id, hashToken(token)])).rows[0];
    try {
      const sent = await sendMail(user.email, 'Crear una nueva contraseña - Portal de Productores', `Tu cuenta ya está activa. Podés elegir una nueva contraseña desde este enlace: ${config.appUrl}/reset/${token}\n\nEl enlace vence en una hora. La contraseña actual no cambia hasta completar el proceso.`);
      if (!sent) throw new Error('Correo no habilitado');
    } catch (error) {
      await db.query('update password_reset_tokens set used_at=now() where id=$1', [row.id]);
      throw error;
    }
    type = 'password-reset';
  } else throw new Error('La cuenta no está habilitada para este envío');
  await audit(null, 'reenviar_enlace_acceso', 'users', user.id, { type, operator: 'root-cli' });
  console.log(JSON.stringify({ email: user.email, type, sent: true, expiresHours: type === 'invitation' ? 48 : 1 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
