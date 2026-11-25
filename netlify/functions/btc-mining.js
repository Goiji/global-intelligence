// Netlify Function: Bitcoin mining data for the ₿ tab (cost of production + are miners selling?).
//
//   GET /.netlify/functions/btc-mining
//   → { height, difficulty, hashrateEh, subsidy, feePerBlock, price, priceDate,
//       ribbon: { sma30, sma60, state, days }, puell, hist: [[YYYY-MM-DD, EH/s 30d, EH/s 60d]], source }
//
// Sources (all free, no key):
//   • mempool.space /api/v1/mining/hashrate/1y   daily network hashrate (H/s) + every difficulty adjustment
//   • mempool.space /api/v1/mining/reward-stats/1008   fees paid over the last ~week of blocks (sats)
//   • Kraken OHLC (daily XBT/USD closes, ~720 days), CoinGecko market_chart as a backup
// The page turns difficulty + fees into a cost per BTC with the visitor's own electricity price and
// machine efficiency, so only raw inputs are sent from here. Hash Ribbons (30- vs 60-day average
// hashrate) and the Puell Multiple (today's new-coin revenue in US$ ÷ its 365-day average) are
// worked out here because they need a year of history. Miner wallet flows (CryptoQuant, Glassnode)
// are paid data, so the "are miners selling?" tile reads these two plus the price/cost margin.
// No Cloudflare KV on purpose; the page keeps its own last good copy in localStorage.

const TIMEOUT_MS = 9000;
const TTL_S = 3 * 3600;
const MEMPOOL = 'https://mempool.space/api/v1/mining/';
const URL_HASH = MEMPOOL + 'hashrate/1y';
const URL_FEES = MEMPOOL + 'reward-stats/1008';
const URL_KRAKEN = 'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440';
const URL_GECKO = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=400&interval=daily';
const TWO32 = 4294967296;
const DAY_MS = 86400000;

let memCache = { data: null, expiresAt: 0 };

async function fetchJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)', Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return typeof n === 'number' && isFinite(n) ? n : null; };
// mempool uses seconds; accept ms too
const toMs = (t) => { const n = num(t); return n == null ? null : (n < 1e12 ? n * 1000 : n); };
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };

// Block subsidy (BTC) at a height: 50 halved every 210,000 blocks.
function subsidyAt(height) {
  return 50 / Math.pow(2, Math.floor(height / 210000));
}

// mempool hashrate/1y → { days: [{ day, hashrate, difficulty }], difficulty, height }
// One row per UTC day (several points on one day are averaged), each with the difficulty in force.
function parseHashrate(json) {
  const rows = (json && Array.isArray(json.hashrates)) ? json.hashrates : [];
  const diffs = ((json && Array.isArray(json.difficulty)) ? json.difficulty : [])
    .map((d) => ({ t: toMs(d.time != null ? d.time : d.timestamp), diff: num(d.difficulty), height: num(d.height) }))
    .filter((d) => d.t != null && d.diff > 0)
    .sort((a, b) => a.t - b.t);
  const byDay = new Map();
  for (const r of rows) {
    const t = toMs(r.timestamp != null ? r.timestamp : r.time), h = num(r.avgHashrate);
    if (t == null || !(h > 0)) continue;
    const k = dayOf(t);
    const cur = byDay.get(k) || { sum: 0, n: 0, t };
    cur.sum += h; cur.n += 1;
    byDay.set(k, cur);
  }
  let di = 0;
  const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => {
    const t = Date.parse(day + 'T12:00:00Z');
    while (di + 1 < diffs.length && diffs[di + 1].t <= t) di++;
    const difficulty = diffs.length && diffs[di].t <= t ? diffs[di].diff : (diffs.length ? diffs[0].diff : null);
    return { day, hashrate: v.sum / v.n, difficulty };
  });
  if (days.length < 60) throw new Error('not enough hashrate history');
  const last = diffs[diffs.length - 1];
  const difficulty = num(json.currentDifficulty) || (last && last.diff);
  if (!(difficulty > 0)) throw new Error('no difficulty');
  return { days, difficulty, height: last ? last.height : null };
}

// Hash Ribbons: 30- vs 60-day simple average of daily hashrate.
//   capitulation = 30d below 60d (miners switching machines off, usually selling to survive)
//   recovery     = 30d crossed back above 60d within the last 14 days after ≥ 7 days of capitulation
//   normal       = otherwise
function hashRibbons(days) {
  const hs = days.map((d) => d.hashrate);
  const sma = (i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += hs[k]; return s / n; };
  const series = days.map((d, i) => ({ day: d.day, s30: sma(i, 30), s60: sma(i, 60) })).filter((r) => r.s60 != null);
  if (!series.length) return null;
  const below = series.map((r) => r.s30 < r.s60);
  const last = series.length - 1;
  let run = 0;
  for (let i = last; i >= 0 && below[i] === below[last]; i--) run++;
  let state = below[last] ? 'capitulation' : 'normal';
  if (!below[last] && run <= 14) {
    let prev = 0;
    for (let i = last - run; i >= 0 && below[i]; i--) prev++;
    if (prev >= 7) state = 'recovery';
  }
  return { state, days: run, sma30: series[last].s30, sma60: series[last].s60, series };
}

// Daily closes: Kraken { result: { XXBTZUSD: [[time, o, h, l, close, …]] } } or CoinGecko { prices: [[ms, price]] }
function parsePrices(json) {
  const out = new Map();
  if (json && json.result && typeof json.result === 'object') {
    for (const k of Object.keys(json.result)) {
      if (!Array.isArray(json.result[k])) continue;
      for (const row of json.result[k]) {
        const t = toMs(row[0]), c = num(row[4]);
        if (t != null && c > 0) out.set(dayOf(t), c);
      }
    }
  } else if (json && Array.isArray(json.prices)) {
    for (const row of json.prices) {
      const t = toMs(row[0]), c = num(row[1]);
      if (t != null && c > 0) out.set(dayOf(t), c);
    }
  }
  if (out.size < 30) throw new Error('no usable price history');
  return out;
}

// Puell Multiple = today's issuance in US$ ÷ average daily issuance in US$ over the last 365 days.
// Blocks per day come from hashrate ÷ difficulty (the same thing mempool derived the hashrate from).
function puellMultiple(days, prices, height) {
  const issued = [];
  for (const d of days) {
    const p = prices.get(d.day);
    if (!(p > 0) || !(d.difficulty > 0)) continue;
    const blocks = d.hashrate * 86400 / (d.difficulty * TWO32);
    issued.push({ day: d.day, usd: blocks * subsidyAt(height || 0) * p });
  }
  if (issued.length < 300) return null;
  const lastT = Date.parse(issued[issued.length - 1].day);
  const yr = issued.filter((r) => lastT - Date.parse(r.day) < 365 * DAY_MS);
  const avg = yr.reduce((s, r) => s + r.usd, 0) / yr.length;
  // smooth today's value over 3 days: a single day's block count is noisy
  const recent = issued.slice(-3);
  const today = recent.reduce((s, r) => s + r.usd, 0) / recent.length;
  return avg > 0 ? round(today / avg, 2) : null;
}

function build(hashJson, feeJson, prices) {
  const h = parseHashrate(hashJson);
  const height = num(feeJson && feeJson.endBlock) || h.height;
  if (!(height > 0)) throw new Error('no block height');
  const totalFee = num(feeJson && feeJson.totalFee), start = num(feeJson && feeJson.startBlock), end = num(feeJson && feeJson.endBlock);
  const blocks = start != null && end != null ? end - start + 1 : 1008;
  const feePerBlock = totalFee != null && blocks > 0 ? round(totalFee / blocks / 1e8, 4) : null;
  const rib = hashRibbons(h.days);
  const last7 = h.days.slice(-7);
  const hashrateEh = round(last7.reduce((s, d) => s + d.hashrate, 0) / last7.length / 1e18, 1);
  let price = null, priceDate = null, puell = null;
  if (prices) {
    const keys = [...prices.keys()].sort();
    priceDate = keys[keys.length - 1];
    price = round(prices.get(priceDate), 0);
    puell = puellMultiple(h.days, prices, height);
  }
  return {
    height,
    date: h.days[h.days.length - 1].day,
    difficulty: h.difficulty,
    hashrateEh,
    subsidy: subsidyAt(height),
    feePerBlock,
    price,
    priceDate,
    puell,
    ribbon: rib ? { state: rib.state, days: rib.days, sma30: round(rib.sma30 / 1e18, 1), sma60: round(rib.sma60 / 1e18, 1) } : null,
    hist: rib ? rib.series.slice(-180).map((r) => [r.day, round(r.s30 / 1e18, 1), round(r.s60 / 1e18, 1)]) : []
  };
}

async function loadPrices() {
  try { return parsePrices(await fetchJson(URL_KRAKEN)); } catch (e) { /* try the backup */ }
  try { return parsePrices(await fetchJson(URL_GECKO)); } catch (e) { return null; }
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=43200`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const [hashJson, feeJson, prices] = await Promise.all([
      fetchJson(URL_HASH),
      fetchJson(URL_FEES).catch(() => null), // fees are a small part of revenue; carry on without them
      loadPrices()
    ]);
    const data = { ...build(hashJson, feeJson, prices), source: 'mempool.space' + (prices ? ' + kraken/coingecko' : '') };
    memCache = { data, expiresAt: now + TTL_S * 1000 };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.data && now - memCache.expiresAt < 2 * DAY_MS) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...memCache.data, stale: true }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'mining data unavailable', detail: e.message }) };
  }
};

module.exports.__test = {
  parseHashrate, hashRibbons, parsePrices, puellMultiple, subsidyAt, build,
  URL_HASH, URL_FEES, URL_KRAKEN, URL_GECKO,
  _clearCache: () => { memCache = { data: null, expiresAt: 0 }; }
};
