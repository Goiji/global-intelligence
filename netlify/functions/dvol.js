// Netlify Function: Deribit BTC DVOL (Bitcoin implied-volatility index) for the ₿ tab.
//
//   GET /.netlify/functions/dvol
//   → { label, latest, prev, change, date, time, high, low, hist: [[YYYY-MM-DD, close], ...], source }
//
// DVOL is Deribit's 30-day forward-looking implied volatility of BTC, built from its BTC options
// the same way Cboe builds VIX from S&P 500 options. Deribit's public market-data API needs no
// key: public/get_volatility_index_data returns OHLC candles [ts_ms, open, high, low, close].
// We ask for daily candles over the last ~13 months; the last candle is today's, still forming,
// so its close is the live value. One fallback (hourly candles over the last 2 days) keeps the
// tile alive if the daily call fails. The page calls Deribit directly if this function is down.

const TIMEOUT_MS = 6000;
const TTL_S = 300;
const DAY_MS = 86400000;
const BASE = 'https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC';
const RANGE = [5, 400]; // DVOL has lived between ~30 and ~200 since 2019; anything else is a bad payload

let memCache = { data: null, expiresAt: 0, lastGood: null };

function candlesUrl(resolution, days, now) {
  return `${BASE}&resolution=${resolution}&start_timestamp=${now - days * DAY_MS}&end_timestamp=${now}`;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard; +https://global-intelligence-dashboard.netlify.app)', Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Deribit candles → one close per UTC day (the last candle of each day wins), oldest first.
function parseDvol(text, histDays) {
  const j = JSON.parse(text);
  if (j.error) throw new Error('deribit: ' + (j.error.message || JSON.stringify(j.error)));
  const rows = (j.result && j.result.data) || [];
  const byDay = new Map();
  let lastTs = 0;
  for (const c of rows) {
    if (!Array.isArray(c) || c.length < 5) continue;
    const ts = Number(c[0]), close = Number(c[4]);
    if (!isFinite(ts) || !isFinite(close) || close < RANGE[0] || close > RANGE[1]) continue;
    byDay.set(new Date(ts).toISOString().slice(0, 10), Math.round(close * 100) / 100);
    if (ts > lastTs) lastTs = ts;
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length < 1) throw new Error('no usable candles');
  const hist = histDays ? days.slice(-histDays) : days;
  const latest = days[days.length - 1][1];
  const prev = days.length > 1 ? days[days.length - 2][1] : null;
  const vals = hist.map((d) => d[1]);
  return {
    label: 'DVOL',
    latest,
    prev,
    change: prev != null ? Math.round((latest - prev) * 100) / 100 : null,
    date: days[days.length - 1][0],
    time: new Date(lastTs).toISOString(),
    high: Math.max.apply(null, vals),
    low: Math.min.apply(null, vals),
    hist
  };
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'dvol:lastGood';

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=1800`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  const sources = [
    { name: 'deribit:1D', url: candlesUrl('1D', 380, now), parse: (t) => parseDvol(t, 366) },
    { name: 'deribit:1h', url: candlesUrl('3600', 2, now), parse: (t) => parseDvol(t, 0) }
  ];
  const errors = {};
  for (const s of sources) {
    try {
      const data = { ...s.parse(await fetchText(s.url)), source: s.name };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      await kvPutGood(event, KV_KEY, data);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { errors[s.name] = e.message; }
  }
  // memory first; after a cold start (new instance / other host) the copy kept in KV
  const good = (memCache.lastGood && now - memCache.expiresAt < 21600000) ? memCache.lastGood : await kvGetGood(event, KV_KEY, 21600000);
  if (good) {
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' }, body: JSON.stringify({ ...good, stale: true }) };
  }
  return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'no source answered', errors }) };
};

module.exports.__test = { parseDvol, candlesUrl, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
