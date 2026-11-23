// VIX card: bands, "fear past its peak" label, fresher live quote — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');
const markets = require('../netlify/functions/markets.js').__test;

test('VIX bands: <20 hold, 20–30 caution, 30–40 buy in steps, 40+ crisis', async () => {
  const sb = await runAllScripts(makeSandbox());
  assert.match(sb.vixZone(14).label, /^🟢/);
  assert.match(sb.vixZone(19.99).label, /^🟢/);
  assert.match(sb.vixZone(20).label, /^🟡/);
  assert.match(sb.vixZone(29.9).label, /^🟡/);
  assert.match(sb.vixZone(35.89).label, /^🟠.*ทยอยสะสม/);
  assert.match(sb.vixZone(40).label, /^🔴/);
});

test('VIX past-peak label: only at 25+ and below last month', async () => {
  const sb = await runAllScripts(makeSandbox());
  assert.equal(sb.vixZone(35.89, 17).pastPeak, false, 'still rising');
  assert.equal(sb.vixZone(30, 42).pastPeak, true);
  assert.equal(sb.vixZone(24, 40).pastPeak, false, 'below 25');
  assert.equal(sb.vixZone(30, null).pastPeak, false);
  const hist = [['2026-10-16', 20], ['2026-10-23', 17.5], ['2026-10-30', 19], ['2026-11-20', 35.89]];
  assert.equal(sb.vixMonthAgo(hist, '2026-11-20'), 20);
});

test('VIX card face shows no historical return stats', () => {
  const card = HTML.slice(HTML.indexOf('function vixZone'), HTML.indexOf('function vixMonthAgo'));
  assert.doesNotMatch(card, /%/);
  assert.match(HTML, /<p><b>อ่านสี:<\/b> 🟢 ต่ำกว่า 20/);
  assert.match(HTML, /<p><b>Colours:<\/b> 🟢 below 20/);
});

test('live quote: Yahoo wins when Cboe is older, Cboe wins a tie', async (t) => {
  const yahoo = JSON.stringify({ chart: { result: [{
    meta: { gmtoffset: -18000, regularMarketPrice: 35.89, regularMarketTime: Date.parse('2026-11-20T21:15:00Z') / 1000 },
    timestamp: [Date.parse('2026-11-19T14:30:00Z') / 1000, Date.parse('2026-11-20T14:30:00Z') / 1000],
    indicators: { quote: [{ close: [28.44, 35.5] }] } }] } });
  const q = markets.parseYahooQuote(yahoo);
  assert.deepEqual(q, { value: 35.89, change: 35.89 - 28.44, date: '2026-11-20', time: '2026-11-20T16:15:00', source: 'yahoo' });
  const cboe = (d) => JSON.stringify({ data: { current_price: 28.44, price_change: 1, last_trade_time: d } });
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  let cboeDay = '2026-11-19T16:15:00';
  global.fetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes('cboe') ? cboe(cboeDay) : yahoo) });
  assert.equal((await markets.loadLiveQuote('https://cdn.cboe.com/x', '^VIX')).source, 'yahoo');
  cboeDay = '2026-11-20T16:15:00';
  assert.equal((await markets.loadLiveQuote('https://cdn.cboe.com/x', '^VIX')).source, undefined, 'cboe quote kept on a tie');
  const merged = markets.mergeLive({ latest: 28.44, date: '2026-11-19', prev: 26, hist: [['2026-11-19', 28.44]] }, q);
  assert.equal(merged.latest, 35.89);
  assert.equal(merged.source, 'yahoo');
});
