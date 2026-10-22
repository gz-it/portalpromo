const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { parseStaff } = require('../src/services/excel');

test('Excel rejects malformed, oversized and excessive-row imports', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-excel-'));
  const file = path.join(dir, 'test.xlsx');
  try {
    await fs.writeFile(file, 'not a spreadsheet');
    await assert.rejects(parseStaff(file), error => error.status === 400);
    const handle = await fs.open(file, 'w');
    await handle.truncate(10 * 1024 ** 2 + 1);
    await handle.close();
    await assert.rejects(parseStaff(file), error => error.status === 413);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Personal');
    sheet.getCell('A5002').value = 'Too many rows';
    await workbook.xlsx.writeFile(file);
    await assert.rejects(parseStaff(file), error => error.status === 400);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
