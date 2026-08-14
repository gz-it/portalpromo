const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULES, ROLES } = require('../src/constants');
const { hashToken } = require('../src/utils/security');
const { canViewEventFile, canDownloadEventFile, canEditEventContent, canReviewEventContent, canDeleteEventFile } = require('../src/middleware/auth');
const { workbookTemplateBuffer, parseStaff } = require('../src/services/excel');
const { reviewNotificationMessage } = require('../src/services/notifications');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ExcelJS = require('exceljs');

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

test('event file permissions separate producer, manager and admin access', () => {
  const event = { owner_user_id: 'producer-id' };
  const admin = { id: 'admin-id', roles: [ROLES.ADMIN] };
  const producer = { id: 'producer-id', roles: [ROLES.PRODUCER] };
  const manager = { id: 'manager-id', roles: [ROLES.MANAGER] };

  assert.equal(canViewEventFile(admin), true);
  assert.equal(canViewEventFile(manager), true);
  assert.equal(canViewEventFile(producer), false);
  assert.equal(canDownloadEventFile(admin), true);
  assert.equal(canDownloadEventFile(manager), false);
  assert.equal(canDownloadEventFile(producer), false);
  assert.equal(canEditEventContent(admin, event), false);
  assert.equal(canEditEventContent(manager, event), false);
  assert.equal(canEditEventContent(producer, event), true);
  assert.equal(canReviewEventContent(admin), true);
  assert.equal(canReviewEventContent(manager), true);
  assert.equal(canReviewEventContent(producer), false);
  assert.equal(canDeleteEventFile(admin, event), false);
  assert.equal(canDeleteEventFile(producer, event), true);
  assert.equal(canDeleteEventFile(manager, event), false);
});

test('staff template can be parsed and validates required fields', async () => {
  const tmp = path.join(os.tmpdir(), `staff-${Date.now()}.xlsx`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await workbookTemplateBuffer());
  const sheet = workbook.getWorksheet('Personal');
  sheet.addRow(['Ana', 'Lopez', '20-12345678-3', 'Tecnica']);
  sheet.addRow(['', 'Perez', 'bad', 'Seguridad']);
  await workbook.xlsx.writeFile(tmp);
  const parsed = await parseStaff(tmp);
  fs.unlinkSync(tmp);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.valid, 1);
  assert.equal(parsed.invalid, 1);
  assert.ok(parsed.errors.some((e) => e.problem.includes('Falta Nombre')));
});

test('review notifications include status and optional comment', () => {
  assert.equal(reviewNotificationMessage('seguros', 'APROBADO'), 'Seguros fue marcado como APROBADO.');
  assert.equal(reviewNotificationMessage('tecnica', 'OBSERVADO', 'Falta firma'), 'Produccion Tecnica fue marcado como OBSERVADO. Comentario: Falta firma');
});
