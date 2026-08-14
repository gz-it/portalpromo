const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('../src/config');

async function main() {
  fs.mkdirSync(config.backupPath, { recursive: true });
  const filename = `portal-${new Date().toISOString().replace(/[:.]/g, '-')}.dump`;
  const target = path.join(config.backupPath, filename);
  await new Promise((resolve, reject) => {
    const child = spawn(config.pgDumpBin, ['--format=custom', '--file', target, config.databaseUrl], { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`pg_dump finalizo con codigo ${code}`)));
  });
  console.log(target);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
