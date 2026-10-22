const { parentPort, workerData } = require('node:worker_threads');
const { parseStaffWorkbook } = require('./excel');
parseStaffWorkbook(workerData).then(result => parentPort.postMessage({ ok: true, result }),
  () => parentPort.postMessage({ ok: false }));
