const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { csvCell, csv, writeZip, backupPaths } = require('../scripts/complete-backup');

test('recovery and consultation use separate sibling files', () => {
  const files = backupPaths(path.join(os.tmpdir(), 'portal-fecha.zip'));
  assert.equal(files.consultation, path.join(os.tmpdir(), 'portal-fecha.zip'));
  assert.equal(files.recovery, path.join(os.tmpdir(), 'portal-fecha.ppr'));
  assert.notEqual(files.consultation, files.recovery);
  assert.throws(() => backupPaths('archivo.dump'));
});

test('consultable exports escape CSV and neutralize spreadsheet formulas', () => {
  assert.equal(csvCell('=HYPERLINK("bad")'), '"\'=HYPERLINK(""bad"")"');
  assert.equal(csvCell('  +formula'), '"\'  +formula"');
  assert.equal(csvCell('Seguro; firmado'), '"Seguro; firmado"');
  assert.match(csv([{ nombre: 'Gabriel' }], ['nombre']), /"nombre"\r\n"Gabriel"/);
});

test('ZIP encrypts file contents and refuses overwrite or weak passwords', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-zip-test-'));
  try {
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'data.txt'), 'private-backup-information');
    const output = path.join(dir, 'backup.zip');
    await assert.rejects(writeZip(source, output, 'short'));
    await writeZip(source, output, 'test-only-password-with-32-characters');
    const before = fs.readFileSync(output);
    assert.equal(before.subarray(0, 2).toString(), 'PK');
    assert.equal(before.includes(Buffer.from('private-backup-information')), false);
    await assert.rejects(writeZip(source, output, 'test-only-password-with-32-characters'));
    assert.deepEqual(fs.readFileSync(output), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
