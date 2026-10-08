const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { encrypt, decrypt, pgEnvironment } = require('../scripts/recovery-backup');

test('recovery encryption detects wrong keys and modified content', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  try {
    const source = path.join(dir, 'source'), encrypted = path.join(dir, 'backup');
    const key = crypto.randomBytes(32);
    fs.writeFileSync(source, 'confidential settings and documents');
    await encrypt(source, encrypted, key);
    const result = path.join(dir, 'result');
    await decrypt(encrypted, result, key);
    assert.equal(fs.readFileSync(result, 'utf8'), fs.readFileSync(source, 'utf8'));
    assert.equal(fs.readFileSync(encrypted).includes(Buffer.from('confidential')), false);
    await assert.rejects(decrypt(encrypted, path.join(dir, 'wrong'), crypto.randomBytes(32)));
    const content = fs.readFileSync(encrypted); content[18] ^= 1; fs.writeFileSync(encrypted, content);
    await assert.rejects(decrypt(encrypted, path.join(dir, 'modified'), key));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PostgreSQL credentials are environment values, not command arguments', () => {
  const env = pgEnvironment('postgres://portal:p%40ss@localhost:5433/restore');
  assert.equal(env.PGPASSWORD, 'p@ss');
  assert.equal(env.PGDATABASE, 'restore');
  assert.equal(env.PGPORT, '5433');
  assert.throws(() => pgEnvironment('https://example.com'));
});
