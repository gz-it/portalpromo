const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const email = require('../src/utils/email');
const { hashToken } = require('../src/utils/security');
const originalSend = email.sendMail;
let mail;
email.sendMail = async (...args) => { mail = args; return true; };
const { sendInvitation, acceptInvitation } = require('../src/services/invitations');
email.sendMail = originalSend;

test('invitation mails a setup link and stores only its hash', async () => {
  const original = db.query;
  let saved;
  db.query = async (sql, params) => { saved = { sql, params }; return { rows: [] }; };
  try {
    await sendInvitation({ id:'user-id', email:'producer@example.com' });
    const token = mail[2].match(/invitation\/([a-f0-9]+)/)[1];
    assert.equal(saved.params[1], hashToken(token));
    assert.match(saved.sql, /48 hours/);
    assert.equal(mail[0], 'producer@example.com');
  } finally { db.query = original; }
});

test('expired, used or blocked invitations cannot activate an account', async () => {
  const original = db.tx;
  const queries = [];
  db.tx = async (callback) => callback({ query:async (sql) => { queries.push(sql); return { rows:[] }; } });
  try {
    assert.equal(await acceptInvitation('bad-token', 'strong-password'), null);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /used_at is null/);
    assert.match(queries[0], /expires_at>now\(\)/);
    assert.match(queries[0], /u.status='PENDIENTE'/);
  } finally { db.tx = original; }
});

test('acceptance activates account and consumes every pending invitation', async () => {
  const original = db.tx;
  const queries = [];
  db.tx = async (callback) => callback({ query:async (sql, params) => {
    queries.push({ sql, params });
    return { rows:queries.length === 1 ? [{ user_id:'user-id' }] : queries.length === 2 ? [{ id:'user-id' }] : [] };
  } });
  try {
    assert.equal((await acceptInvitation('valid-token', 'strong-password')).id, 'user-id');
    assert.match(queries[1].sql, /status='ACTIVO'/);
    assert.match(queries[1].params[1], /^\$2/);
    assert.match(queries[2].sql, /where user_id=\$1 and used_at is null/);
  } finally { db.tx = original; }
});
