const db = require('../db');

async function loadSettings(app) {
  const result = await db.query('select key, value from system_settings');
  app.locals.settings = Object.fromEntries(result.rows.map((r) => [r.key, r.value]));
  return app.locals.settings;
}

async function setSetting(key, value, userId) {
  await db.query(
    `insert into system_settings (key, value, updated_by, updated_at)
     values ($1,$2,$3,now())
     on conflict (key) do update set value=excluded.value, updated_by=excluded.updated_by, updated_at=now()`,
    [key, value, userId],
  );
}

module.exports = { loadSettings, setSetting };
