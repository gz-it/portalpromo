const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../src/config');

function run(command, args, cwd = config.git.workdir) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} fallo`);
}

async function main() {
  if (!config.git.branch) throw new Error('GIT_BRANCH no configurado');
  run(process.execPath, [path.join(config.root, 'scripts', 'backup.js')]);
  run('git', ['fetch', '--all', '--prune']);
  run('git', ['checkout', config.git.branch]);
  run('git', ['pull', '--ff-only']);
  const lock = fs.existsSync(path.join(config.git.workdir, 'pnpm-lock.yaml'));
  run(lock ? config.npmBin : 'npm', lock ? ['install', '--prod=false'] : ['install']);
  run(lock ? config.npmBin : 'npm', lock ? ['run', 'migrate'] : ['run', 'migrate']);
  console.log('Actualizacion completada. Reinicie el proceso Node mediante systemd/pm2 y verifique /health.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
