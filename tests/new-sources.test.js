// Unit tests for the market snapshot, economic calendar and Thai gold functions — run with: npm test
// No network: every parser is fed a fixture shaped like the real upstream response.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const markets = require('../netlify/functions/markets.js').__test;
const cal = require('../netlify/functions/calendar.js').__test;
const gold = require('../netlify/functions/gold-th.js').__test;

// ---------------- markets ----------------
test('markets: FRED CSV parsing skips "." and sorts oldest-first', () => {
  const obs = markets.parseCsv('observation_date,DGS10\n2026-10-01,4.09\n2026-09-29,.\n2026-09-30,4.05\n');
  assert.deepEqual(obs, [{ date: '2026-09-30', value: 4.05 }, { date: '2026-10-01', value: 4.09 }]);
});

test('markets: daily series are thinned to one point per week, ending on the latest value', () => {
  const obs = [];
  for (let d = new Date('2025-09-01T00:00:00Z'); d <= new Date('2026-10-01T00:00:00Z'); d = new Date(d.getTime() + 86400000)) {
    if (d.getUTCDay() % 6) obs.push({ date: d.toISOString().slice(0, 10), value: 4 + d.getUTCDate() / 100 });
  }
  const s = markets.summarize('us10y', obs);
  assert.equal(s.date, '2026-10-01');
  assert.equal(s.hist[s.hist.length - 1][0], '2026-10-01');
  assert.ok(s.hist.length >= 50 && s.hist.length <= 56, `expected ~52 weekly points, got ${s.hist.length}`);
  assert.equal(s.change, Math.round((obs[obs.length - 1].value - obs[obs.length - 2].value) * 1000) / 1000);
});

// ---------------- calendar ----------------
test('calendar: Eastern time converts to UTC across daylight-saving', () => {
  assert.equal(cal.etToUtcIso('2026-10-15', '08:30'), '2026-10-15T12:30:00.000Z'); // EDT (UTC-4)
  assert.equal(cal.etToUtcIso('2026-12-10', '08:30'), '2026-12-10T13:30:00.000Z'); // EST (UTC-5)
});

test('calendar: BLS iCalendar events are recognised, folded lines unfolded, others ignored', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'DTSTART;TZID=US-Eastern:20261015T083000', 'SUMMARY:Consumer Price Index for Septem', ' ber 2026', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261106T133000Z', 'SUMMARY:The Employment Situation for October 2026', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261020', 'SUMMARY:Real Earnings', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
  const ev = cal.blsEvents(ics);
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => [e.key, e.date, e.at]), [
    ['cpi', '2026-10-15', '2026-10-15T12:30:00.000Z'],
    ['jobs', '2026-11-06', '2026-11-06T13:30:00.000Z']
  ]);
  assert.match(ev[0].title, /September 2026/);
});

test('calendar: FRED release dates map to events at the usual release time', () => {
  const ev = cal.fredEvents({ release_dates: [{ release_id: 54, date: '2026-10-30' }] }, 'pce');
  assert.deepEqual(ev, [{ key: 'pce', date: '2026-10-30', at: '2026-10-30T12:30:00.000Z', source: 'fred' }]);
});

test('calendar: merge drops past events, de-duplicates and prefers BLS times', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const merged = cal.mergeEvents([
    [{ key: 'cpi', date: '2026-10-15', at: '2026-10-15T12:30:00.000Z', source: 'fred' }],
    [{ key: 'cpi', date: '2026-10-15', at: '2026-10-15T12:30:00.000Z', source: 'bls' }, { key: 'cpi', date: '2026-09-10', source: 'bls' }],
    cal.fomcEvents()
  ], now);
  assert.equal(merged.filter((e) => e.key === 'cpi').length, 1);
  assert.equal(merged.find((e) => e.key === 'cpi').source, 'bls');
  assert.ok(merged.every((e) => e.date >= '2026-10-02'));
  assert.ok(merged.some((e) => e.key === 'fomc' && e.date === '2026-10-28'));
});

// ---------------- Thai gold ----------------
test('gold-th: goldtraders.or.th spans are parsed', () => {
  const html = '<span id="DetailPlace_uc_goldprices1_lblBLBuy">64,250.00</span>'
    + '<span id="DetailPlace_uc_goldprices1_lblBLSell"> 64,350.00 </span>'
    + '<span id="DetailPlace_uc_goldprices1_lblOMBuy">62,983.16</span>'
    + '<span id="DetailPlace_uc_goldprices1_lblOMSell">65,150.00</span>'
    + '<span id="DetailPlace_uc_goldprices1_lblAsTime">02/10/2569 เวลา 09:31 น. (ครั้งที่ 3)</span>';
  const g = gold.parseGoldtraders(html);
  assert.deepEqual([g.barBuy, g.barSell, g.ornamentBuy, g.ornamentSell], [64250, 64350, 62983.16, 65150]);
  assert.match(g.updated, /09:31/);
});

test('gold-th: community API shape is parsed', () => {
  const g = gold.parseChnwt(JSON.stringify({ status: 'success', response: { date: '2 ตุลาคม 2569', update_time: 'เวลา 09:31 น.', price: { gold: { buy: '62,983.16', sell: '65,150.00' }, gold_bar: { buy: '64,250.00', sell: '64,350.00' } } } }));
  assert.equal(g.barSell, 64350);
  assert.equal(g.ornamentSell, 65150);
});

test('gold-th: an implausible or swapped price is rejected rather than shown', () => {
  assert.throws(() => gold.parseGoldtraders('<span id="x_lblBLBuy">643.5</span><span id="x_lblBLSell">644</span>'));
  assert.throws(() => gold.parseGoldtraders('<span id="x_lblBLBuy">64,350</span><span id="x_lblBLSell">64,250</span>'));
});

// ---------------- risk scoring (index.html) ----------------
test('risk scoring matches whole words only and separates calm from tense news', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const i = html.indexOf('  const HIGH_RISK_TERMS'), j = html.indexOf('  function scoreCategory(titles)');
  assert.ok(i > 0 && j > i, 'scoring block not found');
  // eslint-disable-next-line no-new-func
  const api = new Function(html.slice(i, j) + '\nreturn { scoreHeadline, scoreCategoryDetail };')();
  assert.equal(api.scoreHeadline('Analysts warn of software award delays').net, 0, '"war" must not match warn/award/software');
  assert.equal(api.scoreHeadline('Output shows increase; data release due').net, 0, '"ease" must not match increase/release');
  assert.ok(api.scoreHeadline('Russia launches missile strikes').net > 0);
  assert.ok(api.scoreHeadline('Markets rally on rate cut hopes').net < 0);
  const tense = api.scoreCategoryDetail(['Russia launches missile strikes', 'Iran war escalates', 'Talks collapse']).score;
  const calm = api.scoreCategoryDetail(['Stocks hit record high', 'Peace deal reached', 'Economy shows recovery']).score;
  assert.ok(tense >= 75 && calm <= 25, `expected a clear spread, got tense=${tense} calm=${calm}`);
});

test('markets: cache is 15 min on release days and only the remaining time is advertised', async (t) => {
  const { handler } = require('../netlify/functions/markets.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T13:00:00Z') });
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => 'observation_date,X\n2026-09-01,3.0\n2026-10-01,3.1\n' });
  t.after(() => { global.fetch = realFetch; });
  const first = await handler();
  assert.equal(JSON.parse(first.body).ttl, 15 * 60);
  assert.match(first.headers['Cache-Control'], /max-age=900,/);
  t.mock.timers.tick(10 * 60 * 1000);
  const second = await handler();
  assert.equal(JSON.parse(second.body).ttl, 5 * 60);
  assert.match(second.headers['Cache-Control'], /max-age=300,/);
});

test('markets: Cboe VIX quote is laid over the FRED close', () => {
  const quote = markets.parseCboeQuote(JSON.stringify({ data: { current_price: 16.87, price_change: 1.6, last_trade_time: '2026-10-14T16:15:01' } }));
  assert.deepEqual(quote, { value: 16.87, change: 1.6, date: '2026-10-14', time: '2026-10-14T16:15:01' });
  const fred = { label: 'VIX', unit: '', latest: 15.27, date: '2026-10-13', prev: 15.21, change: 0.06,
    hist: [['2026-10-09', 14.84], ['2026-10-13', 15.27]] };
  const merged = markets.mergeLive(fred, quote);
  assert.equal(merged.latest, 16.87);
  assert.equal(merged.date, '2026-10-14');
  assert.equal(merged.prev, 15.27);
  assert.equal(merged.change, 1.6);
  assert.deepEqual(merged.hist.slice(-2), [['2026-10-13', 15.27], ['2026-10-14', 16.87]]);
  // same day as FRED → replace that point, not add a second one
  const sameDay = markets.mergeLive({ ...fred, date: '2026-10-14', hist: [['2026-10-14', 16.85]] }, quote);
  assert.deepEqual(sameDay.hist, [['2026-10-14', 16.87]]);
  // an older quote never overrides a newer FRED close
  assert.equal(markets.mergeLive(fred, { ...quote, date: '2026-10-12' }), fred);
  assert.throws(() => markets.parseCboeQuote('{"data":{}}'));
});

test('markets: normal days cache for 1 h and a Cboe outage keeps the FRED VIX', async (t) => {
  const { handler } = require('../netlify/functions/markets.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T13:00:00Z') });
  const realFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('cboe')
    ? ({ ok: false, status: 503, text: async () => '' })
    : ({ ok: true, status: 200, text: async () => 'observation_date,X\n2026-10-15,15.0\n2026-10-16,15.5\n' });
  t.after(() => { global.fetch = realFetch; });
  const body = JSON.parse((await handler()).body);
  assert.equal(body.ttl, 60 * 60);
  assert.equal(body.series.vix.latest, 15.5);
  assert.match(body.errors.vixLive, /503/);
});

test('markets: dollar is DXY from ECB rates, FRED broad index only as fallback', async (t) => {
  const rates = { CAD: 1.4219, CHF: 0.83341, EUR: 0.89326, GBP: 0.75377, JPY: 158.45, SEK: 9.9669 };
  assert.ok(Math.abs(markets.dxyFromRates(rates) - 102.22) < 0.01);
  assert.ok(Number.isNaN(markets.dxyFromRates({ ...rates, SEK: undefined })));
  const obs = markets.parseDxySeries(JSON.stringify({ rates: { '2026-10-14': rates, '2026-10-13': { ...rates, EUR: 0.9 } } }));
  assert.deepEqual(obs.map((o) => o.date), ['2026-10-13', '2026-10-14']);

  const { handler } = require('../netlify/functions/markets.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-21T13:00:00Z') });
  const realFetch = global.fetch;
  global.fetch = async (url) => String(url).includes('frankfurter')
    ? ({ ok: true, status: 200, text: async () => JSON.stringify({ rates: { '2026-10-20': rates } }) })
    : ({ ok: true, status: 200, text: async () => 'observation_date,X\n2026-10-15,15.0\n2026-10-16,15.5\n' });
  t.after(() => { global.fetch = realFetch; });
  const body = JSON.parse((await handler()).body);
  assert.equal(body.series.dollar.source, 'ecb-dxy');
  assert.equal(body.series.dollar.date, '2026-10-20');
  assert.equal(body.series.dollar.latest, 102.225);
});

test('markets: 10-year from Cboe TNX and 2-year from the Treasury curve beat the day-late FRED close', async (t) => {
  assert.deepEqual(markets.tnxToPercent({ value: 49.49, change: -1.81, date: '2026-10-22', time: 'x' }),
    { value: 4.949, change: -0.181, date: '2026-10-22', time: 'x' });
  const csv = 'Date,"1 Mo","2 Yr","10 Yr","30 Yr"\n10/22/2026,4.30,4.70,4.96,5.40\n10/21/2026,4.31,4.81,5.13,5.55\n';
  assert.deepEqual(markets.parseTreasuryCurve(csv), { date: '2026-10-22', us2y: 4.7, us10y: 4.96 });
  assert.throws(() => markets.parseTreasuryCurve('Date,"1 Mo"\n'));

  const { handler } = require('../netlify/functions/markets.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-23T03:00:00Z') });
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('_TNX')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: { current_price: 49.49, price_change: -1.81, last_trade_time: '2026-10-22T16:59:00' } }) };
    if (u.includes('cboe')) return { ok: false, status: 503, text: async () => '' };
    if (u.includes('treasury.gov')) return { ok: true, status: 200, text: async () => csv };
    return { ok: true, status: 200, text: async () => 'observation_date,X\n2026-10-20,5.12\n2026-10-21,5.13\n' };
  };
  t.after(() => { global.fetch = realFetch; });
  const body = JSON.parse((await handler()).body);
  assert.equal(body.series.us10y.source, 'cboe');
  assert.equal(body.series.us10y.latest, 4.949);
  assert.equal(body.series.us10y.date, '2026-10-22');
  assert.equal(body.series.us10y.change, -0.181);
  assert.equal(body.series.us2y.source, 'treasury');
  assert.equal(body.series.us2y.latest, 4.7);
  assert.equal(body.series.us2y.change, -0.43);
});

// ---------------- WTI (NYMEX CL) ----------------
const wti = require('../netlify/functions/wti.js').__test;

test('wti: Yahoo CL=F compares the live price with the previous session settle', () => {
  const t = (d) => Date.parse(d + 'T04:00:00Z') / 1000;
  const body = (lastBarDay, marketDay) => JSON.stringify({ chart: { result: [{
    meta: { regularMarketPrice: 98.95, regularMarketTime: t(marketDay), previousClose: 1 },
    timestamp: [t('2026-10-15'), t('2026-10-16'), t(lastBarDay)],
    indicators: { quote: [{ close: [96.1, 97.91, 98.95] }] }
  }] } });
  const live = wti.parseYahoo(body('2026-10-19', '2026-10-19'));
  assert.equal(live.price, 98.95);
  assert.equal(live.prevClose, 97.91);
  assert.equal(live.pct, 1.06);
  // Last bar is a finished earlier day (e.g. Yahoo hasn't opened today's bar): it is the reference.
  assert.equal(wti.parseYahoo(body('2026-10-16', '2026-10-19')).prevClose, 98.95);
});

test('wti: CNBC @CL.1 quote strings are parsed', () => {
  const r = wti.parseCnbc(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: [
    { symbol: '@CL.1', last: '98.95', previous_day_closing: '97.91', last_time: '2026-10-19T21:59:58.000-0400' }
  ] } }));
  assert.equal(r.price, 98.95);
  assert.equal(r.pct, 1.06);
  assert.throws(() => wti.parseCnbc(JSON.stringify({ FormattedQuoteResult: { FormattedQuote: [{ last: '' }] } })));
});

test('wti: Stooq cl.f CSV is parsed, and N/D is rejected', () => {
  const r = wti.parseStooq('Symbol,Date,Time,Open,High,Low,Close,Prev\r\nCL.F,2026-10-19,23:59:58,97.95,99.2,97.6,98.95,97.91\r\n');
  assert.equal(r.price, 98.95);
  assert.equal(r.pct, 1.06);
  assert.equal(r.asOf, '2026-10-19T23:59:58');
  assert.throws(() => wti.parseStooq('Symbol,Date,Time,Open,High,Low,Close,Prev\nCL.F,N/D,N/D,N/D,N/D,N/D,N/D,N/D\n'));
});

test('wti: NYMEX sources are tried in order, with a second Yahoo host', () => {
  assert.deepEqual(wti.SOURCES.map((s) => s.name), ['yahoo:CL=F', 'yahoo2:CL=F', 'cnbc:@CL.1', 'stooq:cl.f']);
  assert.match(wti.SOURCES[1].url, /^https:\/\/query2\.finance\.yahoo\.com\//);
});
