// BTC spot ETF flow — function + tile wiring. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const etf = require('../netlify/functions/etf-flow.js');
const T = etf.__test;
const { HTML } = require('./dom-stub.js');

const FARSIDE = `<html><body><table class="etf">
<tr><th></th><th>Blackrock</th><th>Fidelity</th><th>Grayscale</th><th></th></tr>
<tr><th><span class="tabletext">Date</span></th><th>IBIT</th><th>FBTC</th><th>GBTC</th><th>Total</th></tr>
<tr><td>Fee</td><td>0.25%</td><td>0.25%</td><td>1.50%</td><td></td></tr>
<tr><td>11 Nov 2026</td><td>120.5</td><td>(10.0)</td><td>0.0</td><td>110.5</td></tr>
<tr><td>12 Nov 2026</td><td>1,050.2</td><td>40.0</td><td><span class="redFont">(90.2)</span></td><td>1,000.0</td></tr>
<tr><td>13 Nov 2026</td><td>(300.0)</td><td>-</td><td>(250.5)</td><td><span class="redFont">(550.5)</span></td></tr>
<tr><td>14 Nov 2026</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>
<tr><td>Total</td><td>60,000</td><td>12,000</td><td>(22,000)</td><td>50,000</td></tr>
</table></body></html>`;

test('num / isoDate: parentheses are negative, dashes are blank', () => {
  assert.equal(T.num('(56.7)'), -56.7);
  assert.equal(T.num('1,234.5'), 1234.5);
  assert.equal(T.num('-'), null);
  assert.equal(T.isoDate('3 Jan 2025'), '2025-01-03');
  assert.equal(T.isoDate('Total'), null);
});

test('parseFarside: daily totals, 5/30-day sums, biggest funds of the latest day, blank day skipped', () => {
  const d = T.parseFarside(FARSIDE);
  assert.equal(d.date, '2026-11-13');
  assert.equal(d.net, -550.5);
  assert.equal(d.prev, 1000);
  assert.equal(d.sum5, 560);
  assert.deepEqual(d.hist, [['2026-11-11', 110.5], ['2026-11-12', 1000], ['2026-11-13', -550.5]]);
  assert.deepEqual(d.funds, [['IBIT', -300], ['GBTC', -250.5]]);
  assert.throws(() => T.parseFarside('<html><title>Just a moment...</title></html>'), /cloudflare challenge/);
});

test('parseSoso: USD → US$m, newest-first input, bare or wrapped array', () => {
  const rows = [{ date: '2026-11-13', total_net_inflow: -55066297 }, { date: '2026-11-12', total_net_inflow: 91269283 }];
  for (const body of [rows, { code: 0, data: rows }]) {
    const d = T.parseSoso(JSON.stringify(body));
    assert.equal(d.date, '2026-11-13');
    assert.equal(d.net, -55.1);
    assert.equal(d.prev, 91.3);
  }
  assert.throws(() => T.parseSoso(JSON.stringify({ code: 401, message: 'bad key' })), /bad key/);
});

test('handler: Farside first, allorigins next, SoSoValue only with a key, KV last-good, 502', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; delete process.env.SOSOVALUE_API_KEY; T._clearCache(); });
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const seen = [];
  global.fetch = async (url) => { seen.push(url); return url.startsWith('https://farside.co.uk') ? ok(FARSIDE) : { ok: false, status: 500 }; };
  T._clearCache();
  let body = JSON.parse((await etf.handler({})).body);
  assert.equal(body.source, 'farside');
  assert.equal(body.net, -550.5);

  global.fetch = async (url) => url.includes('allorigins') ? ok(FARSIDE) : { ok: false, status: 403 };
  T._clearCache();
  body = JSON.parse((await etf.handler({})).body);
  assert.equal(body.source, 'farside:allorigins');

  seen.length = 0;
  global.fetch = async (url) => { seen.push(url); return { ok: false, status: 403 }; };
  T._clearCache();
  assert.equal((await etf.handler({})).statusCode, 502);
  assert.equal(seen.length, 2, 'no SoSoValue call without a key');

  process.env.SOSOVALUE_API_KEY = 'k';
  let sentKey;
  global.fetch = async (url, opt) => { if (url.includes('sosovalue')) { sentKey = opt.headers['x-soso-api-key']; return ok(JSON.stringify([{ date: '2026-11-13', total_net_inflow: 2e8 }])); } return { ok: false, status: 403 }; };
  T._clearCache();
  const kvData = new Map();
  const kv = { put: async (k, v) => kvData.set(k, v), get: async (k) => JSON.parse(kvData.get(k) || 'null') };
  require('../netlify/lib/last-good.js')._resetThrottle();
  body = JSON.parse((await etf.handler({ cloudflare: { kv } })).body);
  assert.equal(body.source, 'sosovalue');
  assert.equal(body.net, 200);
  assert.equal(sentKey, 'k');

  // a fresh isolate (empty memory) whose sources all fail serves the KV copy, marked stale
  global.fetch = async () => ({ ok: false, status: 403 });
  T._clearCache();
  const res = await etf.handler({ cloudflare: { kv } });
  body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.stale, true);
  assert.equal(body.net, 200);
});

test('index.html: ETF flow tile on the BTC tab with explainer, bars and a Farside link', () => {
  for (const id of ['etfNum', 'etfZone', 'etfSums', 'etfBars']) assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /aria-label="ETF Flow คืออะไร" data-en-aria="What is ETF flow\?"/);
  assert.match(HTML, /href="https:\/\/farside\.co\.uk\/btc\/"/);
  assert.ok(HTML.indexOf('id="dvolNum"') < HTML.indexOf('id="etfNum"') && HTML.indexOf('id="etfNum"') < HTML.indexOf('id="halvingDays"'));
  assert.match(HTML, /fetchDvol\(\), fetchEtfFlow\(\)\]/);
  assert.match(HTML, /bindEtfTip\(el\('etfBars'\)/, 'hover/tap tooltip on the bars');
  assert.match(HTML, /class="etf-tip" hidden/);
  assert.match(HTML, /\/\.netlify\/functions\/etf-flow/);
});
