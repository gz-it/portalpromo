const test = require('node:test');
const assert = require('node:assert/strict');
const { mayManageUser } = require('../src/middleware/user-management');

test('ordinary administrators cannot grant Systems or manage a Systems account', () => {
  const admin = { roles: ['ADMINISTRADOR'] };
  assert.equal(mayManageUser(admin, ['PRODUCTOR'], 'SISTEMAS'), false);
  assert.equal(mayManageUser(admin, ['SISTEMAS']), false);
  assert.equal(mayManageUser(admin, ['ADMINISTRADOR', 'SISTEMAS'], 'PRODUCTOR'), false);
  assert.equal(mayManageUser(admin, ['PRODUCTOR'], 'ADMINISTRADOR'), true);
  assert.equal(mayManageUser(admin, ['PRODUCTOR']), true);
});

test('Systems management is reserved to active authenticated Systems routes, never producers', () => {
  assert.equal(mayManageUser({ roles: ['SISTEMAS'] }, ['SISTEMAS'], 'PRODUCTOR'), true);
  assert.equal(mayManageUser({ roles: ['SISTEMAS'] }, [], 'SISTEMAS'), true);
  assert.equal(mayManageUser({ roles: ['PRODUCTOR'] }, ['PRODUCTOR']), false);
  assert.equal(mayManageUser(null), false);
});
