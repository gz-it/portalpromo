const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Pool } = require('pg');

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { env, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} no pudo completar la operacion`);
  return result.stdout.trim();
}

function pgEnvironment(url) {
  const parsed = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('DATABASE_URL invalida');
  return { ...process.env, PGHOST: parsed.hostname, PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username), PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)) };
}

function readKey(file) {
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Clave de recuperacion invalida');
  return Buffer.from(key, 'hex');
}

async function fileHash(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function encrypt(source, target, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  fs.writeFileSync(target, Buffer.concat([Buffer.from('PPR1'), iv]), { mode: 0o600, flag: 'wx' });
  await pipeline(fs.createReadStream(source), cipher, fs.createWriteStream(target, { flags: 'a', mode: 0o600 }));
  fs.appendFileSync(target, cipher.getAuthTag());
}

async function decrypt(source, target, key) {
  const length = fs.statSync(source).size;
  if (length < 33) throw new Error('Respaldo incompleto');
  const fd = fs.openSync(source, 'r');
  const header = Buffer.alloc(16), tag = Buffer.alloc(16);
  try {
    fs.readSync(fd, header, 0, 16, 0);
    fs.readSync(fd, tag, 0, 16, length - 16);
  } finally { fs.closeSync(fd); }
  if (header.subarray(0, 4).toString() !== 'PPR1') throw new Error('Formato de respaldo desconocido');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(4));
  decipher.setAuthTag(tag);
  await pipeline(fs.createReadStream(source, { start: 16, end: length - 17 }), decipher,
    fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}

async function create({ directory, output, envFile, keyFile }) {
  const config = require('../src/config');
  if (!config.databaseUrl || !envFile) throw new Error('Falta la base o el archivo de configuracion');
  if (fs.existsSync(output)) throw new Error('El respaldo de destino ya existe');
  fs.mkdirSync(path.join(directory, 'uploads'));
  // Copy immutable uploads first; verify every database reference after the dump.
  fs.cpSync(config.storagePath, path.join(directory, 'uploads'), { recursive: true, dereference: true });
  run(config.pgDumpBin, ['--format=custom', '--file', path.join(directory, 'database.dump')], pgEnvironment(config.databaseUrl));
  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const files = (await pool.query('select storage_key,size_bytes from attachments')).rows;
    for (const file of files) {
      const target = path.resolve(directory, 'uploads', file.storage_key);
      if (!target.startsWith(path.join(directory, 'uploads') + path.sep) || !fs.existsSync(target)
          || fs.statSync(target).size !== Number(file.size_bytes)) {
        throw new Error('Hubo cambios en los adjuntos durante el respaldo; repita con el portal detenido');
      }
    }
  } finally { await pool.end(); }
  fs.copyFileSync(envFile, path.join(directory, 'portal.env'));
  fs.chmodSync(path.join(directory, 'portal.env'), 0o600);
  const version = fs.readFileSync(path.join(config.root, 'VERSION'), 'utf8').trim();
  const revision = run('git', ['-c', `safe.directory=${config.root}`, '-C', config.root, 'rev-parse', 'HEAD']);
  const code = path.join(directory, 'code');
  fs.mkdirSync(code);
  for (const name of ['src', 'scripts', 'migrations', 'nginx', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'VERSION', 'README.md', '.env.example']) {
    const source = path.join(config.root, name);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(code, name), { recursive: true });
  }
  const hashes = {};
  async function hashFiles(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await hashFiles(file);
      else hashes[path.relative(directory, file).split(path.sep).join('/')] = await fileHash(file);
    }
  }
  await hashFiles(directory);
  fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ format: 1, version, revision, createdAt: new Date().toISOString(), hashes }, null, 2));
  const archive = path.join(directory, '..', `${path.basename(directory)}.tar.gz`);
  try {
    run('tar', ['-czf', archive, '-C', directory, '.']);
    await encrypt(archive, output, readKey(keyFile));
  } catch (error) {
    if (fs.existsSync(output)) fs.unlinkSync(output);
    throw error;
  } finally { if (fs.existsSync(archive)) fs.unlinkSync(archive); }
  return { output, version, revision };
}

async function unpack({ directory, input, keyFile }) {
  const archive = path.join(directory, 'bundle.tar.gz');
  await decrypt(input, archive, readKey(keyFile));
  // Authentication is checked before extracting anything from the archive.
  run('tar', ['-xzf', archive, '-C', directory, '--no-same-owner', '--no-same-permissions']);
  fs.unlinkSync(archive);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1) throw new Error('Version de respaldo no soportada');
  for (const [name, hash] of Object.entries(manifest.hashes)) {
    const file = path.resolve(directory, name);
    if (!file.startsWith(directory + path.sep) || await fileHash(file) !== hash) {
      throw new Error('El respaldo no supera la verificacion de integridad');
    }
  }
  return manifest;
}

async function restore({ directory, input, keyFile, databaseUrl, uploads, restoredEnv, code, confirmation }) {
  if (confirmation !== 'RESTAURAR' || !databaseUrl || !uploads || !restoredEnv) throw new Error('Faltan destinos o confirmacion RESTAURAR');
  if (fs.existsSync(restoredEnv) || (fs.existsSync(uploads) && fs.readdirSync(uploads).length)) throw new Error('Los destinos deben estar vacios');
  if (code && fs.existsSync(code) && fs.readdirSync(code).length) throw new Error('El destino de codigo debe estar vacio');
  const manifest = await unpack({ directory, input, keyFile });
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const tables = await pool.query("select 1 from pg_tables where schemaname not in ('pg_catalog','information_schema') limit 1");
    if (tables.rowCount) throw new Error('La base de destino debe estar vacia; no se sobrescriben datos');
  } finally { await pool.end(); }
  run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--single-transaction', '--exit-on-error', '--no-owner', '--no-privileges',
    '--dbname', pgEnvironment(databaseUrl).PGDATABASE, path.join(directory, 'database.dump')], pgEnvironment(databaseUrl));
  fs.cpSync(path.join(directory, 'uploads'), uploads, { recursive: true });
  fs.copyFileSync(path.join(directory, 'portal.env'), restoredEnv, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(restoredEnv, 0o600);
  if (code) fs.cpSync(path.join(directory, 'code'), code, { recursive: true });
  return manifest;
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Esta herramienta de recuperacion se ejecuta en Linux');
  const [operation, ...args] = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || !args[i + 1]) throw new Error('Argumentos invalidos');
    flags[args[i].slice(2)] = args[i + 1];
  }
  const options = { envFile: flags.env, keyFile: flags.key, input: flags.input, output: flags.output,
    databaseUrl: process.env.RESTORE_DATABASE_URL, uploads: flags.uploads, restoredEnv: flags['restored-env'], code: flags.code, confirmation: flags.confirm };
  process.umask(0o077);
  if (operation === 'key') {
    fs.writeFileSync(options.keyFile, crypto.randomBytes(32).toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
    console.log('Clave creada; conserve una copia fuera del VPS.');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-recovery-'));
  try {
    options.directory = directory;
    let result;
    if (operation === 'create') result = await create(options);
    else if (operation === 'verify') result = await unpack(options);
    else if (operation === 'restore') result = await restore(options);
    else throw new Error('Operacion invalida: key, create, verify o restore');
    console.log(JSON.stringify({ ok: true, operation, version: result.version, revision: result.revision, output: result.output }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { encrypt, decrypt, pgEnvironment, create, unpack, restore };
