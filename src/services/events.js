const db = require('../db');
const { MODULES } = require('../constants');

async function initModules(client, eventId) {
  for (const module of MODULES) {
    await client.query(
      `insert into event_modules (event_id, module_key, module_name) values ($1,$2,$3)
       on conflict (event_id, module_key) do nothing`,
      [eventId, module.key, module.name],
    );
  }
}

async function loadModuleStatuses(event) {
  const result = await db.query('select module_key, status from event_modules where event_id=$1', [event.id]);
  event.module_statuses = Object.fromEntries(result.rows.map((r) => [r.module_key, r.status]));
  return event;
}

async function markLoaded(eventId, moduleKey, userId) {
  const current = await db.query('select status from event_modules where event_id=$1 and module_key=$2', [eventId, moduleKey]);
  const previous = current.rows[0]?.status || 'PENDIENTE';
  if (previous === 'APROBADO') return;
  await db.tx(async (client) => {
    await client.query('update event_modules set status=$3, updated_at=now() where event_id=$1 and module_key=$2', [eventId, moduleKey, 'CARGADO']);
    await client.query(
      'insert into module_status_history (event_id,module_key,previous_status,new_status,created_by) values ($1,$2,$3,$4,$5)',
      [eventId, moduleKey, previous, 'CARGADO', userId],
    );
  });
}

module.exports = { initModules, loadModuleStatuses, markLoaded };
