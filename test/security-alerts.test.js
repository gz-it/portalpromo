const test = require('node:test');
const assert = require('node:assert/strict');
const { enqueue, claim, acknowledge, normalizeDetails } = require('../src/services/security-alerts');
const { healthChanges, firewallHealthy } = require('../scripts/security-monitor');

test('security messages allow no passwords, tokens, arbitrary subjects or file paths', () => {
  assert.deepEqual(normalizeDetails({ password: 'secret', token: 'secret', file: '/private/secret', component: 'antivirus\nlog', ip: '127.0.0.1' }),
    { component: 'antivirus log', ip: '127.0.0.1' });
  assert.deepEqual(normalizeDetails({ ip: 'not-an-ip', actorId: 'SQL invalid' }), {});
  assert.throws(() => enqueue({}, 'unknown', {}));
});

test('isolated failed logins do not send mail; repeated failures become one summary', () => {
  const state = {};
  for (let i = 0; i < 9; i++) enqueue(state, 'LOGIN_FAILED', { ip: '127.0.0.1' }, 1000 + i);
  assert.equal(claim(state, 1100), null);
  enqueue(state, 'LOGIN_FAILED', { ip: '127.0.0.2' }, 1200);
  const batch = claim(state, 1300);
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0][1].count, 10);
  assert.deepEqual(batch.items[0][1].origins, ['127.0.0.1', '127.0.0.2']);
  assert.equal(claim(state, 1400), null, 'another worker cannot send the same lease');
  acknowledge(state, batch, true, 1400);
  assert.equal(state.pending.LOGIN_FAILED, undefined);
});

test('a failed mail keeps its events, backs off, and recovers after an expired lease', () => {
  const state = {};
  enqueue(state, 'MAIL_CHANGED', {}, 1000);
  const batch = claim(state, 1100);
  acknowledge(state, batch, false, 1200);
  assert.equal(state.pending.MAIL_CHANGED.count, 1);
  assert.equal(state.lastDeliveryOk, false);
  assert.equal(claim(state, 1300), null);
  const retry = claim(state, 1200 + 5 * 60000);
  assert.ok(retry);
  assert.equal(claim(state, 1300 + 5 * 60000), null);
  assert.ok(claim(state, 1300 + 10 * 60000), 'crashed delivery lease eventually expires');
});

test('events queued during SMTP delivery are not lost or sent twice immediately', () => {
  const state = {};
  enqueue(state, 'ROLE_CHANGED', {}, 1000);
  const batch = claim(state, 1100);
  enqueue(state, 'ROLE_CHANGED', {}, 1200);
  acknowledge(state, batch, true, 1300);
  assert.equal(state.pending.ROLE_CHANGED.count, 1);
  assert.equal(claim(state, 1400), null);
  assert.ok(claim(state, 1300 + 15 * 60000));
});

test('healthy first run is quiet, failed controls and recoveries report only transitions', () => {
  assert.deepEqual(healthChanges({}, { firewall: 'correcto' }), []);
  assert.deepEqual(healthChanges({}, { antivirus: 'inactivo' }), [
    { kind: 'HEALTH_FAILED', details: { component: 'antivirus', state: 'inactivo' } },
  ]);
  assert.deepEqual(healthChanges({ antivirus: 'inactivo' }, { antivirus: 'inactivo' }), []);
  assert.deepEqual(healthChanges({ antivirus: 'inactivo' }, { antivirus: 'correcto' }), [
    { kind: 'HEALTH_RECOVERED', details: { component: 'antivirus', state: 'correcto' } },
  ]);
});

test('a health summary names each failed component rather than hiding all but the last', () => {
  const state = {};
  enqueue(state, 'HEALTH_FAILED', { component: 'firewall', state: 'inactivo' }, 1000);
  enqueue(state, 'HEALTH_FAILED', { component: 'antivirus', state: 'inactivo' }, 1100);
  assert.equal(claim(state, 1200).items[0][1].controls.length, 2);
});

test('firewall control recognizes IPv4/IPv6 UFW and rejects direct allow-all bypasses', () => {
  const ipv4 = { ok: true, output: 'policy drop; counter packets 10 jump ufw-before-input' };
  const ipv6 = { ok: true, output: 'policy drop; counter packets 10 jump ufw6-before-input' };
  assert.equal(firewallHealthy([ipv4, ipv6]), true);
  assert.equal(firewallHealthy([ipv4]), false);
  assert.equal(firewallHealthy([ipv4, { ok: false, output: '' }]), false);
  assert.equal(firewallHealthy([{ ...ipv4, output: ipv4.output + ' ip saddr 192.0.2.1 accept' }, ipv6]), false);
  assert.equal(firewallHealthy([{ ...ipv4, output: ipv4.output.replace('drop;', 'accept;') }, ipv6]), false);
});
