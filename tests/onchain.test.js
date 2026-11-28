// Unit tests for onchain.js — run with:  npm test
//
// The only risky logic in that function is guessing which field of the BGeometrics response holds
// the number, so it is pinned down here for each shape the API has been seen answering with.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../netlify/functions/onchain.js');

const { extractValue, METRICS } = __test;

test('extractValue handles a single object with a value field', () => {
  assert.equal(extractValue({ date: '2026-09-11', value: 0.512 }), 0.512);
});

test('extractValue handles arrays and {data:[…]} wrappers (newest entry last)', () => {
  assert.equal(extractValue([{ value: 0.4 }, { value: 0.512 }]), 0.512);
  assert.equal(extractValue({ data: [{ value: 0.4 }, { value: 0.512 }] }), 0.512);
  assert.equal(extractValue({ data: { value: 1.87 } }), 1.87);
});

test('extractValue prefers named fields over the first numeric key', () => {
  // "d" is numeric-looking but is a date placeholder — must not win over `value`.
  assert.equal(extractValue({ d: 20260911, value: 2.41 }), 2.41);
});

test('extractValue skips timestamp-like keys when falling back', () => {
  assert.equal(extractValue({ timestamp: 1757600000, unixTs: 1757600000, mvrv_ratio: 2.1 }), 2.1);
});

test('extractValue returns null for junk instead of NaN', () => {
  assert.equal(extractValue(null), null);
  assert.equal(extractValue({ timestamp: 1, date: '2026-09-11' }), null);
  assert.equal(extractValue('not a number'), null);
  assert.equal(extractValue({ value: 'abc' }), null);
});

test('only whitelisted metric slugs exist (the query string can never pick the upstream path)', () => {
  assert.deepEqual(Object.keys(METRICS).sort(), ['mvrv', 'mvrv-zscore', 'nupl']);
  assert.ok(METRICS.nupl.every((s) => /^[a-z0-9/-]+$/.test(s) && !s.includes('..')));
});

test('extractValue never mistakes the "d" date string for the value', () => {
  assert.equal(extractValue({ d: '2026-11-26', unixTs: 1795651200, other: 0.5 }), 0.5);
});

test('handler keeps the last good value in KV: served without an upstream call while fresh, as stale after a 429', async (t) => {
  const { handler } = require('../netlify/functions/onchain.js');
  const lg = require('../netlify/lib/last-good.js');
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; __test._clearCache(); lg._resetThrottle(); });
  const store = new Map();
  const kv = { get: async (k) => JSON.parse(store.get(k) || 'null'), put: async (k, v) => { store.set(k, v); } };
  const ev = { cloudflare: { kv }, queryStringParameters: { metric: 'mvrv' } };
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ d: '2026-11-26', unixTs: 1795651200, mvrv: 1.1 }) }; };
  __test._clearCache(); lg._resetThrottle();
  let res = await handler(ev);
  assert.equal(JSON.parse(res.body).value, 1.1);
  assert.ok(store.has('onchain:mvrv'));
  // a new isolate (empty memory) reads KV instead of calling the upstream again
  __test._clearCache();
  res = await handler(ev);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(res.body).value, 1.1);
  // older than the TTL and the upstream says 429 → stale value, not a 502
  const saved = JSON.parse(store.get('onchain:mvrv'));
  saved.data.fetchedAt = new Date(Date.now() - 2 * 86400000).toISOString();
  store.set('onchain:mvrv', JSON.stringify(saved));
  __test._clearCache();
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  res = await handler(ev);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).stale, true);
  assert.equal(JSON.parse(res.body).value, 1.1);
});

test('after a 429 the handler stops asking BGeometrics for a while instead of burning the quota again', async (t) => {
  const { handler } = require('../netlify/functions/onchain.js');
  __test._clearCache();
  let calls = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  t.after(() => { global.fetch = realFetch; __test._clearCache(); });
  const a = await handler({ queryStringParameters: { metric: 'nupl' } });
  assert.equal(a.statusCode, 502);
  assert.equal(calls, 1, 'one 429 is enough: the other slugs share the same quota');
  const b = await handler({ queryStringParameters: { metric: 'mvrv' } });
  assert.equal(b.statusCode, 502);
  assert.equal(calls, 1, 'cooling down: no upstream call');
  assert.match(b.headers['Cache-Control'], /max-age=300/);
});

test('a failed answer says whether a token is configured, never the token itself', async (t) => {
  const { handler } = require('../netlify/functions/onchain.js');
  __test._clearCache();
  const realFetch = global.fetch, prev = process.env.BGEOMETRICS_TOKEN;
  process.env.BGEOMETRICS_TOKEN = 'secret-token-123';
  global.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  t.after(() => { global.fetch = realFetch; if (prev === undefined) delete process.env.BGEOMETRICS_TOKEN; else process.env.BGEOMETRICS_TOKEN = prev; __test._clearCache(); });
  const r = await handler({ queryStringParameters: { metric: 'nupl' } });
  assert.equal(JSON.parse(r.body).tokenConfigured, true);
  assert.doesNotMatch(r.body, /secret-token-123/);
});
