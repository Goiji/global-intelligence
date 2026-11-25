// index.html loads its big scripts from js/ with a content hash. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { staleStamps, SRC_RE } = require('../tools/stamp.js');

test('every js/*.js has an up-to-date ?v= hash in index.html (run: node tools/stamp.js)', () => {
  assert.deepEqual(staleStamps(), []);
});

test('every file in js/ is loaded by index.html, and nothing missing is referenced', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const used = [...html.matchAll(SRC_RE)].map((m) => m[1]).sort();
  const onDisk = fs.readdirSync(path.join(__dirname, '..', 'js')).filter((f) => f.endsWith('.js')).map((f) => 'js/' + f).sort();
  assert.deepEqual(used, onDisk);
});
