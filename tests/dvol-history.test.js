// BTC vs DVOL backtest: history function + the stats behind the Backtest tab section. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fn = require('../netlify/functions/dvol-history.js');
const T = fn.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400000;
const t0 = Date.UTC(2021, 2, 24);
const iso = (i) => new Date(t0 + i * DAY).toISOString().slice(0, 10);

// synthetic history: BTC rises, falls 50% (DVOL spikes early in the fall), then recovers
function series(n) {
  const btc = [], dvol = [];
  for (let i = 0; i < n; i++) {
    btc.push(i < 200 ? 30000 + i * 100 : i < 300 ? 50000 - (i - 200) * 250 : 25000 + (i - 300) * 60);
    dvol.push(i >= 210 && i < 220 ? 120 : i < 200 ? 50 : 70);
  }
  return { dates: btc.map((_, i) => iso(i)), dvol, btc };
}

test('align keeps only days present in both feeds and drops bad DVOL candles', () => {
  const n = 450;
  const candles = Array.from({ length: n }, (_, i) => [t0 + i * DAY, 1, 1, 1, i === 5 ? 9999 : 50 + (i % 7)]);
  const chart = { ticks: Array.from({ length: n - 1 }, (_, i) => t0 + (i + 1) * DAY), close: Array.from({ length: n - 1 }, () => 40000) };
  const d = T.align(candles, chart);
  assert.equal(d.dates[0], iso(1));
  assert.ok(!d.dates.includes(iso(5)));
  assert.equal(d.dates.length, n - 2);
  assert.equal(d.dvol.length, d.btc.length);
  assert.throws(() => T.align(candles.slice(0, 10), chart), /too little history/);
});

test('handler pages DVOL via continuation, then fetches BTC; 502 when Deribit is down', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const n = 500, ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (url.includes('get_tradingview_chart_data')) return ok({ result: { ticks: Array.from({ length: n }, (_, i) => t0 + i * DAY), close: Array.from({ length: n }, (_, i) => 30000 + i) } });
    const older = !/end_timestamp=\d{13}$/.test(url) || url.endsWith('end_timestamp=' + (t0 + 250 * DAY));
    const rows = Array.from({ length: 250 }, (_, i) => [t0 + (older ? i : 250 + i) * DAY, 1, 1, 1, 60]);
    return ok({ result: { data: rows, continuation: older ? null : t0 + 250 * DAY } });
  };
  T._clearCache();
  const body = JSON.parse((await fn.handler()).body);
  assert.equal(body.dates.length, 500);
  assert.equal(body.btc[499], 30499);
  assert.equal(seen.filter((u) => u.includes('get_volatility_index_data')).length, 2);

  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  assert.equal((await fn.handler()).statusCode, 502);
});

test('backtest section is wired: cards, lazy load on tab open, Cloudflare route', () => {
  for (const id of ['bdvChart', 'bdvFalls', 'bdvZones', 'bdvSwing', 'bdvPoints', 'bdvNote']) assert.match(HTML, new RegExp('id="' + id + '"'));
  assert.match(HTML, /tabId === 'backtestTab' && typeof window\.btDvolActivate === 'function'/);
  assert.ok(HTML.indexOf('id="btNote"') < HTML.indexOf('id="bdvChart"'), 'after the S&P 500 backtest');
  const cf = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(cf, /'dvol-history': dvolHistory/);
});

test('bdvStats: fall, DVOL high before the bottom, zones and swing check', async () => {
  const sb = await runAllScripts(makeSandbox());
  const D = series(500);
  const S = sb.bdvStats(D, [{ id: 'x', th: 'x', en: 'x', from: iso(150), to: iso(320) }, { id: 'live', th: 'y', en: 'y', from: iso(480), to: null }]);
  const f = S.falls[0];
  assert.equal(f.peak, iso(200)); assert.equal(f.trough, iso(300));
  assert.equal(f.fall, -0.5);
  assert.equal(f.dvMax, 120); assert.equal(f.dvMaxAt, iso(210)); assert.equal(f.dvMaxLead, 90);
  assert.ok(f.after90 > 0);
  assert.equal(S.falls[1].ongoing, true); assert.equal(S.falls[1].after90, null);
  const z = Object.fromEntries(S.zones.map((r) => [r.lo, r]));
  assert.equal(z[50].days, 200); assert.equal(z[80].days, 10); assert.equal(z[60].top.year, '2022');
  assert.equal(S.swing[1].h, 30);
  assert.ok(S.swing[1].count > 400);
  assert.equal(S.spikes[0].date, iso(200)); assert.equal(S.spikes[0].dvol, 70);
});

test('page renders the section from data and points use the computed numbers', async () => {
  const sb = await runAllScripts(makeSandbox());
  const D = series(500);
  sb.__bdvTest.bdvRender(D);
  const html = (id) => sb.document.getElementById(id).innerHTML;
  assert.match(html('bdvFalls'), /ตลาดหมี 2022/);
  assert.match(html('bdvZones'), /≥ 80/);
  assert.match(html('bdvSwing'), /30 วันข้างหน้า/);
  assert.match(html('bdvChart'), /<svg/);
  assert.equal((html('bdvPoints').match(/<li>/g) || []).length >= 5, true);
});

test('both backtest charts get the hover box (date, values, shaded period name)', () => {
  assert.match(HTML, /function btHover\(box, o\)/);
  assert.match(HTML, /btHover\(box, \{ W, H, L, R, T, B, n, x,\n      label: i => ym\(lab\(i\)\)/);
  assert.match(HTML, /window\.btHover\(box, \{ W, H, L, R, T, B, n, x,\n      label: i => dm\(D\.dates\[i\]\)/);
  assert.match(HTML, /ev\.pointerType !== 'touch'/);
});

test('backtest tab is split into a stocks/VIX group and a bitcoin/DVOL group, each saying what it compares', () => {
  assert.match(HTML, /<nav class="bt-nav"[\s\S]*data-go="btGrpSpx"[\s\S]*data-go="btGrpBtc"/);
  assert.ok(HTML.indexOf('id="btGrpSpx"') < HTML.indexOf('id="btChart"') && HTML.indexOf('id="btGrpBtc"') < HTML.indexOf('id="bdvChart"'));
  assert.equal((HTML.match(/<ol class="bt-what">/g) || []).length, 2);
  assert.equal((HTML.match(/class="card full bt-g spx"/g) || []).length, 4);
  assert.equal((HTML.match(/class="card full bt-g btc"/g) || []).length, 5);
});
