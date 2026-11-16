// "Never blank a card": partial answers are filled from the last good copy and retried soon, and a
// cold start (empty memory) falls back to the copy kept in Cloudflare KV.
const test = require('node:test');
const assert = require('node:assert/strict');
const lg = require('../netlify/lib/last-good.js');

const makeKv = () => {
  const store = new Map();
  return { store, kv: { get: async (k) => JSON.parse(store.get(k) || 'null'), put: async (k, v) => { store.set(k, v); } } };
};

test('partialTtl: complete → normal, all gaps filled → ≤15 min, still blank → 2 min', () => {
  assert.equal(lg.partialTtl(3600, 0, 0), 3600);
  assert.equal(lg.partialTtl(3600, 2, 0), 900);
  assert.equal(lg.partialTtl(3600, 2, 1), 120);
  assert.equal(lg.partialTtl(60, 2, 1), 60);
});

test('fillFromGood copies only failed keys that the good copy has', () => {
  const target = { a: 1 }, errors = { b: 'x', c: 'y' };
  assert.deepEqual(lg.fillFromGood(target, { a: 9, b: 2 }, errors), ['b']);
  assert.deepEqual(target, { a: 1, b: 2 });
  assert.deepEqual(errors, { c: 'y' });
});

test('KV: writes are throttled, old copies are ignored', async (t) => {
  lg._resetThrottle();
  const { kv, store } = makeKv();
  const ev = { cloudflare: { kv } };
  await lg.kvPutGood(ev, 'k', { v: 1 });
  await lg.kvPutGood(ev, 'k', { v: 2 }); // within 30 min → skipped
  assert.deepEqual(await lg.kvGetGood(ev, 'k'), { v: 1 });
  store.set('old', JSON.stringify({ at: Date.now() - 2 * 3600000, data: { v: 0 } }));
  assert.equal(await lg.kvGetGood(ev, 'old', 3600000), null);
  assert.equal(await lg.kvGetGood({}, 'k'), null, 'no KV (Netlify) → null');
});

for (const name of ['wti', 'usdjpy', 'gold-th', 'dvol']) {
  test(`${name}: a cold start with every source down serves the KV copy instead of a 502`, async (t) => {
    const fn = require(`../netlify/functions/${name}.js`);
    const realFetch = global.fetch;
    t.after(() => { global.fetch = realFetch; });
    global.fetch = async () => { throw new Error('offline'); };
    const { kv } = makeKv();
    await kv.put(`${name}:lastGood`, JSON.stringify({ at: Date.now(), data: { price: 1, latest: 1, source: 'test' } }));
    const res = await fn.handler({ cloudflare: { kv } });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).stale, true);
    assert.match(res.headers['Cache-Control'], /max-age=60/);
    const none = await fn.handler({});
    assert.equal(none.statusCode, 502);
    assert.equal(none.headers['Cache-Control'], 'no-store');
  });
}

test('on Netlify the last good copy goes to Netlify Blobs (store "last-good")', async (t) => {
  const prev = process.env.NETLIFY_BLOBS_CONTEXT;
  t.after(() => { if (prev === undefined) delete process.env.NETLIFY_BLOBS_CONTEXT; else process.env.NETLIFY_BLOBS_CONTEXT = prev; });
  const data = new Map();
  lg._setBlobs({ connectLambda() {}, getStore: (name) => { assert.equal(name, 'last-good'); return { get: async (k) => data.get(k) || null, setJSON: async (k, v) => { data.set(k, v); } }; } });
  t.after(() => lg._setBlobs(null));
  process.env.NETLIFY_BLOBS_CONTEXT = 'x';
  lg._resetThrottle();
  await lg.kvPutGood({}, 'n', { v: 7 });
  assert.deepEqual(await lg.kvGetGood({}, 'n'), { v: 7 });
});

test('page: browser keeps a 3-day copy of data-function answers, but not live prices or writes', async () => {
  const vm = require('node:vm');
  const { SCRIPTS, makeSandbox } = require('./dom-stub.js');
  const sb = makeSandbox();
  sb.Response = class { constructor(b, o) { this.body = b; this.status = o.status; this.ok = true; } };
  sb.window.fetch = sb.window.fetch || sb.fetch;
  vm.runInNewContext(SCRIPTS[0], sb, { filename: 'index.html#0' });
  const api = sb.window.__giFetchCache;
  assert.ok(api, 'fetch cache wrapper missing');
  for (const u of ['/.netlify/functions/fred-data', '/.netlify/functions/econ-extra', '/.netlify/functions/news-feed?q=x&lang=th']) assert.ok(api.CACHED.test(u), u);
  for (const u of ['/.netlify/functions/usdjpy', '/.netlify/functions/visitors', '/.netlify/functions/consensus-override', 'https://fapi.binance.com/x']) assert.ok(!api.CACHED.test(u), u);
});
