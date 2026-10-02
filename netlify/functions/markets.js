// Netlify Function: US market snapshot + 12-month histories for the dashboard's sparklines.
//
//   GET /.netlify/functions/markets
//   → { series: { us10y, us2y, vix, dollar, cpi, unrate, fedUpper }, spread2s10s, asOf, ttl }
//     each series: { label, unit, latest, date, prev, change, hist: [[isoDate, value], ...] }
//
// Every series comes from FRED. The public graph CSV needs no key; FRED_API_KEY (optional, the
// same one fred-data.js uses) is tried first when it's set. Daily series are thinned to one point
// per week so a year of history stays ~52 points. Market series (10y/2y/VIX/dollar) are daily
// closes, so they lag the live market by about a day — the page labels them that way.
//
// Caching: memory + CDN for 3 h. If every source fails we serve the last good payload marked
// stale instead of an error, same as fred-data.js.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const ATTEMPT_TIMEOUT_MS = 5000;
const TTL_S = 3 * 60 * 60;

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

async function buildPayload(apiKey) {
  const keys = Object.keys(SERIES);
  const results = await Promise.allSettled(keys.map((k) => loadSeries(k, apiKey)));
  const series = {}, errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') series[keys[i]] = r.value;
    else errors[keys[i]] = r.reason && r.reason.message;
  });
  const out = { series, asOf: new Date().toISOString() };
  if (series.us10y && series.us2y) out.spread2s10s = Math.round((series.us10y.latest - series.us2y.latest) * 100) / 100;
  if (Object.keys(errors).length) out.errors = errors;
  return { data: out, okCount: Object.keys(series).length };
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=${12 * 60 * 60}`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true, ttl: TTL_S }) };
  }
  try {
    const { data, okCount } = await buildPayload((process.env.FRED_API_KEY || '').trim());
    if (!okCount) throw new Error('every series failed: ' + JSON.stringify(data.errors || {}));
    data.ttl = TTL_S;
    memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.lastGood) {
      return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, stale: true, staleReason: e.message }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { parseCsv, parseApiJson, weekly, summarize, SERIES };
