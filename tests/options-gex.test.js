// BTC options positioning (dealer GEX, zero gamma, hedge flow, 25Δ risk reversal) and the
// volume profile / VPOC panel. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fn = require('../netlify/functions/options-gex.js');
const T = fn.__test;
const { HTML, SCRIPTS, makeSandbox } = require('./dom-stub.js');

const NOW = Date.UTC(2026, 10, 25, 1, 0);
// a small synthetic Deribit book: two expiries, strikes 40k–80k, spot/forward 60k
// calls sit mostly above spot and puts below (as on a real book), puts heavier by default
function book({ putIv = 0.6, callIv = 0.45, callOi = 300, putOi = 450 } = {}) {
  const rows = [];
  for (const exp of ['4DEC26', '25DEC26']) {
    for (let k = 40000; k <= 80000; k += 2000) {
      rows.push({ instrument_name: `BTC-${exp}-${k}-C`, open_interest: k >= 60000 ? callOi : 20, mark_iv: (k >= 60000 ? callIv : 0.5) * 100, underlying_price: 60000, estimated_delivery_price: 60000 });
      rows.push({ instrument_name: `BTC-${exp}-${k}-P`, open_interest: k <= 60000 ? putOi : 20, mark_iv: (k <= 60000 ? putIv : 0.5) * 100, underlying_price: 60000, estimated_delivery_price: 60000 });
    }
  }
  return JSON.stringify({ jsonrpc: '2.0', result: rows });
}

test('Black-76 greeks: ATM call delta ≈ 0.5, put = call − 1, gamma positive and largest at the money', () => {
  const g = T.greeks(60000, 60000, 0.5, 30 / 365);
  assert.ok(Math.abs(g.callDelta - 0.5) < 0.03);
  assert.ok(Math.abs(g.putDelta - (g.callDelta - 1)) < 1e-12);
  assert.ok(g.gamma > T.greeks(60000, 80000, 0.5, 30 / 365).gamma);
  assert.ok(Math.abs(T.ncdf(1.96) - 0.975) < 1e-4);
  assert.equal(T.greeks(0, 1, 1, 1), null);
});

test('instrument names → expiry at 08:00 UTC, strike, type', () => {
  assert.deepEqual(T.parseInstrument('BTC-26MAR27-85000-P'), { expiry: Date.UTC(2027, 2, 26, 8), strike: 85000, type: 'P', code: '26MAR27' });
  assert.equal(T.parseInstrument('BTC-PERPETUAL'), null);
  assert.equal(T.parseInstrument('ETH-26MAR27-3000-C'), null);
});

test('GEX: put-heavy book is negative gamma at spot, zero gamma sits above, hedge flow follows the move', () => {
  const d = T.compute(book(), NOW);
  const g = d.gex;
  assert.equal(d.spot, 60000);
  assert.ok(g.total < 0, 'total ' + g.total);
  assert.ok(g.zeroGamma > 60000 && g.zeroGamma < 78000, 'zero gamma ' + g.zeroGamma);
  // negative gamma below the flip → dealers sell into a fall
  const by = Object.fromEntries(g.flows.map((f) => [f.move, f]));
  assert.ok(by['-0.1'].btc < 0 && by['-0.05'].btc < 0, JSON.stringify(g.flows));
  assert.ok(Math.abs(by['-0.1'].btc) > Math.abs(by['-0.05'].btc));
  assert.ok(g.callWall >= 60000 && g.putWall <= 60000);
  assert.ok(g.byStrike.every((r) => r.call >= 0 && r.put <= 0 && r.net === r.call + r.put));
  assert.ok(g.curve.length > 100);
});

test('GEX: call-heavy book is positive gamma, dealers hedge against the move', () => {
  const g = T.compute(book({ callOi: 450, putOi: 200 }), NOW).gex;
  assert.ok(g.total > 0);
  const up = g.flows.find((f) => f.move === 0.05), dn = g.flows.find((f) => f.move === -0.05);
  assert.ok(up.btc < 0 && dn.btc > 0);
});

test('25Δ risk reversal: puts dearer → negative, constant 7/30/90-day values interpolated', () => {
  const rr = T.compute(book(), NOW).rr;
  assert.equal(rr.expiries.length, 2);
  for (const e of rr.expiries) {
    assert.ok(Math.abs(e.put25 - 60) < 0.5 && Math.abs(e.call25 - 45) < 0.5, JSON.stringify(e));
    assert.ok(Math.abs(e.rr - (e.call25 - e.put25)) < 0.02);
  }
  assert.ok(rr.cm[30].rr < -14 && rr.cm[7].rr < -14);
  assert.deepEqual(rr.cm[90].from, ['25DEC26']); // beyond the last expiry → flat extrapolation
  const flipped = T.compute(book({ putIv: 0.45, callIv: 0.6 }), NOW).rr;
  assert.ok(flipped.cm[30].rr > 14);
});

test('RR history keeps one point per ~3h for 30 days', () => {
  const H = 3600000;
  let h = T.addHist([], NOW, -5);
  h = T.addHist(h, NOW + H, -6);                // too soon → skipped
  h = T.addHist(h, NOW + 3 * H, -7);
  assert.deepEqual(h.map((p) => p[1]), [-5, -7]);
  h = T.addHist(h, NOW + 31 * 86400000, -1);    // old points age out
  assert.deepEqual(h.map((p) => p[1]), [-1]);
  assert.deepEqual(T.addHist(h, NOW + 32 * 86400000, null).length, 1);
});

test('handler: computes from Deribit, serves the last good copy when Deribit fails, 502 with nothing', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clear(); });
  T._clear();
  global.fetch = async (url) => {
    assert.match(url, /get_book_summary_by_currency\?currency=BTC&kind=option/);
    return { ok: true, status: 200, text: async () => book() };
  };
  let res = await fn.handler({});
  let body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.ok(body.gex.zeroGamma && body.rr.cm[30] && Array.isArray(body.rr.hist));
  assert.equal(body.source, 'deribit');

  global.fetch = async () => ({ ok: false, status: 503 });
  T._clear();
  res = await fn.handler({});
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).error, /HTTP 503/);
  assert.throws(() => T.parseBook(JSON.stringify({ result: [] }), NOW), /too few options/);
  assert.throws(() => T.parseBook(JSON.stringify({ error: { message: 'x' } }), NOW), /deribit: x/);
});

async function page() {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const api = sandbox.window.__optTest;
  assert.ok(api, '__optTest helpers missing');
  return api;
}

test('volume profile: VPOC at the busiest price, value area holds ≥70% around it', async () => {
  const { buildVolumeProfile } = await page();
  const cs = [];
  for (let i = 0; i < 50; i++) cs.push({ t: i, h: 60100, l: 59900, c: 60000, vol: 1e8, buy: 6e7 });   // heavy at 60k
  for (let i = 0; i < 10; i++) cs.push({ t: 50 + i, h: 64000, l: 63000, c: 63500, vol: 1e7, buy: 5e6 }); // light up high
  cs.push({ t: 99, h: 57000, l: 56500, c: 56800, vol: 1e7, buy: 1e6 });
  const p = buildVolumeProfile(cs, 70);
  assert.ok(Math.abs(p.poc - 60000) <= p.step, 'poc ' + p.poc);
  assert.ok(p.val <= 59900 && p.vah >= 60100 && p.vah < 63000, p.val + '–' + p.vah);
  const inside = p.bins.slice(p.vaLo, p.vaHi + 1).reduce((s, b) => s + b.vol, 0);
  assert.ok(inside >= 0.7 * p.total);
  assert.ok(Math.abs(p.bins.reduce((s, b) => s + b.vol, 0) - p.total) < 1);
  assert.equal(p.last, 56800);
  assert.equal(buildVolumeProfile(cs.slice(0, 5)), null);
});

test('RR zones and GEX meaning read the right way round', async () => {
  const { rrZone, gexMeaning } = await page();
  assert.equal(rrZone(-9)[0], '🔴');
  assert.equal(rrZone(-3)[0], '🟠');
  assert.equal(rrZone(0)[0], '🟡');
  assert.equal(rrZone(4)[0], '🔵');
  assert.equal(rrZone(8)[0], '🟢');
  assert.equal(gexMeaning({ total: -1e8, zeroGamma: 66000 }, 60000)[0], 'neg');
  assert.match(gexMeaning({ total: -1e8, zeroGamma: 66000 }, 60000)[1], /\$66,000/);
  assert.equal(gexMeaning({ total: 1e8, zeroGamma: null }, 60000)[0], 'pos');
});

test('index.html: GEX panel, RR tile and VPOC panel on the BTC tab, wired to their data', () => {
  for (const id of ['gexZero', 'gexTotal', 'gexWalls', 'gexChart', 'gexFlows', 'gexRanges', 'rrNum', 'rrZone', 'rrCm', 'rrTerm', 'vpPoc', 'vpVah', 'vpVal', 'vpChart', 'vpRanges']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const btc = HTML.indexOf('<section id="btcTab"');
  assert.ok(btc > 0 && HTML.indexOf('id="dvolNum"') < HTML.indexOf('id="rrNum"') && HTML.indexOf('id="rrNum"') < HTML.indexOf('id="stableNum"'));
  assert.ok(HTML.indexOf('id="rektGrid"') < HTML.indexOf('id="gexChart"') && HTML.indexOf('id="gexChart"') < HTML.indexOf('id="vpChart"') && HTML.indexOf('id="vpChart"') < HTML.indexOf('id="halvingDays"'));
  assert.ok(btc < HTML.indexOf('id="gexChart"'));
  assert.match(HTML, /fetchRekt\(\), fetchOptionsGex\(force\)\]/);
  assert.match(HTML, /fetchVpoc\(force\);/);
  assert.match(HTML, /\/\.netlify\/functions\/options-gex/);
  assert.match(HTML, /aria-label="GEX คืออะไร" data-en-aria="What is GEX\?"/);
  assert.match(HTML, /aria-label="VPOC คืออะไร" data-en-aria="What is VPOC\?"/);
  const fs = require('node:fs');
  assert.match(fs.readFileSync(require.resolve('../functions/[[path]].js'), 'utf8'), /'options-gex': optionsGex/);
});
