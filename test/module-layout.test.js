const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { eventHeader } = require('../src/ui');

test('module navigation identifies the current module accessibly', () => {
  const html = eventHeader({ id: 'event', name: '<Demo>', module_statuses: { seguros: 'APROBADO' } }, 'seguros');
  assert.match(html, /aria-label="Módulos del evento"/);
  assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  assert.match(html, /aria-current="page"[^>]*href="\/events\/event\/modules\/seguros"/);
  assert.match(html, /&lt;Demo&gt;/);
});

test('module layout keeps navigation and review responsive without nested main landmarks', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/public/css/app.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.match(css, /\.event-workspace\s*\{[^}]*grid-template-columns: 242px minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 960px\)/);
  assert.match(css, /\.event-workspace \.review-panel\s*\{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(app, /<section class="module-content">/);
  assert.doesNotMatch(app, /<main class="module-content">/);
});
