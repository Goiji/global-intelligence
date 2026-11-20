// Netlify Function: total stablecoin market cap (USDT, USDC, DAI, …) for the ₿ tab.
//
//   GET /.netlify/functions/stablecoins
//   → { latest, date, ch7, ch7Pct, ch30, ch30Pct, hist: [[YYYY-MM-DD, US$ billions], ...], source }
//
// Like TradingView's CRYPTOCAP:STABLE.C: the money parked inside crypto, ready to buy BTC and the
// rest. DefiLlama's free stablecoins API needs no key: /stablecoincharts/all returns one row per day
// with totalCirculatingUSD = circulating supply of every stablecoin, already converted to US$, split
// by peg (peggedUSD, peggedEUR, …). We add the pegs up, keep the last ~12 months and work out the
// 7- and 30-day change. The numbers move once a day, so this answers from memory/CDN for an hour.
// No Cloudflare KV here on purpose (keeps the KV daily quota for the cards that need it): the page
// keeps its own last good copy in localStorage and calls DefiLlama directly if this is down.

const TIMEOUT_MS = 8000;
const TTL_S = 3600;
const URL_ALL = 'https://stablecoins.llama.fi/stablecoincharts/all';
const HIST_DAYS = 366;

let memCache = { data: null, expiresAt: 0 };

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)', Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Sum of every peg in totalCirculatingUSD (US$), or null.
function rowTotal(row) {
  const t = row && row.totalCirculatingUSD;
  if (!t || typeof t !== 'object') return null;
  let sum = 0, any = false;
  for (const v of Object.values(t)) {
    const n = Number(v);
    if (isFinite(n) && n > 0) { sum += n; any = true; }
  }
  return any ? sum : null;
}

const round2 = (v) => Math.round(v * 100) / 100;

// Change vs the day `days` before the latest one (or the closest earlier day we have).
function changeOver(days, n) {
  if (days.length < 2) return { abs: null, pct: null };
  const lastT = Date.parse(days[days.length - 1][0] + 'T00:00:00Z');
  const target = lastT - n * 86400000;
  let base = null;
  for (let i = days.length - 2; i >= 0; i--) {
    if (Date.parse(days[i][0] + 'T00:00:00Z') <= target) { base = days[i][1]; break; }
  }
  if (base == null || !(base > 0)) return { abs: null, pct: null };
  const latest = days[days.length - 1][1];
  return { abs: round2(latest - base), pct: round2((latest / base - 1) * 100) };
}

// DefiLlama chart rows → { latest (US$ bn), date, ch7, ch7Pct, ch30, ch30Pct, hist }
function parseStablecoins(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  const rows = Array.isArray(j) ? j : [];
  const byDay = new Map();
  for (const r of rows) {
    const sec = Number(r && r.date);
    const total = rowTotal(r);
    if (!isFinite(sec) || sec <= 0 || total == null) continue;
    const bn = total / 1e9;
    if (bn < 1 || bn > 100000) continue; // sanity: not a real total
    byDay.set(new Date(sec * 1000).toISOString().slice(0, 10), round2(bn));
  }
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!days.length) throw new Error('no usable rows');
  const c7 = changeOver(days, 7), c30 = changeOver(days, 30);
  return {
    label: 'Stablecoin market cap',
    unit: 'US$ bn',
    latest: days[days.length - 1][1],
    date: days[days.length - 1][0],
    ch7: c7.abs, ch7Pct: c7.pct,
    ch30: c30.abs, ch30Pct: c30.pct,
    hist: days.slice(-HIST_DAYS)
  };
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=21600`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const data = { ...parseStablecoins(await fetchText(URL_ALL)), source: 'defillama' };
    memCache = { data, expiresAt: now + TTL_S * 1000 };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.data && now - memCache.expiresAt < 2 * 86400000) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...memCache.data, stale: true }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'defillama unavailable', detail: e.message }) };
  }
};

module.exports.__test = { parseStablecoins, rowTotal, changeOver, URL_ALL, _clearCache: () => { memCache = { data: null, expiresAt: 0 }; } };
