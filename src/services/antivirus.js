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

function scannedUpload(middleware, enabled, scan = scanFile) {
  return (req, res, next) => middleware(req, res, error => {
    const finish = async () => {
      if (error) throw error;
      if (enabled && req.file) await scan(req.file.path);
    };
    finish().then(() => next(), async failure => {
      if (req.file?.path) await fs.unlink(req.file.path).catch(() => {});
      next(failure);
    });
  });
}

module.exports = { scanFile, scannedUpload };
