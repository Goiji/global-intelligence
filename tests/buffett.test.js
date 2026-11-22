// Buffett Indicator card (markets: buffett ← FRED NCBEILQ027S ÷ GDP, carried forward with the S&P 500) — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const markets = require('../netlify/functions/markets.js');
const T = markets.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

// Real FRED values (Nov 2026): equity $ millions, GDP $ billions; quarter dated by its first day.
const EQ = [['2000-01-01', 16264941], ['2021-10-01', 54276033], ['2025-01-01', 59428546], ['2025-04-01', 65333338],
  ['2025-07-01', 70397225], ['2025-10-01', 71994893], ['2026-01-01', 70018384], ['2026-04-01', 83050847]].map(([date, value]) => ({ date, value }));
const GDP = [['2000-01-01', 10002.179], ['2021-10-01', 24823.19], ['2025-01-01', 30000], ['2025-04-01', 30630.174], ['2025-07-01', 31180.493],
  ['2025-10-01', 31462.523], ['2026-01-01', 31906.274], ['2026-04-01', 32563.03], ['2026-07-01', 33010.036]].map(([date, value]) => ({ date, value }));

test('quarterEnd: FRED quarter start → last day of that quarter', () => {
  assert.equal(T.quarterEnd('2026-04-01'), '2026-06-30');
  assert.equal(T.quarterEnd('2025-10-01'), '2025-12-31');
});

test('buffettSummary: quarterly ratio, stats, and the S&P 500 carry-forward over the latest GDP', () => {
  const q = T.buffettSummary(EQ, GDP, null);
  assert.equal(q.quarterValue, 255);                 // 83,051 / 32,563
  assert.equal(q.latest, 255);
  assert.equal(q.estimated, false);
  assert.equal(q.date, '2026-06-30');
  assert.equal(q.peak, 255);
  assert.equal(q.since, '2000-03-31');
  assert.equal(q.quarters, 8);

  const live = T.buffettSummary(EQ, GDP, [{ date: '2026-06-30', value: 6800 }, { date: '2026-11-20', value: 6500 }]);
  assert.equal(live.estimated, true);
  assert.equal(live.date, '2026-11-20');
  assert.equal(live.gdpDate, '2026-07-01');
  assert.equal(live.marketCap, Math.round(83050.847 * 6500 / 6800));
  assert.equal(live.latest, Math.round(live.marketCap / 33010.036 * 1000) / 10);
  assert.equal(live.prev, 255);
  assert.deepEqual(live.hist[live.hist.length - 1], ['2026-11-20', live.latest]);
  // no S&P close near the quarter end → stay on the published quarter
  assert.equal(T.buffettSummary(EQ, GDP, [{ date: '2026-05-01', value: 6800 }, { date: '2026-11-20', value: 6500 }]).estimated, false);
  assert.throws(() => T.buffettSummary(EQ.slice(0, 3), GDP, null), /too few/);
});

test('markets handler: buffett from FRED CSVs, carried forward with the S&P 500 series', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const csv = (id, rows) => `observation_date,${id}\n` + rows.map((o) => `${o.date},${o.value}`).join('\n');
  global.fetch = async (url) => {
    if (url.endsWith('fredgraph.csv?id=NCBEILQ027S')) return ok(csv('NCBEILQ027S', EQ));
    if (url.endsWith('fredgraph.csv?id=GDP')) return ok(csv('GDP', GDP));
    if (url.includes('fredgraph.csv?id=SP500')) return ok('observation_date,SP500\n2026-06-30,6800\n2026-11-19,6600\n2026-11-20,6500');
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const body = JSON.parse((await markets.handler()).body);
  const b = body.series.buffett;
  assert.ok(b, JSON.stringify(body.errors));
  assert.equal(b.estimated, true);
  assert.equal(b.date, '2026-11-20');
  assert.equal(b.spxMove, -4.41);
});

test('index.html: Buffett card with (i) colours + caveat, meaning line and source note; colour follows one verdict', async () => {
  for (const id of ['buffettCard', 'mkBuffett', 'spBuffett', 'mkBuffettZone', 'mkBuffettInfo', 'mkBuffettMeaning']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const card = HTML.slice(HTML.indexOf('id="buffettCard"'), HTML.indexOf('id="mkBuffettMeaning"'));
  assert.match(card, /🟢 ต่ำกว่า 100%/);
  assert.match(card, /🔴 150% ขึ้นไป/);
  assert.match(card, /รายได้จากต่างประเทศ/);
  assert.match(card, /earn a lot abroad/);
  assert.match(HTML, /Buffett Indicator จาก FRED/);
  assert.match(HTML, /Buffett Indicator from FRED/);
  assert.ok(HTML.indexOf('id="capeCard"') < HTML.indexOf('id="buffettCard"'), 'sits next to the Shiller PE card');

  const sb = makeSandbox();
  await runAllScripts(sb);
  assert.equal(sb.buffettVerdict(99.9).key, 'fair');
  assert.equal(sb.buffettVerdict(100).key, 'above');
  assert.equal(sb.buffettVerdict(150).key, 'high');
  assert.equal(sb.buffettVerdict(undefined), null);

  const els = sb.__elements;
  const base = { quarterValue: 255, quarterEnd: '2026-06-30', date: '2026-11-20', estimated: true, mean: 84.3, since: '1947-03-31',
    peak: 255, peakDate: '2026-06-30', pctile: 99.7, hist: [['2016-12-31', 120], ['2026-11-20', 240.5]] };
  for (const [latest, cls, dot] of [[240.5, 'tone-bad', /🔴/], [120, 'tone-warn', /🟡/], [80, 'tone-good', /🟢/]]) {
    sb.renderBuffett({ ...base, latest });
    assert.equal(els.get('mkBuffett').textContent, Math.round(latest) + '%');
    assert.match(els.get('mkBuffett').className, new RegExp(cls));
    assert.match(els.get('mkBuffettZone').textContent, dot);
    assert.match(els.get('mkBuffettZone').textContent, /ค่าเฉลี่ย 84% \(ตั้งแต่ 1947\)/);
    assert.match(els.get('mkBuffettInfo').textContent, /ไตรมาส มิ\.ย\. 2026 255% · .* · ประมาณการ ณ 20 พ\.ย\. 2026/);
    assert.match(els.get('mkBuffettMeaning').innerHTML, /^<b>ความหมาย:<\/b> /);
  }
  sb.renderBuffett(null);
  assert.match(els.get('mkBuffettZone').textContent, /⚪/);
});
