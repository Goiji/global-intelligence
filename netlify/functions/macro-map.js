// Netlify Function: the extra FRED series behind the Macro Map tab.
//
//   GET /.netlify/functions/macro-map
//   → { items: { realPce, productivity, fwd5y5y, hy, netLiq, debt, oil }, errors?, ttl, fetchedAt }
//
//   • realPce       real personal consumption, YoY % — FRED PCEC96 (monthly, BEA)
//   • productivity  nonfarm business output per hour, YoY % — FRED OPHNFB (quarterly, BLS)
//   • fwd5y5y       5-year, 5-year-forward inflation expectation, % — FRED T5YIFR (daily)
//   • hy            US high-yield option-adjusted spread, % — FRED BAMLH0A0HYM2 (daily, ICE BofA)
//   • netLiq        Fed balance sheet − Treasury General Account − overnight reverse repo, US$ bn —
//                   FRED WALCL, WTREGEN (weekly, $ mn) and RRPONTSYD (daily, $ bn), on WALCL's dates
//   • debt          total public debt, US$ tn and YoY % — FRED GFDEBTN (quarterly, $ mn)
//   • oil           WTI spot, US$/bbl and % change over ~1 month — FRED DCOILWTICO (daily)
//
// Every item is independent (one failed series drops one item). Missing items are filled from the
// last good copy in KV, like econ-extra.js.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const ATTEMPT_TIMEOUT_MS = 6000;
const HARD_DEADLINE_MS = 8500;
const TTL_S = 60 * 60;

const { parseFredCsv, parseFredApiJson, inRange } = require('./fred-data.js').__test;
const { partialTtl, kvGetGood, kvPutGood, fillFromGood } = require('../lib/last-good.js');

let memCache = { data: null, expiresAt: 0, lastGood: null };

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysBefore = (date, n) => isoDay(new Date(new Date(date + 'T00:00:00Z').getTime() - n * 86400000));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

async function fetchText(url, deadline) {
  const ms = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
  if (ms <= 250) throw new Error('deadline exceeded');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

// newest-first observations: FRED API (only with a key) → public CSV
async function fredObs(id, start, apiKey, deadline) {
  const trail = [];
  if (apiKey) {
    try {
      return parseFredApiJson(await fetchText(`${FRED_API}?series_id=${id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${start}`, deadline));
    } catch (e) { trail.push(`fred-api: ${e.message}`); }
  }
  try {
    const obs = parseFredCsv(await fetchText(`${FRED_CSV}?id=${id}&cosd=${start}`, deadline));
    if (!obs.length) throw new Error('empty CSV');
    return obs;
  } catch (e) { trail.push(`fred-csv: ${e.message}`); }
  throw new Error(`${id}: ${trail.join(' | ')}`);
}

// ── pure helpers (exported for tests) ─────────────────────────────────────────────────────────
// value on `date` or the closest earlier observation within `maxBack` days (newest-first input)
function onOrBefore(obs, date, maxBack = 10) {
  const floor = daysBefore(date, maxBack);
  return obs.find((o) => o.date <= date && o.date >= floor) || null;
}

// YoY % of the latest level vs the observation dated exactly one year earlier (monthly/quarterly)
function yoyByDate(obs, range) {
  const ok = obs.filter((o) => inRange(o.value, range));
  const latest = ok[0];
  if (!latest) throw new Error('no observation inside the expected range');
  const [y, m, d] = latest.date.split('-');
  const ago = ok.find((o) => o.date === `${+y - 1}-${m}-${d}`);
  if (!ago) throw new Error(`no year-ago level for ${latest.date}`);
  const yoy = (latest.value / ago.value - 1) * 100;
  const prevLatest = ok[1];
  let prevYoy = null;
  if (prevLatest) {
    const [py, pm, pd] = prevLatest.date.split('-');
    const pAgo = ok.find((o) => o.date === `${+py - 1}-${pm}-${pd}`);
    if (pAgo) prevYoy = round((prevLatest.value / pAgo.value - 1) * 100);
  }
  return { value: round(yoy), date: latest.date, level: latest.value, prev: prevYoy };
}

// latest level + change vs ~30 days earlier (absolute, or % when pct=true)
function levelAndMonth(obs, range, { pct = false, digits = 2 } = {}) {
  const ok = obs.filter((o) => inRange(o.value, range));
  const latest = ok[0];
  if (!latest) throw new Error('no observation inside the expected range');
  const ago = onOrBefore(ok, daysBefore(latest.date, 30));
  const change1m = ago ? (pct ? round((latest.value / ago.value - 1) * 100, 1) : round(latest.value - ago.value, digits)) : null;
  return { value: round(latest.value, digits), date: latest.date, change1m, from: ago ? ago.date : null };
}

// Net liquidity (US$ bn) on each WALCL date: WALCL − TGA (same week) − ON RRP (that day or before).
function netLiquidity(walcl, tga, rrp) {
  const at = (w) => {
    const t = onOrBefore(tga, w.date, 7);
    const r = onOrBefore(rrp, w.date, 7);
    if (!t || !r) return null;
    return { date: w.date, value: round(w.value / 1000 - t.value / 1000 - r.value, 1), walcl: round(w.value / 1000, 1), tga: round(t.value / 1000, 1), rrp: round(r.value, 1) };
  };
  const ws = walcl.filter((o) => inRange(o.value, [1e6, 2e7]));
  const latest = ws.map(at).find(Boolean);
  if (!latest) throw new Error('no WALCL week with matching TGA and RRP');
  const agoW = onOrBefore(ws, daysBefore(latest.date, 28), 7);
  const ago = agoW && at(agoW);
  return { ...latest, change1m: ago ? round(latest.value - ago.value, 1) : null, from: ago ? ago.date : null };
}

async function buildPayload(apiKey, now = new Date()) {
  const deadline = Date.now() + HARD_DEADLINE_MS;
  const ago = (days) => isoDay(new Date(now.getTime() - days * 86400000));
  const obs = (id, days) => fredObs(id, ago(days), apiKey, deadline);
  const jobs = {
    realPce: async () => ({ ...yoyByDate(await obs('PCEC96', 800), [5000, 50000]), source: 'FRED PCEC96' }),
    productivity: async () => ({ ...yoyByDate(await obs('OPHNFB', 1200), [50, 500]), source: 'FRED OPHNFB' }),
    fwd5y5y: async () => ({ ...levelAndMonth(await obs('T5YIFR', 75), [-2, 8]), source: 'FRED T5YIFR' }),
    hy: async () => ({ ...levelAndMonth(await obs('BAMLH0A0HYM2', 75), [0.5, 30]), source: 'FRED BAMLH0A0HYM2' }),
    netLiq: async () => {
      const [w, t, r] = await Promise.all([obs('WALCL', 90), obs('WTREGEN', 90), obs('RRPONTSYD', 90)]);
      return { ...netLiquidity(w, t, r), source: 'FRED WALCL − WTREGEN − RRPONTSYD' };
    },
    debt: async () => {
      const y = yoyByDate(await obs('GFDEBTN', 1200), [1e6, 1e9]);
      return { ...y, levelTn: round(y.level / 1e6, 2), source: 'FRED GFDEBTN' };
    },
    oil: async () => ({ ...levelAndMonth(await obs('DCOILWTICO', 75), [5, 300], { pct: true }), source: 'FRED DCOILWTICO' })
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]()));
  const items = {};
  const errors = {};
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') items[keys[i]] = r.value;
    else errors[keys[i]] = (r.reason && r.reason.message) || String(r.reason);
  });
  return { items, errors };
}

const KV_KEY = 'macro-map:lastGood';

exports.handler = async function (event) {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=3600`
  };
  if (memCache.data && now < memCache.expiresAt) {
    const remaining = Math.max(30, Math.round((memCache.expiresAt - now) / 1000));
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${remaining}, s-maxage=${remaining}` }, body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining }) };
  }
  let good = memCache.lastGood;
  const loadGood = async () => {
    if (!good) good = await kvGetGood(event, KV_KEY, 21 * 86400000);
    return good;
  };
  try {
    const { items, errors } = await buildPayload((process.env.FRED_API_KEY || '').trim());
    const missing = Object.keys(errors);
    const staleItems = [];
    if (missing.length && await loadGood()) staleItems.push(...fillFromGood(items, good.items, errors));
    if (!Object.keys(items).length) throw new Error(`every source failed: ${JSON.stringify(errors)}`);
    const ttl = partialTtl(TTL_S, missing.length, Object.keys(errors).length);
    const data = { items, fetchedAt: new Date().toISOString(), ttl };
    if (Object.keys(errors).length) data.errors = errors;
    if (staleItems.length) data.staleItems = staleItems;
    const merged = { ...data, items: { ...((good && good.items) || {}), ...items } };
    delete merged.errors; delete merged.staleItems;
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
  onOrBefore, yoyByDate, levelAndMonth, netLiquidity, buildPayload,
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; }
};
