#!/usr/bin/env node
// index.html loads its big scripts from js/*.js as  <script src="js/NAME.js?v=HASH"></script>.
// HASH = first 10 hex of the file's sha256. Changing a js file changes index.html too, so the
// browser never runs a stale copy and the "new version" banner (which watches index.html) fires.
// After editing anything in js/, run:  node tools/stamp.js   (npm test fails until you do).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const SRC_RE = /<script src="(js\/[a-z0-9-]+\.js)(?:\?v=([0-9a-f]+))?"><\/script>/g;

const hashOf = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex').slice(0, 10);

function stamp(html) {
  return html.replace(SRC_RE, (_, rel) => '<script src="' + rel + '?v=' + hashOf(rel) + '"></script>');
}

// index.html with every local js/*.js put back inline — what the browser effectively runs.
// Tests use this so they can keep reading the page as one document.
function readPage() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  return html.replace(SRC_RE, (_, rel) => '<script>' + fs.readFileSync(path.join(ROOT, rel), 'utf8') + '</script>');
}

function staleStamps() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const bad = [];
  for (const m of html.matchAll(SRC_RE)) if (m[2] !== hashOf(m[1])) bad.push(m[1]);
  return bad;
}

if (require.main === module) {
  const p = path.join(ROOT, 'index.html');
  const before = fs.readFileSync(p, 'utf8');
  const after = stamp(before);
  if (after !== before) { fs.writeFileSync(p, after); console.log('index.html: script versions updated'); }
  else console.log('index.html: script versions already up to date');
}

module.exports = { stamp, readPage, staleStamps, SRC_RE };
