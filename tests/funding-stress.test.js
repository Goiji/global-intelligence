// MOVE index and SOFR − IORB spread (markets) — run with:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const markets = require('../netlify/functions/markets.js');
const T = markets.__test;
const { HTML } = require('./dom-stub.js');

test('markets: SOFR − IORB is joined by date in bp, carrying IORB forward', () => {
  const sofr = [{ date: '2026-11-03', value: 3.92 }, { date: '2026-11-04', value: 3.95 }, { date: '2026-11-05', value: 3.88 }];
  const iorb = [{ date: '2026-11-03', value: 3.9 }, { date: '2026-11-05', value: 3.9 }];
  const out = T.joinSofrIorb(sofr, iorb);
  assert.deepEqual(out.map((o) => [o.date, o.value]), [['2026-11-03', 2], ['2026-11-04', 5], ['2026-11-05', -2]]);
  assert.equal(out[1].iorb, 3.9);
  // SOFR days before the first IORB print are dropped, not guessed
  assert.equal(T.joinSofrIorb([{ date: '2026-01-01', value: 4 }], iorb).length, 0);
});

test('markets: Yahoo ^MOVE chart → daily closes on the US trading day, live price appended', () => {
  const day = (iso) => Date.parse(iso + 'T14:30:00Z') / 1000;
  const json = JSON.stringify({ chart: { result: [{
    meta: { gmtoffset: -18000, regularMarketPrice: 92.4, regularMarketTime: Date.parse('2026-11-06T21:00:00Z') / 1000 },
    timestamp: [day('2026-11-03'), day('2026-11-04'), day('2026-11-05')],
    indicators: { quote: [{ close: [88.1, null, 90.5] }] }
  }] } });
  const obs = T.parseYahooSeries(json);
  assert.deepEqual(obs, [{ date: '2026-11-03', value: 88.1 }, { date: '2026-11-05', value: 90.5 }, { date: '2026-11-06', value: 92.4 }]);
  assert.throws(() => T.parseYahooSeries('{"chart":{"result":[]}}'), /no result/);
});

test('markets handler: move + sofrSpread series come through, a failed one does not sink the rest', async (t) => {
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const days = [];
  for (let d = new Date(Date.UTC(2026, 9, 1)); d <= new Date(Date.UTC(2026, 10, 5)); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  global.fetch = async (url) => {
    if (url.includes('fredgraph.csv?id=SOFR')) return ok('observation_date,SOFR\n' + days.map((d, i) => `${d},${i === days.length - 1 ? '3.97' : '3.88'}`).join('\n'));
    if (url.includes('fredgraph.csv?id=IORB')) return ok('observation_date,IORB\n' + days.map((d) => `${d},3.90`).join('\n'));
    if (url.includes('fredgraph.csv?id=VIXCLS')) return ok('observation_date,VIXCLS\n2026-11-04,18\n2026-11-05,19');
    return { ok: false, status: 503, text: async () => '' };   // Yahoo (MOVE) and everything else down
  };
  t.after(() => { global.fetch = realFetch; });
  const body = JSON.parse((await markets.handler()).body);
  assert.equal(body.series.sofrSpread.latest, 7);
  assert.equal(body.series.sofrSpread.change, 9);
  assert.equal(body.series.sofrSpread.sofr, 3.97);
  assert.equal(body.series.sofrSpread.iorb, 3.9);
  assert.equal(body.series.sofrSpread.unit, 'bp');
  assert.ok(body.series.vix);
  assert.equal(body.series.move, undefined);
  assert.match(body.errors.move, /move:/);
});

test('index.html: MOVE and SOFR tiles have a Thai explainer and a TradingView button', () => {
  for (const id of ['mkMove', 'spMove', 'mkMoveZone', 'mkSofr', 'spSofr', 'mkSofrZone']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /tradingview\.com\/chart\/\?symbol=TVC%3AMOVE/);
  assert.match(HTML, /tradingview\.com\/chart\/\?symbol=FRED%3ASOFR-FRED%3AIORB/);
  assert.equal((HTML.match(/class="tip-btn"/g) || []).length, 19); // 3 market tiles + 8 macro cards + 8 extra econ cards
  assert.match(HTML, /haircut/);
});

test('markets: CFTC TFF rows → leveraged funds net short in $bn, only complete weeks', () => {
  const row = (date, code, long, short) => ({ report_date_as_yyyy_mm_dd: date + 'T00:00:00.000', cftc_contract_market_code: code, lev_money_positions_long: String(long), lev_money_positions_short: String(short) });
  const week = (date, extra = 0) => [
    row(date, '042601', 764270, 2121928 + extra),   // 2Y: $200k face
    row(date, '044601', 466758, 2544618), row(date, '043602', 506310, 2733585), row(date, '043607', 300000, 1300000),
    row(date, '020601', 197843, 348236), row(date, '020604', 67030, 872858),
    row(date, '999999', 0, 99999999)                // not a UST future: ignored
  ];
  const rows = [...week('2026-10-20'), ...week('2026-10-27', 50000), row('2026-11-03', '042601', 1, 2)];   // 11-03 incomplete
  const obs = T.parseCftcLevShort(JSON.stringify(rows));
  assert.deepEqual(obs.map((o) => o.date), ['2026-10-20', '2026-10-27']);
  // 1,357,658 × 200k + (2,077,860 + 2,227,275 + 1,000,000 + 150,393 + 805,828) × 100k = $897.6 bn
  assert.equal(obs[0].value, 897.7);
  assert.equal(obs[1].value, 907.7);
  assert.throws(() => T.parseCftcLevShort('{"message":"bad query"}'), /cftc: bad query/);
});

test('markets handler: levShort comes from CFTC with its record since 2016', async (t) => {
  const realFetch = global.fetch;
  const codes = ['042601', '044601', '043602', '043607', '020601', '020604'];
  const dates = ['2026-10-13', '2026-10-20', '2026-10-27'], shorts = [1000, 1200, 1100];
  const rows = [];
  dates.forEach((d, i) => codes.forEach((c) => rows.push({ report_date_as_yyyy_mm_dd: d + 'T00:00:00.000', cftc_contract_market_code: c, lev_money_positions_long: '0', lev_money_positions_short: String(shorts[i] * 1000) })));
  let cftcUrl = '';
  global.fetch = async (url) => {
    if (url.startsWith('https://publicreporting.cftc.gov/')) { cftcUrl = url; return { ok: true, status: 200, text: async () => JSON.stringify(rows) }; }
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  T._clearCache();
  const body = JSON.parse((await markets.handler()).body);
  const L = body.series.levShort;
  // 1,100k contracts × (200k + 5 × 100k) = $770 bn
  assert.equal(L.latest, 770);
  assert.equal(L.unit, '$bn');
  assert.equal(L.change, -70);
  assert.equal(L.record, 840);
  assert.equal(L.recordDate, '2026-10-20');
  assert.equal(L.hist.length, 3);
  assert.match(decodeURIComponent(cftcUrl), /cftc_contract_market_code in\('042601'/);
});

test('index.html: leveraged-funds short tile has a Thai/English explainer tied to MOVE and a TradingView button', () => {
  for (const id of ['mkLevShort', 'spLevShort', 'mkLevShortZone']) assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  assert.match(HTML, /basis trade/);
  assert.match(HTML, /Capital Wars/);
  assert.match(HTML, /tradingview\.com\/chart\/\?symbol=CBOT%3AZN1%21/);
  assert.match(HTML, /function levShortZone/);
});
