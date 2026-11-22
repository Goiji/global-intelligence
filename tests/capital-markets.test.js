// World capital markets bar chart — function parsers/handler + the page's row builder. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const cm = require('../netlify/functions/capital-markets.js');
const T = cm.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

// companiesmarketcap all-countries rows (shape copied from the live page, values made up)
const cmcRow = (rank, name, usd, n) => `<tr><td class="rank-td td-right" data-sort="${rank}">${rank}</td><td data-sort="${name}"><a href="/x/">🏳 ${name}</a></td><td class="td-right" data-sort="${usd}"><span class="currency-symbol-left">$</span>x T</td><td class="td-right" data-sort="${n}">${n}</td></tr>`;
const CMC_ROWS = [
  ['United States', 70e12], ['China', 10e12], ['Japan', 7e12], ['India', 4e12], ['United Kingdom', 4e12], ['Canada', 3.5e12],
  ['Taiwan', 3e12], ['Switzerland', 3e12], ['France', 2.8e12], ['South Korea', 2.7e12], ['Germany', 2.7e12], ['Thailand', 0.4e12], ['Brazil', 0.8e12]
];
const CMC_HTML = '<table><thead><tr><th>Rank</th><th>Name</th></tr></thead><tbody>' + CMC_ROWS.map((r, i) => cmcRow(i + 1, r[0], r[1], 100)).join('') + '</tbody></table>';
const CMC_TOTAL = CMC_ROWS.reduce((a, r) => a + r[1], 0) / 1e12;

const BIS_CSV = 'FREQ,ADJUSTMENT,REF_AREA,COUNTERPART_AREA,REF_SECTOR,COUNTERPART_SECTOR,CONSOLIDATION,ACCOUNTING_ENTRY,STO,INSTR_ASSET,MATURITY,EXPENDITURE,UNIT_MEASURE,CURRENCY_DENOM,VALUATION,PRICES,TRANSFORMATION,CUST_BREAKDOWN,TIME_PERIOD,OBS_VALUE\n'
  + [['US', '2026-Q1', 62166], ['CN', '2026-Q1', 29613], ['U2', '2026-Q1', 28038], ['JP', '2026-Q1', 10625], ['FR', '2026-Q1', 7141],
     ['GB', '2026-Q1', 6833], ['DE', '2026-Q1', 5237], ['MT', '2025-Q4', 21.7], ['XX', 'bad', 5]]
    .map(([a, p, v]) => `Q,N,${a},XW,S1,S1,N,L,LE,F3,T,_Z,USD,_T,N,V,N,_T,${p},${v}`).join('\n');

const CG_GLOBAL = JSON.stringify({ data: { total_market_cap: { usd: 2.08e12 }, market_cap_percentage: { btc: 57.8 }, updated_at: 1795313622 } });
const YAHOO_GOLD = JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 4000 } }] } });

function fakeFetch(overrides = {}) {
  const seen = [];
  const fn = async (url) => {
    seen.push(url);
    const body = url in overrides ? overrides[url]
      : url === T.URLS.CMC_COUNTRIES ? CMC_HTML
      : url === T.URLS.BIS_DSS ? BIS_CSV
      : url === T.URLS.COINGECKO_GLOBAL ? CG_GLOBAL
      : url === T.URLS.YAHOO_GOLD ? YAHOO_GOLD
      : url === T.URLS.COINGECKO_PAXG ? JSON.stringify({ 'pax-gold': { usd: 3990 } })
      : null;
    if (body == null) return { ok: false, status: 503, text: async () => '' };
    return { ok: true, status: 200, text: async () => body };
  };
  fn.seen = seen;
  return fn;
}

test('parseCmcCountries + equitiesPart: sums countries, Europe bar, "other" = the rest', () => {
  const c = T.parseCmcCountries(CMC_HTML);
  assert.equal(c.count, CMC_ROWS.length);
  assert.ok(Math.abs(c.total - CMC_TOTAL) < 1e-9);
  const e = T.equitiesPart(c);
  assert.equal(e.byKey.US, 70);
  assert.equal(e.byKey.EU, 4 + 3 + 2.8 + 2.7, 'UK + Switzerland + France + Germany');
  assert.equal(e.byKey.TH, 0.4);
  const sum = Object.values(e.byKey).reduce((a, v) => a + v, 0);
  assert.ok(Math.abs(sum - e.total) < 0.01, 'bars add up to the world total');
  assert.equal(e.byKey.OTHER, 0.8, 'Brazil is the only country not shown on its own');
  assert.throws(() => T.parseCmcCountries('<tr><td data-sort="1"></td></tr>'), /too few/);
});

test('parseBisDss + bondsPart: US$ bn → tn, euro area not counted twice, bad rows skipped', () => {
  const b = T.parseBisDss(BIS_CSV);
  assert.equal(b.period, '2026-Q1', 'the quarter most countries report');
  assert.equal(b.count, 7);
  const want = (62166 + 29613 + 10625 + 7141 + 6833 + 5237 + 21.7) / 1000;
  assert.ok(Math.abs(b.total - want) < 1e-9);
  const p = T.bondsPart(b);
  assert.equal(p.byKey.US, 62.166);
  assert.equal(p.byKey.U2, 28.038);
  assert.equal(p.asOf, '2026-03-31');
  assert.equal(p.cadence, 'quarterly');
  assert.ok(p.byKey.OTHER >= 0);
  assert.throws(() => T.parseBisDss('nope'), /header/);
});

test('quarterEnd, goldPart, cryptoPart', () => {
  assert.equal(T.quarterEnd('2025-Q4'), '2025-12-31');
  assert.equal(T.quarterEnd('2026-Q2'), '2026-06-30');
  const at = Date.UTC(2025, 11, 31, 6); // ~1 year after the WGC baseline
  const g = T.goldPart(4000, 'test', at);
  assert.ok(Math.abs(g.tonnes - (216265 + 3661)) < 5);
  assert.ok(g.total > 27 && g.total < 29, 'about 220k t × 32,151 oz/t × $4,000 ≈ $28T');
  assert.throws(() => T.goldPart(12, 'x'), /implausible/);
  const c = T.cryptoPart(CG_GLOBAL);
  assert.equal(c.total, 2.08);
  assert.equal(c.byKey.BTC, Math.round(2.08 * 0.578 * 1000) / 1000);
  assert.throws(() => T.cryptoPart('{"data":{}}'), /implausible/);
});

test('handler: all four parts, memory cache, gold falls back to PAXG, a dead source is filled from last good', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  T._clearCache();
  global.fetch = fakeFetch();
  let res = await cm.handler({});
  let body = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(body.parts).sort(), ['bonds', 'crypto', 'equities', 'gold']);
  assert.equal(body.parts.gold.price, 4000);
  assert.equal(body.errors, undefined);
  body = JSON.parse((await cm.handler({})).body);
  assert.equal(body.cached, true);

  // fresh instance: Yahoo down → PAXG; CoinGecko global down → crypto missing, no last good yet
  T._clearCache();
  global.fetch = fakeFetch({ [T.URLS.YAHOO_GOLD]: null, [T.URLS.COINGECKO_GLOBAL]: null });
  body = JSON.parse((await cm.handler({})).body);
  assert.equal(body.parts.gold.price, 3990);
  assert.ok(body.errors.crypto);
  assert.equal(body.parts.crypto, undefined);
});

test('handler: a part that fails later is served from the last good copy (staleParts)', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  T._clearCache();
  global.fetch = fakeFetch();
  await cm.handler({});
  // expire the memory answer but keep lastGood: call the private cache via a second round
  global.fetch = fakeFetch({ [T.URLS.CMC_COUNTRIES]: null });
  const realNow = Date.now;
  Date.now = () => realNow() + 16 * 60 * 1000;
  t.after(() => { Date.now = realNow; });
  const body = JSON.parse((await cm.handler({})).body);
  assert.deepEqual(body.staleParts, ['equities']);
  assert.equal(body.parts.equities.byKey.US, 70);
});

test('handler: 502 when every source is down and nothing is cached', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  T._clearCache();
  global.fetch = async () => ({ ok: false, status: 503, text: async () => '' });
  const res = await cm.handler({});
  assert.equal(res.statusCode, 502);
});

test('Cloudflare adapter routes /.netlify/functions/capital-markets', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(src, /import capitalMarkets from '\.\.\/netlify\/functions\/capital-markets\.js'/);
  assert.match(src, /'capital-markets': capitalMarkets/);
});

test('page: card sits between Market Prices and US Markets, with a collapsible source note', () => {
  const i = HTML.indexOf('id="capMarketsCard"');
  assert.ok(i > HTML.indexOf('id="livePrices"') && i < HTML.indexOf('id="mktGrid"'));
  assert.match(HTML, /<details class="src-note"><summary data-en="ⓘ Sources">ⓘ แหล่งข้อมูล<\/summary><div id="cmNote"/);
});

test('page: rows sorted largest first, "others" last, bars on one scale, values rendered', async () => {
  const payload = await (async () => {
    const realFetch = global.fetch;
    T._clearCache();
    global.fetch = fakeFetch();
    try { return JSON.parse((await cm.handler({})).body); } finally { global.fetch = realFetch; T._clearCache(); }
  })();
  const sb = makeSandbox({
    fetchImpl: async (url) => String(url).includes('capital-markets')
      ? { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
      : { ok: false, status: 503, json: async () => ({}), text: async () => '' }
  });
  await runAllScripts(sb);
  const { capMarketRows, fmtCapT } = sb.__capTest;
  const r = capMarketRows(payload.parts);
  const mains = r.rows.filter((x) => x.kind === 'main').map((x) => x.key);
  assert.deepEqual([...mains], ['bonds', 'equities', 'gold', 'crypto'], 'fixture: bonds $122T > stocks $114T');
  assert.equal(r.rows[0].width, 100);
  const eqSubs = r.rows.filter((x) => x.key.startsWith('equities:')).map((x) => x.key.split(':')[1]);
  assert.equal(eqSubs[0], 'US');
  assert.equal(eqSubs[eqSubs.length - 1], 'OTHER');
  assert.ok(Math.abs(r.grand - mains.reduce((a, k) => a + payload.parts[k].total, 0)) < 1e-9);
  assert.equal(fmtCapT(62.166), '$62.2 ล้านล้าน');
  assert.equal(fmtCapT(0.43), '$430 พันล้าน');
  assert.equal(fmtCapT(157.4), '$157 ล้านล้าน');
  const rows = sb.__elements.get('cmRows').innerHTML;
  assert.match(rows, /หุ้นทั่วโลก/);
  assert.match(rows, /🇹🇭 ไทย/);
  assert.match(sb.__elements.get('cmTotal').innerHTML, /รวมทั้งหมด/);
  assert.equal(sb.__elements.get('cmWarn').textContent, '');
});
