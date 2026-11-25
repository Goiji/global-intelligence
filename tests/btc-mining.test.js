// BTC mining: cost to mine 1 BTC + "are miners selling?" (function + BTC tab wiring). Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fn = require('../netlify/functions/btc-mining.js');
const T = fn.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400;
const t0 = Date.UTC(2025, 10, 1) / 1000; // 2025-11-01
const N = 390;
const TWO32 = 4294967296;

// mempool /mining/hashrate/1y: one point per day; difficulty set so blocks/day = 144 exactly
function hashJson(ehAt) {
  const hashrates = [], difficulty = [];
  for (let i = 0; i < N; i++) {
    const h = ehAt(i) * 1e18;
    hashrates.push({ timestamp: t0 + i * DAY, avgHashrate: h });
    if (i % 14 === 0) difficulty.push({ time: t0 + i * DAY, height: 920000 + i * 144, difficulty: h * 600 / TWO32, adjustment: 0 });
  }
  return { hashrates, difficulty, currentHashrate: hashrates[N - 1].avgHashrate, currentDifficulty: difficulty[difficulty.length - 1].difficulty };
}
const kraken = (priceAt) => ({ error: [], result: { XXBTZUSD: Array.from({ length: N }, (_, i) => [t0 + i * DAY, '1', '1', '1', String(priceAt(i)), '1', '1', 1]), last: 0 } });
const fees = { startBlock: 975000, endBlock: 976007, totalFee: String(1008 * 0.02 * 1e8), totalReward: '0', totalTx: '0' };

test('subsidy follows the halvings', () => {
  assert.equal(T.subsidyAt(0), 50);
  assert.equal(T.subsidyAt(840000), 3.125);
  assert.equal(T.subsidyAt(1049999), 3.125);
  assert.equal(T.subsidyAt(1050000), 1.5625);
});

test('hash ribbons: normal, capitulation and recovery', () => {
  const rising = T.parseHashrate(hashJson((i) => 800 + i));
  assert.equal(T.hashRibbons(rising.days).state, 'normal');

  // falls over the last 20 days → 30d average drops under the 60d one
  const falling = T.parseHashrate(hashJson((i) => (i < N - 20 ? 1000 : 1000 - (i - (N - 20)) * 15)));
  const f = T.hashRibbons(falling.days);
  assert.equal(f.state, 'capitulation');
  assert.ok(f.sma30 < f.sma60);

  // a dip 60 days ago then a strong rebound → crossed back up recently
  const dip = (i) => (i < N - 60 ? 1000 : i < N - 35 ? 800 : 1300);
  const r = T.hashRibbons(T.parseHashrate(hashJson(dip)).days);
  assert.ok(['recovery', 'normal'].includes(r.state));
  const rec = T.hashRibbons(T.parseHashrate(hashJson(dip)).days.slice(0, N - 20));
  assert.equal(rec.state, 'recovery', 'shortly after the cross');
  assert.ok(rec.days <= 14);
});

test('Puell Multiple: flat price = 1, today at double the yearly average ≈ 2', () => {
  const h = T.parseHashrate(hashJson(() => 1000));
  assert.equal(T.puellMultiple(h.days, T.parsePrices(kraken(() => 100000)), 976000), 1);
  const p = T.puellMultiple(h.days, T.parsePrices(kraken((i) => (i >= N - 3 ? 200000 : 100000))), 976000);
  assert.ok(p > 1.9 && p < 2.05, String(p));
  assert.equal(T.puellMultiple(h.days.slice(-100), T.parsePrices(kraken(() => 1)), 976000), null, 'needs ~a year');
});

test('parsePrices reads Kraken and CoinGecko shapes', () => {
  const k = T.parsePrices(kraken((i) => 1000 + i));
  assert.equal(k.get('2025-11-01'), 1000);
  const g = T.parsePrices({ prices: Array.from({ length: 40 }, (_, i) => [(t0 + i * DAY) * 1000, 5 + i]) });
  assert.equal(g.get('2025-11-02'), 6);
  assert.throws(() => T.parsePrices({ result: {} }), /no usable/);
});

test('handler: builds the payload, caches it, 502 when mempool is down', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const seen = [];
  const body = (j) => ({ ok: true, status: 200, text: async () => JSON.stringify(j) });
  global.fetch = async (url) => {
    seen.push(url);
    if (url === T.URL_HASH) return body(hashJson((i) => 900 + i * 0.5));
    if (url === T.URL_FEES) return body(fees);
    if (url === T.URL_KRAKEN) return body(kraken(() => 95000));
    return { ok: false, status: 404 };
  };
  T._clearCache();
  let res = await fn.handler({});
  let d = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(d.height, 976007);
  assert.equal(d.subsidy, 3.125);
  assert.equal(d.feePerBlock, 0.02);
  assert.equal(d.price, 95000);
  assert.equal(d.puell, 1);
  assert.equal(d.ribbon.state, 'normal');
  assert.ok(d.difficulty > 0 && d.hashrateEh > 1000);
  assert.ok(d.hist.length > 100 && d.hist[0].length === 3);
  d = JSON.parse((await fn.handler({})).body);
  assert.equal(d.cached, true);
  assert.equal(seen.filter((u) => u === T.URL_HASH).length, 1);

  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  res = await fn.handler({});
  assert.equal(res.statusCode, 502);
});

test('handler: carries on without fees or prices (no Puell, no made-up price)', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  global.fetch = async (url) => (url === T.URL_HASH ? { ok: true, status: 200, text: async () => JSON.stringify(hashJson(() => 1000)) } : { ok: false, status: 503 });
  T._clearCache();
  const d = JSON.parse((await fn.handler({})).body);
  assert.equal(d.feePerBlock, null);
  assert.equal(d.price, null);
  assert.equal(d.puell, null);
});

async function pageWith(mining, price) {
  const fetchImpl = async (url) => {
    if (String(url).includes('/.netlify/functions/btc-mining')) return { ok: true, status: 200, json: async () => mining };
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  const sb = makeSandbox({ fetchImpl });
  if (price) sb.document.getElementById('priceInput').value = String(price);
  return runAllScripts(sb);
}

test('cost model: realistic network numbers', async () => {
  const sb = await pageWith({});
  const M = sb.__mineTest;
  // ~150 T difficulty, 22 J/TH, $0.05/kWh, 3.125 + 0.02 BTC per block
  const c = M.mineCost(150e12, 3.125, 0.02, 0.05, 22);
  const kwh = 150e12 * TWO32 / 1e12 * 22 / 3.6e6;
  assert.ok(Math.abs(c.elec - kwh * 0.05 / 3.145) < 1e-6);
  assert.ok(c.elec > 40000 && c.elec < 90000, String(c.elec));
  assert.ok(Math.abs(c.allIn - c.elec / 0.6) < 1e-6);
  assert.equal(M.mineCost(0, 3.125, 0, 0.05, 22), null);
  const hp = M.mineHashprice(150e12, 3.145, 100000);
  assert.ok(hp > 30 && hp < 60, String(hp)); // US$/PH/day
});

test('margin and miner verdicts', async () => {
  const sb = await pageWith({});
  const M = sb.__mineTest;
  const c = { elec: 60000, allIn: 100000 };
  assert.equal(M.mineMarginVerdict(50000, c).key, 'cash');
  assert.equal(M.mineMarginVerdict(80000, c).key, 'loss');
  assert.equal(M.mineMarginVerdict(110000, c).key, 'thin');
  assert.equal(M.mineMarginVerdict(130000, c).key, 'healthy');
  assert.equal(M.minerVerdict('capitulation', 1, 0.3, false).key, 'stress');
  assert.equal(M.minerVerdict('normal', 1, 0.3, true).key, 'stress');
  assert.equal(M.minerVerdict('normal', 0.4, 0.3, false).key, 'stress');
  assert.equal(M.minerVerdict('normal', 2.3, 0.6, false).key, 'profit');
  assert.equal(M.minerVerdict('recovery', 0.9, 0.1, false).key, 'recovery');
  assert.equal(M.minerVerdict('normal', 0.9, 0.4, false).key, 'hold');
  assert.equal(M.minerVerdict('normal', 1.4, 0.4, false).key, 'normal');
  assert.equal(M.minerVerdict('normal', 0.9, 0.1, false).key, 'normal');
});

test('tiles render from the function, with the page's BTC price and fixed cost assumptions', async () => {
  const mining = { height: 976007, date: '2026-11-24', difficulty: 150e12, hashrateEh: 1074, subsidy: 3.125, feePerBlock: 0.02, price: 90000, puell: 0.9,
    ribbon: { state: 'capitulation', days: 12, sma30: 1050, sma60: 1080 }, hist: [['2026-11-23', 1060, 1080], ['2026-11-24', 1050, 1080]] };
  const sb = await pageWith(mining, 120000);
  const g = (id) => sb.document.getElementById(id);
  await new Promise((r) => setImmediate(r));
  assert.match(g('mineCost').textContent, /^\$\d+(\.\d)?k$/);
  assert.ok(['healthy', 'thin', 'loss', 'cash'].includes(g('mineCost').dataset.verdict));
  assert.equal(g('mineCost').dataset.verdict, g('mineCostZone').dataset.verdict, 'number and label agree');
  assert.match(g('mineCostSub').textContent, /\$120k/, 'uses the price on the page');
  assert.match(g('mineNet').textContent, /Hashprice \$\d/);
  assert.equal(g('mineVerdict').dataset.verdict, 'stress');
  assert.match(g('mineVerdict').textContent, /ถูกบีบ/);
  assert.match(g('mineSigs').innerHTML, /Hash Ribbons[\s\S]*12 วัน[\s\S]*Puell Multiple[\s\S]*0\.90/);
  assert.match(g('mineRibbon').innerHTML, /<svg[\s\S]*1050 \/ 1080 EH\/s/);
});

test('index.html: miners panel sits in the BTC tab, above the halving countdown', () => {
  assert.doesNotMatch(HTML, /id="mineKwh"|id="mineEff"/, 'no visitor inputs: fixed network-average assumptions');
  for (const id of ['mineCost', 'mineCostZone', 'mineScale', 'mineCostSub', 'mineNet', 'mineVerdict', 'mineWhy', 'mineSigs', 'mineRibbon']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const btc = HTML.indexOf('<section id="btcTab"'), mine = HTML.indexOf('id="mineCost"'), halving = HTML.indexOf('id="halvingDays"');
  assert.ok(btc > 0 && btc < mine && mine < halving);
  assert.match(HTML, /fetchRekt\(\), fetchMining\(\)\]\)/);
  assert.match(HTML, /country-profiles\|btc-mining[|)]/, 'browser keeps a last good copy');
  assert.match(HTML, /cryptoquant\.com\/asset\/btc\/chart\/miner-flows\/miner-reserve/);
});

test('Cloudflare adapter routes /.netlify/functions/btc-mining', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(src, /import btcMining from '\.\.\/netlify\/functions\/btc-mining\.js'/);
  assert.match(src, /'btc-mining': btcMining/);
});
