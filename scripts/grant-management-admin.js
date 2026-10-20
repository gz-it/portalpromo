// Explicit temporary dual-role grant; does not change passwords or other users.
const db = require('../src/db');
const config = require('../src/config');
const { audit } = require('../src/utils/audit');
async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || config.appUrl !== 'https://portalproductores.estadiohuracan.com') throw new Error('Ejecutar como root en el definitivo');
  const result = await db.tx(async client => {
    const user = (await client.query("select id,status from users where email='gestion@gzit.com.ar' for update")).rows[0];
    if (!user) throw new Error('No existe la cuenta de Sistemas');
    const roles = (await client.query('select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1', [user.id])).rows.map(row => row.name);
    if (!roles.includes('SISTEMAS')) throw new Error('La cuenta no tiene el rol Sistemas esperado');
    const grant = await client.query("insert into user_roles(user_id,role_id) select $1,id from roles where name='ADMINISTRADOR' on conflict do nothing returning role_id", [user.id]);
    const updated = (await client.query('select r.name from user_roles ur join roles r on r.id=ur.role_id where ur.user_id=$1 order by r.name', [user.id])).rows.map(row => row.name);
    if (!updated.includes('ADMINISTRADOR')) throw new Error('No se pudo agregar el rol');
    return { id: user.id, status: user.status, roles: updated, changed: grant.rowCount > 0 };
  });
  if (result.changed) await audit(null, 'agregar_admin_temporal', 'users', result.id, { operator: 'root-cli', email: 'gestion@gzit.com.ar', existingSystemsAccessPreserved: true });
  console.log(JSON.stringify({ email: 'gestion@gzit.com.ar', status: result.status, roles: result.roles, changed: result.changed, passwordUnchanged: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => db.pool.end());
