const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { MODULES } = require('../src/constants');
const { moduleNotificationTitle, notifyAdminsOfProducerUpdate, reviewNotificationMessage, reviewNotificationAction, notificationActorName } = require('../src/services/notifications');

test('reviews identify the authenticated reviewer, action, module and comment', () => {
  const actor = { first_name: 'Gabriel', last_name: 'Cason' };
  assert.equal(reviewNotificationMessage('seguros', 'APROBADO', '', actor), 'Gabriel Cason aprobó el módulo Seguros.');
  assert.equal(reviewNotificationMessage('seguros', 'OBSERVADO', 'Falta firma', actor), 'Gabriel Cason observó el módulo Seguros. Comentario: Falta firma');
  assert.equal(reviewNotificationAction('PENDIENTE', actor), 'Gabriel Cason marcó como pendiente');
  assert.equal(reviewNotificationAction('OTRO', actor), 'Gabriel Cason revisó');
  assert.equal(notificationActorName({ first_name: 'Gabriel' }), 'Gabriel');
  assert.equal(notificationActorName({}), 'Administracion');
});

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
