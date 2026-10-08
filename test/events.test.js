const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const notifications = require('../src/services/notifications');
let notified = 0;
const originalNotify = notifications.notifyAdminsOfProducerUpdate;
notifications.notifyAdminsOfProducerUpdate = async () => { notified += 1; };
const { markLoaded } = require('../src/services/events');
notifications.notifyAdminsOfProducerUpdate = originalNotify;

for (const previous of ['APROBADO', 'OBSERVADO', 'PENDIENTE', 'CARGADO']) {
  test(`producer change reopens ${previous} module for review`, async () => {
    const original = db.tx;
    const queries = [];
    notified = 0;
    db.tx = async (callback) => callback({ query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: queries.length === 1 ? [{ status: previous }] : [] };
    } });
    try {
      await markLoaded('event', 'seguros', 'producer');
      assert.match(queries[0].sql, /for update/);
      assert.equal(queries[1].params[2], 'CARGADO');
      assert.deepEqual(queries[2].params, ['event', 'seguros', previous, 'CARGADO', 'producer']);
      assert.equal(notified, 1);
    } finally { db.tx = original; }
  });
}
