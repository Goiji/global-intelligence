// Stablecoin market cap (≈ CRYPTOCAP:STABLE.C) — function + BTC tile wiring. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../netlify/functions/stablecoins.js');
const T = sc.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY_S = 86400;
const t0 = Date.UTC(2026, 9, 1) / 1000; // 2026-10-01
// one DefiLlama-style row per day; `usd` in US$ bn, plus a small EUR peg that must be added in
const rows = (vals) => vals.map((usd, i) => ({
  date: String(t0 + i * DAY_S),
  totalCirculating: { peggedUSD: usd * 1e9 },
  totalCirculatingUSD: { peggedUSD: usd * 1e9, peggedEUR: 0.5e9 }
}));
// 31 days: 300 → 330 linear (+1/day); latest = 330.5 incl. EUR
const RISING = rows(Array.from({ length: 31 }, (_, i) => 300 + i));

test('parseStablecoins: sums every peg, 7- and 30-day change, bad rows skipped', () => {
  const d = T.parseStablecoins(JSON.stringify([...RISING, { date: 'x', totalCirculatingUSD: { peggedUSD: 1e12 } }, { date: String(t0 + 40 * DAY_S) }]));
  assert.equal(d.latest, 330.5);
  assert.equal(d.date, '2026-10-31');
  assert.equal(d.ch7, 7);
  assert.equal(d.ch7Pct, Math.round((330.5 / 323.5 - 1) * 10000) / 100);
  assert.equal(d.ch30, 30);
  assert.equal(d.ch30Pct, Math.round((330.5 / 300.5 - 1) * 10000) / 100);
  assert.equal(d.hist.length, 31);
  assert.deepEqual(d.hist[0], ['2026-10-01', 300.5]);
  assert.throws(() => T.parseStablecoins('[]'), /no usable rows/);
});

test('parseStablecoins: too little history → changes are null, not made up', () => {
  const d = T.parseStablecoins(rows([300, 301, 302]));
  assert.equal(d.ch7, null);
  assert.equal(d.ch30Pct, null);
});

test('handler: DefiLlama first, served from memory, 502 when it is down and nothing is cached', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const seen = [];
  global.fetch = async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => JSON.stringify(RISING) }; };
  T._clearCache();
  let res = await sc.handler({});
  let body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(body.latest, 330.5);
  assert.equal(body.source, 'defillama');
  assert.equal(seen[0], 'https://stablecoins.llama.fi/stablecoincharts/all');
  body = JSON.parse((await sc.handler({})).body);
  assert.equal(body.cached, true);
  assert.equal(seen.length, 1, 'second call answered from memory');

  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  res = await sc.handler({});
  assert.equal(res.statusCode, 502);
});

test('the function never touches Cloudflare KV (keeps the daily KV quota for other cards)', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  let kvCalls = 0;
  const kv = { get: async () => { kvCalls++; return null; }, put: async () => { kvCalls++; } };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(RISING) });
  T._clearCache();
  await sc.handler({ cloudflare: { kv } });
  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  await sc.handler({ cloudflare: { kv } });
  assert.equal(kvCalls, 0);
});

async function pageWith(stable) {
  const fetchImpl = async (url) => {
    if (String(url).includes('/.netlify/functions/stablecoins')) return { ok: true, status: 200, json: async () => stable };
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  return runAllScripts(makeSandbox({ fetchImpl }));
}

test('stableVerdict: green inflow, amber flat, red outflow', async () => {
  const sb = await pageWith({});
  const V = sb.__stableTest.stableVerdict;
  assert.equal(V(0.5, 3).key, 'in');
  assert.equal(V(1.2, 0.2).key, 'in');
  assert.equal(V(-0.5, 3).key, 'flat', '30-day growth fading this week');
  assert.equal(V(0.1, 0.4).key, 'flat');
  assert.equal(V(-1.1, 2).key, 'out');
  assert.equal(V(0.2, -1.6).key, 'out');
  assert.equal(V(-4.21, null).key, 'out');
  assert.equal(V(null, null).key, 'none');
  assert.equal(V(0.5, 3).color, 'var(--green)');
  assert.equal(V(0.1, 0.4).color, 'var(--amber)');
  assert.equal(V(-1.1, 2).color, 'var(--red)');
});

test('tile: number colour and the reading below it come from the same verdict', async () => {
  const cases = [
    [{ ch7: 3, ch7Pct: 1.02, ch30: 9, ch30Pct: 3.1 }, 'in', 'var(--green)', /เงินไหลเข้า/],
    [{ ch7: 0.3, ch7Pct: 0.1, ch30: 1, ch30Pct: 0.3 }, 'flat', 'var(--amber)', /ทรงตัว/],
    [{ ch7: -13, ch7Pct: -4.21, ch30: -20, ch30Pct: -6.4 }, 'out', 'var(--red)', /เงินไหลออก/]
  ];
  for (const [ch, key, color, re] of cases) {
    const sb = await pageWith({ latest: 294.75, date: '2026-11-19', hist: [['2026-11-18', 300], ['2026-11-19', 294.75]], source: 'defillama', ...ch });
    const num = sb.document.getElementById('stableNum'), read = sb.document.getElementById('stableRead');
    assert.match(num.innerHTML, /^\$294\.75B/);
    assert.equal(num.style.color, color);
    assert.equal(num.dataset.verdict, key);
    assert.equal(read.dataset.verdict, key, 'reading uses the same verdict as the number');
    assert.equal(read.hidden, false);
    assert.match(read.innerHTML, re);
    assert.match(sb.document.getElementById('stableZone').textContent, re);
    assert.match(sb.document.getElementById('stableChanges').textContent, /7 วัน .*30 วัน /);
  }
});

test('stableFromLlama (direct fallback) matches the function', async () => {
  const sb = await pageWith({});
  const a = sb.__stableTest.stableFromLlama(RISING), b = T.parseStablecoins(RISING);
  for (const k of ['latest', 'date', 'ch7', 'ch7Pct', 'ch30', 'ch30Pct']) assert.equal(a[k], b[k], k);
});

test('index.html: stablecoin tile in the BTC Sentiment panel with explainer, spark and TradingView STABLE.C', () => {
  for (const id of ['stableNum', 'stableZone', 'stableChanges', 'stableRead', 'spStable']) assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /tradingview\.com\/chart\/\?symbol=CRYPTOCAP%3ASTABLE\.C/);
  assert.match(HTML, /aria-label="Stablecoin Market Cap คืออะไร" data-en-aria="What is the stablecoin market cap\?"/);
  assert.ok(HTML.indexOf('id="etfNum"') < HTML.indexOf('id="stableNum"') && HTML.indexOf('id="stableNum"') < HTML.indexOf('id="halvingDays"'));
  assert.match(HTML, /fetchEtfFlow\(\), fetchStablecoins\(\)/);
  assert.match(HTML, /etf-flow\|stablecoins\|news-feed/, 'browser keeps a last good copy');
});

test('Cloudflare adapter routes /.netlify/functions/stablecoins', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(src, /import stablecoins from '\.\.\/netlify\/functions\/stablecoins\.js'/);
  assert.match(src, /\bstablecoins,/);
});
