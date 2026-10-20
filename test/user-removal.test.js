const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { removeUser } = require('../src/services/user-removal');

test('self deletion is denied before accessing the database', async () => {
  await assert.rejects(removeUser('self', 'self'), error => error.status === 400);
});
test('last active administrator cannot be removed', async t => {
  t.mock.method(db, 'tx', async fn => fn({ query: async sql => {
    if (/select id,status/.test(sql)) return { rows: [{ id: 'last', status: 'ACTIVO' }] };
    if (/select distinct u.id/.test(sql)) return { rows: [{ id: 'last' }] };
    return { rows: [] };
  } }));
  await assert.rejects(removeUser('other', 'last'), error => error.status === 400);
});
test('removal revokes access and tokens but never deletes users or events', async t => {
  const queries = [];
  t.mock.method(db, 'tx', async fn => fn({ query: async sql => {
    queries.push(sql);
    if (/select id,status/.test(sql)) return { rows: [{ id: 'producer', status: 'ACTIVO' }] };
    if (/select distinct u.id/.test(sql)) return { rows: [{ id: 'admin' }] };
    return { rows: [] };
  } }));
  await removeUser('admin', 'producer');
  assert.ok(queries.some(sql => /status='DESHABILITADO'/.test(sql)));
  assert.ok(queries.some(sql => /delete from session/.test(sql)));
  assert.ok(queries.some(sql => /update password_reset_tokens/.test(sql)));
  assert.ok(queries.some(sql => /update user_invitation_tokens/.test(sql)));
  assert.ok(!queries.some(sql => /delete from (users|events|attachments)\b/i.test(sql)));
});
