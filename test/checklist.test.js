const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeChecklist, summarizeModuleCompleteness } = require('../src/services/checklist');

test('summarizes missing and warning checklist requirements', () => {
  const summary = summarizeChecklist([
    { state: 'complete' },
    { state: 'warning' },
    { state: 'missing' },
    { state: 'missing' },
  ]);
  assert.deepEqual(summary, { complete: 2, missing: 2, warnings: 1, total: 4, percentage: 50 });
});

test('separates module completeness from administrative approval', () => {
  const modules = summarizeModuleCompleteness([
    { moduleKey: 'identificacion', state: 'complete' },
    { moduleKey: 'identificacion', state: 'missing' },
    { moduleKey: 'seguros', state: 'warning' },
    { moduleKey: 'aceptacion', state: 'complete' },
  ]);
  assert.equal(modules.identificacion.state, 'incomplete');
  assert.equal(modules.identificacion.percentage, 50);
  assert.equal(modules.seguros.state, 'warning');
  assert.equal(modules.aceptacion, undefined);
});
