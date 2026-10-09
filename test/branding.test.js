const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/public/css/app.css'), 'utf8');
const { layout } = require('../src/ui');

test('management screens have explicit safe return destinations', () => {
  for (const route of ['/admin/events', '/admin/reviews', '/admin/users', '/admin/settings', '/events/new']) {
    const html = layout({ path: route, app: { locals: {} }, session: {}, user: { roles: [] } }, 'Prueba', '');
    assert.match(html, /class="page-return"/);
    assert.ok(html.includes(`href="${route === '/events/new' ? '/dashboard' : '/admin'}"><span aria-hidden="true">←</span>`));
  }
});

test('header separates portal name and venue without changing navigation', () => {
  const html = layout({ app: { locals: { portalSettings: { portal_title: 'Portal de Productores - Estadio Huracán' } } },
    session: {}, user: { roles: [] } }, 'Prueba', '');
  assert.match(html, /class="brand-title">Portal de Productores<\/b>/);
  assert.match(html, /class="brand-subtitle">Estadio Huracán<\/span>/);
  assert.match(html, /href="\/notifications"/);
  assert.match(html, /app\.css\?v=[a-f0-9]{12}/);
});

test('brand stays red while reading and positive states use neutral colors', () => {
  assert.match(css, /--primary:\s*#e30713;/);
  assert.match(css, /--ok:\s*#344054;/);
  assert.match(css, /font-size:\s*16px; line-height:\s*1\.5;/);
  assert.match(css, /\.module-pill small\s*\{[^}]*font-size:\s*14px;/);
  const green = [...css.matchAll(/#([a-f\d]{6})\b/gi)].filter(([, hex]) => {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return g > r && g > b;
  });
  assert.deepEqual(green.map(([color]) => color), []);
});

test('native progress controls have neutral fills for Safari and Firefox', () => {
  assert.match(css, /progress::-webkit-progress-value\s*\{\s*background:\s*var\(--progress\)/);
  assert.match(css, /progress::-moz-progress-bar\s*\{\s*background:\s*var\(--progress\)/);
});

test('admin dashboard puts events before producer creation and settings', () => {
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  const actions = app.slice(app.indexOf('aria-label="Acciones del administrador"'), app.indexOf('</nav></section>', app.indexOf('aria-label="Acciones del administrador"')));
  assert.ok(actions.indexOf('href="/admin/events"') < actions.indexOf('href="/admin/reviews"'));
  assert.ok(actions.indexOf('href="/admin/reviews"') < actions.indexOf('href="/admin/users"'));
  assert.ok(actions.indexOf('href="/admin/users"') < actions.indexOf('href="/admin/settings"'));
  assert.match(actions, /aria-label="Eventos y revisiones"/);
  assert.match(actions, /aria-label="Gestión del portal"/);
  assert.match(css, /\.dashboard-actions \.primary\s*\{ grid-column: 1 \/ -1;/);
});
