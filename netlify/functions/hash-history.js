// Netlify Function: daily BTC hashrate + BTC price since Aug 2010, for the Hash Ribbons backtest.
//
//   GET /.netlify/functions/hash-history
//   → { dates: [YYYY-MM-DD, ...], hash: [EH/s, ...], btc: [USD, ...], source }
//
// Both series come from blockchain.com's public charts API (no key): the estimated network hashrate
// and the market price, one point per UTC day. Only days present in both are kept.
// History barely changes, so it is cached for 6 hours. The page calls blockchain.com directly if this is down.

const TIMEOUT_MS = 12000;
const TTL_S = 6 * 3600;
const API = 'https://api.blockchain.info/charts/';
const Q = '?timespan=all&format=json&sampled=false';

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(await r.text());
  } finally {
    clearTimeout(timer);
  }
}

const dayOf = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

// blockchain.com { values: [{ x: unix s, y }] } ×2 → aligned daily rows, oldest first.
// Hashrate arrives in TH/s and is sent as EH/s with 4 significant digits.
function align(hashJson, priceJson) {
  const hm = new Map(), pm = new Map();
  for (const v of (hashJson && hashJson.values) || []) { const y = Number(v && v.y); if (isFinite(y) && y > 0) hm.set(dayOf(v.x), Number((y / 1e6).toPrecision(4))); }
  for (const v of (priceJson && priceJson.values) || []) { const y = Number(v && v.y); if (isFinite(y) && y > 0) pm.set(dayOf(v.x), y); }
  const dates = [...pm.keys()].filter((d) => hm.has(d)).sort();
  if (dates.length < 1000) throw new Error('too little history: ' + dates.length + ' days');
  return { dates, hash: dates.map((d) => hm.get(d)), btc: dates.map((d) => pm.get(d)) };
}

async function load() {
  const [h, p] = await Promise.all([getJson(API + 'hash-rate' + Q), getJson(API + 'market-price' + Q)]);
  return align(h, p);
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'hash-history:lastGood';

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
    const data = { ...(await load()), source: 'blockchain.com' };
    memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
    await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || (await kvGetGood(event, KV_KEY, 7 * 86400000));
    if (good) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { align, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
