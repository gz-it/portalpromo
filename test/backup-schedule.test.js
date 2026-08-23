const test = require('node:test');
const assert = require('node:assert/strict');
const { isBackupDue, normalizeEmails, normalizeWeekdays } = require('../src/utils/backup-schedule');

const settings = {
  frequency: 'twice_weekly',
  weekdays: [1, 4],
  time: '03:00',
  timezone: 'America/Argentina/Buenos_Aires',
};

test('accepts two unique backup recipients', () => {
  assert.deepEqual(normalizeEmails(['Uno@Empresa.com', 'dos@empresa.com']), ['uno@empresa.com', 'dos@empresa.com']);
  assert.deepEqual(normalizeEmails('uno@empresa.com, dos@empresa.com'), ['uno@empresa.com', 'dos@empresa.com']);
});

test('normalizes two valid and distinct weekdays', () => {
  assert.deepEqual(normalizeWeekdays(['1', '4', '4']), [1, 4]);
});

test('runs on each configured weekday after the scheduled time', () => {
  assert.equal(isBackupDue(settings, null, new Date('2026-08-24T06:05:00Z')), true);
  assert.equal(isBackupDue(settings, null, new Date('2026-08-27T06:05:00Z')), true);
  assert.equal(isBackupDue(settings, null, new Date('2026-08-25T06:05:00Z')), false);
});

test('does not run before schedule or twice on the same local day', () => {
  assert.equal(isBackupDue(settings, null, new Date('2026-08-24T05:59:00Z')), false);
  assert.equal(isBackupDue(settings, new Date('2026-08-24T06:01:00Z'), new Date('2026-08-24T12:00:00Z')), false);
});
