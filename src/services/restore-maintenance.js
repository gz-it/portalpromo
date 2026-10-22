const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const marker = path.join(config.backupPath, '.restore-in-progress');
let busy = fs.existsSync(marker);
let requests = 0;

function middleware(req, res, next) {
  if (busy) return res.status(503).set('Retry-After', '30').send('Portal en mantenimiento por restauracion. Intente nuevamente en unos minutos.');
  requests++;
  let finished = false;
  const release = () => { if (!finished) { finished = true; requests--; } };
  res.once('finish', release);
  res.once('close', release);
  next();
}

async function acquire() {
  if (busy) throw new Error('Ya hay una restauracion en curso');
  fs.writeFileSync(marker, JSON.stringify({ startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
  busy = true;
  const deadline = Date.now() + 15000;
  while (requests > 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (requests > 1) { fs.unlinkSync(marker); busy = false; throw new Error('Hay solicitudes en curso. Intente nuevamente.'); }
  return () => { fs.unlinkSync(marker); busy = false; };
}

module.exports = { middleware, acquire, isRestoring: () => busy };
