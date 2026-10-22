// One-time OAuth helper. Never prints client secrets, authorization codes or tokens.
const fs = require('node:fs');
const { spawn } = require('node:child_process');

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Ejecutar como root');
  process.umask(0o077);
  const file = '/etc/portalpromo-drive.json';
  if (fs.existsSync(file)) throw new Error('Drive ya tiene una autorizacion; no se sobrescribe');
  const client = JSON.parse(fs.readFileSync('/root/portalpromo-drive-client.json', 'utf8')).installed;
  const child = spawn('rclone', ['authorize', 'drive', '--auth-no-open-browser', '--drive-scope', 'drive.file'], {
    env: { ...process.env, RCLONE_DRIVE_CLIENT_ID: client.client_id, RCLONE_DRIVE_CLIENT_SECRET: client.client_secret, RCLONE_DRIVE_SCOPE: 'drive.file' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const timer = setTimeout(() => child.kill(), 15 * 60 * 1000);
  const collect = chunk => {
    const text = chunk.toString();
    const link = text.match(/http:\/\/127\.0\.0\.1:53682\/auth\?state=[^\s]+/);
    if (link) fs.writeFileSync('/root/portal-drive-auth-url.txt', link[0], { mode: 0o600 });
  };
  child.stdout.on('data', chunk => { output += chunk.toString(); collect(chunk); });
  child.stderr.on('data', collect);
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('No se completo la autorizacion de Google')));
  }).finally(() => clearTimeout(timer));
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  const token = JSON.parse(output.slice(start, end + 1));
  if (!token.access_token || !token.refresh_token) throw new Error('Google no entrego una autorizacion permanente');
  const response = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error('No se pudo comprobar la cuenta autorizada');
  const user = (await response.json()).user;
  if (user.emailAddress?.toLowerCase() !== 'productores@estadiohuracan.com') throw new Error('La cuenta autorizada no es productores');
  fs.writeFileSync(file, JSON.stringify({ accountEmail:user.emailAddress, clientId:client.client_id, clientSecret:client.client_secret, refreshToken:token.refresh_token, authorizedAt:new Date().toISOString() }, null, 2), { flag:'wx',mode:0o600 });
  fs.rmSync('/root/portal-drive-auth-url.txt', { force:true });
  console.log('DRIVE_AUTHORIZED_PRODUCTORES');
}

main().catch(() => { console.error('No se completo la autorizacion de Drive. Revise la cuenta o intente nuevamente.'); process.exitCode = 1; });
