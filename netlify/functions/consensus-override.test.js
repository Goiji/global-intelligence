// Tests for the shared consensus-override store (netlify/functions/consensus-override.js).
// Runs against the real handler with env-stubbed backends — no network, no GitHub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fn = require('./consensus-override.js');
const { __test: T, handler } = fn;

const SAVED_ENV = {
  NETLIFY_DATABASE_URL: process.env.NETLIFY_DATABASE_URL,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  SITE_ID: process.env.SITE_ID,
  DEPLOY_ID: process.env.DEPLOY_ID,
  NETLIFY_URL: process.env.NETLIFY_URL,
  CONSENSUS_OVERRIDE_PASSWORD: process.env.CONSENSUS_OVERRIDE_PASSWORD,
  OVERRIDE_STORE_FILE: process.env.OVERRIDE_STORE_FILE,
  OVERRIDE_GITHUB_REPO: process.env.OVERRIDE_GITHUB_REPO,
  OVERRIDE_GITHUB_BRANCH: process.env.OVERRIDE_GITHUB_BRANCH,
  OVERRIDE_MAX_BAD_ATTEMPTS: process.env.OVERRIDE_MAX_BAD_ATTEMPTS
};

function withEnv(vars, fnBody) {
  return (async () => {
    const old = {};
    for (const k of Object.keys(SAVED_ENV)) {
      old[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, vars);
    T._resetState();
    try {
      return await fnBody();
    } finally {
      for (const k of Object.keys(SAVED_ENV)) {
        if (SAVED_ENV[k] == null) delete process.env[k];
        else process.env[k] = SAVED_ENV[k];
      }
      T._resetState();
    }
  })();
}

function post(body, { method = 'POST', headers = {} } = {}) {
  return handler({
    httpMethod: method,
    path: '/.netlify/functions/consensus-override',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { http: { sourceIp: '203.0.113.7' } }
  });
}
const get = () => handler({ httpMethod: 'GET', path: '/.netlify/functions/consensus-override', headers: {}, requestContext: { http: { sourceIp: '203.0.113.7' } } });

function tmpStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consensus-override-'));
  return path.join(dir, 'data', 'consensus-override.json');
}

test('validate helpers: applyPatch sets, clears and rejects', () => {
  assert.deepEqual(T.applyPatch(null, { cpi: 3.4, nfp: 55000 }).value, { cpi: 3.4, nfp: 55000 });
  assert.deepEqual(T.applyPatch({ cpi: 3.4, nfp: 55000 }, { cpi: null }).value, { nfp: 55000 });
  assert.deepEqual(T.applyPatch({ cpi: 3.4 }, {}).value, { cpi: 3.4 }, 'absent keys keep the stored value');
  assert.deepEqual(T.applyPatch({ cpi: 3.4 }, { cpi: 999 }).ok, false, 'out of range');
  assert.deepEqual(T.applyPatch(null, { bogus: 1 }).ok, false, 'unknown field');
  assert.deepEqual(T.applyPatch(null, { cpi: 'abc' }).ok, false, 'not a number');
  assert.deepEqual(T.applyPatch(null, { asOf: '2026-09-12' }).value, { asOf: '2026-09-12' });
  assert.deepEqual(T.applyPatch(null, { asOf: 'someday' }).ok, false, 'bad date');
  assert.equal(T.applyPatch({ cpi: 1 }, { cpi: null }).value, null, 'clearing the last field → null');
  assert.equal(T.timingSafeEqualStr('abc', 'abc'), true);
  assert.equal(T.timingSafeEqualStr('abc', 'abd'), false);
});

test('GET with no store configured → enabled:false (page falls back to localStorage)', async () => {
  await withEnv({ SITE_ID: 'site-123' }, async () => {   // looks like Netlify, but no token/DB
    const out = await get();
    assert.equal(out.statusCode, 200);
    const j = JSON.parse(out.body);
    assert.equal(j.enabled, false);
    assert.equal(j.value, null);
    assert.match(j.hint, /no shared store/);
  });
});

test('OPTIONS returns a CORS preflight', async () => {
  await withEnv({}, async () => {
    const out = await handler({ httpMethod: 'OPTIONS', headers: {} });
    assert.equal(out.statusCode, 204);
    assert.equal(out.headers['Access-Control-Allow-Origin'], '*');
    assert.match(out.headers['Access-Control-Allow-Methods'], /POST/);
  });
});

test('full file-store round trip: password gate, set, read, clear (local dev mode)', async () => {
  const store = tmpStoreFile();
  await withEnv({ CONSENSUS_OVERRIDE_PASSWORD: 's3cret', OVERRIDE_STORE_FILE: store }, async () => {
    // reads are public
    let out = await get();
    assert.equal(out.statusCode, 200);
    assert.deepEqual(JSON.parse(out.body), { enabled: true, backend: 'file', value: null, updatedAt: null });

    // writes need the password
    out = await post({ action: 'set', patch: { cpi: 3.5 } });
    assert.equal(out.statusCode, 401);
    assert.equal(JSON.parse(out.body).error, 'password-required');

    out = await post({ password: 'wrong', action: 'set', patch: { cpi: 3.5 } });
    assert.equal(out.statusCode, 401);
    assert.equal(JSON.parse(out.body).error, 'bad-password');

    // a valid set is applied and visible to the next (public) read
    out = await post({ password: 's3cret', action: 'set', patch: { cpi: 3.5, asOf: '2026-09-12' } });
    assert.equal(out.statusCode, 200, out.body);
    const j = JSON.parse(out.body);
    assert.equal(j.ok, true);
    assert.deepEqual(j.value, { cpi: 3.5, asOf: '2026-09-12' });

    out = await get();
    assert.deepEqual(JSON.parse(out.body).value, { cpi: 3.5, asOf: '2026-09-12' });
    assert.ok(fs.existsSync(store), 'the store file must exist on disk');

    // the patch is merged field-by-field (untouched fields survive)
    out = await post({ password: 's3cret', action: 'set', patch: { nfp: 55000 } });
    assert.deepEqual(JSON.parse(out.body).value, { cpi: 3.5, asOf: '2026-09-12', nfp: 55000 });

    // clearField wipes one field; clear wipes everything
    out = await post({ password: 's3cret', action: 'set', patch: { cpi: null } });
    assert.deepEqual(JSON.parse(out.body).value, { asOf: '2026-09-12', nfp: 55000 });
    out = await post({ password: 's3cret', action: 'clear' });
    assert.equal(JSON.parse(out.body).value, null);
    out = await get();
    assert.equal(JSON.parse(out.body).value, null);
  });
});

test('clearFirst makes an un-pushed reset happen before the next patch', async () => {
  const store = tmpStoreFile();
  await withEnv({ CONSENSUS_OVERRIDE_PASSWORD: 's3cret', OVERRIDE_STORE_FILE: store }, async () => {
    let out = await post({ password: 's3cret', action: 'set', patch: { cpi: 3.5, unrate: 4.1 } });
    assert.deepEqual(JSON.parse(out.body).value, { cpi: 3.5, unrate: 4.1 });
    out = await post({ password: 's3cret', action: 'set', clearFirst: true, patch: { cpi: 3.7 } });
    assert.deepEqual(JSON.parse(out.body).value, { cpi: 3.7 }, 'the reset must drop the old fields first');
  });
});

test('POST without a configured password → 503 with a setup hint', async () => {
  const store = tmpStoreFile();
  await withEnv({ OVERRIDE_STORE_FILE: store }, async () => {
    const out = await post({ password: 'anything', action: 'clear' });
    assert.equal(out.statusCode, 503);
    assert.equal(JSON.parse(out.body).error, 'password-not-configured');
    assert.match(JSON.parse(out.body).hint, /CONSENSUS_OVERRIDE_PASSWORD/);
  });
});

test('rejected inputs never touch the store', async () => {
  const store = tmpStoreFile();
  await withEnv({ CONSENSUS_OVERRIDE_PASSWORD: 's3cret', OVERRIDE_STORE_FILE: store }, async () => {
    let out = await post({ password: 's3cret', action: 'set', patch: { cpi: 50 } });
    assert.equal(out.statusCode, 400);
    assert.equal(JSON.parse(out.body).error, 'invalid-out-of-range');
    out = await post({ password: 's3cret', action: 'set', patch: { hacker: 1 } });
    assert.equal(out.statusCode, 400);
    assert.equal(JSON.parse(out.body).error, 'invalid-unknown-field');
    out = await post('not json', { password: 's3cret' });
    assert.equal(out.statusCode, 400);
    assert.equal(JSON.parse(out.body).error, 'invalid-json');
    // none of that may have been stored
    out = await get();
    assert.equal(JSON.parse(out.body).value, null);
  });
});

test('repeated wrong passwords get rate-limited per IP', async () => {
  const store = tmpStoreFile();
  await withEnv({ CONSENSUS_OVERRIDE_PASSWORD: 's3cret', OVERRIDE_STORE_FILE: store, OVERRIDE_MAX_BAD_ATTEMPTS: '3' }, async () => {
    for (let i = 0; i < 3; i++) {
      const out = await post({ password: 'nope', action: 'clear' });
      assert.equal(out.statusCode, 401);
    }
    // even the RIGHT password is paused for the window now
    const out = await post({ password: 's3cret', action: 'clear' });
    assert.equal(out.statusCode, 429);
    assert.equal(JSON.parse(out.body).error, 'too-many-failed-attempts');
    // …and another IP is not affected
    const otherIp = await handler({
      httpMethod: 'POST',
      path: '/.netlify/functions/consensus-override',
      headers: { 'x-forwarded-for': '198.51.100.9' },
      body: JSON.stringify({ password: 's3cret', action: 'clear' }),
      isBase64Encoded: false,
      requestContext: { http: { sourceIp: '198.51.100.9' } }
    });
    assert.equal(otherIp.statusCode, 200);
  });
});

test('github backend: reads via raw CDN, writes via a commit (stubbed fetch)', async () => {
  const store = { file: null };   // simulated repo file content (raw JSON string)
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET' });
    const ok = (status, objOrText, isText) => ({
      ok: status < 400,
      status,
      text: async () => (isText ? objOrText : JSON.stringify(objOrText)),
      json: async () => (isText ? JSON.parse(objOrText) : objOrText)
    });
    if (u.startsWith('https://raw.githubusercontent.com/')) {
      return store.file ? ok(200, store.file, true) : ok(404, '');
    }
    if (u.includes('api.github.com') && u.includes('/contents/')) {
      if ((opts && opts.method) === 'PUT') {
        const j = JSON.parse(opts.body);
        store.file = Buffer.from(j.content, 'base64').toString('utf8');
        return ok(201, { path: j.path });
      }
      return store.file ? ok(200, { sha: 'abc123', content: Buffer.from(store.file).toString('base64') }) : ok(404, { message: 'Not Found' });
    }
    return ok(500, { message: 'unexpected url ' + u });
  };
  try {
    await withEnv({ GITHUB_TOKEN: 'gh-test-token', SITE_ID: 'site-123', CONSENSUS_OVERRIDE_PASSWORD: 's3cret' }, async () => {
      // no file in the repo yet
      let out = await get();
      assert.equal(out.statusCode, 200);
      assert.equal(JSON.parse(out.body).enabled, true);
      assert.equal(JSON.parse(out.body).backend, 'github');
      assert.equal(JSON.parse(out.body).value, null);

      // a save = one commit
      const before = calls.length;
      out = await post({ password: 's3cret', action: 'set', patch: { cpi: 3.5 } });
      assert.equal(out.statusCode, 200, out.body);
      assert.equal(JSON.parse(out.body).backend, 'github');
      const commits = calls.slice(before).filter(c => c.method === 'PUT');
      assert.equal(commits.length, 1, 'exactly one commit per save');
      assert.match(commits[0].url, /api\.github\.com\/repos\/Goiji\/global-intelligence\/contents\/data\/consensus-override\.json/);

      // and the next read (raw CDN) sees it
      out = await get();
      assert.deepEqual(JSON.parse(out.body).value, { cpi: 3.5 });
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('github backend: a failed commit surfaces as 502, not a fake success', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.startsWith('https://raw.githubusercontent.com/')) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    if (u.includes('api.github.com') && u.includes('/contents/')) {
      // the read/stat succeeds (file absent) but the commit is forbidden (token lacks write)
      if ((opts && opts.method) === 'PUT') {
        return { ok: false, status: 403, text: async () => '', json: async () => ({ message: 'Forbidden' }) };
      }
      return { ok: false, status: 404, text: async () => '', json: async () => ({ message: 'Not Found' }) };
    }
    return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
  };
  try {
    await withEnv({ GITHUB_TOKEN: 'gh-test-token', SITE_ID: 'site-123', CONSENSUS_OVERRIDE_PASSWORD: 's3cret' }, async () => {
      const out = await post({ password: 's3cret', action: 'set', patch: { cpi: 3.5 } });
      assert.equal(out.statusCode, 502);
      assert.equal(JSON.parse(out.body).error, 'store-write-failed');
    });
  } finally {
    global.fetch = realFetch;
  }
});

test('a corrupt store file is treated as empty, never as a crash', async () => {
  const store = tmpStoreFile();
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, '{"v":1,"value":{"cpi":9999,"evil":"x"}}');   // out of range + unknown field
  await withEnv({ CONSENSUS_OVERRIDE_PASSWORD: 's3cret', OVERRIDE_STORE_FILE: store }, async () => {
    const out = await get();
    assert.equal(out.statusCode, 200);
    assert.equal(JSON.parse(out.body).value, null);
  });
});
