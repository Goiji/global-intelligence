// Netlify Function: how much money sits in each of the world's big markets, for the
// "ขนาดตลาดทุนโลก / World capital markets" bar chart in the 🌍 tab.
//
//   GET /.netlify/functions/capital-markets
//   → { parts: { equities, bonds, gold, crypto }, fetchedAt, ttl, [errors], [staleParts] }
//     every value is in US$ trillions; each part carries its own `asOf` and `source`
//
// Nothing here is typed in by hand except the gold-stock baseline (see GOLD_*). Each part updates as
// often as its source does:
//   equities — companiesmarketcap.com "all countries" page: market cap of every listed company it
//              tracks, summed per country (live, prices a few minutes to hours delayed). The world total
//              is the sum of the countries. No key.
//   bonds    — BIS debt securities statistics (WS_NA_SEC_DSS): all debt securities outstanding, all
//              issuers, nominal value in US$, per country. Quarterly, about 3–4 months after the quarter.
//              No key. The world total is the sum of the countries (the euro-area aggregate U2 is shown
//              as its own bar but not added again).
//   gold     — gold price (Yahoo GC=F → CoinGecko PAX Gold) × above-ground gold stock. The stock is the
//              World Gold Council's end-2024 figure grown by one year of mine output per year since.
//   crypto   — CoinGecko /global: total crypto market cap and Bitcoin's share (live). No key.
//
// Answers from memory/CDN for 15 min (the BIS file for 12 h). A source that fails is filled from the
// last good copy (memory, then Cloudflare KV / Netlify Blobs), so one hiccup never blanks a bar.

const TIMEOUT_MS = 9000;
const TTL_S = 15 * 60;
const BIS_TTL_MS = 12 * 3600 * 1000;
const UA = 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)';

const CMC_COUNTRIES = 'https://companiesmarketcap.com/all-countries/';
const BIS_DSS = 'https://stats.bis.org/api/v1/data/WS_NA_SEC_DSS/Q.N..XW.S1.S1.N.L.LE.F3.T._Z.USD._T.N.V.N._T/all?lastNObservations=1&format=csv&detail=dataonly';
const COINGECKO_GLOBAL = 'https://api.coingecko.com/api/v3/global';
const YAHOO_GOLD = 'https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF?interval=1d&range=5d';
const COINGECKO_PAXG = 'https://api.coingecko.com/api/v3/simple/price?ids=pax-gold&vs_currencies=usd';

// World Gold Council, "Above-ground stocks": 216,265 t at end-2024; mine production 2024 ≈ 3,661 t.
const GOLD_STOCK_T = 216265;
const GOLD_STOCK_AT = Date.UTC(2024, 11, 31);
const GOLD_MINE_T_PER_YEAR = 3661;
const OZ_PER_TONNE = 32150.7466;

// companiesmarketcap country names that make up the "Europe" bar (EU + UK, Switzerland, Norway, …)
const EUROPE = new Set(['United Kingdom', 'Switzerland', 'France', 'Germany', 'Netherlands', 'Spain', 'Sweden', 'Italy',
  'Ireland', 'Denmark', 'Belgium', 'Norway', 'Finland', 'Poland', 'Austria', 'Luxembourg', 'Greece', 'Portugal',
  'Czech Republic', 'Iceland', 'Hungary', 'Romania', 'Cyprus', 'Malta', 'Estonia', 'Latvia', 'Lithuania', 'Slovenia',
  'Slovakia', 'Croatia', 'Bulgaria', 'Monaco', 'Liechtenstein']);
// bars under "stocks", in this order of preference (the page sorts them by size); the rest → "other"
const EQUITY_KEYS = [['US', 'United States'], ['EU', null], ['CN', 'China'], ['JP', 'Japan'], ['IN', 'India'],
  ['CA', 'Canada'], ['TW', 'Taiwan'], ['KR', 'South Korea'], ['TH', 'Thailand']];
const BOND_KEYS = ['US', 'CN', 'U2', 'JP', 'GB'];

let memCache = { data: null, expiresAt: 0, lastGood: null };
let bisCache = { data: null, expiresAt: 0 };

async function fetchText(url, accept) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: accept || '*/*' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;
const decode = (s) => String(s).replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

// companiesmarketcap all-countries HTML → { total, countries: { name: US$ tn }, count }
// Each row: <td data-sort="Country name">…</td><td class="td-right" data-sort="73546369686323">$73.546 T</td>
function parseCmcCountries(html) {
  const countries = {};
  const rowRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = rowRe.exec(String(html)))) {
    const sorts = [...m[1].matchAll(/data-sort="([^"]*)"/g)].map((x) => x[1]);
    // [rank, name, marketcap, company count]
    if (sorts.length < 3) continue;
    const name = decode(sorts[1]);
    const usd = Number(sorts[2]);
    if (!name || /^\d+$/.test(name) || !isFinite(usd) || usd <= 0) continue;
    countries[name] = (countries[name] || 0) + usd / 1e12;
  }
  const names = Object.keys(countries);
  if (names.length < 10) throw new Error('companiesmarketcap: too few country rows (' + names.length + ')');
  const total = names.reduce((a, k) => a + countries[k], 0);
  if (total < 20 || total > 1000) throw new Error('companiesmarketcap: implausible total ' + total);
  if (!(countries['United States'] > 5)) throw new Error('companiesmarketcap: no United States row');
  return { total, countries, count: names.length };
}

function equitiesPart(cmc) {
  const byKey = {};
  for (const [key, name] of EQUITY_KEYS) {
    if (key === 'EU') {
      let s = 0;
      for (const n of Object.keys(cmc.countries)) if (EUROPE.has(n)) s += cmc.countries[n];
      if (s > 0) byKey.EU = r3(s);
    } else if (cmc.countries[name] > 0) byKey[key] = r3(cmc.countries[name]);
  }
  const shown = Object.values(byKey).reduce((a, v) => a + v, 0);
  byKey.OTHER = r3(Math.max(0, cmc.total - shown));
  return { total: r3(cmc.total), byKey, asOf: new Date().toISOString(), cadence: 'live', source: 'companiesmarketcap.com', countries: cmc.count };
}

// BIS SDMX CSV → { total, byArea: { ISO2: US$ tn }, period }  (OBS_VALUE is in US$ billions)
function parseBisDss(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',');
  const iArea = head.indexOf('REF_AREA'), iTime = head.indexOf('TIME_PERIOD'), iVal = head.indexOf('OBS_VALUE');
  if (iArea < 0 || iTime < 0 || iVal < 0) throw new Error('BIS: unexpected CSV header');
  const byArea = {}, periods = {};
  for (const l of lines) {
    const c = l.split(',');
    const area = c[iArea], period = c[iTime], bn = Number(c[iVal]);
    if (!/^[A-Z0-9]{2}$/.test(area || '') || !/^\d{4}-Q[1-4]$/.test(period || '') || !isFinite(bn) || bn <= 0) continue;
    byArea[area] = bn / 1000;
    periods[area] = period;
  }
  if (!(byArea.US > 5)) throw new Error('BIS: no US row');
  // world = the countries; U2 (euro area) is an aggregate of members already in the list
  let total = 0;
  for (const a of Object.keys(byArea)) if (/^[A-Z]{2}$/.test(a) && a !== 'U2') total += byArea[a];
  // the period most countries report (a few small ones lag a quarter)
  const counts = {};
  for (const p of Object.values(periods)) counts[p] = (counts[p] || 0) + 1;
  const period = Object.keys(counts).sort((a, b) => counts[b] - counts[a] || (a < b ? 1 : -1))[0];
  return { total, byArea, period, count: Object.keys(byArea).filter((a) => a !== 'U2').length };
}

// "2026-Q1" → "2026-03-31"
function quarterEnd(period) {
  const m = /^(\d{4})-Q([1-4])$/.exec(period || '');
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] * 3, 0)).toISOString().slice(0, 10);
}

function bondsPart(bis) {
  const byKey = {};
  for (const k of BOND_KEYS) if (bis.byArea[k] > 0) byKey[k] = r3(bis.byArea[k]);
  const shown = Object.values(byKey).reduce((a, v) => a + v, 0);
  byKey.OTHER = r3(Math.max(0, bis.total - shown));
  return { total: r3(bis.total), byKey, asOf: quarterEnd(bis.period), period: bis.period, cadence: 'quarterly', source: 'BIS debt securities statistics', countries: bis.count };
}

async function loadBonds() {
  if (bisCache.data && Date.now() < bisCache.expiresAt) return bisCache.data;
  const part = bondsPart(parseBisDss(await fetchText(BIS_DSS, 'text/csv')));
  bisCache = { data: part, expiresAt: Date.now() + BIS_TTL_MS };
  return part;
}

function goldTonnes(now) {
  const years = Math.max(0, (now - GOLD_STOCK_AT) / (365.25 * 86400000));
  return GOLD_STOCK_T + GOLD_MINE_T_PER_YEAR * years;
}

function goldPart(pricePerOz, source, now = Date.now()) {
  if (!(pricePerOz > 300 && pricePerOz < 50000)) throw new Error('gold: implausible price ' + pricePerOz);
  const tonnes = goldTonnes(now);
  return { total: r3(tonnes * OZ_PER_TONNE * pricePerOz / 1e12), price: Math.round(pricePerOz * 100) / 100, tonnes: Math.round(tonnes),
    asOf: new Date(now).toISOString(), cadence: 'live', source: source + ' × World Gold Council above-ground stock' };
}

async function loadGold() {
  try {
    const j = JSON.parse(await fetchText(YAHOO_GOLD, 'application/json'));
    const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
    return goldPart(Number(meta && meta.regularMarketPrice), 'Yahoo GC=F');
  } catch (e) {
    const j = JSON.parse(await fetchText(COINGECKO_PAXG, 'application/json'));
    return goldPart(Number(j && j['pax-gold'] && j['pax-gold'].usd), 'CoinGecko PAX Gold');
  }
}

function cryptoPart(json) {
  const d = (typeof json === 'string' ? JSON.parse(json) : json || {}).data || {};
  const usd = Number(d.total_market_cap && d.total_market_cap.usd);
  const btcPct = Number(d.market_cap_percentage && d.market_cap_percentage.btc);
  if (!(usd > 1e11 && usd < 1e14)) throw new Error('coingecko: implausible total ' + usd);
  const total = usd / 1e12;
  const byKey = {};
  if (btcPct > 0 && btcPct < 100) { byKey.BTC = r3(total * btcPct / 100); byKey.OTHER = r3(total - byKey.BTC); }
  const at = Number(d.updated_at);
  return { total: r3(total), byKey, asOf: new Date(at > 1e9 ? at * 1000 : Date.now()).toISOString(), cadence: 'live', source: 'CoinGecko' };
}

async function buildPayload() {
  const jobs = {
    equities: async () => equitiesPart(parseCmcCountries(await fetchText(CMC_COUNTRIES, 'text/html'))),
    bonds: loadBonds,
    gold: loadGold,
    crypto: async () => cryptoPart(await fetchText(COINGECKO_GLOBAL, 'application/json'))
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]()));
  const parts = {}, errors = {};
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') parts[keys[i]] = s.value;
    else errors[keys[i]] = String((s.reason && s.reason.message) || s.reason);
  });
  return { parts, errors };
}

const KV_KEY = 'capital-markets:lastGood';
const { partialTtl, kvGetGood, kvPutGood, fillFromGood } = require('../lib/last-good.js');

exports.handler = async function (event) {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=3600`
  };
  if (memCache.data && now < memCache.expiresAt) {
    const remaining = Math.max(30, Math.round((memCache.expiresAt - now) / 1000));
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${remaining}, s-maxage=${remaining}, stale-while-revalidate=3600` }, body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining }) };
  }
  let good = memCache.lastGood;
  const loadGood = async () => {
    if (!good) good = await kvGetGood(event, KV_KEY, 30 * 86400000);
    return good;
  };
  try {
    const { parts, errors } = await buildPayload();
    const missing = Object.keys(errors);
    const staleParts = [];
    if (missing.length && await loadGood()) staleParts.push(...fillFromGood(parts, good.parts, errors));
    if (!Object.keys(parts).length) throw new Error(`every source failed: ${JSON.stringify(errors)}`);
    const ttl = partialTtl(TTL_S, missing.length, Object.keys(errors).length);
    const data = { parts, fetchedAt: new Date().toISOString(), ttl };
    if (Object.keys(errors).length) data.errors = errors;
    if (staleParts.length) data.staleParts = staleParts;
    const merged = { parts: { ...((good && good.parts) || {}), ...Object.fromEntries(Object.entries(parts).filter(([k]) => !staleParts.includes(k))) }, fetchedAt: data.fetchedAt };
    memCache = { data, expiresAt: Date.now() + ttl * 1000, lastGood: merged };
    await kvPutGood(event, KV_KEY, merged);
    const h = missing.length ? { ...headers, 'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}` } : headers;
    return { statusCode: 200, headers: h, body: JSON.stringify(data) };
  } catch (e) {
    if (await loadGood()) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true, staleReason: e.message, ttl: 300 }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = {
  parseCmcCountries, equitiesPart, parseBisDss, bondsPart, quarterEnd, goldPart, goldTonnes, cryptoPart, buildPayload,
  URLS: { CMC_COUNTRIES, BIS_DSS, COINGECKO_GLOBAL, YAHOO_GOLD, COINGECKO_PAXG },
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; bisCache = { data: null, expiresAt: 0 }; }
};
