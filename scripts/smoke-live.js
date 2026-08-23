const assert = require('node:assert/strict');

const baseUrl = process.env.SMOKE_BASE_URL;
const login = process.env.SMOKE_SYSTEMS_LOGIN;
const password = process.env.SMOKE_SYSTEMS_PASSWORD;

if (!baseUrl || !login || !password) {
  throw new Error('Configure SMOKE_BASE_URL, SMOKE_SYSTEMS_LOGIN y SMOKE_SYSTEMS_PASSWORD.');
}

const cookies = new Map();

function absorbCookies(response) {
  const values = response.headers.getSetCookie?.() || [];
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const separator = pair.indexOf('=');
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
}

function csrfFrom(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match, 'No se encontro el token CSRF.');
  return match[1];
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers);
  if (cookies.size) headers.set('cookie', cookieHeader());
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers, redirect: 'manual' });
  absorbCookies(response);
  return response;
}

async function formPost(path, values) {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
}

async function main() {
  let response = await request('/login');
  assert.equal(response.status, 200);
  const loginHtml = await response.text();

  response = await formPost('/login', {
    _csrf: csrfFrom(loginHtml),
    login,
    password,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/dashboard');

  response = await request('/systems');
  assert.equal(response.status, 200);
  let systemsHtml = await response.text();
  assert.match(systemsHtml, /Correo de notificaciones/);
  assert.match(systemsHtml, /Backup autom.tico/);
  assert.match(systemsHtml, /Dos veces por semana/);
  assert.match(systemsHtml, /name="email_1"/);
  assert.match(systemsHtml, /name="email_2"/);

  response = await formPost('/systems/backups/run', { _csrf: csrfFrom(systemsHtml) });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/systems');

  response = await request('/systems');
  assert.equal(response.status, 200);
  systemsHtml = await response.text();
  const downloadPath = systemsHtml.match(/href="(\/systems\/backups\/[^"]+\/download)"/)?.[1];
  assert.ok(downloadPath, 'No se encontro un backup descargable.');

  response = await request(downloadPath, { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers.get('content-length')) > 0, 'El backup disponible esta vacio.');
  console.log('Smoke HTTPS OK: login Sistemas, panel, backup y disponibilidad de descarga.');
}

main().catch((error) => {
  console.error(error.cause?.message || error.stack || error.message);
  process.exitCode = 1;
});
