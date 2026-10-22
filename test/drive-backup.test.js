const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { expiredRuns, assertPrivate, Drive } = require('../scripts/drive-backup');

test('30 day retention selects only completed app backups in the exact root folder',()=>{
  const now=Date.parse('2026-10-22T12:00:00Z');
  const old={id:'old',mimeType:'application/vnd.google-apps.folder',parents:['ours'],appProperties:{portalBackupRun:'1',completed:'true'},createdTime:'2026-09-21T12:00:00Z'};
  const files=[old,{...old,id:'recent',createdTime:'2026-10-01T00:00:00Z'},{...old,id:'other',parents:['other']},{...old,id:'unknown',appProperties:{}},{...old,id:'incomplete',appProperties:{portalBackupRun:'1',completed:'false'}},{...old,id:'trashed',trashed:true},{...old,id:'bad-date',createdTime:'invalid'}];
  assert.deepEqual(expiredRuns(files,'ours',now).map(item=>item.id),['old']);
});

test('Drive sharing rejects public, group and domain permissions',()=>{
  assert.doesNotThrow(()=>assertPrivate([{type:'user',role:'owner'},{type:'user',role:'reader'}]));
  for(const type of ['anyone','group','domain']) assert.throws(()=>assertPrivate([{type}]));
});

for (const corrupted of [false, true]) test(`upload readback ${corrupted ? 'rejects changed bytes' : 'verifies the exact bytes'}`, async t=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'drive-upload-test-'));
  const file=path.join(temp,'test.zip');
  const bytes=Buffer.from('encrypted-test-fixture');
  fs.writeFileSync(file,bytes);
  let calls=0;
  t.mock.method(globalThis,'fetch',async(url,options={})=>{
    calls++;
    if(calls===1) return new Response(null,{headers:{location:'https://www.googleapis.com/upload/drive/v3/files?upload_id=test'}});
    if(calls===2){
      for await(const chunk of options.body) { assert.ok(chunk.length); }
      return Response.json({id:'test-id',name:'test.zip',size:String(bytes.length),md5Checksum:crypto.createHash('md5').update(bytes).digest('hex')});
    }
    return new Response(corrupted?'corrupted-copy':bytes);
  });
  try {
    const operation=new Drive('test-token-only').upload(file,'test-folder');
    if(corrupted) await assert.rejects(operation,/no coincide/);
    else assert.equal((await operation).id,'test-id');
    assert.equal(calls,3);
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
});
