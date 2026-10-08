const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { safeRoutes, errorHandler } = require('../src/middleware/safe-routes');

test('async routes and middleware return errors without stopping later requests', async () => {
  const app = express();
  const routes = safeRoutes(app);
  routes.use(express.json());
  routes.use('/middleware', async () => { throw Object.assign(new Error('private database detail'), { code: '22P02' }); });
  routes.get('/route', [async () => { throw Object.assign(new Error('private detail'), { code: '22003' }); }]);
  routes.get('/sync', () => { throw Object.assign(new Error('private detail'), { status: 400 }); });
  routes.get('/unexpected', async () => { throw new Error('secret=never-disclose'); });
  routes.post('/json', (req, res) => res.json(req.body));
  routes.get('/healthy', (req, res) => res.send('ok'));
  routes.use(errorHandler);
  for (const url of ['/middleware', '/route', '/sync']) {
    const result = await request(app).get(url).expect(400);
    assert.doesNotMatch(result.text, /private|database/);
  }
  const unexpected = await request(app).get('/unexpected').expect(500);
  assert.doesNotMatch(unexpected.text, /secret|never-disclose/);
  await request(app).post('/json').set('Content-Type', 'application/json').send('{').expect(400);
  await request(app).get('/healthy').expect(200, 'ok');
});

test('oversized uploads are controlled and already-started responses delegate', async () => {
  const app = express();
  const routes = safeRoutes(app);
  routes.post('/upload', async () => { throw Object.assign(new Error('too large'), { code: 'LIMIT_FILE_SIZE' }); });
  routes.use(errorHandler);
  await request(app).post('/upload').expect(413);
  const error = new Error('stream failure');
  let received;
  errorHandler(error, {}, { headersSent: true }, e => { received = e; });
  assert.equal(received, error);
});

test('invalid event identifiers do not reach the database', async () => {
  const { loadAuthorizedEvent } = require('../src/middleware/auth');
  let status;
  const res = { status(value) { status = value; return this; }, send() {} };
  await loadAuthorizedEvent({ params: { eventId: 'not-a-uuid' } }, res, () => assert.fail('must not authorize'));
  assert.equal(status, 404);
});
