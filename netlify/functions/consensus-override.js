// Netlify Function: the SHARED "consensus override" — one set of edited "ที่คาด" values for
// every visitor (the ✏️ editor in index.html writes here, so ทุกคนที่เปิดเว็บเห็นค่าเดียวกัน).
//
//   GET  /.netlify/functions/consensus-override   (public)
//     → 200 { enabled: true,  backend, value: {...}|null, updatedAt }
//     → 200 { enabled: false, hint }              when this deployment has no shared store
//
//   POST /.netlify/functions/consensus-override   (password-protected)
//     body { password, action: 'set', clearFirst?: bool, patch: {cpi, coreCpi, unrate, nfp, fedLo, fedHi, asOf, savedAt} }
//          { password, action: 'clear' }
//     → 200 { ok: true, backend, value, updatedAt }
//     → 400 { error: 'invalid-...' }  ·  401 { error: 'password-required'|'bad-password' }
//     → 413 body too large            ·  429 too many failed passwords
//     → 503 { error: 'password-not-configured'|'storage-unavailable' }
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHERE THE VALUES LIVE (first available wins):
//   1. NETLIFY_DATABASE_URL → Netlify Database (KV) — if the site has it enabled
//   2. GITHUB_TOKEN         → the file data/consensus-override.json committed to the site's
//                             repo (Netlify injects GITHUB_TOKEN automatically for
//                             GitHub-connected sites — no extra setup). Reads go through
//                             raw.githubusercontent.com (CDN) and every save is a small
//                             commit to the default branch.
//   3. local dev            → the same file next to this repo (tools/dev-server.js, no token)
//
// WHY A PASSWORD ON WRITE ONLY: the values are already public information (they are shown on
// the page), so reading needs no auth — but only the site owner should be able to change what
// everyone else sees. The password comes from the CONSENSUS_OVERRIDE_PASSWORD env var (never
// from this file — the repo is public). Wrong passwords are rate-limited per IP.
//
// Patch semantics ('set'): applied field-by-field on top of the stored value —
//   key present with a number  → set that field (stored units: nfp = positions)
//   key present with null/''   → clear that field
//   key absent                 → keep what is stored (the client only sends what changed)
// 'clear' wipes the whole value back to the automatic numbers.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const TIMEOUT_MS = 8000;
const READ_CACHE_MS = 30 * 1000;      // don't hit the store for every page load
const MAX_BODY = 4096;
const KV_KEY = 'consensusOverride';
const FILE_PATH = 'data/consensus-override.json';
const BAD_WINDOW_MS = 15 * 60 * 1000; // rate-limit window for failed passwords

// Field spec mirrors CONSENSUS_FIELDS in index.html. Ranges are in STORAGE units (the page
// scales nfp from "พัน" to positions before it ever reaches this file).
const FIELDS = {
  cpi: { min: 0, max: 30 },
  coreCpi: { min: 0, max: 30 },
  unrate: { min: 0, max: 30 },
  nfp: { min: -2000000, max: 2000000 },
  fedLo: { min: 0, max: 25 },
  fedHi: { min: 0, max: 25 }
};
const DATE_FIELDS = ['asOf', 'savedAt'];
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

function repo() { return process.env.OVERRIDE_GITHUB_REPO || 'Goiji/global-intelligence'; }
function branch() { return process.env.OVERRIDE_GITHUB_BRANCH || 'main'; }
function maxBad() { return Math.max(1, Number(process.env.OVERRIDE_MAX_BAD_ATTEMPTS || 20)); }

// ── small utilities ─────────────────────────────────────────────────────────────────────────

function fetchWithTimeout(url, ms, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}))
    .finally(() => clearTimeout(timer));
}

function json(statusCode, headers, obj) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers), body: JSON.stringify(obj) };
}

// Constant-time string compare (length-independent via digests) — no early-exit timing leak.
function timingSafeEqualStr(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch (e) {
    return false;
  }
}

function clientIp(event) {
  try {
    const h = (event && event.headers) || {};
    const xff = h['x-forwarded-for'] || h['X-Forwarded-For'];
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64);
    const real = h['x-real-ip'] || h['X-Real-Ip'];
    if (typeof real === 'string' && real.trim()) return real.trim().slice(0, 64);
    const rc = event && event.requestContext && event.requestContext.http && event.requestContext.http.sourceIp;
    if (rc) return String(rc).slice(0, 64);
  } catch (e) { /* fall through */ }
  return 'local';
}

// ── failed-password rate limit (per IP, in-memory; cold starts reset it — acceptable here) ──
const badAttempts = new Map();
function rateLimited(ip) {
  const now = Date.now();
  let rec = badAttempts.get(ip);
  if (!rec || now - rec.first > BAD_WINDOW_MS) { rec = { first: now, n: 0 }; badAttempts.set(ip, rec); }
  return rec.n >= maxBad();
}
function noteBad(ip) {
  const now = Date.now();
  let rec = badAttempts.get(ip);
  if (!rec || now - rec.first > BAD_WINDOW_MS) { rec = { first: now, n: 0 }; badAttempts.set(ip, rec); }
  rec.n += 1;
}

// ── validation ──────────────────────────────────────────────────────────────────────────────
// Apply a client patch on top of the stored value. Strict: unknown fields / out-of-range
// numbers / bad dates are a hard error (the client never sends them; anything else means a
// confused or malicious caller and must not partially mutate the shared state).
function applyPatch(currentValue, patch) {
  if (patch === null || patch === undefined) patch = {};
  if (typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: 'patch-must-be-object' };
  const base = (currentValue && typeof currentValue === 'object' && !Array.isArray(currentValue))
    ? Object.assign({}, currentValue)
    : {};
  for (const key of Object.keys(patch)) {
    const raw = patch[key];
    if (Object.prototype.hasOwnProperty.call(FIELDS, key)) {
      if (raw === null || raw === undefined || raw === '') { delete base[key]; continue; }
      const n = Number(raw);
      if (!isFinite(n)) return { ok: false, error: 'not-a-number', field: key };
      if (n < FIELDS[key].min || n > FIELDS[key].max) return { ok: false, error: 'out-of-range', field: key };
      base[key] = n;
    } else if (DATE_FIELDS.indexOf(key) !== -1) {
      if (raw === null || raw === undefined || raw === '') { delete base[key]; continue; }
      if (typeof raw !== 'string' || !DATE_RX.test(raw)) return { ok: false, error: 'bad-date', field: key };
      base[key] = raw;
    } else {
      return { ok: false, error: 'unknown-field', field: key };
    }
  }
  if (!Object.keys(base).length) return { ok: true, value: null };
  return { ok: true, value: base };
}

// Re-validate a stored envelope (a corrupt file must never take the site down).
function sanitizeEnvelope(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.value === null || raw.value === undefined) {
      return { v: 1, value: null, updatedAt: strOrNull(raw.updatedAt), updatedFrom: strOrNull(raw.updatedFrom) };
    }
    const res = applyPatch(null, raw.value);
    if (!res.ok) return null;
    return { v: 1, value: res.value, updatedAt: strOrNull(raw.updatedAt), updatedFrom: strOrNull(raw.updatedFrom) };
  } catch (e) {
    return null;
  }
}
function strOrNull(v) { return typeof v === 'string' && v ? v : null; }

// ── storage backends ────────────────────────────────────────────────────────────────────────

function onNetlify() {
  return !!(process.env.SITE_ID || process.env.DEPLOY_ID || process.env.NETLIFY_URL);
}
function pickBackend() {
  // An explicit local file wins over everything — tools/dev-server.js sets this so a stray
  // GITHUB_TOKEN in the dev machine's environment can't hijack the local store.
  if (process.env.OVERRIDE_STORE_FILE) return 'file';
  if (process.env.NETLIFY_DATABASE_URL) return 'kv';
  if (process.env.GITHUB_TOKEN) return 'github';
  if (!onNetlify()) return 'file';   // tools/dev-server.js and node --test
  return null;                       // deployed, but nothing persistent is configured
}

let readCache = { at: 0, backend: null, env: null };

async function kvRead() {
  const base = String(process.env.NETLIFY_DATABASE_URL).replace(/\/+$/, '');
  const r = await fetchWithTimeout(base + '/kv/' + KV_KEY, TIMEOUT_MS);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('kv read HTTP ' + r.status);
  return await r.json();
}
async function kvWrite(env) {
  const base = String(process.env.NETLIFY_DATABASE_URL).replace(/\/+$/, '');
  const r = await fetchWithTimeout(base + '/kv/' + KV_KEY, TIMEOUT_MS, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(env)
  });
  if (!r.ok) throw new Error('kv write HTTP ' + r.status);
}

async function ghApi(method, apiPath, bodyObj) {
  const headers = {
    Authorization: 'token ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'global-intelligence-dashboard'
  };
  if (bodyObj) headers['Content-Type'] = 'application/json';
  return fetchWithTimeout('https://api.github.com' + apiPath, TIMEOUT_MS, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
}
async function ghRead() {
  // raw.githubusercontent is CDN-served and needs no token when the repo is public — cheapest
  // possible read path. Fall back to the Contents API (works for private repos too).
  const raw = 'https://raw.githubusercontent.com/' + repo() + '/' + branch() + '/' + FILE_PATH;
  try {
    const r = await fetchWithTimeout(raw, TIMEOUT_MS);
    if (r.ok) {
      const text = await r.text();
      return text ? JSON.parse(text) : null;
    }
    if (r.status !== 404) throw new Error('raw read HTTP ' + r.status);
  } catch (e) {
    /* fall through to the API */
  }
  const r2 = await ghApi('GET', '/repos/' + repo() + '/contents/' + FILE_PATH + '?ref=' + encodeURIComponent(branch()));
  if (r2.status === 404) return null;
  if (!r2.ok) throw new Error('api read HTTP ' + r2.status);
  const j = await r2.json();
  const text = Buffer.from(j && j.content ? j.content : '', 'base64').toString('utf8');
  return text ? JSON.parse(text) : null;
}
async function ghWrite(env) {
  const content = JSON.stringify(env, null, 2);
  // A commit to the repo = the shared state. Fetch the current sha so the update never clobbers
  // a concurrent write (the Contents API 409s instead, and the client just retries).
  let sha = null;
  const r0 = await ghApi('GET', '/repos/' + repo() + '/contents/' + FILE_PATH + '?ref=' + encodeURIComponent(branch()));
  if (r0.ok) {
    const j0 = await r0.json();
    sha = j0 && j0.sha ? j0.sha : null;
  } else if (r0.status !== 404) {
    throw new Error('api stat HTTP ' + r0.status);
  }
  const body = {
    message: 'chore(data): update shared consensus override (from the dashboard)',
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: branch()
  };
  if (sha) body.sha = sha;
  const r = await ghApi('PUT', '/repos/' + repo() + '/contents/' + FILE_PATH, body);
  if (!r.ok) {
    let detail = 'HTTP ' + r.status;
    try {
      const j = await r.json();
      if (j && j.message) detail += ' — ' + j.message;
    } catch (e) { /* keep the status only */ }
    throw new Error('github write failed: ' + detail);
  }
}

function fileStorePath() {
  return process.env.OVERRIDE_STORE_FILE ||
    path.join(__dirname, '..', '..', 'data', 'consensus-override.json');
}
async function fileRead() {
  try {
    const text = await fs.readFile(fileStorePath(), 'utf8');
    return text ? JSON.parse(text) : null;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}
// Serialize writes in-process (atomic tmp+rename on disk).
let fileChain = Promise.resolve();
function fileWrite(env) {
  const run = fileChain.then(async () => {
    const p = fileStorePath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(env, null, 2));
    await fs.rename(tmp, p);
  });
  fileChain = run.catch(() => {});
  return run;
}

async function readEnvelope(backend) {
  if (backend !== 'file' && readCache.backend === backend && Date.now() - readCache.at < READ_CACHE_MS) {
    return readCache.env;
  }
  const raw = backend === 'file' ? await fileRead() : backend === 'kv' ? await kvRead() : await ghRead();
  const env = sanitizeEnvelope(raw);
  if (backend !== 'file') readCache = { at: Date.now(), backend, env };
  return env;
}
async function writeEnvelope(backend, env) {
  if (backend === 'file') await fileWrite(env);
  else if (backend === 'kv') await kvWrite(env);
  else await ghWrite(env);
  readCache = { at: 0, backend: null, env: null };
}

// ── handler ─────────────────────────────────────────────────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

exports.handler = async function (event) {
  const method = String((event && event.httpMethod) || 'GET').toUpperCase();
  const ip = clientIp(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ── public read: what does everyone else see right now? ──────────────────────────────────
  if (method === 'GET') {
    const backend = pickBackend();
    if (!backend) {
      return json(200, CORS, {
        enabled: false,
        value: null,
        hint: 'this deployment has no shared store (set GITHUB_TOKEN or NETLIFY_DATABASE_URL, or run locally via tools/dev-server.js)'
      });
    }
    try {
      const env = await readEnvelope(backend);
      return json(200, CORS, {
        enabled: true,
        backend,
        value: env ? env.value : null,
        updatedAt: env ? env.updatedAt : null
      });
    } catch (e) {
      return json(502, CORS, { enabled: false, value: null, error: 'store read failed: ' + e.message });
    }
  }

  // ── protected write ───────────────────────────────────────────────────────────────────────
  if (method !== 'POST') {
    return json(405, CORS, { error: 'method-not-allowed', hint: 'use GET or POST' });
  }

  const password = process.env.CONSENSUS_OVERRIDE_PASSWORD;
  if (!password) {
    return json(503, CORS, {
      error: 'password-not-configured',
      hint: 'set the CONSENSUS_OVERRIDE_PASSWORD environment variable (once) and redeploy'
    });
  }

  let bodyRaw = (event && typeof event.body === 'string') ? event.body : '';
  if (event && event.isBase64Encoded && bodyRaw) bodyRaw = Buffer.from(bodyRaw, 'base64').toString('utf8');
  if (bodyRaw.length > MAX_BODY) return json(413, CORS, { error: 'body-too-large' });
  let body;
  try { body = JSON.parse(bodyRaw || '{}'); } catch (e) { return json(400, CORS, { error: 'invalid-json' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json(400, CORS, { error: 'invalid-body' });

  const given = typeof body.password === 'string' ? body.password : '';
  if (!given) return json(401, CORS, { error: 'password-required' });
  if (rateLimited(ip)) return json(429, CORS, { error: 'too-many-failed-attempts', retryAfterMs: BAD_WINDOW_MS });
  if (!timingSafeEqualStr(given, password)) {
    noteBad(ip);
    return json(401, CORS, { error: 'bad-password' });
  }

  const backend = pickBackend();
  if (!backend) return json(503, CORS, { error: 'storage-unavailable' });

  const action = body.action === 'clear' ? 'clear' : 'set';
  let env;
  try {
    if (action === 'clear') {
      env = { v: 1, value: null, updatedAt: new Date().toISOString(), updatedFrom: ip };
    } else {
      const current = await readEnvelope(backend);
      const clearFirst = !!body.clearFirst;   // an un-pushed "reset" happened before this patch
      const base = clearFirst ? null : (current ? current.value : null);
      const res = applyPatch(base, body.patch);
      if (!res.ok) return json(400, CORS, { error: 'invalid-' + res.error, field: res.field || null });
      env = { v: 1, value: res.value, updatedAt: new Date().toISOString(), updatedFrom: ip };
    }
  } catch (e) {
    return json(502, CORS, { error: 'store read failed: ' + e.message });
  }

  try {
    await writeEnvelope(backend, env);
  } catch (e) {
    return json(502, CORS, { error: 'store-write-failed', details: e.message });
  }

  return json(200, CORS, { ok: true, backend, value: env.value, updatedAt: env.updatedAt });
};

// Exported for unit tests (node --test). Netlify ignores extra exports.
module.exports.__test = {
  FIELDS,
  applyPatch,
  sanitizeEnvelope,
  timingSafeEqualStr,
  pickBackend,
  repo,
  branch,
  _resetState: () => {
    badAttempts.clear();
    readCache = { at: 0, backend: null, env: null };
  }
};
