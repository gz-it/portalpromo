const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULES, ROLES } = require('../src/constants');
const { hashToken } = require('../src/utils/security');
const { workbookTemplateBuffer, parseStaff } = require('../src/services/excel');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

test('defines exactly ten ordered event modules', () => {
  assert.equal(MODULES.length, 10);
  assert.deepEqual(MODULES.map((m) => m.key), ['identificacion','seguros','habilitaciones','servicios','prensa','tecnica','comercial','sponsors','aceptacion','ticketera']);
});

test('roles include required access levels', () => {
  assert.equal(ROLES.ADMIN, 'ADMINISTRADOR');
  assert.equal(ROLES.PRODUCER, 'PRODUCTOR');
  assert.equal(ROLES.MANAGER, 'GERENCIADORA');
});

test('reset token hashing is deterministic and not plaintext', () => {
  const token = 'abc123';
  assert.equal(hashToken(token), hashToken(token));
  assert.notEqual(hashToken(token), token);
});

test('staff template can be parsed and validates required fields', () => {
  const tmp = path.join(os.tmpdir(), `staff-${Date.now()}.xlsx`);
  const wb = XLSX.read(workbookTemplateBuffer());
  XLSX.utils.sheet_add_json(wb.Sheets.Personal, [
    { Nombre: 'Ana', Apellido: 'Lopez', CUIT: '20-12345678-3', 'Funcion / Cargo': 'Tecnica' },
    { Nombre: '', Apellido: 'Perez', CUIT: 'bad', 'Funcion / Cargo': 'Seguridad' },
  ], { origin: -1, skipHeader: true });
  XLSX.writeFile(wb, tmp);
  const parsed = parseStaff(tmp);
  fs.unlinkSync(tmp);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.valid, 1);
  assert.equal(parsed.invalid, 1);
  assert.ok(parsed.errors.some((e) => e.problem.includes('Falta Nombre')));
});
