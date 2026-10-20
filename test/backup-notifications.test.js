const test = require('node:test');
const assert = require('node:assert/strict');
const { notifyBackup } = require('../src/services/backup-notifications');
const settings = { emails: ['backup1@example.invalid', 'backup2@example.invalid'], statusEmails: ['systems@example.invalid'], sendFile: true };

test('backup recipients get the file; systems gets status only', async () => {
  const calls = [];
  await notifyBackup(settings, { ok: true, filename: 'test.dump', target: '/safe/test.dump', size: 100 }, async (...args) => { calls.push(args); return true; });
  assert.equal(calls.length, 3);
  assert.equal(calls[0][3].attachments.length, 1);
  assert.equal(calls[1][3].attachments.length, 1);
  assert.equal(calls[2][3].attachments, undefined);
});
test('backup errors notify all recipients without technical data or attachments', async () => {
  const calls = [];
  await notifyBackup(settings, { ok: false, error: 'SECRET' }, async (...args) => { calls.push(args); return true; });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => /Falló/.test(call[1]) && !call[2].includes('SECRET') && !call[3].attachments));
});
test('one mail failure does not prevent the remaining notifications', async () => {
  const deliveries = await notifyBackup(settings, { ok: true, filename: 'test.dump', size: 100 }, async email => { if (email === settings.emails[0]) throw new Error('smtp'); return true; });
  assert.deepEqual(deliveries.map(item => item.sent), [false, true, true]);
});
test('large backups are not attached and status-only wins on overlapping recipients', async () => {
  const calls = [];
  await notifyBackup({ ...settings, statusEmails: [settings.emails[0]] }, { ok: true, filename: 'large.dump', target: '/safe/large.dump', size: 21 * 1024 * 1024 }, async (...args) => { calls.push(args); return true; });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => !call[3].attachments));
  assert.match(calls[0][2], /sin adjunto/);
  assert.match(calls[1][2], /Supera 20 MB/);
});
