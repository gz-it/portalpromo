const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/public/css/app.css'), 'utf8');
const { layout } = require('../src/ui');

test('header separates portal name and venue without changing navigation', () => {
  const html = layout({ app: { locals: { portalSettings: { portal_title: 'Portal de Productores - Estadio Huracán' } } },
    session: {}, user: { roles: [] } }, 'Prueba', '');
  assert.match(html, /class="brand-title">Portal de Productores<\/b>/);
  assert.match(html, /class="brand-subtitle">Estadio Huracán<\/span>/);
  assert.match(html, /href="\/notifications"/);
});

test('brand stays red while reading and positive states use neutral colors', () => {
  assert.match(css, /--primary:\s*#e30713;/);
  assert.match(css, /--ok:\s*#344054;/);
  assert.match(css, /font-size:\s*16px; line-height:\s*1\.55;/);
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
