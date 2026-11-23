// Macro Map tab: server helpers (macro-map.js, fed-odds.js) and the page's scoring — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');
const mm = require('../netlify/functions/macro-map.js').__test;
const odds = require('../netlify/functions/fed-odds.js').__test;

test('tab is wired into the tab bar, #macro deep link and lazy start', () => {
  assert.match(HTML, /data-tab="macroTab"/);
  assert.match(HTML, /<section id="macroTab" class="tabpage">/);
  assert.match(HTML, /h === 'macro' \|\| h === 'macrotab'\) return 'macroTab'/);
  assert.match(HTML, /tabId === 'macroTab' && typeof window\.macroMapActivate === 'function'/);
  const cf = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(cf, /'macro-map': macroMap/);
  assert.match(cf, /'fed-odds': fedOdds/);
});

test('YoY is matched by date, not by position (a missing month cannot shift it)', () => {
  const obs = [
    { date: '2026-09-01', value: 102 }, { date: '2026-08-01', value: 101.5 },
    { date: '2025-09-01', value: 100 }, { date: '2025-07-01', value: 99 }
  ];
  const r = mm.yoyByDate(obs, [1, 1000]);
  assert.equal(r.value, 2);
  assert.equal(r.date, '2026-09-01');
  assert.equal(r.prev, null); // Aug 2025 is missing → no previous YoY rather than a wrong one
  assert.throws(() => mm.yoyByDate([{ date: '2026-09-01', value: 1 }], [0, 10]), /year-ago/);
});

test('one-month change uses the observation on or just before 30 days earlier', () => {
  const obs = [{ date: '2026-11-20', value: 3.5 }, { date: '2026-10-20', value: 3.2 }, { date: '2026-10-10', value: 3.0 }];
  const r = mm.levelAndMonth(obs, [0, 30]);
  assert.equal(r.change1m, 0.3);
  assert.equal(r.from, '2026-10-20');
  const p = mm.levelAndMonth([{ date: '2026-11-20', value: 88 }, { date: '2026-10-21', value: 80 }], [5, 300], { pct: true });
  assert.equal(p.change1m, 10);
});

test('net liquidity = WALCL − TGA − RRP in $bn, with its 4-week change', () => {
  const walcl = [{ date: '2026-11-18', value: 6600000 }, { date: '2026-10-21', value: 6650000 }];
  const tga = [{ date: '2026-11-18', value: 850000 }, { date: '2026-10-21', value: 800000 }];
  const rrp = [{ date: '2026-11-18', value: 100 }, { date: '2026-10-21', value: 150 }];
  const r = mm.netLiquidity(walcl, tga, rrp);
  assert.equal(r.value, 5650);
  assert.equal(r.change1m, -50);
});

test('Kalshi: next meeting first, buckets from the ticker suffix, mid price, normalised', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  const mk = (s, bid, ask, last) => ({ ticker: 'KXFEDDECISION-26DEC-' + s, yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: last, volume_fp: '100' });
  const j = { events: [
    { event_ticker: 'KXFEDDECISION-27JAN', strike_date: '2027-01-27T19:00:00Z', markets: [mk('H0', '0.5', '0.6', '0.5'), mk('C25', '0.3', '0.4', '0.3')] },
    { event_ticker: 'KXFEDDECISION-26DEC', strike_date: '2026-12-09T19:00:00Z', markets: [mk('C26', '0', '0.01', '0.01'), mk('C25', '0', '0.01', '0.01'), mk('H0', '0.07', '0.08', '0.07'), mk('H25', '0.89', '0.90', '0.89'), mk('H26', '0.02', '0.03', '0.03')] },
    { event_ticker: 'KXFEDDECISION-26OCT', strike_date: '2026-10-28T18:00:00Z', markets: [mk('H0', '1', '1', '1')] }
  ] };
  const r = odds.parseKalshi(j, now);
  assert.equal(r[0].date, '2026-12-09');
  assert.equal(r[1].date, '2027-01-27');
  const o = r[0].odds;
  assert.ok(Math.abs(Object.values(o).reduce((a, b) => a + b, 0) - 100) < 0.5);
  assert.ok(o.hike25 > 85 && o.hike25 < 92);
  assert.ok(o.hold > 6 && o.hold < 9);
});

test('Polymarket: picks open fed-decision events by date and maps the group titles', () => {
  const now = Date.parse('2026-11-23T00:00:00Z');
  const picks = odds.pickPolyEvents({ events: [
    { slug: 'fed-decision-in-january-x', endDate: '2027-01-28T04:59:00Z' },
    { slug: 'how-many-dissent-at-the-december-fed-meeting', endDate: '2026-12-10T04:59:00Z' },
    { slug: 'fed-decision-in-december-x', endDate: '2026-12-10T04:59:00Z' },
    { slug: 'fed-decision-in-october', endDate: '2026-10-29T00:00:00Z', closed: true }
  ] }, now);
  assert.deepEqual(picks.map((e) => e.slug), ['fed-decision-in-december-x', 'fed-decision-in-january-x']);
  assert.equal(odds.polyBucket('50+ bps decrease'), 'cut50');
  assert.equal(odds.polyBucket('25 bps decrease'), 'cut25');
  assert.equal(odds.polyBucket('No change'), 'hold');
  assert.equal(odds.polyBucket('25 bps increase'), 'hike25');
  assert.equal(odds.polyBucket('50+ bps increase'), 'hike50');
  const ev = odds.parsePolyEvent({ slug: 's', endDate: '2026-12-10T04:59:00Z', volume: 5e7, markets: [
    { groupItemTitle: 'No change', outcomePrices: '["0.06","0.94"]', bestBid: 0.059, bestAsk: 0.061 },
    { groupItemTitle: '25 bps increase', outcomePrices: '["0.915","0.085"]', bestBid: 0.91, bestAsk: 0.92 }
  ] });
  assert.equal(ev.date, '2026-12-10');
  assert.ok(ev.odds.hike25 > 93 && ev.odds.hold < 7);
});

test('page: tilt, scenario fit and odds summary from live-shaped data', async () => {
  const sb = await runAllScripts(makeSandbox());
  const M = sb.MM;
  const hist = (a, b) => Array.from({ length: 53 }, (_, i) => [new Date(Date.parse('2025-11-20') + i * 7 * 864e5).toISOString().slice(0, 10), a + (b - a) * i / 52]);
  const ser = (a, b) => { const h = hist(a, b); return { latest: b, date: h[52][0], hist: h }; };
  Object.assign(M.D, {
    fred: { upper: { value: 4 }, lower: { value: 3.75 }, corePce: { value: 3.1, date: '2026-09-01' }, unrate: { value: 4.1, date: '2026-10-01' } },
    mk: { series: { us10y: ser(4.3, 5.0), us2y: ser(3.6, 4.5), dollar: ser(98, 103), nasdaq100: ser(25000, 21000), unrate: ser(4.2, 4.1) } },
    ex: { items: { ry10: { value: 2.4, change1m: 0.2 } } },
    mm: { items: { fwd5y5y: { value: 2.6 }, realPce: { value: 2.5, date: '2026-09-01' }, hy: { value: 3.5, change1m: 0.3 }, netLiq: { value: 5600, change1m: -150 } } },
    btc: { pct: -12 }, gold: { pct: -3 }
  });
  const reads = {};
  Object.keys(M.READ).forEach((k) => { const r = M.READ[k](); if(r) reads[k] = r; });
  const t = M.computeTilt(reads);
  assert.ok(t.tilt > 0.35, 'hot inflation + tight jobs should push toward high rates');
  assert.equal(t.parts[0].id, 'inflation');
  const A = M.actuals();
  const fit = Object.fromEntries(M.SCEN.map((s) => [s.id, M.matchScore(s, A)]));
  assert.ok(fit.hfl > 0.8, 'rising yields, strong dollar, falling stocks/BTC/gold = higher for longer');
  assert.ok(fit.dis < 0.2);
  const o = M.oddsSummary({ hold: 7, hike25: 90, hike50: 3 });
  assert.equal(o.top[0], 'hike25');
  assert.equal(Math.round(o.exp), 24);
});

test('every scenario covers every row, and unreliable links carry a caveat', () => {
  return runAllScripts(makeSandbox()).then((sb) => {
    const { SCEN, ROWS, EDGES, NODES } = sb.MM;
    SCEN.forEach((s) => ROWS.forEach((r) => assert.ok(s.r[r[0]], `${s.id} is missing ${r[0]}`)));
    const ids = new Set(NODES.map((n) => n.id));
    EDGES.forEach((e) => { assert.ok(ids.has(e[0]) && ids.has(e[1])); assert.ok(e[4] && e[5]); });
    // the classic "gold falls when rates stay high" link must not be presented as reliable
    assert.equal(SCEN.find((s) => s.id === 'hfl').r.gold[1], 1);
    assert.equal(SCEN.find((s) => s.id === 'credit').r.btc[0], 0);
  });
});
