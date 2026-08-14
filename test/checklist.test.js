const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeChecklist } = require('../src/services/checklist');

test('summarizes missing and warning checklist requirements', () => {
  const summary = summarizeChecklist([
    { state: 'complete' },
    { state: 'warning' },
    { state: 'missing' },
    { state: 'missing' },
  ]);
  assert.deepEqual(summary, { complete: 2, missing: 2, warnings: 1, total: 4, percentage: 50 });
});
