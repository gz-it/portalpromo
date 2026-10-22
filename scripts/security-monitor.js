const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { queueAlert, flushSecurityAlerts } = require('../src/services/security-alerts');
const config = require('../src/config');
const DIRECTORY = '/var/lib/portalpromo-security';

function run(bin, args) {
  try { return { ok: true, output: execFileSync(bin, args, { encoding: 'utf8', timeout: 20000, maxBuffer: 2 * 1024 ** 2, stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch { return { ok: false, output: '' }; }
}

function healthChanges(previous, checks) {
  return Object.entries(checks).filter(([key, value]) => (previous[key] !== undefined || value !== 'correcto') && previous[key] !== value)
    .map(([component, state]) => ({ kind: state === 'correcto' ? 'HEALTH_RECOVERED' : 'HEALTH_FAILED', details: { component, state } }));
}

function firewallHealthy(results) {
  return results.length === 2 && results.every(result => result.ok && /policy drop;/.test(result.output)
    && /jump ufw6?-before-input/.test(result.output) && !/\baccept\b/.test(result.output));
}

function save(state) {
  const temporary = path.join(DIRECTORY, 'state.tmp');
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, path.join(DIRECTORY, 'state.json'));
}

async function main() {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('Requiere root Linux');
  if (!config.securityAlertsEmail) throw new Error('Falta el destinatario de seguridad');
  fs.mkdirSync(DIRECTORY, { mode: 0o700, recursive: true });
  const info = fs.lstatSync(DIRECTORY);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077)) throw new Error('Directorio del monitor no seguro');
  const filename = path.join(DIRECTORY, 'state.json');
  const state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
  state.pending ||= [];
  state.checks ||= {};
  const checks = {};
  for (const service of ['portalpromo', 'nginx', 'postgresql@16-main', 'fail2ban', 'clamav-daemon', 'clamav-freshclam', 'unattended-upgrades']) {
    checks[service] = run('/usr/bin/systemctl', ['is-active', '--quiet', service]).ok ? 'correcto' : 'inactivo';
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/health`, { signal: AbortSignal.timeout(5000) });
      checks.respuesta_portal = response.ok ? 'correcto' : 'respuesta de error';
      await response.body?.cancel();
    } catch { checks.respuesta_portal = 'no responde'; }
    if (checks.respuesta_portal === 'correcto') break;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  // Read nftables directly: `ufw status` needs a writable /run lock even for reads.
  const firewall = ['ip', 'ip6'].map(family => run('/usr/sbin/nft', ['list', 'chain', family, 'filter', 'INPUT']));
  checks.firewall = firewallHealthy(firewall) ? 'correcto' : 'no confirmado';
  const disk = fs.statfsSync(config.storagePath);
  const used = 100 * (1 - Number(disk.bavail) / Number(disk.blocks));
  checks.disco = used >= 85 ? 'espacio libre menor al 15%' : 'correcto';
  const cert = '/etc/letsencrypt/live/portalproductores.estadiohuracan.com/fullchain.pem';
  checks.certificado = run('/usr/bin/openssl', ['x509', '-checkend', String(14 * 86400), '-noout', '-in', cert]).ok ? 'correcto' : 'vence en menos de 14 dias o no se pudo verificar';
  const signatures = ['/var/lib/clamav/daily.cld', '/var/lib/clamav/daily.cvd'].filter(file => fs.existsSync(file));
  checks.firmas_antivirus = signatures.some(file => Date.now() - fs.statSync(file).mtimeMs < 3 * 86400000) ? 'correcto' : 'firmas sin actualizar hace mas de 3 dias';
  state.pending.push(...healthChanges(state.checks, checks));
  state.checks = checks;
  const until = new Date().toISOString();
  const since = state.lastJournalAt || new Date(Date.now() - 5 * 60000).toISOString();
  const ssh = run('/usr/bin/journalctl', ['-t', 'sshd', '--since', since, '--until', until, '--no-pager', '-o', 'cat']);
  const bans = run('/usr/bin/journalctl', ['-u', 'fail2ban', '--since', since, '--until', until, '--no-pager', '-o', 'cat']);
  const failures = ssh.output.split('\n').filter(line => /Failed password|Invalid user/.test(line)).length;
  const blocked = bans.output.split('\n').filter(line => /\bBan\s+[\da-f:.]+\s*$/i.test(line)).length;
  if (failures) state.pending.push({ kind: 'SSH_FAILED', count: failures, details: {} });
  if (blocked) state.pending.push({ kind: 'SSH_BLOCKED', count: blocked, details: {} });
  state.sshSources ||= [];
  for (const line of ssh.output.split('\n')) {
    const match = line.match(/Accepted (?:password|publickey) for \S+ from ([\da-f:.]+) port/i);
    if (match && net.isIP(match[1]) && !state.sshSources.includes(match[1])) {
      state.sshSources.push(match[1]);
      state.pending.push({ kind: 'SSH_NEW_IP', details: { ip: match[1] } });
    }
  }
  state.sshSources = state.sshSources.slice(-64);
  // A failed journal read keeps its cursor for retry instead of silently skipping records.
  if (ssh.ok && bans.ok) state.lastJournalAt = until;
  if (!ssh.ok || !bans.ok) state.pending.push({ kind: 'HEALTH_FAILED', details: { component: 'lectura de registros SSH/Fail2ban', state: 'no confirmada' } });
  // Keep transitions locally when PostgreSQL or SMTP is unavailable.
  save(state);
  while (state.pending.length) {
    const item = state.pending[0];
    await queueAlert(item.kind, item.details, item.count || 1);
    state.pending.shift();
    save(state);
  }
  const result = await flushSecurityAlerts();
  console.log(JSON.stringify({ checked: true, controls: Object.keys(checks).length, issues: Object.values(checks).filter(value => value !== 'correcto').length, ...result }));
}

if (require.main === module) main().catch(() => { console.error('El monitor de seguridad requiere revision; se conserva su cola local.'); process.exitCode = 1; }).finally(() => require('../src/db').pool.end());
module.exports = { healthChanges, firewallHealthy };
