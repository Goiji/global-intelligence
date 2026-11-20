// Tests for the "more US economy" cards: existing home sales, mortgage rates, retail sales, ISM PMIs
// and breakeven inflation (netlify/functions/econ-extra.js + the cards / analysis in index.html).

const test = require('node:test');
const assert = require('node:assert/strict');
const fn = require('../netlify/functions/econ-extra.js');
const cal = require('../netlify/functions/calendar.js').__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const T = fn.__test;
const ms = (iso) => Date.parse(iso);

// Investing.com chart data as served by sbcharts…/events_charts/us/173.json (shape trimmed).
function ismChart() {
  return {
    data: [
      [ms('2026-08-03T14:00:00Z'), 48.0, 'No'],
      [ms('2026-09-01T14:00:00Z'), 49.1, 'No'],
      [ms('2026-10-01T14:00:00Z'), 48.7, 'No'],
      [ms('2026-11-02T15:00:00Z'), 50.4, 'No']
    ],
    attr: [
      { timestamp: ms('2026-10-01T14:00:00Z'), actual_state: 'down', actual: 48.7, forecast: 49.0, revised: null },
      { timestamp: ms('2026-11-02T15:00:00Z'), actual_state: 'up', actual: 50.4, forecast: 49.3, revised: null }
    ]
  };
}

test('sbcharts → one row per release, about the month before, with the forecast attached', () => {
  const rows = T.parseSbcharts(JSON.stringify(ismChart()));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[3], { release: '2026-11-02', ref: '2026-10-01', actual: 50.4, forecast: 49.3 });
  const s = T.summaryFromReleases(rows, T.RANGE.pmi);
  assert.equal(s.value, 50.4);
  assert.equal(s.date, '2026-10-01');
  assert.equal(s.forecast, 49.3);
  assert.deepEqual(s.prev, { value: 48.7, date: '2026-09-01' });
  assert.equal(s.hist.length, 4);
  assert.throws(() => T.parseSbcharts('{"data":[],"attr":[]}'), /no actual/);
});

test('ISM page fallback reads the "PMI® registered" sentence', () => {
  const html = '<p>The Manufacturing PMI<sup>&reg;</sup> registered 48.7 percent in October, down 0.4 percentage point.</p>';
  assert.equal(T.parseIsmPage(html, 'mfg'), 48.7);
  assert.equal(T.parseIsmPage('<p>In October, the Services PMI® registered 52.4 percent.</p>', 'svc'), 52.4);
  assert.equal(T.parseIsmPage('<p>Just a moment…</p>', 'mfg'), null);
});

test('retail sales MoM is computed by date from RSAFS levels (missing month cannot fake a swing)', () => {
  const obs = [
    { date: '2026-09-01', value: 735000 },
    { date: '2026-08-01', value: 732000 },
    { date: '2026-07-01', value: 729000 },
    // June missing
    { date: '2026-05-01', value: 700000 },
    { date: '2025-09-01', value: 710000 }
  ];
  const r = T.retailFromLevels(obs);
  assert.equal(r.date, '2026-09-01');
  assert.ok(Math.abs(r.value - 0.4098) < 0.001);
  assert.equal(r.prev.date, '2026-08-01');
  assert.equal(r.hist.length, 2, 'July→May is not a month pair');
  assert.ok(Math.abs(r.yoy - 3.52) < 0.01);
});

test('a newer Investing.com print is appended to FRED history and the forecast is matched by month', () => {
  const fred = { value: 0.41, date: '2026-08-01', prev: { value: 0.2, date: '2026-07-01' }, hist: [['2026-07-01', 0.2], ['2026-08-01', 0.41]] };
  const rows = [
    { release: '2026-09-16', ref: '2026-08-01', actual: 0.4, forecast: 0.3 },
    { release: '2026-10-15', ref: '2026-09-01', actual: 0.6, forecast: 0.4 }
  ];
  const m = T.mergeMonthly(fred, rows, T.RANGE.retailMom);
  assert.equal(m.date, '2026-09-01');
  assert.equal(m.value, 0.6);
  assert.equal(m.forecast, 0.4);
  assert.equal(m.prev.value, 0.41);
  assert.equal(m.hist[m.hist.length - 1][0], '2026-09-01');
  // same month: FRED stays, forecast attached
  const same = T.mergeMonthly(fred, rows.slice(0, 1), T.RANGE.retailMom);
  assert.equal(same.date, '2026-08-01');
  assert.equal(same.forecast, 0.3);
  // home sales: Investing.com prints millions
  const hs = T.mergeMonthly({ value: 4060000, date: '2026-09-01', hist: [] }, [{ release: '2026-10-23', ref: '2026-09-01', actual: 4.06, forecast: 4.1 }], T.RANGE.homeSales, 1e6);
  assert.equal(hs.forecast, 4100000);
});

test('mortgage rate carries its spread over the 10-year yield on the survey day (or the day before)', () => {
  const mort = [{ date: '2026-11-12', value: 6.17 }, { date: '2026-11-05', value: 6.22 }];
  const dgs10 = [{ date: '2026-11-11', value: 4.12 }, { date: '2026-11-05', value: 4.15 }];
  const s = T.mortgageSummary(mort, dgs10);
  assert.equal(s.value, 6.17);
  assert.equal(s.change, -0.05);
  assert.equal(s.spread10y, 2.05);
  assert.equal(s.prevSpread10y, 2.07);
  assert.equal(s.hist.length, 2);
});

test('breakeven history is thinned to one point per week', () => {
  const obs = [];
  for (let i = 0; i < 300; i++) obs.push({ date: new Date(Date.UTC(2026, 10, 13) - i * 86400000).toISOString().slice(0, 10), value: 2.3 + (i % 7) / 100 });
  const s = T.levelSummary(obs, T.RANGE.breakeven, { thinDaily: true, digits: 2 });
  assert.ok(s.hist.length <= 54 && s.hist.length >= 40, `got ${s.hist.length} points`);
  assert.equal(s.hist[s.hist.length - 1][0], '2026-11-13');
});

test('real yield: one-month change from the daily series', () => {
  const obs = [];
  for (let i = 0; i < 120; i++) obs.push({ date: new Date(Date.UTC(2026, 10, 13) - i * 86400000).toISOString().slice(0, 10), value: 2.1 - i * 0.01 });
  const s = T.realYieldSummary(obs);
  assert.equal(s.value, 2.1);
  assert.equal(s.change1mFrom, '2026-10-14');
  assert.equal(s.change1m, 0.3);
  assert.equal(T.realYieldSummary(obs.slice(0, 5)).change1m, null, 'no month of history → no change');
});

test('real yield verdict: direction first, then level', async () => {
  const sb = makeSandbox({ fetchImpl: stub() });
  await runAllScripts(sb);
  const V = sb.window.realYieldVerdict;
  assert.equal(V(1.5, 0.25).key, 'rising');
  assert.equal(V(2.4, -0.3).key, 'falling', 'falling fast beats a high level');
  assert.equal(V(2.0, 0.1).key, 'high');
  assert.equal(V(0.5, null).key, 'low');
  assert.equal(V(1.5, 0.1).key, 'normal');
  assert.equal(V(1.5, 0.1).accent, 'var(--warn)');
  assert.equal(V(null, 0.1), null);
});

test('handler: every source down → 502, never throws', async () => {
  const orig = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    T._clearCache();
    const res = await fn.handler();
    assert.equal(res.statusCode, 502);
    assert.match(JSON.parse(res.body).error, /every source failed/);
  } finally {
    global.fetch = orig;
  }
});

test('handler: a card whose source hiccups is filled from the last good copy (KV) and cached only briefly', async () => {
  const orig = global.fetch;
  const csv = (id) => 'observation_date,' + id + '\n' + Array.from({ length: 60 }, (_, i) => new Date(Date.UTC(2026, 10, 12) - i * 7 * 86400000).toISOString().slice(0, 10) + ',' + (id.startsWith('MORT') ? 6.2 : id === 'DGS10' ? 4.1 : 2.3)).reverse().join('\n');
  const store = new Map();
  const kv = { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const event = { cloudflare: { kv } };
  let fredUp = true;
  global.fetch = async (url) => {
    const m = /fredgraph\.csv\?id=([A-Z0-9]+)/.exec(String(url));
    if (m && fredUp) return { ok: true, status: 200, text: async () => csv(m[1]) };
    throw new Error('offline');
  };
  try {
    T._clearCache();
    let body = JSON.parse((await fn.handler(event)).body);
    assert.ok(body.items.mort30 && body.items.be10, 'FRED cards load');
    assert.ok(store.has('econ-extra:lastGood'));

    T._clearCache(); // a cold start: memory gone, FRED now failing
    fredUp = false;
    const res = await fn.handler(event);
    body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.items.mort30.value, 6.2, 'mortgage card filled from KV');
    assert.ok(body.staleItems.includes('mort30') && body.staleItems.includes('be5'));
    assert.ok(!body.errors || !body.errors.mort30);
    assert.match(res.headers['Cache-Control'], /max-age=120/);
  } finally {
    global.fetch = orig;
    T._clearCache();
  }
});

test('calendar: ISM on the 1st / 3rd US business day, skipping holidays', () => {
  assert.equal(cal.nthBusinessDay(2026, 12, 1), '2026-12-01');
  assert.equal(cal.nthBusinessDay(2026, 12, 3), '2026-12-03');
  assert.equal(cal.nthBusinessDay(2027, 1, 1), '2027-01-04', 'Jan 1 2027 is a Friday holiday');
  assert.equal(cal.nthBusinessDay(2025, 9, 1), '2025-09-02', 'Labor Day');
  const ev = cal.ismEvents(new Date('2026-11-14T00:00:00Z'));
  assert.ok(ev.some((e) => e.key === 'ismMfg' && e.date === '2026-12-01' && e.at === '2026-12-01T15:00:00.000Z'));
});

// ── the page ────────────────────────────────────────────────────────────────────────────────
test('markup: 9 cards, each with an (i) explainer in Thai and English', () => {
  const m = /<div class="metrics" id="extraMetrics">([\s\S]*?)<div class="muted"[^>]*id="econExtraNote"/.exec(HTML);
  assert.ok(m, '#extraMetrics missing');
  assert.equal((m[1].match(/class="tip-btn"/g) || []).length, 9);
  for (const id of ['homeSales', 'mort30', 'mort15', 'retailSales', 'ismMfg', 'ismSvc', 'be5', 'be10', 'ry10', 'spHome', 'spMort30', 'spMort15', 'spRetail', 'spIsmMfg', 'spIsmSvc', 'spBe5', 'spBe10', 'spRy10']) {
    assert.match(m[1], new RegExp(`id="${id}"`), `missing #${id}`);
  }
  assert.match(m[1], /ยังไม่หักเงินเฟ้อ/, 'retail tooltip must say it is not inflation-adjusted');
  assert.match(m[1], /not adjusted for inflation/);
  assert.match(m[1], /เส้นแบ่งคือ 50/);
  assert.match(m[1], /TIPS/);
  assert.equal((m[1].match(/<b>สีบนการ์ด:<\/b>/g) || []).length, 9, 'every card explains its colours');
  assert.equal((m[1].match(/<b>Colours on the card:<\/b>/g) || []).length, 9);
  assert.match(m[1], /2\.5%/);
  assert.equal((m[1].match(/class="tv-btn" href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=/g) || []).length, 9, 'each card links to TradingView');
  assert.match(m[1], /symbol=FRED%3ADFII10/, 'real yield card opens FRED:DFII10');
  assert.match(m[1], /ทองคำมักวิ่งสวน/);
  assert.match(m[1], /Direction matters more than level/);
});

test('every US Markets card links to TradingView', () => {
  const m = HTML.match(/<div class="mkt-grid" id="mktGrid">([\s\S]*?)<div id="mktNote"|<div class="mkt-grid" id="mktGrid">([\s\S]*?)<\/section>/);
  const block = m[1] || m[2];
  const cards = block.split(/<div class="metric mkt"[^>]*>/).slice(1);
  assert.equal(cards.length, 13);
  cards.forEach((c, i) => assert.match(c, /class="tv-btn" href="https:\/\/www\.tradingview\.com\/chart\/\?symbol=/, 'card ' + i + ' has a TradingView link'));
});

function fredPayload() {
  return {
    upper: { value: 3.75, date: '2026-11-12', sinceDate: '2026-10-29', changePp: -0.25, meetingsSinceChange: 1 },
    lower: { value: 3.5, date: '2026-11-12' },
    cpi: { value: 3.0, date: '2026-09-01', mom: 0.3 }
  };
}
function extraPayload() {
  const hist = (vals, start = 2025) => vals.map((v, i) => [`${start + Math.floor((9 + i) / 12)}-${String(((9 + i) % 12) + 1).padStart(2, '0')}-01`, v]);
  return {
    items: {
      homeSales: { value: 4060000, date: '2026-09-01', prev: { value: 4000000, date: '2026-08-01' }, forecast: 4100000, hist: hist([4.0e6, 4.06e6]) },
      mort30: { value: 6.17, date: '2026-11-12', change: -0.05, prev: { value: 6.22, date: '2026-11-05' }, spread10y: 2.05, prevSpread10y: 2.07, us10y: { value: 4.12, date: '2026-11-11' }, hist: [['2026-11-05', 6.22], ['2026-11-12', 6.17]] },
      mort15: { value: 5.4, date: '2026-11-12', change: -0.02, prev: { value: 5.42, date: '2026-11-05' }, spread10y: 1.28, hist: [['2026-11-05', 5.42], ['2026-11-12', 5.4]] },
      retail: { value: 0.6, date: '2026-09-01', prev: { value: 0.2, date: '2026-08-01' }, forecast: 0.4, yoy: 4.1, hist: hist([0.2, 0.6]) },
      ismMfg: { value: 48.7, date: '2026-10-01', prev: { value: 49.1, date: '2026-09-01' }, forecast: 49.2, hist: hist([49.1, 48.7]) },
      ismSvc: { value: 52.4, date: '2026-10-01', prev: { value: 49.9, date: '2026-09-01' }, forecast: 51.0, hist: hist([49.9, 52.4]) },
      be5: { value: 2.41, date: '2026-11-13', change: 0.02, hist: [['2026-11-06', 2.39], ['2026-11-13', 2.41]] },
      be10: { value: 2.55, date: '2026-11-13', change: -0.01, hist: [['2026-11-06', 2.56], ['2026-11-13', 2.55]] },
      ry10: { value: 1.85, date: '2026-11-13', change: 0.03, change1m: 0.31, change1mFrom: '2026-10-13', hist: [['2026-10-13', 1.54], ['2026-11-13', 1.85]] }
    },
    ttl: 1800
  };
}
function stub() {
  return async (url) => {
    const u = String(url);
    const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.includes('/.netlify/functions/fred-data')) return ok(fredPayload());
    if (u.includes('/.netlify/functions/econ-extra')) return ok(extraPayload());
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
}
const txt = (sb, id) => String(sb.document.getElementById(id).innerHTML || '') + ' ' + String(sb.document.getElementById(id).textContent || '');

test('page: cards and the analysis section use the econ-extra numbers (Thai)', async () => {
  const sb = makeSandbox({ fetchImpl: stub() });
  await runAllScripts(sb);
  await new Promise((r) => setTimeout(r, 30));
  assert.match(txt(sb, 'homeSales'), /4\.06M/);
  assert.match(txt(sb, 'mort30'), /6\.17%/);
  assert.match(txt(sb, 'mort30Info'), /ห่างบอนด์ 10 ปี/);
  assert.match(txt(sb, 'mort30Info'), /🟡 ปานกลาง/);
  assert.match(txt(sb, 'homeSalesInfo'), /🟢 ปกติ|🟠 ต่ำกว่าปกติ|🔴 ซบเซามาก/);
  assert.match(txt(sb, 'retailInfo'), /🟢 แรงกว่าคาด/);
  assert.match(txt(sb, 'retailSales'), /\+0\.6%/);
  assert.match(txt(sb, 'retailInfo'), /คาด/);
  assert.match(txt(sb, 'ismMfg'), /48\.7/);
  assert.match(txt(sb, 'ismMfgInfo'), /หดตัว/);
  assert.match(txt(sb, 'ismSvcInfo'), /ขยายตัว/);
  assert.match(txt(sb, 'be10Info'), /ไม่เชื่อ/);
  // Real Yield: rising +0.31 in a month → red on the card AND in the analysis (same verdict)
  assert.match(txt(sb, 'ry10'), /1\.85%/);
  assert.match(sb.document.getElementById('ry10').className, /tone-bad/);
  assert.match(txt(sb, 'ry10Info'), /🔴 พุ่งขึ้นเร็ว/);
  assert.match(txt(sb, 'ry10Info'), /\+0\.31/);
  const a = txt(sb, 'fedAnalysis');
  assert.match(a, /Real Yield 10 ปี — 🔴 พุ่งขึ้นเร็ว/);
  assert.match(a, /บอนด์ 10 ปีราว 4\.40%/);
  assert.match(a, /ยอดค้าปลีก — 🟢 แรงกว่าที่คาด/);
  assert.match(a, /หักเงินเฟ้อคร่าว ๆ/);
  assert.match(a, /ISM ภาคการผลิต — 🔴 แย่กว่าที่คาด/);
  assert.match(a, /ISM ภาคบริการ — 🟢 ดีกว่าที่คาด/);
  assert.match(a, /กลับมาขยายตัว/);
  assert.match(a, /ยอดขายบ้านมือสอง — 🟡 ใกล้เคียงที่คาด|ยอดขายบ้านมือสอง — 🔴 แย่กว่าที่คาด/);
  assert.match(a, /ดอกเบี้ยบ้าน — 🟢 ลดลงจากสัปดาห์ก่อน/);
});

test('page: English mode has no Thai left in the new cards and analysis', async () => {
  const sb = makeSandbox({ fetchImpl: stub() });
  sb.localStorage.setItem('gi-lang', 'en');
  await runAllScripts(sb);
  await new Promise((r) => setTimeout(r, 30));
  const THAI = /[฀-๿]/;
  for (const id of ['homeSalesInfo', 'mort30Info', 'retailInfo', 'ismMfgInfo', 'ismSvcInfo', 'be5Info', 'be10Info', 'ry10Info', 'econExtraNote', 'fedAnalysis']) {
    const t = txt(sb, id);
    assert.ok(!THAI.test(t), `#${id} has Thai: ${(t.match(/.{0,40}[฀-๿]+.{0,40}/) || [''])[0]}`);
  }
  assert.match(txt(sb, 'fedAnalysis'), /Retail Sales — 🟢 Stronger than forecast/);
  assert.match(txt(sb, 'fedAnalysis'), /10-year real yield — 🔴 Rising fast/);
});
