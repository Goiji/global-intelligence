// Top US stock gainers (Capital Markets tab) + the HY spread tile. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fn = require('../netlify/functions/us-gainers.js');
const T = fn.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400;
// weekday bars at 14:30 UTC (the US open), oldest-first, ending on `end`
function bars(end, n, priceAt) {
  const ts = [], close = [];
  let t = Date.parse(end + 'T14:30:00Z') / 1000;
  while (ts.length < n) {
    const wd = new Date(t * 1000).getUTCDay();
    if (wd !== 0 && wd !== 6) ts.unshift(t);
    t -= DAY;
  }
  ts.forEach((x, i) => close.push(priceAt(i, ts.length)));
  return { timestamp: ts, close };
}

test('us-gainers: v8 spark shape (flat map) and the old v7 shape both parse', () => {
  const v8 = { NVDA: { symbol: 'NVDA', timestamp: [1, 2], close: [1, 2], fulldayPrice: 3 }, junk: 5 };
  assert.deepEqual(Object.keys(T.sparkEntries(JSON.stringify(v8))), ['NVDA']);
  const v7 = { spark: { result: [{ symbol: 'AAPL', response: [{ timestamp: [1, 2], indicators: { quote: [{ close: [5, 6] }] }, meta: { regularMarketPrice: 7 } }] }] } };
  const e = T.sparkEntries(v7).AAPL;
  assert.deepEqual(e.close, [5, 6]);
  assert.equal(e.fulldayPrice, 7);
});

test('us-gainers: returns per period, live price for a bar without a close, YTD from last year\'s final close', () => {
  const b = bars('2026-11-24', 250, (i) => 100 + i); // rises 1/day
  b.close[b.close.length - 1] = null; // today's bar not closed yet
  const r = T.stockReturns({ ...b, fulldayPrice: 400, fulldayChangePercent: 5.123 });
  assert.equal(r.p, 400);
  assert.equal(r.date, '2026-11-24');
  assert.equal(r.r['1d'], 5.12, '1D = Yahoo\'s own day change');
  // 1W: last close on/before 2026-11-17 (a Tuesday); price index of that bar
  const idx = (d) => b.timestamp.findIndex((t) => new Date(t * 1000).toISOString().slice(0, 10) === d);
  assert.equal(r.r['1w'], Math.round((400 / (100 + idx('2026-11-17')) - 1) * 10000) / 100);
  assert.equal(r.r.ytd, Math.round((400 / (100 + idx('2025-12-31')) - 1) * 10000) / 100);
  assert.ok(isFinite(r.r['3m']) && isFinite(r.r['1m']));
});

test('us-gainers: a new listing gets null for periods longer than its history; 1D falls back to the last two closes', () => {
  const b = bars('2026-11-24', 20, (i) => 50 + i * 2);
  const r = T.stockReturns(b);
  assert.equal(r.r['3m'], null);
  assert.equal(r.r.ytd, null);
  assert.equal(r.r['1m'], null);
  assert.equal(r.r['1d'], Math.round(((50 + 19 * 2) / (50 + 18 * 2) - 1) * 10000) / 100);
});

test('us-gainers: delisted tickers (last bar long ago) and missing tickers are left out', () => {
  const entries = {
    AAA: bars('2026-11-24', 30, (i) => 10 + i),
    OLD: bars('2026-08-04', 30, (i) => 10 + i)
  };
  const { rows, missing, asOf } = T.buildRows(entries, [['AAA', 'Aaa'], ['OLD', 'Old'], ['NOPE', 'Nope']]);
  assert.deepEqual(rows.map((r) => r.s), ['AAA']);
  assert.deepEqual(missing.sort(), ['NOPE', 'OLD']);
  assert.equal(asOf, '2026-11-24');
  assert.equal(rows[0].date, undefined, 'internal date is not sent to the page');
});

test('us-gainers handler: batches of 20, query2 fallback, honest 502 when Yahoo is down and nothing is stored', async () => {
  const realFetch = global.fetch;
  T._clearCache();
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    const syms = decodeURIComponent(/symbols=([^&]+)/.exec(url)[1]).split(',');
    assert.ok(syms.length <= 20, 'Yahoo allows at most 20 symbols');
    if (url.includes('query1') && syms.includes('AAPL')) return { ok: false, status: 500, text: async () => '' };
    const body = {};
    syms.forEach((s, k) => { body[s] = { symbol: s, ...bars('2026-11-24', 250, (i) => 100 + i * (1 + k / 10)) }; });
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    const res = await fn.handler({});
    const j = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(j.rows.length, T.UNIVERSE.length);
    assert.deepEqual(j.periods, ['1d', '1w', '1m', '3m', 'ytd']);
    assert.ok(seen.some((u) => u.includes('query2')), 'retried the failed batch on query2');
    assert.equal(seen.filter((u) => u.includes('query1')).length, Math.ceil(T.UNIVERSE.length / 20));
    // Yahoo down + memory cleared of the fresh copy → served from last good (memory) marked stale
    global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
    const keep = JSON.parse(res.body);
    T._clearCache();
    const down = await fn.handler({});
    assert.equal(down.statusCode, 502, 'nothing stored anywhere → honest error');
    assert.ok(keep.rows.length);
  } finally { global.fetch = realFetch; T._clearCache(); }
});

test('us-gainers universe: unique tickers, every one with a name', () => {
  const syms = T.UNIVERSE.map((u) => u[0]);
  assert.equal(new Set(syms).size, syms.length);
  assert.ok(syms.length >= 200);
  T.UNIVERSE.forEach((u) => assert.ok(u[1] && u[1].length > 0, u[0]));
  assert.ok(syms.includes('NVDA') && syms.includes('TSM'));
});

test('page: top-gainers card sits in the Capital Markets tab and ranks by the chosen period', async () => {
  const markets = HTML.slice(HTML.indexOf('<section id="marketsTab"'), HTML.indexOf('<section id="backtestTab"'));
  assert.match(markets, /id="usGainCard"/);
  assert.ok(markets.indexOf('id="usGainCard"') < markets.indexOf('id="capMarketsCard"'), 'top gainers sits above World Capital Markets');
  for (const p of ['1d', '1w', '1m', '3m', 'ytd']) assert.match(markets, new RegExp(`data-p="${p}"`));
  const payload = {
    periods: ['1d', '1w', '1m', '3m', 'ytd'], asOf: '2026-11-24', universe: 25,
    rows: Array.from({ length: 25 }, (_, i) => ({ s: 'S' + i, n: 'Stock ' + i, p: 10 + i, r: { '1d': i - 5, '1w': 25 - i, '1m': null, '3m': i, ytd: i * 10 } }))
  };
  const sb = makeSandbox({
    fetchImpl: async (url) => String(url).includes('us-gainers')
      ? { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
      : { ok: false, status: 503, json: async () => ({}), text: async () => '' }
  });
  await runAllScripts(sb);
  const U = sb.__ugTest;
  assert.deepEqual(U.usGainersTop(payload.rows, '1w', 3).map((r) => r.s), ['S0', 'S1', 'S2']);
  assert.deepEqual(U.usGainersTop(payload.rows, '1m', 20), [], 'a period with no data ranks nothing');
  assert.equal(U.fmtUgPct(12.345), '+12.3%');
  assert.equal(U.fmtUgPct(-3), '−3.0%');
  assert.equal(U.fmtUgPct(668.4), '+668%');
  payload.rows[24].d = ['ชิปทดสอบ', 'Test chips'];
  U.setData(payload, 'ytd');
  U.renderUsGainers();
  const list = sb.__elements.get('ugList').innerHTML;
  assert.equal((list.match(/class="ug-row/g) || []).length, 20);
  assert.match(list, /^<li class="ug-row ug-top"><span class="ug-rank">1<\/span><span class="ug-idw"><a class="ug-id" href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=S24" target="_blank" rel="noopener noreferrer"[^>]*><b>S24/);
  assert.match(list, /<button type="button" class="tip-btn" aria-label="S24 ทำธุรกิจอะไร"[^>]*>i<\/button><span class="tip-pop" role="tooltip"><b>Stock 24<\/b> · ชิปทดสอบ<\/span>/);
  assert.equal((list.match(/class="tip-btn"/g) || []).length, 1, 'rows without a description get no button');
  assert.equal(U.ugTvUrl('BRK-B'), 'https://www.tradingview.com/chart/?symbol=BRK.B');
  assert.match(list, /\+240%/);
  assert.match(sb.__elements.get('ugSub').textContent, /ตั้งแต่ต้นปี/);
});

test('HY spread: tile in the US Markets grid, FRED BAMLH0A0HYM2 in the markets function, zones as in the tooltip', async () => {
  const mk = require('../netlify/functions/markets.js');
  const src = require('fs').readFileSync(require.resolve('../netlify/functions/markets.js'), 'utf8');
  assert.match(src, /hyOas:\s*\{ id: 'BAMLH0A0HYM2'/);
  const grid = HTML.slice(HTML.indexOf('id="mktGrid"'), HTML.indexOf('id="mkHy"') + 200);
  assert.ok(grid.includes('id="mkHy"') && grid.includes('id="spHy"') && grid.includes('id="mkHyZone"'));
  assert.match(HTML, /symbol=FRED%3ABAMLH0A0HYM2/);
  assert.match(HTML, /🟢 ต่ำกว่า 3.5% สบาย · 🟡 3.5–5% ปกติ · 🟠 5–7% ตึงตัว · 🔴 7% ขึ้นไป วิกฤตสินเชื่อ/);
  assert.ok(mk);
  const hist = [['2026-10-01', 2.9], ['2026-10-20', 3.1], ['2026-11-03', 3.6], ['2026-11-20', 4.3]];
  const payload = { series: { hyOas: { label: 'HY', unit: '%', latest: 4.3, date: '2026-11-20', prev: 4.1, change: 0.2, hist } }, asOf: '2026-11-20', ttl: 3600 };
  const sb = makeSandbox({
    fetchImpl: async (url) => /functions\/markets\b/.test(String(url))
      ? { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
      : { ok: false, status: 503, json: async () => ({}), text: async () => '' }
  });
  await runAllScripts(sb);
  assert.match(sb.__elements.get('mkHy').innerHTML, /^4\.30%<span class="delta down">\+20 bp<\/span>$/);
  const zone = sb.__elements.get('mkHyZone').innerHTML;
  assert.match(zone, /🟡 ปกติ/);
  assert.match(zone, /1 เดือน \+120 bp ⚠️ ถ่างเร็ว/, '1-month change vs the point ~30 days back (2026-10-20: 3.1%)');
});

test('us-gainers: every ticker in the universe has a short Thai and English description', () => {
  const { UNIVERSE } = require('../netlify/functions/us-gainers.js').__test;
  const DESC = require('../netlify/lib/us-stock-desc.js');
  for (const [s] of UNIVERSE) {
    const d = DESC[s];
    assert.ok(Array.isArray(d) && d.length === 2, 'no description for ' + s);
    assert.match(d[0], /[\u0E00-\u0E7F]/, s + ': first entry should be Thai');
    assert.ok(d[0].length <= 60 && d[1].length <= 60, s + ': keep it short');
  }
  const syms = new Set(UNIVERSE.map((u) => u[0]));
  assert.deepEqual(Object.keys(DESC).filter((k) => !syms.has(k)), [], 'descriptions for tickers not in the universe');
});
