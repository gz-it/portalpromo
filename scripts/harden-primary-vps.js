// Run only on the dedicated production VPS after reviewing its current services.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function run(bin, args) { return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Root Linux required');
  if (!run('/usr/sbin/ip', ['-4', 'addr', 'show']).includes('149.50.151.139/')) throw new Error('Not the authorized dedicated VPS');
  process.umask(0o077);
  const root = path.resolve(__dirname, '..');
  const backup = `/root/portal-security-${Date.now()}`;
  fs.mkdirSync(backup, { mode: 0o700 });
  for (const file of ['/etc/clamav/clamd.conf', '/etc/portalpromo.env', '/etc/ufw/user.rules', '/etc/ufw/user6.rules']) {
    fs.copyFileSync(file, path.join(backup, file.replaceAll('/', '_')));
  }
  const file = '/etc/clamav/clamd.conf';
  let content = fs.readFileSync(file, 'utf8');
  for (const [key, value] of Object.entries({ LocalSocketMode:'660', MaxThreads:'2', MaxQueue:'8', MaxScanSize:'512M', MaxFileSize:'200M', StreamMaxLength:'200M', AlertExceedsMax:'true', AlertEncrypted:'true' })) {
    const pattern = new RegExp(`^${key}\\s+.*$`, 'm');
    content = pattern.test(content) ? content.replace(pattern, `${key} ${value}`) : `${content}\n${key} ${value}\n`;
  }
  fs.writeFileSync(file, content, { mode: 0o644 });
  const dropin = '/etc/systemd/system/portalpromo.service.d';
  fs.mkdirSync(dropin, { recursive: true });
  fs.copyFileSync(path.join(root, 'deploy/portalpromo-security.conf'), path.join(dropin, 'security.conf'));
  fs.copyFileSync(path.join(root, 'deploy/52portal-security-upgrades'), '/etc/apt/apt.conf.d/52portal-security-upgrades');
  run('/usr/bin/systemctl', ['disable', '--now', 'postfix', 'snmpd']);
  // Remove only the blanket bypass; existing HTTP(S) and SSH allow rules remain.
  const rules = run('/usr/sbin/ufw', ['status']);
  if (/Anywhere\s+ALLOW(?: IN)?\s+200\.58\.112\.191/.test(rules)) run('/usr/sbin/ufw', ['--force', 'delete', 'allow', 'from', '200.58.112.191']);
  run('/usr/bin/systemctl', ['enable', '--now', 'unattended-upgrades', 'clamav-freshclam']);
  run('/usr/bin/systemctl', ['daemon-reload']);
  run('/usr/bin/systemctl', ['restart', 'clamav-daemon']);
  // Enable the gate only after the installed daemon accepts a clean file.
  run('/usr/bin/clamdscan', ['--fdpass', '--no-summary', '/etc/hostname']);
  const env = '/etc/portalpromo.env';
  const current = fs.readFileSync(env, 'utf8');
  fs.writeFileSync(env, current.replace(/^UPLOAD_ANTIVIRUS=.*\n?/gm, '') + '\nUPLOAD_ANTIVIRUS=true\n', { mode: 0o600 });
  run('/usr/bin/systemctl', ['restart', 'portalpromo']);
  console.log(JSON.stringify({ applied: true, rollbackDirectory: backup, sshUnchanged: true }));
}
if (require.main === module) { try { main(); } catch (error) { console.error('Hardening stopped:', error.status || error.message); process.exitCode = 1; } }
