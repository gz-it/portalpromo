require('dotenv').config();
const { pool } = require('../src/db');
const { hashPassword } = require('../src/utils/security');

const demoUsers = [
  {
    firstName: 'Admin',
    lastName: 'Demo',
    email: process.env.DEMO_ADMIN_EMAIL || 'admin@portalpromo.local',
    username: process.env.DEMO_ADMIN_USERNAME || 'admin',
    password: process.env.DEMO_ADMIN_PASSWORD,
    role: 'ADMINISTRADOR',
  },
  {
    firstName: 'Productor',
    lastName: 'Demo',
    email: process.env.DEMO_PRODUCER_EMAIL || 'productor@portalpromo.local',
    username: process.env.DEMO_PRODUCER_USERNAME || 'productor',
    password: process.env.DEMO_PRODUCER_PASSWORD,
    role: 'PRODUCTOR',
  },
];

async function main() {
  if (demoUsers.some((user) => !user.password)) {
    throw new Error('Configure DEMO_ADMIN_PASSWORD y DEMO_PRODUCER_PASSWORD.');
  }

  await pool.query('begin');
  try {
    for (const user of demoUsers) {
      const result = await pool.query(
        `insert into users (first_name,last_name,email,username,password_hash,status)
         values ($1,$2,$3,$4,$5,'ACTIVO')
         on conflict (email) do update set first_name=excluded.first_name,last_name=excluded.last_name,
           username=excluded.username,password_hash=excluded.password_hash,status='ACTIVO',updated_at=now()
         returning id`,
        [user.firstName, user.lastName, user.email, user.username, await hashPassword(user.password)],
      );
      await pool.query(
        `insert into user_roles (user_id,role_id)
         select $1,id from roles where name=$2 on conflict do nothing`,
        [result.rows[0].id, user.role],
      );
    }
    await pool.query('commit');
    console.log('Usuarios demo listos: admin y productor.');
  } catch (error) {
    await pool.query('rollback');
    throw error;
  }
}

main().then(() => pool.end()).catch((error) => {
  console.error(error.message);
  pool.end().finally(() => process.exit(1));
});
