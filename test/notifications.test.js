const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { MODULES } = require('../src/constants');
const { moduleNotificationTitle, notifyAdminsOfProducerUpdate } = require('../src/services/notifications');

test('notification titles identify every module and event', () => {
  for (const module of MODULES) {
    for (const action of ['Nueva carga', 'Revision', 'Nuevo documento de administracion']) {
      assert.equal(moduleNotificationTitle(action, module.key, 'Megadeth'), `${action}: ${module.name} - Megadeth`);
    }
  }
});

test('producer update stores the module in the notification title and keeps its direct link', async t => {
  const calls = [];
  t.mock.method(db, 'query', async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('is_producer')) return { rows: [{ event_name: 'Tini', actor_name: 'Productor', is_producer: true }] };
    return { rows: [] };
  });
  await notifyAdminsOfProducerUpdate('event', 'seguros', 'producer');
  const notification = calls.find(call => call.sql.includes('insert into notifications'));
  assert.equal(notification.params[1], 'Nueva carga: Seguros - Tini');
  assert.equal(notification.params[3], '/events/event/modules/seguros');
});
