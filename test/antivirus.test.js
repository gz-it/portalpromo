const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scanFile, scannedUpload, reservedUploadBytes } = require('../src/services/antivirus');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const express = require('express');
const multer = require('multer');

async function eventuallyRemoved(file) {
  for (let i = 0; i < 50; i++) {
    try { await fs.stat(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Unclaimed upload was not removed');
}

test('antivirus uses a fixed executable, no shell, and fails closed', async () => {
  await scanFile('/tmp/upload.pdf', (program, args, options, cb) => {
    assert.equal(program, '/usr/bin/clamdscan');
    assert.deepEqual(args, ['--fdpass', '--no-summary', '--', '/tmp/upload.pdf']);
    assert.equal(options.shell, undefined);
    cb(null);
  });
  for (const code of [1, 2, 'ENOENT', 'ETIMEDOUT']) {
    await assert.rejects(scanFile('/tmp/file', (p, a, o, cb) => cb({ code })),
      error => error.status === (code === 1 ? 400 : 503));
  }
});

test('rejected uploads are removed before any business handler can run', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-scan-'));
  const file = path.join(directory, 'document.pdf');
  try {
    await fs.writeFile(file, 'rejected');
    const middleware = scannedUpload((req, res, next) => { req.file = { path: file }; next(); }, true,
      async () => { throw Object.assign(new Error('Rejected'), { status: 400 }); });
    const error = await new Promise(resolve => middleware({}, {}, resolve));
    assert.equal(error.status, 400);
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('a rejected business form or closed client does not leave an orphan upload', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-orphan-'));
  try {
    for (const event of ['finish', 'close']) {
      const file = path.join(directory, event + '.pdf');
      await fs.writeFile(file, 'unclaimed');
      const req = { user: { id: 'producer' } };
      const res = new EventEmitter();
      const middleware = scannedUpload((r, s, next) => { r.file = { path: file }; next(); }, false);
      assert.equal(await new Promise(resolve => middleware(req, res, resolve)), undefined);
      res.emit(event);
      await eventuallyRemoved(file);
    }
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('persisted files survive response cleanup and an in-flight DB save is not unlinked', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-retained-'));
  const res = new EventEmitter();
  try {
    const file = path.join(directory, 'document.pdf');
    await fs.writeFile(file, 'saved');
    const req = { user: { id: 'producer' } };
    const middleware = scannedUpload((r, s, next) => { r.file = { path: file }; next(); }, false);
    await new Promise(resolve => middleware(req, res, resolve));
    req.file.saving = true;
    res.emit('close');
    assert.equal(await fs.readFile(file, 'utf8'), 'saved');
    req.file.saving = false;
    req.file.retained = true;
    res.emit('finish');
    assert.equal(await fs.readFile(file, 'utf8'), 'saved');
  } finally { res.emit('close'); await fs.rm(directory, { recursive: true, force: true }); }
});

test('each uploader is limited to two simultaneous requests and releases capacity', async () => {
  const responses = [];
  const middleware = scannedUpload((r, s, next) => next(), false);
  const request = () => new Promise(resolve => {
    const res = new EventEmitter(); responses.push(res);
    middleware({ user: { id: 'limited-owner' } }, res, resolve);
  });
  try {
    assert.equal(await request(), undefined);
    assert.equal(await request(), undefined);
    assert.equal((await request()).status, 429);
    responses[0].emit('finish');
    assert.equal(await request(), undefined);
  } finally { for (const res of responses) res.emit('close'); }
});

test('all uploaders together are limited to eight in-flight uploads', async () => {
  const responses = [];
  const middleware = scannedUpload((r, s, next) => next(), false);
  try {
    for (let i=0;i<8;i++) {
      const res = new EventEmitter(); responses.push(res);
      assert.equal(await new Promise(resolve => middleware({user:{id:`owner-${i}`}},res,resolve)),undefined);
    }
    const overflow = new EventEmitter();
    assert.equal((await new Promise(resolve => middleware({user:{id:'overflow'}},overflow,resolve))).status,429);
    assert.equal(reservedUploadBytes(200),1600);
  } finally { for (const res of responses) res.emit('close'); }
  assert.equal(reservedUploadBytes(200),0);
});

test('a real multipart client abort removes the partial file and frees its upload slot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-partial-'));
  const app = express();
  app.post('/',scannedUpload(multer({dest:directory}).single('file'),false),(req,res)=>res.end('ok'));
  app.use((error,req,res,next)=>res.status(400).end());
  const server = await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  let client;
  try {
    client = http.request({host:'127.0.0.1',port:server.address().port,method:'POST',path:'/',headers:{
      'Content-Type':'multipart/form-data; boundary=partial-upload-test','Content-Length':1024*1024,
    }});
    client.on('error',()=>{});
    client.write('--partial-upload-test\r\nContent-Disposition: form-data; name="file"; filename="partial.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\npartial');
    let files=[];
    for(let i=0;i<100&&!files.length;i++){await new Promise(resolve=>setTimeout(resolve,10));files=await fs.readdir(directory);}
    assert.equal(files.length,1,'The test must actually create a partial upload');
    const closed = new Promise(resolve=>client.once('close',resolve));
    client.destroy();await closed;
    await eventuallyRemoved(path.join(directory,files[0]));
    assert.equal(reservedUploadBytes(1),0);
  } finally {
    client?.destroy();
    await new Promise(resolve=>server.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
