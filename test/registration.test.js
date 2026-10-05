const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const email = require('../src/utils/email');
const { hashToken } = require('../src/utils/security');
const originalSend = email.sendMail;
let mail;
email.sendMail = async (...args) => { mail = args; return true; };
const { sendVerification, confirmEmail } = require('../src/services/registration');
email.sendMail = originalSend;

test('confirmation email contains a token stored only as a hash with expiry', async () => {
  const original = db.query;
  let insert;
  db.query = async (sql, params) => { insert = { sql, params }; return { rows: [] }; };
  try {
    await sendVerification({ id: 'user-id', email: 'productor@example.com' });
    const token = mail[2].match(/verify-email\/([a-f0-9]+)/)[1];
    assert.equal(insert.params[1], hashToken(token));
    assert.notEqual(insert.params[1], token);
    assert.match(insert.sql, /24 hours/);
    assert.equal(mail[0], 'productor@example.com');
  } finally { db.query = original; }
});

test('invalid or expired confirmation cannot activate or modify the user', async () => {
  const original = db.tx;
  const queries = [];
  db.tx = async (callback) => callback({ query: async (sql) => { queries.push(sql); return { rows: [] }; } });
  try {
    assert.equal(await confirmEmail('expired-token'), null);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /used_at is null and expires_at>now\(\)/);
  } finally { db.tx = original; }
});

test('confirmed token is consumed without bypassing administrative approval', async () => {
  const original = db.tx;
  const queries = [];
  db.tx = async (callback) => callback({ query: async (sql) => {
    queries.push(sql);
    return { rows: queries.length === 1 ? [{ user_id: 'user-id' }] : queries.length === 2 ? [{ id: 'user-id', status: 'PENDIENTE' }] : [] };
  } });
  try {
    const user = await confirmEmail('valid-token');
    assert.equal(user.status, 'PENDIENTE');
    assert.match(queries[0], /for update/);
    assert.match(queries[2], /used_at=now\(\)/);
    assert.doesNotMatch(queries[1], /status\s*=/);
  } finally { db.tx = original; }
});
