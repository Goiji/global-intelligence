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
  ['Taiwan', 3e12], ['Switzerland', 3e12], ['France', 2.8e12], ['South Korea', 2.7e12], ['Germany', 2.7e12], ['Thailand', 0.4e12], ['Brazil', 0.8e12], ['Chile', 0.15e12], ['Narnia', 0.05e12]
];
const CMC_HTML = '<table><thead><tr><th>Rank</th><th>Name</th></tr></thead><tbody>' + CMC_ROWS.map((r, i) => cmcRow(i + 1, r[0], r[1], 100)).join('') + '</tbody></table>';
const CMC_TOTAL = CMC_ROWS.reduce((a, r) => a + r[1], 0) / 1e12;

const BIS_CSV = 'FREQ,ADJUSTMENT,REF_AREA,COUNTERPART_AREA,REF_SECTOR,COUNTERPART_SECTOR,CONSOLIDATION,ACCOUNTING_ENTRY,STO,INSTR_ASSET,MATURITY,EXPENDITURE,UNIT_MEASURE,CURRENCY_DENOM,VALUATION,PRICES,TRANSFORMATION,CUST_BREAKDOWN,TIME_PERIOD,OBS_VALUE\n'
  + [['US', '2026-Q1', 62166], ['CN', '2026-Q1', 29613], ['U2', '2026-Q1', 28038], ['JP', '2026-Q1', 10625], ['FR', '2026-Q1', 7141],
     ['GB', '2026-Q1', 6833], ['DE', '2026-Q1', 5237], ['MT', '2025-Q4', 21.7], ['XX', 'bad', 5]]
    .map(([a, p, v]) => `Q,N,${a},XW,S1,S1,N,L,LE,F3,T,_Z,USD,_T,N,V,N,_T,${p},${v}`).join('\n');

const CG_GLOBAL = JSON.stringify({ data: { total_market_cap: { usd: 2.08e12 }, market_cap_percentage: { btc: 57.8, eth: 10, usdt: 8, xrp: 4, bnb: 3.5, usdc: 3, sol: 3 }, updated_at: 1795313622 } });
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
      : url === T.URLS.COINPAPRIKA_GLOBAL ? JSON.stringify({ market_cap_usd: 2.15e12, bitcoin_dominance_percentage: 56, last_updated: 1795313964 })
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
  assert.equal(e.byKey.BR, 0.8);
  assert.equal(e.byKey.CL, 0.15, 'every mapped country gets its own key');
  assert.equal(e.byKey.OTHER, 0.05, 'only names the map does not know fall into other');
  assert.equal(e.byKey.FR, undefined, 'European countries live inside the Europe bar');
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
  assert.equal(p.byKey.FR, undefined, 'euro members are inside the euro-area bar');
  assert.equal(p.byKey.DE, undefined);
  assert.equal(p.byKey.MT, undefined);
  assert.equal(p.byKey.GB, 6.833, 'non-euro countries get their own bar');
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
  assert.deepEqual(c.top.map((x) => x[0]), ['ETH', 'XRP', 'BNB', 'SOL'], 'biggest coins, no BTC, no stablecoins');
  assert.equal(c.top[0][1], 0.208);
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

  // fresh instance: Yahoo down → PAXG; CoinGecko rate-limited (429 on Cloudflare) → CoinPaprika
  T._clearCache();
  global.fetch = fakeFetch({ [T.URLS.YAHOO_GOLD]: null, [T.URLS.COINGECKO_GLOBAL]: null });
  body = JSON.parse((await cm.handler({})).body);
  assert.equal(body.parts.gold.price, 3990);
  assert.equal(body.parts.crypto.source, 'CoinPaprika');
  assert.equal(body.parts.crypto.total, 2.15);
  assert.equal(body.parts.crypto.byKey.BTC, 1.204);

  // both crypto sources down, no last good yet → crypto missing, the rest still served
  T._clearCache();
  global.fetch = fakeFetch({ [T.URLS.COINGECKO_GLOBAL]: null, [T.URLS.COINPAPRIKA_GLOBAL]: null });
  body = JSON.parse((await cm.handler({})).body);
  assert.ok(body.errors.crypto);
  assert.equal(body.parts.crypto, undefined);
  assert.ok(body.parts.equities);
});

test('crypto: stablecoins split out of "other coins" with the DefiLlama total; skipped when it is missing or too big', async (t) => {
  const p = T.cryptoPart(CG_GLOBAL);
  const s = T.splitStablecoins(p, { total: 0.3, date: '2026-11-21' });
  assert.equal(s.byKey.STABLE, 0.3);
  assert.equal(s.byKey.OTHER, Math.round((p.byKey.OTHER - 0.3) * 1000) / 1000);
  assert.equal(s.byKey.BTC, p.byKey.BTC);
  assert.equal(T.splitStablecoins(p, null), p);
  assert.equal(T.splitStablecoins(p, { total: 5 }), p, 'bigger than the non-BTC part = bad data, no split');

  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  T._clearCache();
  const day = Date.UTC(2026, 10, 21) / 1000;
  global.fetch = fakeFetch({ [T.URLS.STABLE_URL]: JSON.stringify([{ date: String(day), totalCirculatingUSD: { peggedUSD: 300e9 } }]) });
  const body = JSON.parse((await cm.handler({})).body);
  assert.equal(body.parts.crypto.byKey.STABLE, 0.3);
  assert.equal(body.parts.crypto.stableSource, 'DefiLlama');
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

test('page: card is the last one on the first tab (after Morning Brief), with a collapsible source note', () => {
  const i = HTML.indexOf('id="capMarketsCard"');
  const end = HTML.indexOf('</main>', i);
  assert.ok(i > HTML.indexOf('id="aiBrief"') && end > i && end < HTML.indexOf('id="newsStatus"'));
  assert.equal(/<section class="card/.test(HTML.slice(i, end)), false, 'no card after it');
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
  assert.match(rows, /เหรียญอื่น/, 'crypto "others" says other coins');
  assert.match(rows, /ประเทศอื่น/, 'stocks/bonds "others" says other countries');
  assert.doesNotMatch(rows, />· อื่นๆ</);
  assert.match(rows, /class="tip-btn"[^>]*>i<\/button><span class="tip-pop" role="tooltip">ก้อนใหญ่สุดคือ Ethereum \$208 พันล้าน, XRP/, 'i button on other coins names the biggest ones');

  // many countries: 16 biggest per box, Thailand always kept, the rest folded into "other countries"
  const many = { equities: { total: 100, byKey: { TH: 0.4 } } };
  for (let i = 0; i < 25; i++) many.equities.byKey['Q' + String.fromCharCode(65 + i)] = 3 + i;
  many.equities.byKey.OTHER = 1;
  const rr = capMarketRows(many).rows.filter((x) => x.kind === 'sub').map((x) => x.key.split(':')[1]);
  assert.equal(rr.length, 16 + 2, '16 countries + Thailand + other');
  assert.ok(rr.includes('TH'));
  assert.equal(rr[rr.length - 1], 'OTHER');
  const otherRow = capMarketRows(many).rows.find((x) => x.key === 'equities:OTHER');
  assert.equal(otherRow.value, 1 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11, 'the 9 smallest folded in');
  assert.match(sb.__elements.get('cmTotal').innerHTML, /มูลค่ารวม/);
  assert.match(sb.__elements.get('cmStack').innerHTML, /flex:/);
  assert.match(sb.__elements.get('cmLegend').innerHTML, /ตราสารหนี้ทั่วโลก/);
  assert.equal((rows.match(/class="cm-group/g) || []).length, 4, 'one box per asset class');
  assert.equal(sb.__elements.get('cmWarn').textContent, '');
});
