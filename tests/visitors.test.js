// Footer visitor counter (Netlify Function + Blobs) and the BTC open-interest colour zone — run with:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const fn = require('../netlify/functions/visitors.js');
const T = fn.__test;
const { SCRIPTS, makeSandbox } = require('./dom-stub.js');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('visitors: Bangkok date rolls over at 17:00 UTC', () => {
  assert.equal(T.bangkokDate(Date.UTC(2026, 10, 15, 16, 59)), '2026-11-15');
  assert.equal(T.bangkokDate(Date.UTC(2026, 10, 15, 17, 0)), '2026-11-16');
});

test('visitors: addVisit bumps total and today, drops junk and keeps 60 days', () => {
  const days = {};
  for (let i = 0; i < 70; i++) days[new Date(Date.UTC(2026, 0, 1) + i * 864e5).toISOString().slice(0, 10)] = 1;
  const v = T.addVisit({ total: 5, days: { ...days, bad: 3, '2026-02-01': -1 } }, '2026-11-15');
  assert.equal(v.total, 6);
  assert.equal(v.days['2026-11-15'], 1);
  assert.equal(Object.keys(v.days).length, 60);
  assert.equal(v.days.bad, undefined);
  assert.deepEqual(T.normalize(null), { total: 0, days: {} });
});

test('visitors: POST counts, GET only reads, other methods 405', async () => {
  T.resetMemory();
  T.setStoreFactory(null);
  const get = async () => JSON.parse((await fn.handler({ httpMethod: 'GET' })).body);
  assert.equal((await get()).total, 0);
  await fn.handler({ httpMethod: 'POST' });
  const r = await fn.handler({ httpMethod: 'POST' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Cache-Control'], 'no-store');
  const body = await get();
  assert.equal(body.total, 2);
  assert.equal(body.today, 2);
  assert.equal((await fn.handler({ httpMethod: 'DELETE' })).statusCode, 405);
});

test('visitors: storage failure → 503, not a crash', async () => {
  T.setStoreFactory(() => ({ get: async () => { throw new Error('down'); }, setJSON: async () => {} }));
  const r = await fn.handler({ httpMethod: 'POST' });
  assert.equal(r.statusCode, 503);
  T.setStoreFactory(null);
});

test('index.html: footer has the visitor counter and calls the function', () => {
  assert.match(HTML, /<span id="visitorCount" hidden><\/span>/);
  assert.match(HTML, /\/\.netlify\/functions\/visitors/);
  assert.match(HTML, /gi-visit-day/);
});

test('open interest: colour zone from OI ÷ BTC supply', async () => {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const api = (sandbox.window && sandbox.window.__oiTest) || sandbox.__oiTest;
  const s = api.btcSupplyApprox(Date.UTC(2026, 10, 15));
  assert.ok(s > 20.0e6 && s < 20.2e6, 'supply ~20.1M BTC in Nov 2026: ' + s);
  assert.ok(api.btcSupplyApprox(Date.UTC(2040, 0, 1)) <= 21e6);
  assert.equal(api.oiLeverageZone(2.0).dot, '🟢');
  assert.equal(api.oiLeverageZone(2.9).dot, '🟡');
  assert.equal(api.oiLeverageZone(3.6).dot, '🟠');
  assert.equal(api.oiLeverageZone(5).dot, '🔴');
  assert.equal(api.oiLeverageZone(null), null);
  assert.match(HTML, /id="oiZone"/);
});

test('visitors: on Cloudflare the count lives in the STORE KV binding', async () => {
  const data = new Map();
  const kv = { get: async (k) => (data.has(k) ? JSON.parse(data.get(k)) : null), put: async (k, v) => { data.set(k, v); } };
  T.setStoreFactory(null);
  let out = await fn.handler({ httpMethod: 'POST', cloudflare: { kv } });
  assert.equal(JSON.parse(out.body).total, 1);
  out = await fn.handler({ httpMethod: 'GET', cloudflare: { kv } });
  assert.equal(JSON.parse(out.body).total, 1);
  assert.equal(JSON.parse(data.get('counts')).total, 1);
  T.setStoreFactory(null); // forget the count read above
  out = await fn.handler({ httpMethod: 'GET', cloudflare: { kv: null } });
  assert.equal(out.statusCode, 503);
});

test('visitors: plain loads reuse a recent count; a failing store still shows the last count', async () => {
  let reads = 0, fail = false;
  const data = new Map();
  T.setStoreFactory(() => ({ get: async (k) => { reads++; if (fail) throw new Error('429'); return data.get(k) || null; }, setJSON: async (k, v) => { if (fail) throw new Error('429'); data.set(k, v); } }));
  await fn.handler({ httpMethod: 'POST' });
  const r0 = reads;
  for (let i = 0; i < 5; i++) await fn.handler({ httpMethod: 'GET' });
  assert.equal(reads, r0, 'GETs within a minute hit memory, not KV');
  fail = true;
  const r = await fn.handler({ httpMethod: 'POST' });
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).total, 1);
  T.setStoreFactory(null);
});
