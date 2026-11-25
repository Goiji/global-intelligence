// On-chain section of the BTC tab (cost basis & MVRV, holders, power law, Strategy) and the two
// functions behind it. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const holders = require('../netlify/functions/btc-holders.js');
const treasury = require('../netlify/functions/btc-treasury.js');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400000;
const START = Date.UTC(2011, 5, 1);
const GENESIS = Date.UTC(2009, 0, 3);
const N = 5650; // ~ Jun 2011 → Nov 2026
const THAI = /[฀-๿]/;

// BGeometrics-shaped files. Price follows an exact power law (slope 5.8) with a slow wiggle; LTH
// supply falls over the last 30 days while STH supply rises (= distribution).
function rawFiles() {
  const rows = (from, f) => { const out = []; for (let i = from; i < N; i++) out.push([START + i * DAY, f(i)]); return out; };
  const age = (i) => (START + i * DAY - GENESIS) / DAY;
  const price = (i) => 1.0e-17 * Math.pow(age(i), 5.8) * Math.pow(10, 0.2 * Math.sin(i / 25));
  return {
    price: rows(0, price),
    rp: rows(0, (i) => price(i) * 0.7),
    lrp: [[START, null]].concat(rows(200, (i) => price(i) * 0.5)),
    srp: rows(N - 1460, (i) => price(i) * 1.1),
    ls: rows(940, (i) => 14e6 + (i < N - 30 ? i * 100 : (N - 30) * 100 - (i - (N - 30)) * 5000)),
    ss: rows(940, (i) => 5e6 + (i < N - 30 ? 0 : (i - (N - 30)) * 4000))
  };
}

test('btc-holders: build aligns every file onto one daily index and keeps nulls for gaps', () => {
  const d = holders.__test.build(rawFiles());
  assert.equal(d.start, '2011-06-01');
  assert.equal(d.days, N);
  for (const k of ['price', 'rp', 'lrp', 'srp', 'ls', 'ss']) assert.equal(d[k].length, N, k);
  assert.equal(d.lrp[0], null);
  assert.equal(d.srp[N - 1461], null);
  assert.ok(d.srp[N - 1] > 0);
  assert.equal(d.ls[N - 1], Math.round(d.ls[N - 1]));
  assert.throws(() => holders.__test.build({ price: [[START, 1]], rp: [], ls: [] }), /too little history/);
});

test('btc-holders handler: 200 with the aligned payload, last good copy when the source is down', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; holders.__test._clearCache(); });
  const raw = rawFiles(), seen = [];
  const byFile = Object.fromEntries(Object.entries(holders.__test.FILES).map(([k, f]) => [f, raw[k]]));
  global.fetch = async (url) => { seen.push(url); const f = url.split('/').pop().replace('.json', ''); return { ok: true, status: 200, text: async () => JSON.stringify(byFile[f]) }; };
  holders.__test._clearCache();
  const r = await holders.handler({});
  assert.equal(r.statusCode, 200);
  assert.equal(JSON.parse(r.body).days, N);
  assert.ok(seen.every((u) => u.startsWith('https://charts.bgeometrics.com/files/')));
  global.fetch = async () => ({ ok: false, status: 503 });
  holders.__test._clearCache();
  assert.equal((await holders.handler({})).statusCode, 502);
});

const CG = {
  entity: { name: 'Strategy', m_nav: 0.82, holdings: [{ coin_id: 'bitcoin', amount: 851305, percentage_of_total_supply: 4.054, current_value_usd: 50.6e9, total_entry_value_usd: 64.2e9, average_entry_value_usd: 75446, unrealized_pnl: -13.6e9 }] },
  history: { transactions: [
    { date: Date.UTC(2026, 10, 23), coin_id: 'bitcoin', type: 'buy', holding_net_change: 457, transaction_value_usd: 29658386, holding_balance: 851305, source_url: 'https://example.com/form-8-k_11-23-2026.pdf' },
    { date: Date.UTC(2026, 7, 10), coin_id: 'bitcoin', type: 'sell', holding_net_change: -1690, transaction_value_usd: 108602780, holding_balance: 850848, source_url: 'javascript:alert(1)' },
    { date: Date.UTC(2020, 7, 11), coin_id: 'bitcoin', type: 'buy', holding_net_change: 21454, transaction_value_usd: 250000000, holding_balance: 21454 }
  ] },
  list: { total_holdings: 1287588, companies: [{ name: 'Strategy', symbol: 'MSTR.US', country: 'US', total_holdings: 851305, total_entry_value_usd: 64.2e9 }, { name: 'Twenty One', symbol: 'XXI.US', total_holdings: 43514, total_entry_value_usd: 0 }] }
};

test('btc-treasury: shape keeps bitcoin holdings, sorts filings oldest first, drops unsafe links', () => {
  const d = treasury.__test.shape(CG.entity, CG.history, CG.list);
  assert.equal(d.strategy.holdings, 851305);
  assert.equal(d.strategy.mnav, 0.82);
  assert.deepEqual(d.tx.map((t) => t.date), ['2020-08-11', '2026-08-10', '2026-11-23']);
  assert.equal(d.tx[1].type, 'sell');
  assert.equal(d.tx[1].btc, 1690);
  assert.equal(d.tx[1].url, null, 'non-https source links are dropped');
  assert.equal(d.top[1].avgCost, null, 'a company with no disclosed cost has no average');
  assert.throws(() => treasury.__test.shape({ holdings: [] }, null, null), /no bitcoin holdings/);
});

test('btc-treasury handler: asks for the full filing history; 502 when CoinGecko is down', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; treasury.__test._clearCache(); });
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    const body = url.includes('transaction_history') ? CG.history : url.includes('companies/') ? CG.list : CG.entity;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  treasury.__test._clearCache();
  const r = JSON.parse((await treasury.handler({})).body);
  assert.equal(r.tx.length, 3);
  assert.ok(seen.some((u) => /transaction_history\?per_page=250$/.test(u)));
  global.fetch = async () => ({ ok: false, status: 503 });
  treasury.__test._clearCache();
  assert.equal((await treasury.handler({})).statusCode, 502);
});

test('btc-treasury handler: a rate-limited history call keeps the last filings list instead of blanking it', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; treasury.__test._clearCache(); });
  let limited = false;
  global.fetch = async (url) => {
    if (limited && url.includes('transaction_history')) return { ok: false, status: 429 };
    const body = url.includes('transaction_history') ? CG.history : url.includes('companies/') ? CG.list : CG.entity;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  treasury.__test._clearCache();
  assert.equal(JSON.parse((await treasury.handler({})).body).tx.length, 3);
  limited = true;
  treasury.__test._expire();
  const r = JSON.parse((await treasury.handler({})).body);
  assert.equal(r.tx.length, 3, 'filings from the previous good answer');
  // a short page that misses the early buys is not used either
  limited = false;
  const full = CG.history;
  CG.history = { transactions: full.transactions.slice(0, 2) };
  t.after(() => { CG.history = full; });
  treasury.__test._expire();
  assert.equal(JSON.parse((await treasury.handler({})).body).tx.length, 3);
  CG.history = full;
  assert.equal(treasury.__test.complete([{ btc: 457, balance: 851305 }]), false);
  assert.equal(treasury.__test.complete([{ btc: 21454, balance: 21454 }]), true);
});

async function page(lang) {
  const raw = rawFiles();
  const payload = holders.__test.build(raw);
  const tre = treasury.__test.shape(CG.entity, CG.history, CG.list);
  const sb = makeSandbox({
    fetchImpl: async (url) => {
      const u = String(url);
      const body = u.includes('/btc-holders') ? payload : u.includes('/btc-treasury') ? tre : null;
      return body ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } : { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    }
  });
  if (lang) sb.localStorage.setItem('gi-lang', lang);
  await runAllScripts(sb);
  sb.ocActivate();
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  return sb;
}
const html = (sb, id) => String(sb.document.getElementById(id).innerHTML || '') + ' ' + String(sb.document.getElementById(id).textContent || '');

test('power law fit recovers the slope of a clean power-law series', async () => {
  const sb = await page();
  const M = sb.__oc.fitPowerLaw(sb.__oc.prep(holders.__test.build(rawFiles())));
  assert.ok(Math.abs(M.b - 5.8) < 0.15, 'slope ' + M.b);
  const b = M.at(Date.UTC(2026, 10, 25));
  assert.ok(b.lo95 < b.lo68 && b.lo68 < b.fair && b.fair < b.hi68 && b.hi68 < b.hi95);
});

test('holder verdict: LTH down + STH up over 30 days reads as distribution', async () => {
  const sb = await page();
  const v = sb.__oc.holderVerdict(sb.__oc.prep(holders.__test.build(rawFiles())));
  assert.equal(v.kind, 'distribution');
  assert.ok(v.dL < 0 && v.dS > 0);
});

test('Strategy average cost: a sale keeps the average, holdings follow the filings', async () => {
  const sb = await page();
  const tx = [{ date: '2026-01-01', type: 'buy', btc: 10, usd: 1000 }, { date: '2026-01-03', type: 'buy', btc: 10, usd: 3000 }, { date: '2026-01-05', type: 'sell', btc: 5, usd: 1500 }];
  const m = sb.__oc.mstrSeries(tx, Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 6));
  assert.equal(m.avg[0], 100);
  assert.equal(m.avg[2], 200);
  assert.equal(m.avg[4], 200);
  assert.equal(m.bal[5], 15);
});

test('the section renders tiles, verdicts and tables from the two functions (Thai)', async () => {
  const sb = await page();
  assert.match(html(sb, 'ocCostTiles'), /MVRV/);
  assert.match(html(sb, 'ocCostPoints'), /<li>/);
  assert.match(html(sb, 'ocHoldVerdict'), /คนถือยาวกำลังขาย/);
  assert.match(html(sb, 'ocPlProj'), /<tr/);
  assert.match(html(sb, 'ocMstrTiles'), /851,305/);
  assert.match(html(sb, 'ocMstrPoints'), /ขาย BTC 1 ครั้ง/);
  assert.match(html(sb, 'ocMstrTx'), /8-K/);
  assert.match(html(sb, 'ocCostChart'), /<svg/);
  assert.match(html(sb, 'ocPlChart'), /<path/);
});

test('English mode: the on-chain section has no Thai left', async () => {
  const sb = await page('en');
  for (const id of ['ocCostAsOf', 'ocCostTiles', 'ocCostPoints', 'ocHoldVerdict', 'ocHoldTiles', 'ocPlTiles', 'ocPlPoints', 'ocPlProj', 'ocMstrTiles', 'ocMstrPoints', 'ocMstrTx', 'ocMstrTop', 'ocNote', 'ocStatus', 'ocCostChart', 'ocPlChart', 'ocMstrChart']) {
    assert.ok(!THAI.test(html(sb, id)), `#${id} has Thai in English mode: ${html(sb, id).slice(0, 160)}`);
  }
});

test('section is wired: inside the BTC tab, lazy load on tab open, Cloudflare routes', () => {
  const btc = HTML.slice(HTML.indexOf('<section id="btcTab"'));
  for (const id of ['ocCostChart', 'ocLthChart', 'ocSthChart', 'ocRcChart', 'ocPlChart', 'ocMstrChart', 'ocMstrTx']) assert.match(btc, new RegExp('id="' + id + '"'));
  assert.match(HTML, /tabId === 'btcTab' && typeof window\.ocActivate === 'function'/);
  const cf = require('fs').readFileSync(require('path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(cf, /'btc-holders': btcHolders/);
  assert.match(cf, /'btc-treasury': btcTreasury/);
});
