// Root-only provisioning. Password arrives on stdin, never in the repository.
const fs = require('node:fs');
const db = require('../src/db');
const { hashPassword, verifyPassword } = require('../src/utils/security');
const { audit } = require('../src/utils/audit');
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Ejecutar como root');
  const password = fs.readFileSync(0, 'utf8').trim();
  const temporary = process.argv.includes('--temporary');
  if (!password || Buffer.byteLength(password) > 72 || (password.length < 12 && !temporary)) throw new Error('Clave insuficiente; use 12 caracteres o autorizacion temporal explicita');
  const hash = await hashPassword(password);
  const user = await db.tx(async client => {
    const existing = (await client.query("select * from users where username='sistemas' or email='sistemas@portalpromo.local' for update")).rows;
    if (existing.length > 1) throw new Error('Hay dos cuentas coincidentes; revisar sin sobrescribir');
    let id = existing[0]?.id;
    if (id) {
      const roles = (await client.query('select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1', [id])).rows;
      if (roles.length !== 1 || roles[0].name !== 'SISTEMAS') throw new Error('La cuenta existente tiene otro rol; no se modifica');
      await client.query("update users set username='sistemas',password_hash=$2,status='ACTIVO',invitation_pending=false,email_verification_required=false,updated_at=now() where id=$1", [id, hash]);
      await client.query("delete from session where sess->>'userId'=$1", [id]);
    } else {
      id = (await client.query("insert into users(first_name,last_name,email,username,password_hash,status,invitation_pending,email_verification_required) values('Sistemas','Portal','sistemas@portalpromo.local','sistemas',$1,'ACTIVO',false,false) returning id", [hash])).rows[0].id;
      const role = await client.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='SISTEMAS' returning role_id", [id]);
      if (!role.rowCount) throw new Error('Falta el rol Sistemas');
    }
    return (await client.query('select id,username,password_hash,status from users where id=$1', [id])).rows[0];
  });
  if (!await verifyPassword(password, user.password_hash)) throw new Error('No se pudo verificar la clave');
  await audit(null, 'provisionar_acceso_sistemas', 'users', user.id, { temporary, operator: 'root-cli' });
  console.log(JSON.stringify({ username: user.username, status: user.status, role: 'SISTEMAS', temporary, verified: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
