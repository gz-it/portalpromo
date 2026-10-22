// Isolated PostgreSQL integration review. Never restores into the live database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Pool } = require('pg');

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !process.env.DATABASE_URL) {
    throw new Error('Ejecutar en el VPS como root con su entorno; solo crea bases aisladas.');
  }
  const live = new URL(process.env.DATABASE_URL);
  const suffix = randomUUID().replaceAll('-', '');
  const database = `portal_review_${suffix}`;
  const restored = `${database}_restore`;
  const created = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-review-'));
  let server;
  let db;
  const command = (program, args, options = {}) => {
    const result = spawnSync(program, args, { ...options, encoding: 'utf8', timeout: 60000 });
    if (result.status !== 0) throw new Error(`${program} fallo en el entorno aislado`);
    return result.stdout;
  };
  try {
    for (const name of [database, restored]) {
      command('sudo', ['-u', 'postgres', 'createdb', '--owner', decodeURIComponent(live.username), name]);
      created.push(name);
    }
    const scratch = new URL(live); scratch.pathname = `/${database}`;
    process.env.DATABASE_URL = scratch.toString();
    process.env.STORAGE_PATH = path.join(directory, 'uploads');
    process.env.BACKUP_PATH = path.join(directory, 'backups');
    process.env.SESSION_SECURE = 'false';
    process.env.NODE_ENV = 'test';
    process.env.SECURITY_ALERT_EMAIL = 'security@example.invalid';
    process.env.SESSION_SECRET = randomUUID();
    process.env.APP_URL = 'http://localhost';
    db = require('../src/db');
    for (const file of fs.readdirSync(path.join(__dirname, '../migrations')).filter(f => f.endsWith('.sql')).sort()) {
      await db.query(fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8'));
    }
    const outbox = [];
    const email = require('../src/utils/email');
    email.sendMail = async (...values) => { outbox.push(values); return true; };
    const { hashPassword } = require('../src/utils/security');
    const password = randomUUID();
    const admin = (await db.query(`insert into users(first_name,last_name,email,username,password_hash,status)
      values('Prueba','Admin','admin@example.invalid','admin@example.invalid',$1,'ACTIVO') returning id`, [await hashPassword(password)])).rows[0];
    await db.query("insert into user_roles select $1,id from roles where name='ADMINISTRADOR'", [admin.id]);
    const app = require('../src/app');
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = () => {
      const cookies = new Map(); let token;
      return {
        async request(route, options = {}) {
          const headers = new Headers(options.headers);
          if (cookies.size) headers.set('cookie', [...cookies].map(([k,v]) => `${k}=${v}`).join('; '));
          const response = await fetch(base + route, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(route.startsWith('/systems/restore') ? 90000 : 10000) });
          for (const value of response.headers.getSetCookie()) {
            const pair = value.split(';')[0], separator = pair.indexOf('=');
            cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
          }
          const text = await response.text();
          token = text.match(/name="_csrf" value="([^"]+)"/)?.[1] || token;
          return { status: response.status, location: response.headers.get('location'), headers: response.headers, text };
        },
        async post(route, body) {
          return this.request(route, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...body, _csrf: token }) });
        },
        async upload(route, label) {
          const body = new FormData(); body.set('label', label);
          body.set('file', new Blob([fs.readFileSync(path.join(__dirname, '../src/public/images/logo-brand.png'))], { type: 'image/png' }), 'prueba.png');
          return this.request(`${route}?_csrf=${token}`, { method: 'POST', body });
        },
        async login(user) { await this.request('/login'); return this.post('/login', { login: user, password }); },
        cookie() { return [...cookies].map(([k,v]) => `${k}=${v}`).join('; '); },
      };
    };
    const administrator = session();
    assert.equal((await administrator.login('admin@example.invalid')).location, '/dashboard');
    const adminDashboard = await administrator.request('/admin');
    assert.equal(adminDashboard.status, 200);
    assert.match(adminDashboard.text, /href="\/admin\/reviews">Revisiones pendientes/);
    assert.match(adminDashboard.headers.get('content-security-policy'), /script-src 'self' 'nonce-/);
    assert.match(adminDashboard.headers.get('cache-control'), /no-store/);
    assert.equal((await administrator.post('/admin/updates/run', {})).status, 403);
    assert.equal((await administrator.post('/admin/updates/check', {})).status, 403);
    assert.equal((await administrator.request('/admin/settings/account', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'first_name=SinToken' })).status, 403);
    for (const section of ['cuenta', 'portal', 'notificaciones']) {
      const page = await administrator.request(`/admin/settings?section=${section}`);
      assert.equal(page.status, 200);
      assert.match(page.text, /aria-label="Secciones de configuración"/);
      assert.doesNotMatch(page.text, /action="\/admin\/updates\/run"/);
    }
    for (const route of ['/admin/events', '/admin/reviews', '/admin/users', '/admin/settings', '/admin/reviews?status=CARGADO', '/admin/reviews?status=OBSERVADO']) {
      const page = await administrator.request(route);
      assert.equal(page.status, 200);
      assert.match(page.text, /class="page-return"/);
    }
    assert.match(adminDashboard.text, /href="\/admin\/reviews\?status=OBSERVADO"/);
    await administrator.request('/admin/users');
    await administrator.post('/admin/users', { first_name:'Prueba',last_name:'Productor',email:'producer@example.invalid',role:'PRODUCTOR' });
    const invite = outbox.find(mail => mail[0] === 'producer@example.invalid');
    assert.ok(invite, 'Invitacion no generada');
    const token = invite[2].match(/invitation\/([a-f0-9]+)/)[1];
    const producer = session(); await producer.request(`/invitation/${token}`);
    await producer.post(`/invitation/${token}`, { password, confirm_password:password });
    assert.equal((await producer.login('producer@example.invalid')).location, '/dashboard');
    await producer.request('/dashboard');
    const { acceptInvitation } = require('../src/services/invitations');
    assert.equal(await acceptInvitation(token, password), null);
    console.log('PASS invitacion, activacion por clave propia y token de un solo uso (correo simulado)');
    const result = await producer.post('/events', { name:'Revision aislada',artist:'Prueba',show_date:'2026-12-01',venue:'Prueba',city:'Buenos Aires',province:'Buenos Aires' });
    const eventId = result.location.match(/events\/([a-f0-9-]+)/)[1];
    await producer.request(`/events/${eventId}/modules/seguros`);
    await producer.upload(`/events/${eventId}/modules/seguros/entries`, 'Seguro prueba');
    assert.equal((await producer.post(`/events/${eventId}/review/seguros`, { status:'APROBADO' })).status, 403);
    assert.equal((await administrator.post(`/events/${eventId}/modules/identificacion/company`, { legal_name:'No permitido' })).status, 403);
    assert.equal((await producer.request('/systems')).status, 403);
    assert.equal((await producer.request('/admin/settings')).status, 403);
    const file = (await db.query('select id from attachments where event_id=$1', [eventId])).rows[0];
    assert.equal((await producer.request(`/files/${file.id}/download`)).status, 403);
    assert.equal((await administrator.request(`/files/${file.id}/download`)).status, 200);
    console.log('PASS permisos de productor/admin, configuracion y descarga');
    await administrator.request(`/events/${eventId}/modules/seguros`);
    await administrator.post(`/events/${eventId}/review/seguros`, { status:'OBSERVADO',observation:'Falta firma' });
    assert.match((await producer.request(`/events/${eventId}/modules/seguros`)).text, /Falta firma/);
    await producer.post(`/events/${eventId}/modules/seguros/entries`, { label:'Correccion',value:'Firmado' });
    await administrator.post(`/events/${eventId}/review/seguros`, { status:'APROBADO' });
    const reviews = (await db.query("select title,message from notifications where user_id=(select id from users where email='producer@example.invalid') and event_id=$1 and type='REVISION_MODULO'", [eventId])).rows;
    assert.ok(reviews.some(item => item.title.includes('Prueba Admin aprobó: Seguros') && item.message.includes('Prueba Admin aprobó el módulo Seguros.')));
    assert.ok(reviews.some(item => item.title.includes('Prueba Admin observó: Seguros') && item.message.includes('Comentario: Falta firma')));
    assert.ok(outbox.some(mail => mail[1].includes('Prueba Admin aprobó: Seguros') && mail[2].includes('Prueba Admin aprobó el módulo Seguros.')));
    assert.ok(outbox.some(mail => mail[1].includes('Prueba Admin observó: Seguros') && mail[2].includes('Comentario: Falta firma')));
    console.log('PASS avisos internos y correos identifican administrador, modulo y comentario');
    assert.match((await producer.request(`/events/${eventId}/modules/seguros`)).text, /Aprobado por administraci/);
    assert.ok((await db.query("select 1 from notifications where user_id=$1 and type='NUEVA_CARGA'", [admin.id])).rowCount);
    console.log('PASS carga, observacion, correccion, aprobacion y avisos internos');
    assert.match((await producer.request('/notifications')).text, /class="notification-back" href="\/dashboard" aria-label="Volver al panel"/);
    await producer.post(`/events/${eventId}/modules/seguros/entries`, { label:'Cambio posterior',value:'Nueva version' });
    const status = (await db.query("select status from event_modules where event_id=$1 and module_key='seguros'", [eventId])).rows[0].status;
    assert.equal(status, 'CARGADO');
    console.log('PASS cambio posterior a aprobacion vuelve a revision');
    await administrator.upload(`/admin/events/${eventId}/modules/seguros/documents`, 'Documento administrativo');
    const adminFile = (await db.query('select id from attachments where event_id=$1 and uploaded_by=$2', [eventId, admin.id])).rows[0];
    assert.equal((await producer.request(`/files/${adminFile.id}/view`)).status, 200);
    const modulePage = (await producer.request(`/events/${eventId}/modules/seguros`)).text;
    const administrationStart = modulePage.indexOf('class="module-zone zone-administration"');
    assert.ok(administrationStart > modulePage.indexOf('class="module-zone zone-producer"'));
    assert.ok(modulePage.indexOf(`/files/${adminFile.id}/view`) > administrationStart);
    assert.match(modulePage, /Faltan datos/);
    assert.match(modulePage, /Pendiente de revisión/);
    assert.match(modulePage, /Tipo de seguro/);
    assert.match(modulePage, /name="reference" type="date"/);
    assert.match(modulePage, /Guardar archivo/);
    console.log('PASS productor ve campos claros y documentos administrativos separados');
    console.log('PASS documento administrativo visible para el productor');
    const other = (await db.query(`insert into users(first_name,last_name,email,username,password_hash,status)
      values('Otro','Productor','other@example.invalid','other@example.invalid',$1,'ACTIVO') returning id`, [await hashPassword(password)])).rows[0];
    await db.query("insert into user_roles select $1,id from roles where name='PRODUCTOR'", [other.id]);
    const outsider = session();
    await outsider.login('other@example.invalid');
    await outsider.request('/dashboard');
    for (const route of [`/events/${eventId}`, `/events/${eventId}/modules/seguros`, `/events/${eventId}/zip`, `/files/${file.id}/view`, `/files/${file.id}/download`, `/files/${adminFile.id}/view`, '/admin', '/admin/users', '/systems']) {
      assert.equal((await outsider.request(route)).status, 403, `Acceso cruzado permitido: ${route}`);
    }
    for (const [route, body] of [
      [`/events/${eventId}/modules/seguros/entries`, { label: 'Ataque', value: 'No debe persistir' }],
      [`/files/${file.id}/delete`, {}],
      [`/events/${eventId}/review/seguros`, { status: 'APROBADO' }],
      ['/admin/users', { first_name: 'Ataque', last_name: 'Admin', email: 'attack@example.invalid', role: 'SISTEMAS' }],
      ['/systems/backups/run', {}],
      ['/admin/settings/identity', { portal_title: 'Ataque' }],
    ]) assert.equal((await outsider.post(route, body)).status, 403, `Escritura cruzada permitida: ${route}`);
    const ownNotification = (await db.query('select id from notifications where user_id=$1 limit 1', [admin.id])).rows[0];
    assert.equal((await outsider.post(`/notifications/${ownNotification.id}/read`, {})).status, 404);
    assert.equal((await db.query('select deleted_at from attachments where id=$1', [file.id])).rows[0].deleted_at, null);
    console.log('PASS PENTEST aislamiento: 9 lecturas y 6 escrituras cruzadas denegadas; notificaciones privadas');

    await producer.request(`/events/${eventId}/modules/seguros`);
    const injection = '<img src=x onerror=alert(1)><script>alert(1)</script>';
    assert.equal((await producer.post(`/events/${eventId}/modules/seguros/entries`, { label: injection, value: injection })).status, 302);
    const injectedPage = await administrator.request(`/events/${eventId}/modules/seguros`);
    assert.ok(!injectedPage.text.includes(injection));
    assert.match(injectedPage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal((await outsider.post('/login', { login: "' OR 1=1 --", password: 'incorrect' })).location, '/login');
    const forged = new FormData();
    forged.set('label', 'Archivo falso');
    forged.set('file', new Blob([injection], { type: 'image/png' }), 'fake.png');
    const uploadToken = (await producer.request(`/events/${eventId}/modules/seguros`)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    assert.equal((await producer.request(`/events/${eventId}/modules/seguros/entries?_csrf=${uploadToken}`, { method: 'POST', body: forged })).status, 400);
    assert.equal((await db.query('select count(*)::int n from attachments')).rows[0].n, 2);
    const anonymous = session();
    for (const route of ['/admin', '/systems', `/files/${adminFile.id}/view`]) assert.equal((await anonymous.request(route)).location, '/login');
    console.log('PASS PENTEST inyeccion basica SQL/XSS, archivo disfrazado y acceso anonimo');
    await db.query('delete from user_roles where user_id=$1', [other.id]);
    await db.query("insert into user_roles select $1,id from roles where name='GERENCIADORA'", [other.id]);
    assert.equal((await outsider.request(`/events/${eventId}/modules/ticketera`)).status, 403);
    await db.query('insert into event_manager_access(event_id,user_id) values($1,$2)', [eventId, other.id]);
    await outsider.request(`/events/${eventId}/modules/ticketera`);
    assert.equal((await outsider.post(`/events/${eventId}/modules/ticketera/link`, { sales_url: 'javascript:alert(1)' })).status, 400);
    await db.query("insert into ticketing(event_id,sales_url) values($1,'javascript:alert(1)')", [eventId]);
    assert.doesNotMatch((await producer.request(`/events/${eventId}/modules/ticketera`)).text, /href="javascript:/);
    console.log('PASS PENTEST gerenciadora sin asignacion bloqueada; enlaces ejecutables rechazados y no renderizados');
    await administrator.request('/admin/settings');
    const changedAccount = { first_name: 'Prueba', last_name: 'Admin', email: 'changed@example.invalid' };
    assert.equal((await administrator.post('/admin/settings/account', changedAccount)).status, 403);
    assert.equal((await administrator.post('/admin/settings/account', { ...changedAccount, current_password: 'wrong' })).status, 403);
    assert.equal((await db.query('select email from users where id=$1', [admin.id])).rows[0].email, 'admin@example.invalid');
    assert.equal((await administrator.post('/admin/settings/account', { ...changedAccount, current_password: password })).status, 302);
    assert.equal((await administrator.post('/admin/settings/account', { ...changedAccount, email: 'admin@example.invalid', current_password: password })).status, 302);
    await db.query('delete from user_roles where user_id=$1', [other.id]);
    await db.query("insert into user_roles select $1,id from roles where name='SISTEMAS'", [other.id]);
    await outsider.request('/systems');
    assert.equal((await outsider.post(`/systems/backups/${randomUUID()}/restore`, { confirmation: 'RESTAURAR' })).status, 403);
    assert.equal((await db.query('select count(*)::int n from backup_runs')).rows[0].n, 0);
    const replayCookie = outsider.cookie();
    await outsider.post('/logout', {});
    assert.equal((await session().request('/systems', { headers: { cookie: replayCookie } })).location, '/login');
    console.log('PASS PENTEST acciones sensibles exigen clave; restauracion sin clave bloqueada y logout invalida sesion');
    const { createBackup } = require('../src/services/backups');
    const backup = await createBackup({ notify:false });
    const restoreUrl = new URL(scratch); restoreUrl.pathname = `/${restored}`;
    const env = { ...process.env, PGHOST:live.hostname, PGPORT:live.port || '5432', PGUSER:decodeURIComponent(live.username), PGPASSWORD:decodeURIComponent(live.password), PGDATABASE:restored };
    command('pg_restore', ['--exit-on-error','--no-owner','--no-privileges','--dbname',restored,backup.target], { env });
    const restoredPool = new Pool({ connectionString:restoreUrl.toString() });
    try {
      assert.equal((await restoredPool.query('select count(*)::int n from events')).rows[0].n, 1);
      assert.equal((await restoredPool.query('select count(*)::int n from attachments')).rows[0].n, 2);
    } finally { await restoredPool.end(); }
    console.log('PASS backup y restauracion de la base en una segunda base aislada');
    const recovery = require('./recovery-backup');
    const bundle = path.join(directory, 'full-backup.ppr');
    const keyFile = path.join(directory, 'recovery.key');
    const envFile = path.join(directory, 'test.env');
    const staging = path.join(directory, 'staging');
    fs.mkdirSync(staging);
    fs.writeFileSync(keyFile, require('crypto').randomBytes(32).toString('hex'), { mode:0o600 });
    fs.writeFileSync(envFile, 'SESSION_SECRET=test-recovery-only\n', { mode:0o600 });
    await recovery.create({ directory:staging,output:bundle,envFile,keyFile });
    command('sudo', ['-u','postgres','dropdb',restored]);
    command('sudo', ['-u','postgres','createdb','--owner',decodeURIComponent(live.username),restored]);
    const restoreStaging = path.join(directory, 'restore-staging');
    fs.mkdirSync(restoreStaging);
    const recoveredUploads = path.join(directory, 'recovered-uploads');
    const restoredEnv = path.join(directory, 'recovered.env');
    const recoveredCode = path.join(directory, 'recovered-code');
    await recovery.restore({ directory:restoreStaging,input:bundle,keyFile,databaseUrl:restoreUrl.toString(),uploads:recoveredUploads,restoredEnv,code:recoveredCode,confirmation:'RESTAURAR' });
    const recoveredPool = new Pool({ connectionString:restoreUrl.toString() });
    try {
      assert.equal((await recoveredPool.query('select count(*)::int n from events')).rows[0].n, 1);
      const attachments = (await recoveredPool.query('select storage_key from attachments')).rows;
      assert.equal(attachments.length, 2);
      for (const attachment of attachments) {
        assert.deepEqual(fs.readFileSync(path.join(recoveredUploads,attachment.storage_key)), fs.readFileSync(path.join(process.env.STORAGE_PATH,attachment.storage_key)));
      }
      assert.equal(fs.readFileSync(restoredEnv,'utf8'), fs.readFileSync(envFile,'utf8'));
      assert.deepEqual(fs.readFileSync(path.join(recoveredCode,'src/app.js')), fs.readFileSync(path.join(__dirname,'../src/app.js')));
      await assert.rejects(recovery.restore({ directory:restoreStaging,input:bundle,keyFile,databaseUrl:restoreUrl.toString(),uploads:recoveredUploads,restoredEnv,confirmation:'RESTAURAR' }));
    } finally { await recoveredPool.end(); }
    console.log('PASS respaldo cifrado recupera base, adjuntos y configuracion en destinos nuevos');
    const invalidRequest = spawnSync(process.execPath, ['-e', `
      const app=require('./src/app');
      const server=app.listen(0,'127.0.0.1',async()=>{
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/events/not-a-uuid',
          {headers:{cookie:process.env.REVIEW_COOKIE},signal:AbortSignal.timeout(5000)});
        console.log(response.status);server.close(()=>process.exit(0));
      });`], { cwd:path.resolve(__dirname,'..'),env:{...process.env,REVIEW_COOKIE:administrator.cookie()},encoding:'utf8',timeout:8000 });
    assert.equal(invalidRequest.status, 0, 'La solicitud invalida no debe detener el proceso');
    assert.equal(invalidRequest.stdout.trim(), '404');
    assert.equal((await administrator.request('/files/not-a-uuid/download')).status, 400);
    assert.equal((await administrator.request('/health')).status, 200);
    console.log('PASS identificadores invalidos responden sin detener el portal');
    await administrator.request('/admin/users');
    assert.equal((await administrator.post(`/admin/users/${admin.id}/role`, { role: 'PRODUCTOR' })).status, 400);
    assert.equal((await administrator.post(`/admin/users/${admin.id}/status`, { status: 'BLOQUEADO' })).status, 400);
    const attacker = session();
    await administrator.request('/admin/users');
    assert.equal((await producer.post(`/admin/users/${admin.id}/delete`, { confirmation: 'ELIMINAR' })).status, 403);
    assert.equal((await administrator.post(`/admin/users/${admin.id}/delete`, { confirmation: 'ELIMINAR' })).status, 400);
    const producerId = (await db.query("select id from users where email='producer@example.invalid'")).rows[0].id;
    assert.equal((await administrator.request(`/admin/users/${producerId}/delete`)).status, 200);
    assert.equal((await administrator.post(`/admin/users/${producerId}/delete`, { confirmation: 'NO' })).status, 400);
    assert.equal((await administrator.post(`/admin/users/${producerId}/delete`, { confirmation: 'ELIMINAR' })).status, 302);
    assert.equal((await producer.request('/dashboard')).location, '/login');
    assert.equal((await db.query('select count(*)::int n from events')).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from attachments')).rows[0].n, 2);
    assert.doesNotMatch((await administrator.request('/admin/users')).text, /producer@example.invalid/);
    assert.match((await administrator.request('/admin/users?show=disabled')).text, /producer@example.invalid/);
    assert.equal((await administrator.post(`/admin/users/${producerId}/restore`, {})).status, 302);
    assert.equal((await db.query('select status from users where id=$1', [producerId])).rows[0].status, 'PENDIENTE');
    console.log('PASS eliminacion confirmada conserva datos, cierra sesiones y permite restauracion por invitacion');
    assert.equal((await administrator.request('/systems/restore')).status, 403);
    await db.query("insert into user_roles select $1,id from roles where name='SISTEMAS' on conflict do nothing", [admin.id]);
    assert.equal((await administrator.request('/systems/restore')).status, 200);
    const fullStaging = path.join(directory, 'web-restore-snapshot');
    fs.mkdirSync(fullStaging);
    const fullEnv = path.join(directory, 'web-snapshot.env');
    fs.writeFileSync(fullEnv, `SESSION_SECRET=${process.env.SESSION_SECRET}\n`);
    await recovery.create({ directory:fullStaging,output:path.join(directory,'web-snapshot.ppr'),envFile:fullEnv,keyFile });
    const zipKey = 'isolated-restore-test-password-123456';
    const zipFile = path.join(directory, 'web-recovery.zip');
    await require('./complete-backup').writeZip(fullStaging, zipFile, zipKey);
    const submitRestore = async (zipPassword, currentPassword, archive = zipFile) => {
      const page = await administrator.request('/systems/restore');
      const csrf = page.text.match(/\?_csrf=([a-f0-9]+)/)[1];
      const body = new FormData();
      body.set('file', new Blob([fs.readFileSync(archive)]), 'portal-recuperacion.zip');
      body.set('backup_password', zipPassword);
      body.set('current_password', currentPassword);
      body.set('confirmation', 'RESTAURAR');
      return administrator.request(`/systems/restore?_csrf=${csrf}`, { method:'POST',body });
    };
    assert.equal((await submitRestore(zipKey, 'incorrect')).status, 403);
    assert.equal((await submitRestore('incorrect-backup-key-long-enough', password)).status, 400);
    await db.query("update events set name='Cambio posterior al respaldo' where id=$1", [eventId]);
    const restoredFile = (await db.query('select storage_key from attachments where id=$1', [adminFile.id])).rows[0];
    const originalBytes = fs.readFileSync(path.join(process.env.STORAGE_PATH, restoredFile.storage_key));
    fs.writeFileSync(path.join(process.env.STORAGE_PATH, restoredFile.storage_key), 'changed-after-snapshot');
    const badStaging = path.join(directory, 'missing-systems-snapshot');
    fs.cpSync(fullStaging, badStaging, { recursive:true });
    await db.query("delete from user_roles where role_id=(select id from roles where name='SISTEMAS')");
    try {
      command('pg_dump', ['--format=custom','--file',path.join(badStaging,'database.dump')], { env:recovery.pgEnvironment(scratch.toString()) });
    } finally {
      await db.query("insert into user_roles select $1,id from roles where name='SISTEMAS' on conflict do nothing", [admin.id]);
    }
    const badManifest = JSON.parse(fs.readFileSync(path.join(badStaging,'manifest.json')));
    badManifest.hashes['database.dump'] = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(badStaging,'database.dump'))).digest('hex');
    fs.writeFileSync(path.join(badStaging,'manifest.json'),JSON.stringify(badManifest));
    const badZip = path.join(directory,'missing-systems.zip');
    await require('./complete-backup').writeZip(badStaging,badZip,zipKey);
    assert.equal((await submitRestore(zipKey,password,badZip)).status,400);
    assert.equal((await db.query('select name from events where id=$1',[eventId])).rows[0].name,'Cambio posterior al respaldo');
    assert.equal(fs.readFileSync(path.join(process.env.STORAGE_PATH,restoredFile.storage_key),'utf8'),'changed-after-snapshot');
    console.log('PASS rollback de restauracion fallida conserva base, archivos y acceso anterior');
    const fullResponse = await submitRestore(zipKey, password);
    assert.equal(fullResponse.status, 200, fullResponse.text);
    assert.match(fullResponse.text, /Restauración completada/);
    assert.equal((await db.query('select name from events where id=$1', [eventId])).rows[0].name, 'Revision aislada');
    assert.deepEqual(fs.readFileSync(path.join(process.env.STORAGE_PATH, restoredFile.storage_key)), originalBytes);
    assert.equal((await administrator.request('/systems')).location, '/login');
    assert.equal((await administrator.login('admin@example.invalid')).status, 302);
    assert.equal((await administrator.request('/systems')).status, 200);
    console.log('PASS restauracion completa desde formulario: ZIP cifrado, permisos, claves, datos, adjuntos y cierre de sesiones');
    await attacker.request('/login');
    const originalCookie = attacker.cookie();
    assert.equal((await attacker.post('/login', { login: 'admin@example.invalid', password })).status, 302);
    assert.notEqual(attacker.cookie(), originalCookie, 'El login debe rotar la sesion');
    await attacker.request('/login');
    let limited;
    for (let attempt = 0; attempt < 21; attempt++) limited = await attacker.post('/login', { login: 'nonexistent@example.invalid', password: 'incorrect' });
    assert.equal(limited.status, 429);
    assert.equal((await administrator.request('/health')).status, 200);
    console.log('PASS seguridad: CSRF, CSP, limites de login, rotacion de sesion y proteccion de cuenta propia');
    const alerts = require('../src/services/security-alerts');
    const previousMails = outbox.filter(item => item[0] === 'security@example.invalid').length;
    const deliveries = await Promise.all([alerts.flushSecurityAlerts({ force: true }), alerts.flushSecurityAlerts({ force: true })]);
    assert.equal(deliveries.filter(item => item.sent).length, 1, 'Una sola entrega con dos procesos concurrentes');
    const securityMails = outbox.filter(item => item[0] === 'security@example.invalid');
    assert.equal(securityMails.length, previousMails + 1);
    assert.match(securityMails.at(-1)[1], /seguridad/);
    assert.match(securityMails.at(-1)[2], /intentos|ingreso/i);
    assert.equal(securityMails.at(-1)[2].includes(password), false);
    console.log('PASS alertas: cola persistente, resumen, destinatario exclusivo, sin secretos y sin duplicar envios concurrentes (correo simulado)');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.pool.end();
    for (const name of created.reverse()) {
      if (!/^portal_review_[a-f0-9]{32}(_restore)?$/.test(name)) throw new Error('Nombre de limpieza invalido');
      command('sudo', ['-u','postgres','dropdb','--if-exists',name]);
    }
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('portal-review-')) throw new Error('Directorio de limpieza invalido');
    fs.rmSync(resolved, { recursive:true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
