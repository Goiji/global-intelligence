// Netlify Function: daily BTC DVOL + BTC price since DVOL began (Mar 2021), for the 🧪 Backtest tab.
//
//   GET /.netlify/functions/dvol-history
//   → { dates: [YYYY-MM-DD, ...], dvol: [close, ...], btc: [close, ...], source }
//
// Both come from Deribit's public API (no key): DVOL daily candles (paged, newest first, via
// `continuation`) and the BTC-PERPETUAL daily chart. Only days present in both are kept.
// History barely changes, so it is cached for 6 hours. The page calls Deribit directly if this is down.

const TIMEOUT_MS = 9000;
const TTL_S = 6 * 3600;
const START = Date.UTC(2021, 2, 1);
const API = 'https://www.deribit.com/api/v2/public/';
const MAX_PAGES = 6; // 1000 candles a page; ~2 100 days today

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = JSON.parse(await r.text());
    if (j.error) throw new Error('deribit: ' + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}

const dayOf = (ts) => new Date(Number(ts)).toISOString().slice(0, 10);

// DVOL candles [ts, o, h, l, c] + chart { ticks, close } → aligned daily rows, oldest first.
function align(dvolCandles, chart) {
  const dv = new Map();
  for (const c of dvolCandles) {
    const v = Number(c && c[4]);
    if (isFinite(v) && v > 5 && v < 400) dv.set(dayOf(c[0]), Math.round(v * 100) / 100);
  }
  const px = new Map();
  const ticks = (chart && chart.ticks) || [], close = (chart && chart.close) || [];
  ticks.forEach((t, i) => { const v = Number(close[i]); if (isFinite(v) && v > 0) px.set(dayOf(t), v); });
  const dates = [...dv.keys()].filter((d) => px.has(d)).sort();
  if (dates.length < 400) throw new Error('too little history: ' + dates.length + ' days');
  return { dates, dvol: dates.map((d) => dv.get(d)), btc: dates.map((d) => px.get(d)) };
}

async function load(now) {
  const candles = [];
  let end = now;
  for (let p = 0; p < MAX_PAGES && end; p++) {
    const r = await getJson(`${API}get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=${START}&end_timestamp=${end}`);
    candles.push(...((r && r.data) || []));
    end = r && r.continuation;
  }
  const chart = await getJson(`${API}get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&resolution=1D&start_timestamp=${START}&end_timestamp=${now}`);
  return align(candles, chart);
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'dvol-history:lastGood';

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=3600, s-maxage=${TTL_S}, stale-while-revalidate=86400`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const data = { ...(await load(now)), source: 'deribit' };
    memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
    await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || (await kvGetGood(event, KV_KEY, 7 * 86400000));
    if (good) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { align, load, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
