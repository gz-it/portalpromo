const test = require('node:test');
const assert = require('node:assert/strict');
const { fail, LIMIT, WINDOW, checkPassword } = require('../src/services/login-guard');

test('ten failed guesses block the account without extending the block on more attempts', () => {
  let state = {};
  for (let i = 0; i < LIMIT - 1; i++) state = fail(state, 1000 + i);
  assert.equal(state.blockedUntil, undefined);
  state = fail(state, 2000);
  assert.equal(state.blockedUntil, 2000 + WINDOW);
  assert.equal(fail(state, 3000).blockedUntil, 2000 + WINDOW);
  state = fail(state, 2000 + WINDOW + 1);
  assert.equal(state.failures, 1);
  assert.equal(state.blockedUntil, undefined);
});

test('password checks have a bounded CPU queue and release capacity after completion', async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = Array.from({ length: 4 }, () => checkPassword('test', 'hash', async () => { await waiting; return false; }));
  try { await assert.rejects(checkPassword('test', 'hash', async () => true), error => error.status === 429); }
  finally { release(); await Promise.all(pending); }
  assert.equal(await checkPassword('test', 'hash', async () => true), true);
});
