const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '../src/public/css/app.css'), 'utf8');

test('brand and positive states use the Huracan red without green shades', () => {
  assert.match(css, /--primary:\s*#e30713;/);
  assert.match(css, /--ok:\s*#e30713;/);
  const green = [...css.matchAll(/#([a-f\d]{6})\b/gi)].filter(([, hex]) => {
    const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    return g > r && g > b;
  });
  assert.deepEqual(green.map(([color]) => color), []);
});

test('native progress controls have explicit red fills for Safari and Firefox', () => {
  assert.match(css, /progress::-webkit-progress-value\s*\{\s*background:\s*var\(--primary\)/);
  assert.match(css, /progress::-moz-progress-bar\s*\{\s*background:\s*var\(--primary\)/);
});
