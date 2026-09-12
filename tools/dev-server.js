#!/usr/bin/env node
// Local dev server: static files + the real Netlify Functions, with no netlify-cli and no
// dependencies. Handy for checking the page (and the function wiring) before deploying.
//
//   node tools/dev-server.js         → http://localhost:8080          (or npm run dev)
//   PORT=3000 node tools/dev-server.js
//
// It is only a development convenience — Netlify runs the same handlers with its own routing.
// Anything that needs outbound network (FRED, Google News, BGeometrics…) will work only if this
// machine can reach it; if the upstream is unreachable the functions return their normal
// graceful-failure JSON, which is exactly what you want to see locally.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');
const PORT = Number(process.env.PORT || 8080);

// The shared consensus-override store always lives in a local file under this dev server, even
// if the machine's environment happens to contain a GITHUB_TOKEN (which would otherwise make
// the function try to commit to the real repo from a laptop).
process.env.OVERRIDE_STORE_FILE = process.env.OVERRIDE_STORE_FILE ||
  path.join(ROOT, 'data', 'consensus-override.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function send(res, status, headers, body) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Minimal `_redirects` support (only the "block these paths with a 404" rules we actually use),
// so the local server behaves like Netlify for the files that must not be public.
function loadBlockedPatterns() {
  const file = path.join(ROOT, '_redirects');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 3 && parts[2] === '404')
    .map((parts) => parts[0]);
}
const BLOCKED = loadBlockedPatterns();

function isBlocked(pathname) {
  return BLOCKED.some((pattern) => {
    const rx = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return rx.test(pathname);
  });
}

async function serveFunction(name, url, res, { method = 'GET', body = '', headers = {} } = {}) {
  const file = path.join(FUNCTIONS_DIR, `${name}.js`);
  if (!path.resolve(file).startsWith(FUNCTIONS_DIR) || !fs.existsSync(file)) {
    return send(res, 404, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `no function named ${name}` }));
  }
  let mod;
  try {
    delete require.cache[require.resolve(file)];
    mod = require(file);
  } catch (e) {
    return send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `function failed to load: ${e.message}` }));
  }
  if (typeof mod.handler !== 'function') {
    return send(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'function has no exports.handler' }));
  }
  // Forward method/headers/body like Netlify does, so functions with POST endpoints
  // (e.g. consensus-override) behave the same locally as in production.
  const event = {
    httpMethod: method,
    path: url.pathname,
    rawQuery: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams.entries()),
    headers,
    body,
    isBase64Encoded: false
  };
  try {
    const out = await mod.handler(event, {});
    console.log(`  ${name} → ${out.statusCode}`);
    return send(res, out.statusCode, out.headers || {}, out.body || '');
  } catch (e) {
    console.error(`  ${name} → threw`, e);
    return send(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: e.message }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  console.log(`${req.method} ${url.pathname}${url.search}`);

  // Collect the request body (capped) so functions can read POST/PUT payloads.
  const chunks = [];
  let tooBig = false;
  req.on('data', (chunk) => {
    if (tooBig) return;
    chunks.push(chunk);
    if (chunks.reduce((n, c) => n + c.length, 0) > 1024 * 1024) tooBig = true;
  });
  req.on('end', async () => {
    const fn = /^\/\.netlify\/functions\/([\w-]+)$/.exec(url.pathname);
    if (fn) {
      const body = tooBig ? '' : Buffer.concat(chunks).toString('utf8');
      return serveFunction(fn[1], url, res, { method: req.method, body, headers: req.headers });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'method not allowed for static files' }));
    }
    if (isBlocked(url.pathname)) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found (blocked by _redirects)');
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!path.resolve(file).startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
    }
    send(res, 200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }, fs.readFileSync(file));
  });
  req.on('error', () => { try { res.destroy(); } catch (e) { /* already gone */ } });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`dev server → http://localhost:${PORT}`);
  console.log(`functions  → http://localhost:${PORT}/.netlify/functions/fred-data`);
});
