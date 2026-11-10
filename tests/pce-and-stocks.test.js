// Core PCE (fred-data) and the S&P 500 / Nasdaq 100 tiles (markets) — run with:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fred = require('../netlify/functions/fred-data.js');
const markets = require('../netlify/functions/markets.js').__test;
const { HTML } = require('./dom-stub.js');

test('fred-data: core PCE comes from FRED PCEPILFE (BEA series, no BLS copy) as a YoY', async (t) => {
  const { TARGETS } = fred.__test;
  assert.equal(TARGETS.corePce.fred, 'PCEPILFE');
  assert.equal(TARGETS.pce.fred, 'PCEPI');
  assert.equal(TARGETS.corePce.bls, undefined);

  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T12:00:00Z') });
  const months = [];
  for (let d = new Date(Date.UTC(2024, 8, 1)); d <= new Date(Date.UTC(2026, 8, 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 10));
  }
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const ok = (text) => ({ ok: true, status: 200, text: async () => text });
    if (url.includes('fredgraph.csv?id=PCEPILFE')) {
      const pc1 = url.includes('transformation=pc1');
      // level grows 2.8% a year; pc1 copy says the same, previous month 2.7
      return ok('observation_date,PCEPILFE\n' + months.map((m, i) => `${m},${pc1 ? (i === months.length - 1 ? '2.8' : '2.7') : (120 * Math.pow(1.028, i / 12)).toFixed(3)}`).join('\n'));
    }
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; });
  fred.__test._expireCache();
  const body = JSON.parse((await fred.handler()).body);
  assert.equal(body.corePce.date, '2026-09-01');
  assert.equal(body.corePce.value, 2.8);
  assert.equal(body.corePce.changePp, 0.1);
  assert.match(body.errors.pce, /fred-csv/);
});

test('markets: S&P 500 / Nasdaq 100 come from FRED with the Cboe index quote on top', () => {
  assert.equal(markets.SERIES.sp500.id, 'SP500');
  assert.equal(markets.SERIES.nasdaq100.id, 'NASDAQ100');
  const fredClose = { label: 'S&P 500', unit: '', latest: 6800.5, date: '2026-11-03', prev: 6750, change: 50.5,
    hist: [['2026-10-27', 6700], ['2026-11-03', 6800.5]] };
  const quote = markets.parseCboeQuote(JSON.stringify({ data: { current_price: 6850.25, price_change: 49.75, last_trade_time: '2026-11-04T15:30:00' } }));
  const merged = markets.mergeLive(fredClose, quote);
  assert.equal(merged.latest, 6850.25);
  assert.equal(merged.prev, 6800.5);
  assert.equal(merged.source, 'cboe');
});

test('index.html: stock, core PCE and claims-calendar wiring is present', () => {
  for (const id of ['mkSp500', 'spSp500', 'mkNdx', 'spNdx', 'corePce', 'corePceInfo', 'nextPce']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /pce:'pce'/, 'core PCE card must look up the PCE release in the calendar');
  assert.match(HTML, /claims:\s*\['ผู้ขอรับสวัสดิการว่างงาน/, 'jobless claims must stay in the calendar');
});
