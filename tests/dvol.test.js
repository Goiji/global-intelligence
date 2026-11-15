// BTC DVOL (Deribit implied-volatility index) — function + tile wiring. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const dvol = require('../netlify/functions/dvol.js');
const T = dvol.__test;
const { HTML } = require('./dom-stub.js');

const DAY = 86400000;
const t0 = Date.UTC(2026, 10, 12);
const candles = (closes) => JSON.stringify({ jsonrpc: '2.0', result: { data: closes.map((c, i) => [t0 + i * DAY, c, c + 1, c - 1, c]), continuation: null } });

test('parseDvol: daily closes, change vs previous day, bad candles ignored', () => {
  const d = T.parseDvol(JSON.stringify({ result: { data: [[t0, 50, 51, 49, 48.123], [t0 + DAY, 1, 1, 1, 'x'], [t0 + DAY, 48, 55, 47, 52.5], [t0 + 2 * DAY, 9999, 9999, 9999, 9999]] } }), 366);
  assert.equal(d.latest, 52.5);
  assert.equal(d.prev, 48.12);
  assert.equal(d.change, 4.38);
  assert.equal(d.date, '2026-11-13');
  assert.deepEqual(d.hist, [['2026-11-12', 48.12], ['2026-11-13', 52.5]]);
  assert.throws(() => T.parseDvol(JSON.stringify({ error: { message: 'bad_request' } })), /deribit: bad_request/);
  assert.throws(() => T.parseDvol(JSON.stringify({ result: { data: [] } })), /no usable candles/);
});

test('handler: daily candles first, hourly fallback, 502 when Deribit is down', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const seen = [];
  global.fetch = async (url) => { seen.push(url); return url.includes('resolution=1D') ? ok(candles([44, 46.5, 49])) : { ok: false, status: 503 }; };
  T._clearCache();
  let body = JSON.parse((await dvol.handler()).body);
  assert.equal(body.latest, 49);
  assert.equal(body.change, 2.5);
  assert.equal(body.source, 'deribit:1D');
  assert.equal(body.hist.length, 3);
  assert.match(seen[0], /get_volatility_index_data\?currency=BTC&resolution=1D/);

  global.fetch = async (url) => url.includes('resolution=3600') ? ok(candles([61])) : { ok: false, status: 503 };
  T._clearCache();
  body = JSON.parse((await dvol.handler()).body);
  assert.equal(body.latest, 61);
  assert.equal(body.source, 'deribit:1h');

  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  const res = await dvol.handler();
  assert.equal(res.statusCode, 502);
});

test('index.html: DVOL tile in the BTC Sentiment panel with explainer, spark and TradingView DERIBIT:DVOL', () => {
  for (const id of ['dvolNum', 'dvolZone', 'spDvol']) assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /tradingview\.com\/chart\/\?symbol=DERIBIT%3ADVOL/);
  assert.match(HTML, /aria-label="DVOL คืออะไร" data-en-aria="What is DVOL\?"/);
  const btc = HTML.indexOf('id="btcTab"');
  assert.ok(btc > 0 && HTML.indexOf('id="oiNum"') < HTML.indexOf('id="dvolNum"') && HTML.indexOf('id="dvolNum"') < HTML.indexOf('id="halvingDays"'));
  assert.match(HTML, /fetchHalvingCountdown\(\), fetchDvol\(\)\]/);
  assert.match(HTML, /\/\.netlify\/functions\/dvol/);
});
