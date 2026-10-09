const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { csrf } = require('../src/middleware/csrf');
const { resolveAttachment } = require('../src/services/storage');
const { saveAttachment } = require('../src/services/storage');
const fs = require('node:fs/promises');
const os = require('node:os');
const config = require('../src/config');
const { safeWebUrl } = require('../src/utils/security');
const { pgEnvironment } = require('../src/utils/pg-environment');
const { attachUser } = require('../src/middleware/auth');

test('inactive sessions lose authenticated access without a database lookup', async () => {
  const req = { session: { userId: 'expired', lastActiveAt: Date.now() - 31 * 60 * 1000 } };
  let continued = false;
  await attachUser(req, {}, () => { continued = true; });
  assert.equal(req.session.userId, undefined);
  assert.equal(continued, true);
});

test('database backup credentials are decoded into process environment', () => {
  const env = pgEnvironment('postgres://user:pass%40word@localhost:5433/portal');
  assert.equal(env.PGPASSWORD, 'pass@word');
  assert.equal(env.PGDATABASE, 'portal');
  assert.equal(env.PGPORT, '5433');
});

test('ticketing links reject executable schemes and embedded credentials', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '//evil.example', 'https://user:secret@example.com', null]) assert.equal(safeWebUrl(value), '');
  assert.equal(safeWebUrl('https://tickets.example/event'), 'https://tickets.example/event');
});

test('attachment paths cannot escape to a sibling directory', () => {
  assert.throws(() => resolveAttachment({ storage_key: '../uploads-evil/file.pdf' }), /Ruta invalida/);
  assert.throws(() => resolveAttachment({ storage_key: '../../etc/passwd' }), /Ruta invalida/);
  assert.equal(resolveAttachment({ storage_key: 'event/file.pdf' }), path.join(config.storagePath, 'event/file.pdf'));
});

test('CSRF rejects missing and incorrect tokens and accepts the session token', () => {
  for (const token of [undefined, 'incorrect']) {
    let status;
    const res = { status(value) { status = value; return this; }, send() {} };
    csrf({ method: 'POST', session: { csrfToken: 'valid' }, body: { _csrf: token }, headers: {} }, res, () => assert.fail('Unexpected access'));
    assert.equal(status, 403);
  }
  let accepted = false;
  csrf({ method: 'POST', session: { csrfToken: 'valid' }, body: { _csrf: 'valid' }, headers: {} }, {}, () => { accepted = true; });
  assert.equal(accepted, true);
});

test('an HTML payload disguised as a PNG is rejected and removed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-upload-test-'));
  const file = path.join(dir, 'fake.png');
  try {
    await fs.writeFile(file, '<html><script>alert(1)</script></html>');
    await assert.rejects(saveAttachment({ file: { path: file, originalname: 'fake.png' } }), error => error.status === 400);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
