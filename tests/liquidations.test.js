// BTC liquidations 1h/4h/12h/24h (Coinalyze) — function + card. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fn = require('../netlify/functions/liquidations.js');
const T = fn.__test;
const { HTML, SCRIPTS, makeSandbox } = require('./dom-stub.js');

const EXCHANGES = [{ name: 'Binance', code: 'A' }, { name: 'Bybit', code: '6' }, { name: 'OKX', code: '3' }, { name: 'Tiny', code: 'Z' }];
const MARKETS = [
  { symbol: 'BTCUSD_PERP.Z', exchange: 'Z', base_asset: 'BTC', quote_asset: 'USD', is_perpetual: true },
  { symbol: 'ETHUSDT_PERP.A', exchange: 'A', base_asset: 'ETH', quote_asset: 'USDT', is_perpetual: true },
  { symbol: 'BTCUSDT_PERP.3', exchange: '3', base_asset: 'BTC', quote_asset: 'USDT', is_perpetual: true },
  { symbol: 'BTCUSDT_250926.A', exchange: 'A', base_asset: 'BTC', quote_asset: 'USDT', is_perpetual: false },
  { symbol: 'BTCUSD_PERP.A', exchange: 'A', base_asset: 'BTC', quote_asset: 'USD', is_perpetual: true },
  { symbol: 'BTCUSDT_PERP.A', exchange: 'A', base_asset: 'BTC', quote_asset: 'USDT', is_perpetual: true },
  { symbol: 'BTCUSDT.6', exchange: '6', base_asset: 'BTC', quote_asset: 'USDT', is_perpetual: true }
];

test('pickBtcPerps: BTC perpetuals only, big exchanges first, USDT before USD, capped', () => {
  const p = T.pickBtcPerps(MARKETS, EXCHANGES);
  assert.deepEqual(p.map((x) => x.symbol), ['BTCUSDT_PERP.A', 'BTCUSD_PERP.A', 'BTCUSDT.6', 'BTCUSDT_PERP.3', 'BTCUSD_PERP.Z']);
  assert.equal(p[2].exchange, 'Bybit');
  assert.equal(T.pickBtcPerps(MARKETS, EXCHANGES, 2).length, 2);
  // a third Binance contract waits until every exchange has its first two
  const more = MARKETS.concat([{ symbol: 'BTCUSDC_PERP.A', exchange: 'A', base_asset: 'BTC', quote_asset: 'USDC', is_perpetual: true }]);
  assert.deepEqual(T.pickBtcPerps(more, EXCHANGES, 5).map((x) => x.symbol), ['BTCUSDT_PERP.A', 'BTCUSD_PERP.A', 'BTCUSDT.6', 'BTCUSDT_PERP.3', 'BTCUSD_PERP.Z']);
  assert.equal(T.pickBtcPerps(more, EXCHANGES, 6)[5].symbol, 'BTCUSDC_PERP.A');
});

test('sumLiquidations: rolling 1/4/12/24h windows, long vs short, per exchange', () => {
  const now = Date.UTC(2026, 10, 22, 12, 0);
  const at = (hAgo) => Math.floor((now - hAgo * 3600000) / 1000);
  const picked = [{ symbol: 'A1', exchange: 'Binance' }, { symbol: 'B1', exchange: 'Bybit' }];
  const rows = [
    { symbol: 'A1', history: [{ t: at(0.5), l: 100, s: 10 }, { t: at(3), l: 1000, s: 0 }, { t: at(10), l: 0, s: 500 }, { t: at(30), l: 9e9, s: 9e9 }] },
    { symbol: 'B1', history: [{ t: at(20), l: 200, s: 300 }, { t: at(1), l: 'x', s: 5 }] }
  ];
  const r = T.sumLiquidations(rows, picked, now);
  assert.deepEqual(r.windows['1h'], { long: 100, short: 10, total: 110 });
  assert.deepEqual(r.windows['4h'], { long: 1100, short: 10, total: 1110 });
  assert.deepEqual(r.windows['12h'], { long: 1100, short: 510, total: 1610 });
  assert.deepEqual(r.windows['24h'], { long: 1300, short: 810, total: 2110 });
  assert.deepEqual(r.exchanges.map((e) => [e.name, e.total]), [['Binance', 1610], ['Bybit', 500]]);
  assert.equal(r.points, 4);
});

test('handler: no key → 503 missing-key; with key → sums from one history call', async (t) => {
  const realFetch = global.fetch, realKey = process.env.COINALYZE_API_KEY;
  t.after(() => { global.fetch = realFetch; T._clearCache(); if (realKey === undefined) delete process.env.COINALYZE_API_KEY; else process.env.COINALYZE_API_KEY = realKey; });
  delete process.env.COINALYZE_API_KEY;
  T._clearCache();
  let res = await fn.handler({});
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, 'missing-key');

  process.env.COINALYZE_API_KEY = 'k';
  const seen = [];
  const now = Math.floor(Date.now() / 1000);
  global.fetch = async (url) => {
    seen.push(url);
    const body = url.includes('/future-markets') ? MARKETS : url.includes('/exchanges') ? EXCHANGES
      : [{ symbol: 'BTCUSDT_PERP.A', history: [{ t: now - 600, l: 2e6, s: 1e6 }] }, { symbol: 'BTCUSDT.6', history: [{ t: now - 7200, l: 0, s: 4e6 }] }];
    return { ok: true, status: 200, json: async () => body };
  };
  T._clearCache();
  res = await fn.handler({});
  const body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(body.windows['1h'], { long: 2e6, short: 1e6, total: 3e6 });
  assert.deepEqual(body.windows['24h'], { long: 2e6, short: 5e6, total: 7e6 });
  assert.equal(body.exchanges[0].name, 'Bybit');
  const hist = seen.find((u) => u.includes('/liquidation-history'));
  assert.match(hist, /interval=5min/);
  assert.match(hist, /convert_to_usd=true/);
  assert.match(hist, /api_key=k/);
  assert.match(decodeURIComponent(hist), /symbols=BTCUSDT_PERP\.A,BTCUSD_PERP\.A,BTCUSDT\.6/);

  // upstream down → the last good answer, marked stale
  global.fetch = async () => ({ ok: false, status: 500 });
  res = await fn.handler({});
  assert.equal(JSON.parse(res.body).cached, true);
});

test('card: four boxes, CoinGlass link, source note, wired into the Cloudflare adapter', async () => {
  for (const w of ['1h', '4h', '12h']) assert.match(HTML, new RegExp(`class="rekt-row" data-w="${w}"`));
  assert.match(HTML, /id="rektBar24"/);
  assert.match(HTML, /href="https:\/\/www\.coinglass\.com\/LiquidationData"/);
  assert.match(HTML, /id="rektNote"/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8'), /liquidations from '\.\.\/netlify\/functions\/liquidations\.js'/);

  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const api = sandbox.window.__rektTest;
  assert.equal(api.rektPct({ long: 192, short: 808, total: 1000 }, 'long'), '19.2%');
  assert.equal(api.fmtRekt(1.57e9), '$1.57B');
  assert.equal(api.fmtRekt(36.59e6), '$36.59M');
  assert.equal(api.fmtRekt(757810), '$757.8K');
  assert.equal(api.rektZone({ long: 80, short: 20, total: 100 })[0], '🔴');
  assert.equal(api.rektZone({ long: 50, short: 50, total: 100 })[0], '🟡');
  assert.equal(api.rektZone({ long: 20, short: 80, total: 100 })[0], '🟢');
  assert.equal(api.rektZone({ long: 0, short: 0, total: 0 }), null);
});
