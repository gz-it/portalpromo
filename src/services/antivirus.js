const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');

function scanFile(file, execute = execFile) {
  return new Promise((resolve, reject) => {
    execute('/usr/bin/clamdscan', ['--fdpass', '--no-summary', '--', file],
      { timeout: 120000, maxBuffer: 16384, windowsHide: true }, error => {
        if (!error) return resolve();
        const infected = error.code === 1;
        reject(Object.assign(new Error(infected ? 'Archivo rechazado por seguridad.' : 'El antivirus no esta disponible. Intente mas tarde.'),
          { status: infected ? 400 : 503, code: infected ? 'UPLOAD_INFECTED' : 'SCAN_UNAVAILABLE' }));
      });
  });
}

let activeUploads = 0;
const owners = new Map();

function reservedUploadBytes(maxFileBytes) { return activeUploads * maxFileBytes; }

function scannedUpload(middleware, enabled, scan = scanFile) {
  return (req, res, next) => {
    const owner = req.user?.id || req.ip || 'anonymous';
    if (activeUploads >= 8 || (owners.get(owner) || 0) >= 2) return next(Object.assign(new Error('Demasiadas cargas simultaneas.'), { status: 429 }));
    activeUploads++;
    owners.set(owner, (owners.get(owner) || 0) + 1);
    let released = false;
    let closed = false;
    const release = () => {
      if (released) return;
      released = true;
      activeUploads--;
      const remaining = owners.get(owner) - 1;
      remaining ? owners.set(owner, remaining) : owners.delete(owner);
    };
    const discard = () => {
      closed = true;
      release();
      if (req.file) {
        req.file.discarded = true;
        if (!req.file.retained && !req.file.saving) fs.unlink(req.file.path).catch(() => {});
      }
    };
    res.once?.('finish', discard);
    res.once?.('close', discard);
    const complete = error => {
      const finish = async () => {
        if (error) throw error;
        if (closed) { discard(); return; }
        if (enabled && req.file) await scan(req.file.path);
      };
      finish().then(() => {
        if (closed) { discard(); return; }
        if (!res.once) release();
        next();
      }, async failure => {
        release();
        if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
        if (closed) return;
        if (['UPLOAD_INFECTED', 'SCAN_UNAVAILABLE'].includes(failure.code)) {
          await require('./security-alerts').safelyQueue(failure.code, { actorId: req.user?.id, ip: req.ip });
        }
        next(failure);
      });
    };
    try { middleware(req, res, complete); }
    catch (error) { complete(error); }
  };
}

module.exports = { scanFile, scannedUpload, reservedUploadBytes };
