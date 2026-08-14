const db = require('../db');

async function audit(userId, action, entityType, entityId, detail = {}) {
  await db.query(
    `insert into audit_logs (user_id, action, entity_type, entity_id, detail)
     values ($1, $2, $3, $4, $5)`,
    [userId || null, action, entityType || null, entityId || null, detail],
  );
}

module.exports = { audit };
