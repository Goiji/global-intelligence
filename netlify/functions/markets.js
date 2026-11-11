// Netlify Function: US market snapshot + 12-month histories for the dashboard's sparklines.
//
//   GET /.netlify/functions/markets
//   → { series: { sp500, nasdaq100, us10y, us2y, vix, move, sofrSpread, levShort, dollar, cpi, unrate, fedUpper }, asOf, ttl }
//     each series: { label, unit, latest, date, prev, change, hist: [[isoDate, value], ...] }
//
// Every series comes from FRED. The public graph CSV needs no key; FRED_API_KEY (optional, the
// same one fred-data.js uses) is tried first when it's set. Daily series are thinned to one point
// per week so a year of history stays ~52 points. Market series (10y/2y/VIX/dollar) are daily
// closes and FRED files each one the next day, so on their own they lag the live market by about a
// day. Live overlays close that gap: Cboe's delayed quotes (~15 min behind) for VIX and the 10-year
// (TNX), and the Treasury's own daily par yield curve (out the same evening, a day before FRED) for
// the 2-year and as the 10-year fallback. FRED stays the history behind each sparkline.
// Stock indices work the same way: FRED's SP500 / NASDAQ100 daily closes are the history, and
// Cboe's delayed index quotes (_SPX / _NDX, ~15 min behind) lay today's level on top.
// The dollar is the ICE DXY formula applied to the ECB's daily reference rates (via Frankfurter,
// out the same afternoon in Europe) — FRED's broad index (DTWEXBGS) is published once a week and
// ran up to a week behind. FRED's broad index is the fallback if Frankfurter fails.
// Funding-stress gauges (proxies for repo haircuts, which have no public daily number):
//   • sofrSpread = SOFR − IORB in basis points, both from FRED, joined by date (IORB carried forward
//     to each SOFR day). Positive and widening = cash is scarce and repo is tight. The payload also
//     carries the latest sofr / iorb levels it was built from.
//   • move = ICE BofA MOVE index (Treasury implied volatility, the "VIX of bonds"). FRED doesn't
//     carry it, so it comes from Yahoo Finance's chart API (^MOVE, query1 then the query2 mirror).
//   • levShort = leveraged funds' NET SHORT in US Treasury futures (2Y, 5Y, 10Y, Ultra 10Y, Bond,
//     Ultra Bond), the usual proxy for the size of the cash-futures basis trade (long cash bonds
//     financed in repo, short futures). From the CFTC Traders in Financial Futures report (futures
//     only, Socrata open-data API, no key), weekly: positions as of Tuesday, published Friday.
//     Value = (short − long) × face value per contract ($200k for the 2Y, $100k for the rest), in
//     $ billions, positive = net short. A week is used only when all six contracts are reported.
//     The payload also carries the record since 2016 (Ultra 10Y launched then) and its date.
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
const CBOE_TNX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_TNX.json';
const CBOE_SPX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json';
const CBOE_NDX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_NDX.json';
const YAHOO_MOVE = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EMOVE?interval=1d&range=13mo';
const CFTC_TFF = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
// CFTC contract code → face value per contract (USD)
const UST_FUTURES = { '042601': 200000, '044601': 100000, '043602': 100000, '043607': 100000, '020601': 100000, '020604': 100000 };
const CFTC_SINCE = '2016-03-01';
const CFTC_TIMEOUT_MS = 9000;
const TREASURY_CSV = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/';
const TTL_S = 60 * 60;
const RELEASE_TTL_S = 15 * 60;
const { isReleaseDay, cacheControl } = require('./fred-data.js').__test;

const SERIES = {
  sp500:     { id: 'SP500',     label: 'S&P 500', unit: '', cadence: 'daily' },
  nasdaq100: { id: 'NASDAQ100', label: 'Nasdaq 100', unit: '', cadence: 'daily' },
  us10y:    { id: 'DGS10',    label: 'US 10Y', unit: '%', cadence: 'daily' },
  us2y:     { id: 'DGS2',     label: 'US 2Y', unit: '%', cadence: 'daily' },
  vix:      { id: 'VIXCLS',   label: 'VIX', unit: '', cadence: 'daily' },
  move:     { id: '^MOVE',    label: 'MOVE', unit: '', cadence: 'daily', loader: 'yahoo' },
  sofrSpread: { id: 'SOFR-IORB', label: 'SOFR − IORB', unit: 'bp', cadence: 'daily', loader: 'sofrSpread' },
  levShort: { id: 'CFTC-TFF-UST', label: 'Leveraged funds net short, UST futures', unit: '$bn', cadence: 'weekly', loader: 'cftc' },
  dollar:   { id: 'DTWEXBGS', label: 'Dollar (Broad)', unit: '', cadence: 'daily' },
  cpi:      { id: 'CPIAUCSL', label: 'CPI YoY', unit: '%', cadence: 'monthly', transformation: 'pc1' },
  unrate:   { id: 'UNRATE',   label: 'Unemployment', unit: '%', cadence: 'monthly' },
  fedUpper: { id: 'DFEDTARU', label: 'Fed upper', unit: '%', cadence: 'daily' }
};

let memCache = { data: null, expiresAt: 0, lastGood: null };

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgoIso(n, from = new Date()) { return isoDay(new Date(from.getTime() - n * 86400000)); }

async function fetchText(url, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

// Raw FRED observations (oldest first) for one series id: API with key first, then the public CSV.
async function fetchFredObs(cfg, apiKey) {
  // monthly YoY needs 2 years of levels behind it; FRED's pc1 transform does that for us.
  const start = daysAgoIso(cfg.cadence === 'monthly' ? 800 : 420);
  const errors = [];
  if (apiKey) {
    try {
      const url = `${FRED_API}?series_id=${cfg.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${start}`
        + (cfg.transformation ? `&units=${cfg.transformation}` : '');
      const obs = parseApiJson(await fetchText(url));
      if (obs.length) return { obs, source: 'fred-api' };
      errors.push('fred-api: no observations');
    } catch (e) { errors.push('fred-api: ' + e.message); }
  }
  try {
    const url = `${FRED_CSV}?id=${cfg.id}&cosd=${start}` + (cfg.transformation ? `&transformation=${cfg.transformation}` : '');
    const obs = parseCsv(await fetchText(url));
    if (obs.length) return { obs, source: 'fred-csv' };
    errors.push('fred-csv: no observations');
  } catch (e) { errors.push('fred-csv: ' + e.message); }
  throw new Error(errors.join(' | '));
}

async function loadSeries(key, apiKey) {
  const { obs, source } = await fetchFredObs(SERIES[key], apiKey);
  return { ...summarize(key, obs), source };
}

// SOFR − IORB in basis points, one point per SOFR day. IORB only changes on Fed decisions, so the
// latest IORB on or before each SOFR date is used (a missing IORB day never drops a SOFR print).
function joinSofrIorb(sofr, iorb) {
  const out = [];
  let j = -1;
  sofr.forEach((s) => {
    while (j + 1 < iorb.length && iorb[j + 1].date <= s.date) j++;
    if (j >= 0) out.push({ date: s.date, value: Math.round((s.value - iorb[j].value) * 1000) / 10, sofr: s.value, iorb: iorb[j].value });
  });
  return out;
}

async function loadSofrSpread(apiKey) {
  const [sofr, iorb] = await Promise.all([
    fetchFredObs({ id: 'SOFR', cadence: 'daily' }, apiKey),
    fetchFredObs({ id: 'IORB', cadence: 'daily' }, apiKey)
  ]);
  const joined = joinSofrIorb(sofr.obs, iorb.obs);
  if (!joined.length) throw new Error('sofr/iorb: no overlapping dates');
  const last = joined[joined.length - 1];
  return { ...summarize('sofrSpread', joined), sofr: last.sofr, iorb: last.iorb, source: sofr.source };
}

// Yahoo chart JSON → [{date, value}] of daily closes. Bar timestamps are shifted by the exchange's
// UTC offset first, so each close lands on the US trading day it belongs to. A live regularMarketPrice
// newer than the last bar is appended as today's point.
function parseYahooSeries(text) {
  const res = (((JSON.parse(text) || {}).chart || {}).result || [])[0];
  if (!res) throw new Error('yahoo: no result');
  const m = res.meta || {};
  const off = isFinite(m.gmtoffset) ? m.gmtoffset : 0;
  const day = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0]) || {}).close || [];
  const byDay = new Map();
  (res.timestamp || []).forEach((t, i) => {
    const v = closes[i];
    if (v != null && isFinite(v) && v > 0) byDay.set(day(t), v);
  });
  const price = parseFloat(m.regularMarketPrice);
  if (isFinite(price) && price > 0 && isFinite(m.regularMarketTime)) {
    const d = day(m.regularMarketTime);
    const lastDay = [...byDay.keys()].sort().pop();
    if (!lastDay || d >= lastDay) byDay.set(d, price);
  }
  return [...byDay.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

async function loadMove() {
  const errors = [];
  for (const url of [YAHOO_MOVE, YAHOO_MOVE.replace('//query1.', '//query2.')]) {
    try {
      const obs = parseYahooSeries(await fetchText(url));
      if (obs.length) return { ...summarize('move', obs), source: 'yahoo' };
      errors.push('yahoo: no observations');
    } catch (e) { errors.push(e.message); }
  }
  throw new Error('move: ' + errors.join(' | '));
}

// CFTC TFF rows → weekly [{date, value}] of leveraged funds' net short in $bn (positive = short).
function parseCftcLevShort(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('cftc: ' + ((rows && rows.message) || 'unexpected response'));
  const byDate = new Map();
  rows.forEach((r) => {
    const face = UST_FUTURES[String(r.cftc_contract_market_code || '').trim()];
    const date = String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    const long = parseFloat(r.lev_money_positions_long), short = parseFloat(r.lev_money_positions_short);
    if (!face || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(long) || !isFinite(short)) return;
    const w = byDate.get(date) || { n: new Set(), usd: 0 };
    if (w.n.has(r.cftc_contract_market_code)) return;
    w.n.add(r.cftc_contract_market_code);
    w.usd += (short - long) * face;
    byDate.set(date, w);
  });
  const need = Object.keys(UST_FUTURES).length;
  return [...byDate.entries()].filter(([, w]) => w.n.size === need)
    .map(([date, w]) => ({ date, value: Math.round(w.usd / 1e8) / 10 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadLevShort() {
  const codes = Object.keys(UST_FUTURES).map((c) => `'${c}'`).join(',');
  // encodeURIComponent (spaces as %20, not URLSearchParams' "+") keeps the SoQL unambiguous
  const qs = Object.entries({
    $select: 'report_date_as_yyyy_mm_dd,cftc_contract_market_code,lev_money_positions_long,lev_money_positions_short',
    $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${CFTC_SINCE}T00:00:00.000'`,
    $order: 'report_date_as_yyyy_mm_dd',
    $limit: '20000'
  }).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const obs = parseCftcLevShort(await fetchText(`${CFTC_TFF}?${qs}`, CFTC_TIMEOUT_MS));
  if (!obs.length) throw new Error('cftc: no complete weeks');
  const rec = obs.reduce((a, b) => (b.value >= a.value ? b : a));
  return { ...summarize('levShort', obs), record: rec.value, recordDate: rec.date, since: obs[0].date, source: 'cftc-tff' };
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

// Cboe's TNX is quoted as 10× the yield (49.49 = 4.949%); scale it back to percent.
function tnxToPercent(q) {
  if (q.value <= 20) return q;
  return { ...q, value: q.value / 10, change: q.change != null ? q.change / 10 : null };
}

// Treasury daily par yield curve CSV (newest row first, dates MM/DD/YYYY) → latest { date, us2y, us10y }.
function parseTreasuryCurve(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map((h) => h.replace(/"/g, '').trim());
  const i2 = head.indexOf('2 Yr'), i10 = head.indexOf('10 Yr');
  if (i2 < 0 || i10 < 0) throw new Error('treasury: no 2 Yr / 10 Yr columns');
  const rows = lines.map((line) => {
    const c = line.split(',');
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((c[0] || '').replace(/"/g, '').trim());
    return m && { date: `${m[3]}-${m[1]}-${m[2]}`, us2y: parseFloat(c[i2]), us10y: parseFloat(c[i10]) };
  }).filter((r) => r && isFinite(r.us2y) && isFinite(r.us10y)).sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) throw new Error('treasury: no rows');
  return rows[0];
}

// Lay a newer live quote over the FRED series: replace the point for the same day or append a new one.
function mergeLive(series, live, source = 'cboe') {
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
    source
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

async function loadIndexLive(url) {
  return parseCboeQuote(await fetchText(url));
}

async function loadTnxLive() {
  return tnxToPercent(parseCboeQuote(await fetchText(CBOE_TNX)));
}

// This month's curve; in the first days of a month it can be empty, so fall back to last month's.
async function loadTreasuryCurve(now = new Date()) {
  const month = (d) => d.toISOString().slice(0, 7).replace('-', '');
  const url = (m) => `${TREASURY_CSV}${m}?type=daily_treasury_yield_curve&field_tdr_date_value_month=${m}&page&_format=csv`;
  try {
    return parseTreasuryCurve(await fetchText(url(month(now))));
  } catch (e) {
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return parseTreasuryCurve(await fetchText(url(month(last))));
  }
}

async function buildPayload(apiKey) {
  const keys = Object.keys(SERIES);
  const [results, vixLive, tnxLive, curve, spxLive, ndxLive] = await Promise.all([
    Promise.allSettled(keys.map((k) => (k === 'dollar'
      ? loadDxy().catch((e) => loadSeries(k, apiKey).then((s) => ({ ...s, dxyError: e.message })))
      : SERIES[k].loader === 'yahoo' ? loadMove()
      : SERIES[k].loader === 'sofrSpread' ? loadSofrSpread(apiKey)
      : SERIES[k].loader === 'cftc' ? loadLevShort()
      : loadSeries(k, apiKey)))),
    loadVixLive().catch((e) => ({ error: e.message })),
    loadTnxLive().catch((e) => ({ error: e.message })),
    loadTreasuryCurve().catch((e) => ({ error: e.message })),
    loadIndexLive(CBOE_SPX).catch((e) => ({ error: e.message })),
    loadIndexLive(CBOE_NDX).catch((e) => ({ error: e.message }))
  ]);
  const series = {}, errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') series[keys[i]] = r.value;
    else errors[keys[i]] = r.reason && r.reason.message;
  });
  // FRED stays the backbone (history); a failed Cboe call just leaves the FRED close in place.
  if (vixLive.error) errors.vixLive = vixLive.error;
  else if (series.vix) series.vix = mergeLive(series.vix, vixLive);
  if (spxLive.error) errors.spxLive = spxLive.error;
  else if (series.sp500) series.sp500 = mergeLive(series.sp500, spxLive);
  if (ndxLive.error) errors.ndxLive = ndxLive.error;
  else if (series.nasdaq100) series.nasdaq100 = mergeLive(series.nasdaq100, ndxLive);
  // Yields: Treasury's same-day close first, then the Cboe 10-year quote on top when it's as new or newer.
  if (curve.error) errors.treasury = curve.error;
  else {
    if (series.us2y) series.us2y = mergeLive(series.us2y, { value: curve.us2y, change: null, date: curve.date }, 'treasury');
    if (series.us10y) series.us10y = mergeLive(series.us10y, { value: curve.us10y, change: null, date: curve.date }, 'treasury');
  }
  if (tnxLive.error) errors.tnxLive = tnxLive.error;
  else if (series.us10y) series.us10y = mergeLive(series.us10y, tnxLive);
  const out = { series, asOf: new Date().toISOString() };
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

module.exports.__test = { parseCsv, parseApiJson, weekly, summarize, parseCboeQuote, tnxToPercent, parseTreasuryCurve, mergeLive, dxyFromRates, parseDxySeries, joinSofrIorb, parseYahooSeries, parseCftcLevShort, SERIES, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
