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
