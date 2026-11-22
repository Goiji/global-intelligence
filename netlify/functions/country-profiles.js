// Netlify Function: facts behind the ⓘ button of each country in the "ขนาดตลาดทุนโลก" equities box.
//
//   GET /.netlify/functions/country-profiles
//   → { parts: { champs, people }, fetchedAt, ttl, [errors], [staleParts] }
//     champs: { US: [[name, ticker, capUSD], …top 4], …, asOf }
//     people: { US: { old65, old65Year, hci, hciYear, perHour, perHourYear, priceLevel, priceYear }, …, asOf }
//
// Every number comes from a source and updates when that source publishes new data:
//   champs  — companiesmarketcap.com "largest companies in <country>" pages (live market caps). "Europe" is the
//             EU page merged with the UK and Switzerland pages, as in the equities bar.
//   people  — World Bank API (no key): share of people aged 65+ (SP.POP.65UP.TO.ZS, yearly), Human Capital Index
//             (HD.HCI.OVRL), price level = GDP per head at market rates ÷ at PPP (NY.GDP.PCAP.CD / NY.GDP.PCAP.PP.CD,
//             US = 1). ILO modelled estimates (rplumber.ilo.org, no key): output per hour worked in PPP dollars
//             (GDP_2HRW_NOC_NB_A), latest year that is not a projection. Europe = average of its big economies.
//
// These move slowly (company ranks daily, statistics yearly), so answers are cached 12 h, and a part that fails is
// filled from the last good copy (memory, then Cloudflare KV / Netlify Blobs).

const TIMEOUT_MS = 9000;
const TTL_S = 12 * 3600;
const UA = 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)';

// code → companiesmarketcap page path(s)
const CMC = 'https://companiesmarketcap.com';
const cmcPath = (slug, name) => `/${slug}/largest-companies-in-${name || slug}-by-market-cap/`;
const CMC_PAGES = {
  US: [cmcPath('usa', 'the-usa')], CN: [cmcPath('china')], JP: [cmcPath('japan')], IN: [cmcPath('india')],
  CA: [cmcPath('canada')], TW: [cmcPath('taiwan')], KR: [cmcPath('south-korea')], SA: [cmcPath('saudi-arabia')],
  AU: [cmcPath('australia')], HK: [cmcPath('hong-kong')], AE: [cmcPath('united-arab-emirates', 'the-uae')],
  BR: [cmcPath('brazil')], SG: [cmcPath('singapore')], MX: [cmcPath('mexico')], IL: [cmcPath('israel')],
  ZA: [cmcPath('south-africa')], ID: [cmcPath('indonesia')], MY: [cmcPath('malaysia')], TH: [cmcPath('thailand')],
  VN: [cmcPath('vietnam')],
  EU: [cmcPath('european-union', 'the-eu'), cmcPath('united-kingdom', 'the-uk'), cmcPath('switzerland')]
};
const CODES = Object.keys(CMC_PAGES);
// "Europe" statistics = plain average of these economies
const EU_MEMBERS = ['DE', 'FR', 'GB', 'IT', 'ES', 'NL', 'CH', 'SE'];
const ISO3 = {
  US: 'USA', CN: 'CHN', JP: 'JPN', IN: 'IND', CA: 'CAN', TW: 'TWN', KR: 'KOR', SA: 'SAU', AU: 'AUS', HK: 'HKG', AE: 'ARE',
  BR: 'BRA', SG: 'SGP', MX: 'MEX', IL: 'ISR', ZA: 'ZAF', ID: 'IDN', MY: 'MYS', TH: 'THA', VN: 'VNM',
  DE: 'DEU', FR: 'FRA', GB: 'GBR', IT: 'ITA', ES: 'ESP', NL: 'NLD', CH: 'CHE', SE: 'SWE'
};
const WB_COUNTRIES = CODES.filter((c) => c !== 'EU').concat(EU_MEMBERS);
const WB_IND = { old65: 'SP.POP.65UP.TO.ZS', hci: 'HD.HCI.OVRL', gdpUsd: 'NY.GDP.PCAP.CD', gdpPpp: 'NY.GDP.PCAP.PP.CD' };
const wbUrl = (ind) => `https://api.worldbank.org/v2/country/${WB_COUNTRIES.join(';')}/indicator/${ind}?format=json&mrnev=1&per_page=500`;
const iloUrl = (year) => `https://rplumber.ilo.org/data/indicator/?id=GDP_2HRW_NOC_NB_A&timefrom=${year - 3}&timeto=${year}&format=.csv`;

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: '*/*' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const decode = (s) => String(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();

// companiesmarketcap country page → [[name, ticker, capUSD], …] in page order (largest first)
function parseCmcCompanies(html) {
  const out = [];
  const rows = String(html).split(/<tr[\s>]/).slice(1);
  for (const row of rows) {
    const name = /class="company-name"[^>]*>([\s\S]*?)<\/div>/.exec(row);
    if (!name) continue;
    const code = /class="company-code"[^>]*>(?:<span[^>]*><\/span>)?([^<]*)</.exec(row);
    const cap = /<td class="td-right" data-sort="(\d+(?:\.\d+)?)"/.exec(row);
    const v = cap ? Number(cap[1]) : NaN;
    if (!Number.isFinite(v) || v <= 0) continue;
    out.push([decode(name[1]), code ? decode(code[1]) : '', v]);
  }
  return out;
}

async function loadChamps() {
  const res = {};
  const errs = [];
  await Promise.all(CODES.map(async (code) => {
    const lists = await Promise.allSettled(CMC_PAGES[code].map((p) => fetchText(CMC + p).then(parseCmcCompanies)));
    const all = [];
    lists.forEach((l, i) => { if (l.status === 'fulfilled') all.push(...l.value); else errs.push(`${code}${i}: ${l.reason && l.reason.message}`); });
    const seen = new Set();
    const top = all.sort((a, b) => b[2] - a[2]).filter((c) => !seen.has(c[0]) && seen.add(c[0])).slice(0, 4);
    if (top.length) res[code] = top;
  }));
  if (!Object.keys(res).length) throw new Error(`companiesmarketcap: ${errs.slice(0, 3).join('; ') || 'no rows'}`);
  res.asOf = new Date().toISOString();
  return res;
}

// World Bank JSON → { ISO2: [value, year] }
function parseWb(json) {
  const rows = Array.isArray(json) && Array.isArray(json[1]) ? json[1] : [];
  const out = {};
  for (const r of rows) {
    const id = r && r.country && r.country.id;
    if (id && Number.isFinite(r.value)) out[id] = [r.value, Number(r.date)];
  }
  return out;
}

// ILO csv → { ISO3: [value, year] } using the latest year ≤ thisYear - 1 (later years are projections)
function parseIlo(csv, thisYear) {
  const out = {};
  for (const line of String(csv).split(/\r?\n/).slice(1)) {
    const f = line.split(',').map((s) => s.replace(/^"|"$/g, ''));
    const area = f[0];
    const year = Number(f[3]);
    const v = Number(f[4]);
    if (!area || !Number.isFinite(year) || !Number.isFinite(v) || year > thisYear - 1) continue;
    if (!out[area] || out[area][1] < year) out[area] = [v, year];
  }
  return out;
}

const r2 = (v) => Math.round(v * 100) / 100;
function avg(list) {
  const ok = list.filter(Boolean);
  if (!ok.length) return null;
  return [ok.reduce((s, x) => s + x[0], 0) / ok.length, Math.max(...ok.map((x) => x[1]))];
}

function buildPeople(wb, ilo) {
  const out = {};
  const get = (src, code) => src[code] || null;
  for (const code of CODES) {
    const pick = (src, key) => code === 'EU' ? avg(EU_MEMBERS.map((m) => get(src, key === 'ilo' ? ISO3[m] : m))) : get(src, key === 'ilo' ? ISO3[code] : code);
    const p = {};
    const old = pick(wb.old65, 'wb');
    if (old) { p.old65 = r2(old[0]); p.old65Year = old[1]; }
    const hci = pick(wb.hci, 'wb');
    if (hci) { p.hci = r2(hci[0]); p.hciYear = hci[1]; }
    const hr = pick(ilo, 'ilo');
    if (hr) { p.perHour = r2(hr[0]); p.perHourYear = hr[1]; }
    // price level: market-rate GDP ÷ PPP GDP (same country, same year) → share of US prices
    const ratio = {};
    for (const c of Object.keys(wb.gdpUsd)) if (wb.gdpPpp[c] && wb.gdpPpp[c][0] > 0) ratio[c] = [wb.gdpUsd[c][0] / wb.gdpPpp[c][0], wb.gdpUsd[c][1]];
    const pl = pick(ratio, 'wb');
    if (pl) { p.priceLevel = r2(pl[0]); p.priceYear = pl[1]; }
    if (Object.keys(p).length) out[code] = p;
  }
  return out;
}

async function loadPeople(now) {
  const year = new Date(now || Date.now()).getUTCFullYear();
  const keys = Object.keys(WB_IND);
  const [wbRes, iloRes] = await Promise.all([
    Promise.allSettled(keys.map((k) => fetchText(wbUrl(WB_IND[k])).then((t) => parseWb(JSON.parse(t))))),
    fetchText(iloUrl(year)).then((t) => parseIlo(t, year)).catch((e) => { throw new Error(`ILO: ${e.message}`); }).then((v) => v, (e) => e)
  ]);
  const wb = {};
  const errs = [];
  keys.forEach((k, i) => { wb[k] = wbRes[i].status === 'fulfilled' ? wbRes[i].value : (errs.push(`${k}: ${wbRes[i].reason && wbRes[i].reason.message}`), {}); });
  const ilo = iloRes instanceof Error ? (errs.push(iloRes.message), {}) : iloRes;
  const people = buildPeople(wb, ilo);
  if (errs.length === keys.length + 1) throw new Error(errs.join('; '));
  people.asOf = new Date(now || Date.now()).toISOString();
  return people;
}

async function buildPayload(now) {
  const jobs = { champs: loadChamps(), people: loadPeople(now) };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
  const parts = {};
  const errors = {};
  settled.forEach((s, i) => { if (s.status === 'fulfilled') parts[keys[i]] = s.value; else errors[keys[i]] = String(s.reason && s.reason.message || s.reason); });
  return { parts, errors };
}

const KV_KEY = 'country-profiles:lastGood';
const { partialTtl, kvGetGood, kvPutGood, fillFromGood } = require('../lib/last-good.js');

exports.handler = async function (event) {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=86400`
  };
  if (memCache.data && now < memCache.expiresAt) {
    const remaining = Math.max(30, Math.round((memCache.expiresAt - now) / 1000));
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${remaining}, s-maxage=${remaining}, stale-while-revalidate=86400` }, body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining }) };
  }
  let good = memCache.lastGood;
  const loadGood = async () => {
    if (!good) good = await kvGetGood(event, KV_KEY, 60 * 86400000);
    return good;
  };
  try {
    const { parts, errors } = await buildPayload(now);
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
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=600, s-maxage=600' }, body: JSON.stringify({ ...good, stale: true, staleReason: e.message, ttl: 600 }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = {
  parseCmcCompanies, parseWb, parseIlo, buildPeople, buildPayload, CMC, CMC_PAGES, WB_IND, wbUrl, iloUrl, EU_MEMBERS,
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; }
};
