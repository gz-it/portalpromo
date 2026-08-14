const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleCompletion } = require('../src/utils/completion');

test('calculates completed and missing module percentages', () => {
  assert.deepEqual(moduleCompletion(8), { completed: 80, missing: 20 });
  assert.deepEqual(moduleCompletion(5), { completed: 50, missing: 50 });
  assert.deepEqual(moduleCompletion(3), { completed: 30, missing: 70 });
});

test('clamps module completion to valid percentage bounds', () => {
  assert.deepEqual(moduleCompletion(-2), { completed: 0, missing: 100 });
  assert.deepEqual(moduleCompletion(20), { completed: 100, missing: 0 });
});
