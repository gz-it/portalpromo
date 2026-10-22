const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CONFIG = '/etc/portalpromo-drive.json';
const READERS = ['booking@estadiohuracan.com', 'gestion@gzit.com.ar'];
const RETENTION_DAYS = 30;
const FOLDER = 'application/vnd.google-apps.folder';

function assertNoLinks(directory) {
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error('No se admiten enlaces ni archivos especiales en los datos del respaldo');
  if (info.isDirectory()) for (const name of fs.readdirSync(directory)) assertNoLinks(path.join(directory,name));
}

function expiredRuns(files, root, now = Date.now()) {
  return files.filter(file => file.mimeType === FOLDER && file.parents?.includes(root)
    && file.appProperties?.portalBackupRun === '1' && file.appProperties?.completed === 'true'
    && !file.trashed && Number.isFinite(Date.parse(file.createdTime))
    && Date.parse(file.createdTime) < now - RETENTION_DAYS * 86400000);
}

function assertPrivate(permissions) {
  if (permissions.some(item => ['anyone', 'domain', 'group'].includes(item.type))) throw new Error('La carpeta tiene acceso publico, de dominio o de grupo. Revise los permisos.');
}

async function hashFile(file, algorithm = 'sha256') {
  const digest = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

class Drive {
  constructor(token) { this.token = token; }
  async request(route, { method = 'GET', body } = {}) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/${route}`, {
      method, headers: { Authorization:`Bearer ${this.token}`, 'Content-Type':'application/json' },
      ...(body !== undefined ? { body:JSON.stringify(body) } : {}), signal:AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Drive no completo la operacion (HTTP ${response.status})`);
    return response.status === 204 ? null : response.json();
  }
  async list(route, key) {
    const result = [];
    let cursor;
    do {
      const page = await this.request(route + (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''));
      result.push(...(page[key] || [])); cursor = page.nextPageToken;
    } while (cursor);
    return result;
  }
  async permissions(id) {
    return this.list(`files/${id}/permissions?fields=nextPageToken,permissions(id,type,role,emailAddress)&pageSize=100`, 'permissions');
  }
  async upload(file, parent) {
    const size = fs.statSync(file).size;
    const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,webViewLink', {
      method:'POST', headers:{ Authorization:`Bearer ${this.token}`, 'Content-Type':'application/json', 'X-Upload-Content-Type':'application/zip', 'X-Upload-Content-Length':String(size) },
      body:JSON.stringify({ name:path.basename(file), parents:[parent], appProperties:{ portalBackupFile:'1' } }), signal:AbortSignal.timeout(30000),
    });
    if (!init.ok) throw new Error(`Drive no inicio la subida (HTTP ${init.status})`);
    const location = new URL(init.headers.get('location'));
    if (location.protocol !== 'https:' || location.hostname !== 'www.googleapis.com') throw new Error('Destino de subida inesperado');
    const response = await fetch(location, { method:'PUT', headers:{ Authorization:`Bearer ${this.token}`, 'Content-Type':'application/zip', 'Content-Length':String(size) }, body:fs.createReadStream(file), duplex:'half', signal:AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`Drive no termino la subida (HTTP ${response.status})`);
    const stored = await response.json();
    if (Number(stored.size) !== size || stored.md5Checksum !== await hashFile(file, 'md5')) throw new Error('La copia de Drive no coincide con el archivo local');
    // Read back the uploaded bytes, not only metadata returned by the upload.
    const download = await fetch(`https://www.googleapis.com/drive/v3/files/${stored.id}?alt=media`, { headers:{ Authorization:`Bearer ${this.token}` }, signal:AbortSignal.timeout(600000) });
    if (!download.ok) throw new Error('No se pudo releer el respaldo subido');
    const hash = crypto.createHash('sha256');
    for await (const chunk of download.body) hash.update(chunk);
    if (hash.digest('hex') !== await hashFile(file)) throw new Error('El respaldo descargado de Drive no coincide');
    return stored;
  }
}

async function connect(settings) {
  const response = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{ 'Content-Type':'application/x-www-form-urlencoded' }, body:new URLSearchParams({ client_id:settings.clientId,client_secret:settings.clientSecret,refresh_token:settings.refreshToken,grant_type:'refresh_token' }), signal:AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Google rechazo la autorizacion; vuelva a conectar Drive');
  const token = await response.json();
  const drive = new Drive(token.access_token);
  const about = await drive.request('about?fields=user,storageQuota');
  if (about.user.emailAddress?.toLowerCase() !== 'productores@estadiohuracan.com') throw new Error('La cuenta de Drive no es la esperada');
  return drive;
}

async function prepareFolder(drive, settings) {
  if (!settings.folderId) {
    const created = await drive.request('files?fields=id,webViewLink', { method:'POST',body:{ name:'Respaldos Portal de Productores',mimeType:FOLDER,appProperties:{portalBackupsRoot:'1'},copyRequiresWriterPermission:false } });
    settings.folderId = created.id; settings.folderUrl = created.webViewLink;
    const temporary = CONFIG + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(settings,null,2), { flag:'wx',mode:0o600 });
    fs.renameSync(temporary, CONFIG);
  }
  const folder = await drive.request(`files/${settings.folderId}?fields=id,name,mimeType,ownedByMe,trashed,appProperties,webViewLink`);
  if (folder.mimeType !== FOLDER || !folder.ownedByMe || folder.trashed || folder.appProperties?.portalBackupsRoot !== '1') throw new Error('La carpeta de respaldos no es valida');
  let permissions = await drive.permissions(folder.id);
  assertPrivate(permissions);
  for (const email of READERS) {
    const existing = permissions.find(item => item.emailAddress?.toLowerCase() === email);
    if (!existing) await drive.request(`files/${folder.id}/permissions?sendNotificationEmail=true&fields=id`, { method:'POST',body:{type:'user',role:'reader',emailAddress:email} });
    else if (existing.role !== 'reader') throw new Error(`Revise el permiso de ${email}; debe ser lector`);
  }
  permissions = await drive.permissions(folder.id);
  assertPrivate(permissions);
  if (permissions.some(item => item.type === 'user' && !['productores@estadiohuracan.com', ...READERS].includes(item.emailAddress?.toLowerCase()))) throw new Error('La carpeta tiene usuarios adicionales; revise los permisos antes de subir respaldos');
  for (const email of READERS) if (!permissions.some(item => item.emailAddress?.toLowerCase() === email && item.role === 'reader')) throw new Error('No se pudieron comprobar los lectores');
  return folder;
}

function command(program, args, input) {
  const result = spawnSync(program, args, { encoding:'utf8',timeout:900000,input,maxBuffer:2*1024*1024 });
  if (result.error || result.status !== 0) throw new Error('Fallo la generacion o verificacion local del respaldo');
  return result.stdout.trim();
}

async function publicStatus(status, folderUrl = '', detail = '') {
  const db = require('../src/db');
  const now = new Date().toISOString();
  const values = { drive_backup_status:status,drive_backup_folder_url:folderUrl,drive_backup_detail:detail,drive_backup_updated_at:now };
  if (status === 'SUCCESS' || status === 'SUCCESS_MAIL_WARNING') values.drive_backup_last_success_at = now;
  for (const [key,value] of Object.entries(values)) {
    await db.query('insert into system_settings(key,value) values($1,$2) on conflict(key) do update set value=$2,updated_at=now()', [key,value]);
  }
}

async function notify(ok, folderUrl) {
  const { sendMail } = require('../src/utils/email');
  const results = await Promise.allSettled(READERS.map(email => sendMail(email, ok ? 'Respaldos completos en Drive - Correcto' : 'Alerta: fallo el respaldo completo en Drive', ok
    ? `Se generaron y verificaron los dos respaldos: recuperacion del sistema y consulta de datos/documentos.\nConservacion: 30 dias.\nCarpeta privada: ${folderUrl}\nLa clave se conserva aparte. No se adjunta en este correo.`
    : 'No se completo el respaldo de Drive. Se conservaron las copias anteriores. Sistemas debe revisar el resultado. El backup de base por correo funciona de forma independiente.')));
  return results.every(item => item.status === 'fulfilled' && item.value !== false);
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Ejecutar como root');
  process.umask(0o077);
  const config = require('../src/config');
  let settings = {};
  let folder;
  try {
    try { settings = JSON.parse(fs.readFileSync(CONFIG,'utf8')); }
    catch { throw new Error('Falta o es invalida la configuracion de Drive'); }
    const drive = await connect(settings);
    folder = await prepareFolder(drive, settings);
    if (process.argv.includes('--setup')) {
      await publicStatus('CONNECTED', folder.webViewLink, 'Cuenta productores; lectores Booking y Gestion. Retencion 30 dias.');
      console.log(JSON.stringify({connected:true,folderUrl:folder.webViewLink,readers:READERS,retentionDays:RETENTION_DAYS}));
      return;
    }
    if (fs.existsSync(path.join(config.backupPath,'.restore-in-progress'))) throw new Error('El portal esta en restauracion');
    assertNoLinks(config.storagePath);
    const local = '/var/backups/portalpromo-drive';
    fs.mkdirSync(local,{recursive:true,mode:0o700});
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const output = path.join(local,`portal-${stamp}.zip`);
    const report = JSON.parse(command(process.execPath,['-r','dotenv/config',path.join(config.root,'scripts/complete-backup.js'),output,'/etc/portalpromo-recovery.key','/etc/portalpromo-backup-zip.key']));
    const python = process.env.RESTORE_PYTHON || '/opt/portal-backup-tools/verify-env/bin/python';
    command(python,[path.join(config.root,'scripts/verify-complete-zip.py'),report.output,'/etc/portalpromo-backup-zip.key']);
    const verify = fs.mkdtempSync(path.join(local,'verify-'));
    try { command(python,[path.join(config.root,'scripts/unpack-recovery-zip.py'),report.recoveryOutput,verify],JSON.stringify({password:fs.readFileSync('/etc/portalpromo-backup-zip.key','utf8').trim()})); }
    finally { fs.rmSync(verify,{recursive:true,force:true}); }
    const run = await drive.request('files?fields=id,webViewLink',{method:'POST',body:{name:`Respaldo ${stamp}`,mimeType:FOLDER,parents:[folder.id],appProperties:{portalBackupRun:'1',completed:'false'}}});
    const uploads = [];
    for (const file of [report.output, report.recoveryOutput]) uploads.push(await drive.upload(file,run.id));
    await drive.request(`files/${run.id}?fields=id`,{method:'PATCH',body:{appProperties:{portalBackupRun:'1',completed:'true'}}});
    const query = encodeURIComponent(`'${folder.id}' in parents and trashed = false`);
    const files = await drive.list(`files?q=${query}&pageSize=100&fields=nextPageToken,files(id,mimeType,parents,appProperties,createdTime,trashed)`,'files');
    const expired = expiredRuns(files,folder.id);
    // Recoverable trash only; never permanently deletes or touches unrelated Drive files.
    for (const file of expired) await drive.request(`files/${file.id}?fields=id`,{method:'PATCH',body:{trashed:true}});
    for (const name of fs.readdirSync(local)) {
      const file = path.join(local,name);
      if (/^portal-\d{4}-\d{2}-\d{2}T[\dTZ-]+(?:-recuperacion)?\.zip$/.test(name) && fs.statSync(file).mtimeMs < Date.now()-RETENTION_DAYS*86400000) fs.unlinkSync(file);
    }
    await publicStatus('SUCCESS',folder.webViewLink,'Dos ZIP subidos y releidos con SHA-256 correcto. Retencion 30 dias.');
    const notified = await notify(true,folder.webViewLink);
    console.log(JSON.stringify({ok:true,folderUrl:folder.webViewLink,files:uploads.map(item=>({name:item.name,size:item.size})),expiredMovedToTrash:expired.length,notified}));
    if (!notified) await publicStatus('SUCCESS_MAIL_WARNING',folder.webViewLink,'Respaldo correcto; no se pudieron enviar todos los avisos.');
  } catch (error) {
    await publicStatus('FAILED',folder?.webViewLink || settings.folderUrl || '',error.message).catch(()=>{});
    await notify(false).catch(()=>{});
    throw error;
  } finally { await require('../src/db').pool.end(); }
}

if (require.main === module) main().catch(error=>{ console.error(error.message);process.exitCode=1; });
module.exports = { expiredRuns, assertPrivate, assertNoLinks, Drive };
