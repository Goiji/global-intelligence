// Market breadth card (markets: spxew = S&P 500 Equal Weight vs S&P 500) — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const markets = require('../netlify/functions/markets.js');
const T = markets.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

function weekdays(from, to) {
  const out = [];
  for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() % 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

test('breadthSummary: % changes on shared dates, rel = EW − S&P, ratio indexed to 100', () => {
  const ew = [{ date: '2026-10-01', value: 8000 }, { date: '2026-10-20', value: 8100 }, { date: '2026-11-19', value: 8240 }];
  const spx = [{ date: '2026-10-01', value: 6000 }, { date: '2026-10-20', value: 6000 }, { date: '2026-11-18', value: 6400 }, { date: '2026-11-19', value: 6300 }];
  const b = T.breadthSummary(ew, spx);
  assert.equal(b.breadthDate, '2026-11-19');
  assert.equal(b.ew1m, 1.73);    // 8240 / 8100 (10-20 is the last shared day on/before 10-20)
  assert.equal(b.spx1m, 5);      // 6300 / 6000
  assert.equal(b.rel1m, -3.27);
  assert.equal(b.ew3m, null);    // not enough history
  assert.equal(b.relHist[0][1], 100);
  assert.ok(b.relHist[b.relHist.length - 1][1] < 100);
  assert.throws(() => T.breadthSummary(ew, [{ date: '2025-01-01', value: 1 }]), /no overlapping/);
});

test('markets handler: spxew from Yahoo joined with the S&P 500 (FRED + Cboe)', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const days = weekdays('2026-08-03', '2026-11-19');
  const ts = days.map((d) => Date.parse(d + 'T21:00:00Z') / 1000);
  // EW flat, S&P up 0.1% a day → EW lags = narrow market
  const yahoo = JSON.stringify({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ close: days.map(() => 8000) }] } }] } });
  global.fetch = async (url) => {
    if (url.includes('%5ESPXEW')) return ok(yahoo);
    if (url.includes('fredgraph.csv?id=SP500')) return ok('observation_date,SP500\n' + days.map((d, i) => `${d},${(6000 * Math.pow(1.001, i)).toFixed(2)}`).join('\n'));
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const body = JSON.parse((await markets.handler()).body);
  const s = body.series.spxew;
  assert.ok(s, JSON.stringify(body.errors));
  assert.equal(s.latest, 8000);
  assert.equal(s.source, 'yahoo');
  assert.equal(s.ew1m, 0);
  assert.ok(s.spx1m > 1.5 && s.spx1m < 3, String(s.spx1m));
  assert.equal(s.rel1m, -s.spx1m);
  assert.ok(Number.isFinite(s.rel3m));
  assert.ok(s.relHist.length > 5);
  assert.equal(body.errors && body.errors.spxewBreadth, undefined);
});

test('index.html: SPXEW card, tooltip, TradingView ratio link; colour and analysis share one verdict', async () => {
  for (const id of ['spxewCard', 'mkSpxew', 'spSpxew', 'mkSpxewZone', 'mkSpxewInfo', 'mktAnalysis']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(HTML, /symbol=SP%3ASPXEW%2FSP%3ASPX/);
  assert.match(HTML, /S&amp;P 500 Equal Weight/);
  const sb = makeSandbox();
  await runAllScripts(sb);
  assert.equal(sb.breadthVerdict(0.5).key, 'broad');
  assert.equal(sb.breadthVerdict(0).key, 'even');
  assert.equal(sb.breadthVerdict(-1.49).key, 'even');
  assert.equal(sb.breadthVerdict(-1.5).key, 'narrow');
  assert.equal(sb.breadthVerdict(null), null);

  const els = sb.__elements;
  const base = { latest: 8566.99, prev: 8721.54, change: -154.55, date: '2026-11-19', breadthDate: '2026-11-19',
    hist: [['2025-11-20', 7600], ['2026-11-19', 8566.99]], relHist: [['2025-11-20', 100], ['2026-11-19', 94.2]] };
  const cases = [
    [{ ew1m: -2.1, spx1m: 1.2, rel1m: -3.3 }, 'tone-bad', 'var(--bad)', /🔴/],
    [{ ew1m: 1.0, spx1m: 1.3, rel1m: -0.3 }, 'tone-warn', 'var(--warn)', /🟡/],
    [{ ew1m: 2.0, spx1m: 0.5, rel1m: 1.5 }, 'tone-good', 'var(--good)', /🟢/]
  ];
  for (const [rel, cls, accent, dot] of cases) {
    sb.renderBreadth({ ...base, ...rel });
    assert.doesNotMatch(els.get('mkSpxew').className, /tone-/);   // big number stays neutral
    assert.match(els.get('mkSpxewZone').className, new RegExp(cls));
    assert.match(els.get('mkSpxewZone').textContent, dot);
    assert.ok(els.get('mktAnalysis').innerHTML.includes('border-left:3px solid ' + accent), 'analysis box uses the card colour');
    assert.equal(els.get('mktAnalysisWrap').hidden, false, 'the analysis block (with its heading) shows when there is a box');
  }
  // no comparison → plain number, no analysis box
  sb.renderBreadth({ ...base });
  assert.doesNotMatch(els.get('mkSpxewZone').className, /tone-/);
  assert.equal(els.get('mktAnalysis').innerHTML, '');
  assert.equal(els.get('mktAnalysisWrap').hidden, true, 'no box → the heading hides too');
});

test('index.html: the SPXEW analysis sits in its own titled block after the sources line, not loose under it', () => {
  const sec = HTML.slice(HTML.indexOf('id="spxewCard"'), HTML.indexOf('Top Events'));
  const note = sec.indexOf('id="mktNote"'), wrap = sec.indexOf('id="mktAnalysisWrap"'), box = sec.indexOf('id="mktAnalysis"');
  assert.ok(note > 0 && wrap > note && box > wrap, 'order: sources note → analysis heading → analysis box');
  assert.match(sec.slice(wrap, box), /<h3[^>]*>🔍 วิเคราะห์/);
});

function yahooJson(days, closes) {
  const ts = days.map((d) => Date.parse(d + 'T21:00:00Z') / 1000);
  return JSON.stringify({ chart: { result: [{ meta: { gmtoffset: -18000 }, timestamp: ts, indicators: { quote: [{ close: closes }] } }] } });
}

test('maxDailyGap: largest gap between two series\' daily % moves on shared days', () => {
  const a = [{ date: 'd1', value: 100 }, { date: 'd2', value: 101 }, { date: 'd3', value: 99.99 }];
  const b = [{ date: 'd1', value: 50 }, { date: 'd2', value: 50.5 }, { date: 'd3', value: 50 }];
  assert.ok(T.maxDailyGap(a, b) < 0.05);
  const c = [{ date: 'd1', value: 50 }, { date: 'd2', value: 50.5 }, { date: 'd3', value: 51 }];
  assert.ok(T.maxDailyGap(a, c) > 1.9);
  assert.equal(T.maxDailyGap(a.slice(0, 2), b), null);
});

test('markets handler: breadth uses Yahoo ^GSPC (same days as ^SPXEW) and ends on the same day', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const days = weekdays('2026-08-03', '2026-11-19');
  global.fetch = async (url) => {
    if (url.includes('%5ESPXEW')) return ok(yahooJson(days, days.map((d, i) => 8000 * Math.pow(1.0005, i))));
    if (url.includes('/RSP?')) return ok(yahooJson(days, days.map((d, i) => 190 * Math.pow(1.0005, i))));
    if (url.includes('%5EGSPC')) return ok(yahooJson(days, days.map((d, i) => 6000 * Math.pow(0.999, i))));
    // FRED's S&P 500 lags a day: must not be what breadth uses
    if (url.includes('fredgraph.csv?id=SP500')) return ok('observation_date,SP500\n' + days.slice(0, -1).map((d) => `${d},6000`).join('\n'));
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const s = JSON.parse((await markets.handler()).body).series.spxew;
  assert.equal(s.breadthDate, '2026-11-19');
  assert.equal(s.date, '2026-11-19');
  assert.equal(s.breadthBy, 'SPXEW');
  assert.ok(s.rspGap < 0.01);
  assert.ok(s.spx1m < 0 && s.ew1m > 0 && s.rel1m > 2);
});

test('markets handler: ^SPXEW that disagrees with RSP is dropped for RSP; headline trimmed to the compared day', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const ok = (text) => ({ ok: true, status: 200, text: async () => text });
  const days = weekdays('2026-08-03', '2026-11-19');
  const bad = days.map((d, i) => (i >= days.length - 3 ? 8000 * (1 - 0.02 * (i - days.length + 4)) : 8000));
  global.fetch = async (url) => {
    if (url.includes('%5ESPXEW')) return ok(yahooJson(days, bad));
    if (url.includes('/RSP?')) return ok(yahooJson(days, days.map(() => 190)));
    if (url.includes('%5EGSPC')) return ok(yahooJson(days.slice(0, -1), days.slice(0, -1).map(() => 6000)));
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const s = JSON.parse((await markets.handler()).body).series.spxew;
  assert.equal(s.breadthBy, 'RSP');
  assert.match(s.ewIssue, /RSP/);
  assert.equal(s.latest, 190);
  assert.equal(s.breadthDate, '2026-11-18');
  assert.equal(s.date, '2026-11-18');      // not a day ahead of the comparison
  assert.equal(s.rel1m, 0);
});
