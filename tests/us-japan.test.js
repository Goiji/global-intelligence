// US − Japan yield spreads (markets: usjp2y / usjp10y) and the live USD/JPY quote — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const markets = require('../netlify/functions/markets.js');
const usdjpy = require('../netlify/functions/usdjpy.js');
const T = markets.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const MOF_CURRENT = 'Interest Rate (November 2026),,,,,,,,,,,,,,,(Unit : %)\n'
  + 'Date,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y,15Y,20Y,25Y,30Y,40Y\n'
  + '2026/11/2,1.671,1.88,1.982,2.136,2.243,2.326,2.429,2.569,2.692,2.817,3.362,3.669,3.972,3.94,3.96\n'
  + '2026/11/4,1.676,1.891,1.997,2.159,2.269,2.358,2.465,2.603,2.728,2.855,3.393,3.693,4.004,3.979,3.99\n'
  + '2026/11/12,1.653,1.857,1.953,2.1,2.209,2.307,2.423,2.562,2.694,2.841,3.382,3.698,4.004,3.974,4.006\n'
  + ',,,,,,,,,,,,,,,\n'
  + '"  �If you cannot download the latest csv data, please clear the browser\'s cache and download again.",,,,,,,,,,,,,,\n';

test('MOF JGB CSV → ISO-dated 2Y / 10Y rows, footer and "-" ignored', () => {
  const rows = T.parseMofCsv(MOF_CURRENT);
  assert.deepEqual(rows.map((r) => [r.date, r.y2, r.y10]), [
    ['2026-11-02', 1.88, 2.817], ['2026-11-04', 1.891, 2.855], ['2026-11-12', 1.857, 2.841]
  ]);
  const old = 'Interest Rate,,,(Unit : %)\nDate,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y\n1974/9/24,10.327,9.362,8.83,8.515,8.348,8.29,8.24,8.121,8.127,-\n';
  assert.deepEqual(T.parseMofCsv(old), [{ date: '1974-09-24', y2: 9.362, y10: null }]);
  assert.deepEqual(T.parseMofCsv(old, '2025-01-01'), []);
  assert.throws(() => T.parseMofCsv('<html>blocked</html>'), /no Date header/);
});

test('spread joins each US day with the JGB yield of that day or the last Tokyo day before it', () => {
  const jgb = T.parseMofCsv(MOF_CURRENT);
  const us = [{ date: '2026-11-03', value: 4.9 }, { date: '2026-11-04', value: 4.88 }, { date: '2026-11-13', value: 4.84 }, { date: '2026-11-30', value: 4.8 }];
  const out = T.joinUsJp(us, jgb, 'y2');
  assert.deepEqual(out.map((o) => [o.date, o.value, o.jpDate]), [
    ['2026-11-03', 3.02, '2026-11-02'], ['2026-11-04', 2.989, '2026-11-04'], ['2026-11-13', 2.983, '2026-11-12']
  ]); // 11-30 is >7 days after the last JGB print: dropped, not guessed
  // the overlaid "today" from Treasury / Cboe replaces FRED's point for the same day
  assert.deepEqual(T.withLatest([{ date: '2026-11-12', value: 1 }, { date: '2026-11-13', value: 2 }], { latest: 3, date: '2026-11-13' }),
    [{ date: '2026-11-12', value: 1 }, { date: '2026-11-13', value: 3 }]);
});

test('chg1m / chg1w compare with the value on or before 30 / 7 days earlier', () => {
  const obs = [{ date: '2026-10-01', value: 3.6 }, { date: '2026-10-14', value: 3.4 }, { date: '2026-11-06', value: 3.1 }, { date: '2026-11-13', value: 2.98 }];
  assert.equal(T.changeOver(obs, 30), -0.42);
  assert.equal(T.changeOver(obs, 7), -0.12);
  assert.equal(T.changeOver(obs.slice(-1), 30), null);
});

test('markets handler: usjp2y / usjp10y built from FRED + Treasury overlay + MOF', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const days = [];
  for (let d = new Date(Date.UTC(2026, 9, 1)); d <= new Date(Date.UTC(2026, 10, 12)); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));
  }
  const hist = 'Interest Rate,,,(Unit : %)\nDate,1Y,2Y,3Y,4Y,5Y,6Y,7Y,8Y,9Y,10Y\n'
    + days.filter((d) => d < '2026-11-01').map((d) => `${d.replace(/-0?/g, '/')},1.5,1.6,1.7,1.8,1.9,2,2.1,2.2,2.3,2.5`).join('\n');
  global.fetch = async (url) => {
    if (url.includes('fredgraph.csv?id=DGS2')) return ok('observation_date,DGS2\n' + days.map((d) => `${d},4.90`).join('\n'));
    if (url.includes('fredgraph.csv?id=DGS10')) return ok('observation_date,DGS10\n' + days.map((d) => `${d},5.10`).join('\n'));
    if (url.includes('daily-treasury-rates')) return ok('Date,"1 Mo","2 Yr","10 Yr"\n11/13/2026,4.1,4.84,5.07');
    if (url.includes('jgbcme_all.csv')) return ok(hist);
    if (url.includes('jgbcme.csv')) return ok(MOF_CURRENT);
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const body = JSON.parse((await markets.handler()).body);
  const s2 = body.series.usjp2y, s10 = body.series.usjp10y;
  assert.ok(s2 && s10, JSON.stringify(body.errors));
  assert.equal(s2.date, '2026-11-13');
  assert.equal(s2.latest, 2.983);          // 4.84 (Treasury 11-13) − 1.857 (JGB 11-12)
  assert.equal(s2.us, 4.84);
  assert.equal(s2.jp, 1.857);
  assert.equal(s2.jpDate, '2026-11-12');
  assert.equal(s10.latest, 2.229);         // 5.07 − 2.841
  assert.equal(s2.unit, 'pp');
  assert.ok(s2.hist.length > 4);
  assert.equal(s2.chg1m, -0.317);          // 2.983 vs 3.30 on 10-13
  assert.ok(Number.isFinite(s2.chg1w));
});

test('markets handler: MOF down → spreads missing with an error, the rest still served', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  global.fetch = async (url) => (url.includes('fredgraph.csv?id=DGS2')
    ? { ok: true, status: 200, text: async () => 'observation_date,DGS2\n2026-11-12,4.9\n2026-11-13,4.84' }
    : { ok: false, status: 503, text: async () => '' });
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const body = JSON.parse((await markets.handler()).body);
  assert.ok(body.series.us2y);
  assert.equal(body.series.usjp2y, undefined);
  assert.match(body.errors.usjp2y, /mof/i);
});

test('usdjpy: Yahoo quote uses previousClose; out-of-range prices are rejected; falls through sources', async (t) => {
  const U = usdjpy.__test;
  const y = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 154.32, previousClose: 155.1, regularMarketTime: 1794643200 } }] } });
  const q = U.parseYahooFx(y);
  assert.equal(q.price, 154.32);
  assert.equal(q.pct, -0.5);
  assert.throws(() => U.sane({ price: 1.54, prevClose: null }), /outside/);
  U._clearCache();
  const realFetch = global.fetch;
  global.fetch = async (url) => (url.includes('stooq')
    ? { ok: true, status: 200, text: async () => 'Symbol,Date,Time,Open,High,Low,Close,Prev\nUSDJPY,2026-11-13,22:00:00,155.0,155.2,154.1,154.4,155.1' }
    : { ok: false, status: 503, text: async () => '' });
  t.after(() => { global.fetch = realFetch; U._clearCache(); });
  const body = JSON.parse((await usdjpy.handler()).body);
  assert.equal(body.price, 154.4);
  assert.equal(body.source, 'stooq:usdjpy');
});

test('index.html: spread tiles + USD/JPY row, each with a TradingView link and explainer', async () => {
  for (const id of ['mkUsJp2y', 'spUsJp2y', 'mkUsJp2yZone', 'mkUsJp10y', 'spUsJp10y', 'mkUsJp10yZone', 'usjpCards', 'lpUsdJpy', 'lpUsdJpySub', 'lpUsdJpyLink']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /symbol=TVC%3AUS02Y-TVC%3AJP02Y/);
  assert.match(HTML, /symbol=TVC%3AUS10Y-TVC%3AJP10Y/);
  assert.match(HTML, /symbol=FX%3AUSDJPY/);
  assert.match(HTML, /Carry trade/);
  assert.match(HTML, /ส.ค. 2024/);
  const sb = makeSandbox();
  await runAllScripts(sb);
  assert.match(sb.usJpZone(-0.6), /🔴/);
  assert.match(sb.usJpZone(-0.3), /🟠/);
  assert.match(sb.usJpZone(0.1), /🟡/);
  assert.match(sb.usJpZone(0.3), /🟢/);
  assert.equal(sb.usJpZone(null), '');
});
