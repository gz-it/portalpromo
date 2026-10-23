const db = require('../db');
const { verifyPassword } = require('../utils/security');
const WINDOW = 15 * 60 * 1000;
const LIMIT = 10;

function fail(state, now = Date.now()) {
  if (!state.startedAt || now - state.startedAt >= WINDOW) state = { startedAt: now, failures: 0 };
  state.failures = Math.min(LIMIT, state.failures + 1);
  if (state.failures >= LIMIT && !state.blockedUntil) state.blockedUntil = now + WINDOW;
  return state;
}

async function blockedUntil(userId) {
  const row = (await db.query('select value from system_settings where key=$1', [`auth_guard_${userId}`])).rows[0];
  const until = row ? JSON.parse(row.value).blockedUntil : 0;
  return until > Date.now() ? until : 0;
}

async function recordFailure(userId) {
  const key = `auth_guard_${userId}`;
  return db.tx(async client => {
    await client.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do nothing', [key, '{}']);
    const row = (await client.query('select value from system_settings where key=$1 for update', [key])).rows[0];
    const state = fail(JSON.parse(row.value));
    await client.query('update system_settings set value=$2,updated_at=now() where key=$1', [key, JSON.stringify(state)]);
    return state.blockedUntil || 0;
  });
}

async function clear(userId) { await db.query('delete from system_settings where key=$1', [`auth_guard_${userId}`]); }

let checks = 0;
async function checkPassword(password, hash, verify = verifyPassword) {
  if (checks >= 4) throw Object.assign(new Error('Demasiadas verificaciones de acceso.'), { status: 429 });
  checks++;
  try { return await verify(password, hash); }
  finally { checks--; }
}

module.exports = { fail, blockedUntil, recordFailure, clear, checkPassword, WINDOW, LIMIT };
