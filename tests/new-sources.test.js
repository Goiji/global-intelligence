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
