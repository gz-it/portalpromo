const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanFile, scannedUpload } = require('../src/services/antivirus');

test('antivirus uses a fixed executable, no shell, and fails closed', async () => {
  await scanFile('/tmp/upload.pdf', (program, args, options, cb) => {
    assert.equal(program, '/usr/bin/clamdscan');
    assert.deepEqual(args, ['--fdpass', '--no-summary', '--', '/tmp/upload.pdf']);
    assert.equal(options.shell, undefined);
    cb(null);
  });
  for (const code of [1, 2, 'ENOENT', 'ETIMEDOUT']) {
    await assert.rejects(scanFile('/tmp/file', (p, a, o, cb) => cb({ code })),
      error => error.status === (code === 1 ? 400 : 503));
  }
});

test('rejected uploads are removed before any business handler can run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-scan-'));
  const file = path.join(directory, 'document.pdf');
  try {
    await fs.writeFile(file, 'rejected');
    const middleware = scannedUpload((req, res, next) => { req.file = { path: file }; next(); }, true,
      async () => { throw Object.assign(new Error('Rejected'), { status: 400 }); });
    const error = await new Promise(resolve => middleware({}, {}, resolve));
    assert.equal(error.status, 400);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
