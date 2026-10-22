const test = require('node:test');
const assert = require('node:assert/strict');
const { rewrapMailSecret, validateCompatibility } = require('../src/services/full-restore');
const { encryptSecret, decryptSecret } = require('../src/utils/email');
const config = require('../src/config');
const maintenance = require('../src/services/restore-maintenance');

test('restored mail credentials are encrypted for the new installation', () => {
  const stored = encryptSecret('test-smtp-credential');
  const rewrapped = rewrapMailSecret(stored, config.sessionSecret);
  assert.equal(decryptSecret(rewrapped), 'test-smtp-credential');
  assert.notEqual(rewrapped, stored);
  assert.throws(() => rewrapMailSecret(stored, 'wrong-secret'));
});

test('restore maintenance is exclusive and blocks concurrent requests', async () => {
  const release = await maintenance.acquire();
  assert.equal(maintenance.isRestoring(), true);
  await assert.rejects(maintenance.acquire());
  let status;
  const res = { status(value) { status = value; return this; }, set() { return this; }, send() {} };
  maintenance.middleware({}, res, () => assert.fail('request must not pass'));
  assert.equal(status, 503);
  release();
  assert.equal(maintenance.isRestoring(), false);
});
