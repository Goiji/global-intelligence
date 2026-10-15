// Netlify Function: US market snapshot + 12-month histories for the dashboard's sparklines.
//
//   GET /.netlify/functions/markets
//   → { series: { us10y, us2y, vix, dollar, cpi, unrate, fedUpper }, spread2s10s, asOf, ttl }
//     each series: { label, unit, latest, date, prev, change, hist: [[isoDate, value], ...] }
//
// Every series comes from FRED. The public graph CSV needs no key; FRED_API_KEY (optional, the
// same one fred-data.js uses) is tried first when it's set. Daily series are thinned to one point
// per week so a year of history stays ~52 points. Market series (10y/2y/VIX/dollar) are daily
// closes, so they lag the live market by about a day — the page labels them that way. VIX is the
// exception: Cboe's own delayed quote (~15 min behind) is laid over the FRED close, so the card shows
// today's level while the market is open and yesterday's close by the next morning in Asia.
// The dollar is the ICE DXY formula applied to the ECB's daily reference rates (via Frankfurter,
// out the same afternoon in Europe) — FRED's broad index (DTWEXBGS) is published once a week and
// ran up to a week behind. FRED's broad index is the fallback if Frankfurter fails.
//
// Caching: memory + CDN for 1 h, but only 15 min on CPI / jobs / FOMC days (same calendar as
// fred-data.js) so the CPI / unemployment / Fed sparklines don't trail the cards for hours after a
// release. If every source fails we serve the last good payload marked stale instead of an error.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const ATTEMPT_TIMEOUT_MS = 5000;
const FRANKFURTER = 'https://api.frankfurter.dev/v1/';
// ICE US Dollar Index: 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091
// × USDSEK^0.042 × USDCHF^0.036. With USD-based rates (units per dollar) every exponent is positive.
const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
const CBOE_VIX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json';
const TTL_S = 60 * 60;
const RELEASE_TTL_S = 15 * 60;
const { isReleaseDay, cacheControl } = require('./fred-data.js').__test;

const SERIES = {
  us10y:    { id: 'DGS10',    label: 'US 10Y', unit: '%', cadence: 'daily' },
  us2y:     { id: 'DGS2',     label: 'US 2Y', unit: '%', cadence: 'daily' },
  vix:      { id: 'VIXCLS',   label: 'VIX', unit: '', cadence: 'daily' },
  dollar:   { id: 'DTWEXBGS', label: 'Dollar (Broad)', unit: '', cadence: 'daily' },
  cpi:      { id: 'CPIAUCSL', label: 'CPI YoY', unit: '%', cadence: 'monthly', transformation: 'pc1' },
  unrate:   { id: 'UNRATE',   label: 'Unemployment', unit: '%', cadence: 'monthly' },
  fedUpper: { id: 'DFEDTARU', label: 'Fed upper', unit: '%', cadence: 'daily' }
};

let memCache = { data: null, expiresAt: 0, lastGood: null };

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgoIso(n, from = new Date()) { return isoDay(new Date(from.getTime() - n * 86400000)); }

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'global-intelligence-dashboard (netlify function)', Accept: '*/*' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// FRED graph CSV → [{date, value}] oldest-first. Skips "." (FRED's missing marker) and blanks.
function parseCsv(text) {
  const out = [];
  String(text).trim().split(/\r?\n/).slice(1).forEach((line) => {
    const [date, raw] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test((date || '').trim())) return;
    const v = parseFloat(String(raw || '').replace(/"/g, ''));
    if (isFinite(v)) out.push({ date: date.trim(), value: v });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function parseApiJson(text) {
  const j = JSON.parse(text);
  if (j.error_message) throw new Error(j.error_message);
  return (j.observations || [])
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Keep the last observation of each ISO week (daily series → ~52 points a year).
function weekly(obs) {
  const byWeek = new Map();
  obs.forEach((o) => {
    const d = new Date(o.date + 'T00:00:00Z');
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    byWeek.set(isoDay(monday), o);
  });
  return [...byWeek.values()];
}

function summarize(key, obs) {
  const cfg = SERIES[key];
  if (!obs.length) throw new Error('no observations');
  const last = obs[obs.length - 1];
  const prev = obs.length > 1 ? obs[obs.length - 2] : null;
  const yearAgo = daysAgoIso(372, new Date(last.date + 'T00:00:00Z'));
  const window = obs.filter((o) => o.date >= yearAgo);
  const thinned = cfg.cadence === 'daily' ? weekly(window) : window;
  // make sure the very latest point is the last one plotted
  if (thinned.length && thinned[thinned.length - 1].date !== last.date) thinned.push(last);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    label: cfg.label,
    unit: cfg.unit,
    latest: round(last.value),
    date: last.date,
    prev: prev ? round(prev.value) : null,
    change: prev ? round(last.value - prev.value) : null,
    hist: thinned.map((o) => [o.date, round(o.value)])
  };
}

async function loadSeries(key, apiKey) {
  const cfg = SERIES[key];
  // monthly YoY needs 2 years of levels behind it; FRED's pc1 transform does that for us.
  const start = daysAgoIso(cfg.cadence === 'monthly' ? 800 : 420);
  const errors = [];
  if (apiKey) {
    try {
      const url = `${FRED_API}?series_id=${cfg.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${start}`
        + (cfg.transformation ? `&units=${cfg.transformation}` : '');
      return { ...summarize(key, parseApiJson(await fetchText(url))), source: 'fred-api' };
    } catch (e) { errors.push('fred-api: ' + e.message); }
  }
  try {
    const url = `${FRED_CSV}?id=${cfg.id}&cosd=${start}` + (cfg.transformation ? `&transformation=${cfg.transformation}` : '');
    return { ...summarize(key, parseCsv(await fetchText(url))), source: 'fred-csv' };
  } catch (e) { errors.push('fred-csv: ' + e.message); }
  throw new Error(errors.join(' | '));
}

// Cboe delayed quote → { value, change, date, time }. last_trade_time is US Eastern wall-clock time,
// so its date part is the US trading day the price belongs to (what FRED would file it under).
function parseCboeQuote(text) {
  const d = (JSON.parse(text) || {}).data || {};
  const value = parseFloat(d.current_price);
  const change = parseFloat(d.price_change);
  const time = String(d.last_trade_time || '');
  const date = time.slice(0, 10);
  if (!isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad cboe quote');
  return { value, change: isFinite(change) ? change : null, date, time };
}

// Lay a newer live quote over the FRED series: replace the point for the same day or append a new one.
function mergeLive(series, live) {
  if (!series || !live || live.date < series.date) return series;
  const round = (v) => Math.round(v * 1000) / 1000;
  const hist = series.hist.filter((p) => p[0] < live.date).concat([[live.date, round(live.value)]]);
  let prev = live.change != null ? round(live.value - live.change)
    : live.date === series.date ? series.prev : series.latest;
  return {
    ...series,
    latest: round(live.value),
    date: live.date,
    time: live.time,
    prev,
    change: prev != null ? round(live.value - prev) : null,
    hist,
    source: 'cboe'
  };
}

function dxyFromRates(r) {
  let v = 50.14348112;
  for (const [ccy, w] of Object.entries(DXY_WEIGHTS)) {
    const x = parseFloat(r && r[ccy]);
    if (!isFinite(x) || x <= 0) return NaN;
    v *= Math.pow(x, w);
  }
  return v;
}

// Frankfurter time series ({ rates: { date: { EUR, JPY, ... } } }) → [{date, value}] of DXY.
function parseDxySeries(text) {
  const rates = (JSON.parse(text) || {}).rates || {};
  return Object.keys(rates).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    .map((date) => ({ date, value: dxyFromRates(rates[date]) }))
    .filter((o) => isFinite(o.value));
}

async function loadDxy() {
  const url = `${FRANKFURTER}${daysAgoIso(420)}..?base=USD&symbols=${Object.keys(DXY_WEIGHTS).join(',')}`;
  return { ...summarize('dollar', parseDxySeries(await fetchText(url))), label: 'DXY', source: 'ecb-dxy' };
}

async function loadVixLive() {
  return parseCboeQuote(await fetchText(CBOE_VIX));
}

async function buildPayload(apiKey) {
  const keys = Object.keys(SERIES);
  const [results, vixLive] = await Promise.all([
    Promise.allSettled(keys.map((k) => (k === 'dollar'
      ? loadDxy().catch((e) => loadSeries(k, apiKey).then((s) => ({ ...s, dxyError: e.message })))
      : loadSeries(k, apiKey)))),
    loadVixLive().catch((e) => ({ error: e.message }))
  ]);
  const series = {}, errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') series[keys[i]] = r.value;
    else errors[keys[i]] = r.reason && r.reason.message;
  });
  // FRED stays the backbone (history); a failed Cboe call just leaves the FRED close in place.
  if (vixLive.error) errors.vixLive = vixLive.error;
  else if (series.vix) series.vix = mergeLive(series.vix, vixLive);
  const out = { series, asOf: new Date().toISOString() };
  if (series.us10y && series.us2y) out.spread2s10s = Math.round((series.us10y.latest - series.us2y.latest) * 100) / 100;
  if (Object.keys(errors).length) out.errors = errors;
  return { data: out, okCount: Object.keys(series).length };
}

exports.handler = async function () {
  const now = Date.now();
  const { release } = isReleaseDay(new Date(now));
  const ttl = release ? RELEASE_TTL_S : TTL_S;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheControl(ttl, release)
  };
  if (memCache.data && now < memCache.expiresAt) {
    // advertise only the time this copy has left, so the CDN/browser don't stack another full TTL
    const remaining = Math.round((memCache.expiresAt - now) / 1000);
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': cacheControl(remaining, release) },
      body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining })
    };
  }
  try {
    const { data, okCount } = await buildPayload((process.env.FRED_API_KEY || '').trim());
    if (!okCount) throw new Error('every series failed: ' + JSON.stringify(data.errors || {}));
    data.ttl = ttl;
    memCache = { data, expiresAt: now + ttl * 1000, lastGood: data };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.lastGood) {
      return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, stale: true, staleReason: e.message }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { parseCsv, parseApiJson, weekly, summarize, parseCboeQuote, mergeLive, dxyFromRates, parseDxySeries, SERIES };
