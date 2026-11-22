// Netlify Function: BTC futures liquidations over the last 1h / 4h / 12h / 24h, long vs short,
// summed across exchanges, for the "ยอดล้างพอร์ต BTC" card on the ₿ tab.
//
//   GET /.netlify/functions/liquidations
//   → { at, windows: { '1h': { long, short, total }, '4h': …, '12h': …, '24h': … },
//       exchanges: [{ name, long, short, total }] (24h, largest first), markets, source }
//
// Data: Coinalyze's free API (needs COINALYZE_API_KEY, free at coinalyze.net/account/api-key/).
// Exchanges stopped publishing liquidation history for free (Binance removed allForceOrders, Bybit
// only streams it live), and Coinalyze keeps those streams for Binance, Bybit, OKX, Bitget,
// Hyperliquid, BitMEX, Deribit and others. One /liquidation-history call over 5-minute buckets for
// the last 24h of every BTC perpetual we pick gives rolling 1h/4h/12h/24h sums.
//
// Limits: 40 calls/min per key, and each symbol counts as one call, so we ask for at most 20
// symbols (one request) and cache the answer for 1 minute. The market list is kept for a day.

const TIMEOUT_MS = 9000;
const TTL_S = 60; // 20 symbols = 20 of the 40 calls/min a key allows, so at most one refresh a minute
const MARKETS_TTL_MS = 24 * 3600 * 1000;
const BASE = 'https://api.coinalyze.net/v1';
const MAX_SYMBOLS = 20;
const PER_EXCHANGE = 2;
const WINDOWS = [['1h', 1], ['4h', 4], ['12h', 12], ['24h', 24]];

// Largest BTC derivatives venues first; anything unlisted comes after, in Coinalyze's own order.
const EXCHANGE_RANK = [/binance/i, /bybit/i, /okx|okex/i, /bitget/i, /hyperliquid/i, /gate/i, /aster/i, /lighter/i, /bitmex/i,
  /deribit/i, /huobi|htx/i, /bingx/i, /mexc/i, /kraken/i, /coinbase/i, /bitfinex/i, /dydx/i, /phemex/i, /kucoin/i];
const QUOTE_RANK = ['USDT', 'USD', 'USDC', 'FDUSD'];

let memCache = { data: null, expiresAt: 0, lastGood: null };
let marketsCache = { list: null, names: null, at: 0 };

async function getJson(path, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // key as a query parameter: some proxies drop header names with an underscore ("api_key")
    const url = BASE + path + (path.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key);
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (r.status === 401) throw new Error('coinalyze: invalid API key');
    if (r.status === 429) throw new Error('coinalyze: rate limited');
    if (!r.ok) throw new Error('coinalyze HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function exchangeRank(name) {
  const i = EXCHANGE_RANK.findIndex((re) => re.test(name || ''));
  return i < 0 ? EXCHANGE_RANK.length : i;
}

// /future-markets + /exchanges → up to MAX_SYMBOLS BTC perpetual symbols, big venues first.
function pickBtcPerps(markets, exchanges, max = MAX_SYMBOLS) {
  const names = {};
  for (const e of exchanges || []) if (e && e.code != null) names[String(e.code)] = String(e.name || e.code);
  const perps = (markets || []).filter((m) => m && m.is_perpetual && String(m.base_asset).toUpperCase() === 'BTC' && m.symbol);
  const ranked = perps.map((m, i) => {
    const ex = names[String(m.exchange)] || String(m.exchange || '');
    const q = QUOTE_RANK.indexOf(String(m.quote_asset).toUpperCase());
    return { symbol: String(m.symbol), exchange: ex, r: exchangeRank(ex), q: q < 0 ? QUOTE_RANK.length : q, i };
  }).sort((a, b) => a.r - b.r || a.q - b.q || a.i - b.i);
  // At most PER_EXCHANGE symbols per exchange first, so Binance/Bybit/OKX's many BTC contracts
  // don't use up all 20 slots and leave out Bitget, Hyperliquid, Gate and others; spare slots
  // then go to the remaining contracts in the same order.
  const first = [], rest = [], seen = {};
  for (const m of ranked) ((seen[m.exchange] = (seen[m.exchange] || 0) + 1) <= PER_EXCHANGE ? first : rest).push(m);
  return first.concat(rest).slice(0, max);
}

// Coinalyze [{ symbol, history: [{ t (s), l, s }] }] → rolling window sums (USD) and per-exchange 24h.
// l = long positions liquidated, s = short positions liquidated (same naming as its long/short ratio).
function sumLiquidations(rows, picked, nowMs) {
  const exOf = {};
  for (const p of picked || []) exOf[p.symbol] = p.exchange;
  const windows = {};
  for (const [k] of WINDOWS) windows[k] = { long: 0, short: 0, total: 0 };
  const byEx = {};
  let points = 0, latestT = 0;
  for (const row of rows || []) {
    const ex = exOf[row && row.symbol] || 'Other';
    for (const h of (row && row.history) || []) {
      const t = Number(h.t) * 1000, l = Number(h.l), s = Number(h.s);
      if (!isFinite(t) || !(l >= 0) || !(s >= 0)) continue;
      const ageH = (nowMs - t) / 3600000;
      if (ageH > 24 || ageH < -1) continue;
      points++;
      if (t > latestT) latestT = t;
      for (const [k, hrs] of WINDOWS) if (ageH <= hrs) { windows[k].long += l; windows[k].short += s; }
      const e = byEx[ex] || (byEx[ex] = { name: ex, long: 0, short: 0, total: 0 });
      e.long += l; e.short += s;
    }
  }
  for (const [k] of WINDOWS) {
    const w = windows[k];
    w.long = Math.round(w.long); w.short = Math.round(w.short); w.total = w.long + w.short;
  }
  const exchanges = Object.values(byEx).map((e) => ({ name: e.name, long: Math.round(e.long), short: Math.round(e.short), total: Math.round(e.long + e.short) }))
    .filter((e) => e.total > 0).sort((a, b) => b.total - a.total);
  return { windows, exchanges, points, latestAt: latestT ? new Date(latestT).toISOString() : null };
}

async function loadMarkets(key, now) {
  if (marketsCache.list && now - marketsCache.at < MARKETS_TTL_MS) return marketsCache.list;
  const [markets, exchanges] = await Promise.all([getJson('/future-markets', key), getJson('/exchanges', key)]);
  const list = pickBtcPerps(markets, exchanges);
  if (!list.length) throw new Error('coinalyze: no BTC perpetual markets');
  marketsCache = { list, at: now };
  return list;
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'liquidations:lastGood';

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=120`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  const key = ((typeof process !== 'undefined' && process.env && process.env.COINALYZE_API_KEY) || '').trim();
  let error;
  if (!key) {
    error = 'missing-key';
  } else {
    try {
      const picked = await loadMarkets(key, now);
      const to = Math.floor(now / 1000), from = to - 24 * 3600;
      const rows = await getJson('/liquidation-history?symbols=' + encodeURIComponent(picked.map((p) => p.symbol).join(','))
        + '&interval=5min&from=' + from + '&to=' + to + '&convert_to_usd=true', key);
      const sums = sumLiquidations(rows, picked, now);
      if (!sums.points) throw new Error('coinalyze: empty history');
      const data = {
        at: new Date(now).toISOString(),
        ...sums,
        markets: picked.map((p) => p.exchange + ' ' + p.symbol),
        exchangeCount: new Set(picked.map((p) => p.exchange)).size,
        source: 'coinalyze'
      };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      await kvPutGood(event, KV_KEY, data);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { error = e.message; }
  }
  const good = memCache.lastGood || (key ? await kvGetGood(event, KV_KEY, 6 * 3600 * 1000) : null);
  if (good) {
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' }, body: JSON.stringify({ ...good, stale: true, error }) };
  }
  return { statusCode: error === 'missing-key' ? 503 : 502, headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' }, body: JSON.stringify({ error }) };
};

module.exports.__test = {
  pickBtcPerps, sumLiquidations, WINDOWS,
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; marketsCache = { list: null, at: 0 }; }
};
