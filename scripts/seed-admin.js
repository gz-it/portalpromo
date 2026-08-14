require('dotenv').config();
const { pool } = require('../src/db');
const { hashPassword } = require('../src/utils/security');

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const username = process.env.INITIAL_ADMIN_USERNAME;
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!email || !username || !password) throw new Error('Configure INITIAL_ADMIN_EMAIL, INITIAL_ADMIN_USERNAME e INITIAL_ADMIN_PASSWORD.');
  if (password.length < 12) throw new Error('INITIAL_ADMIN_PASSWORD debe tener al menos 12 caracteres.');
  const passwordHash = await hashPassword(password);
  await pool.query('begin');
  try {
    const user = await pool.query(
      `insert into users (first_name,last_name,email,username,password_hash,status)
       values ($1,$2,$3,$4,$5,'ACTIVO')
       on conflict (email) do update set username=excluded.username, password_hash=excluded.password_hash, status='ACTIVO', updated_at=now()
       returning id`,
      [process.env.INITIAL_ADMIN_FIRST_NAME || 'Admin', process.env.INITIAL_ADMIN_LAST_NAME || 'Portal', email, username, passwordHash],
    );
    await pool.query(`insert into user_roles (user_id, role_id) select $1, id from roles where name='ADMINISTRADOR' on conflict do nothing`, [user.rows[0].id]);
    await pool.query('commit');
    console.log(`Administrador inicial listo: ${email}`);
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
}

main().then(() => pool.end()).catch((error) => {
  console.error(error.message);
  pool.end().finally(() => process.exit(1));
});
