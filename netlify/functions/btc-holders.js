// Netlify Function: daily BTC price, realized prices (all / long-term / short-term holders) and
// LTH / STH supply, for the on-chain section of the BTC tab.
//
//   GET /.netlify/functions/btc-holders
//   → { start: 'YYYY-MM-DD', days, price: [...], rp: [...], lrp: [...], srp: [...], ls: [...], ss: [...], source }
//     one entry per UTC day from `start`; null where a series has no value that day
//
// Source: the public JSON files behind charts.bgeometrics.com (no key, no per-IP quota, CORS open,
// refreshed daily). The free files hold the full history for price / realized price / supply and
// about four years for the STH realized price, and the newest week is held back by the publisher.
// Cached 6 hours; the page reads the same files itself if this function is down.

const TIMEOUT_MS = 12000;
const TTL_S = 6 * 3600;
const BASE = 'https://charts.bgeometrics.com/files/';
const FILES = {
  price: 'realized_price_btc_price',
  rp: 'realized_price',
  lrp: 'lth_realized_price',
  srp: 'sth_realized_price',
  ls: 'lth_supply',
  ss: 'sth_supply'
};
const START = Date.UTC(2011, 5, 1);
const DAY = 86400000;

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

// prices keep cents below $100 (2011–2013), whole dollars above; supply in whole BTC
const roundPx = (v) => (v < 100 ? Math.round(v * 100) / 100 : Math.round(v));

// raw { key: [[tsMs, value], ...] } → aligned daily arrays from START to the last day any series has
function build(raw) {
  const maps = {};
  let last = 0;
  for (const k of Object.keys(FILES)) {
    const m = new Map();
    for (const row of raw[k] || []) {
      const t = Number(row && row[0]), v = Number(row && row[1]);
      if (!isFinite(t) || row[1] == null || !isFinite(v) || v <= 0) continue;
      const d = Math.floor((t - START) / DAY);
      if (d < 0) continue;
      m.set(d, k === 'ls' || k === 'ss' ? Math.round(v) : roundPx(v));
      if (k === 'price' && d > last) last = d;
    }
    maps[k] = m;
  }
  const days = last + 1;
  if (days < 3000 || maps.rp.size < 2000 || maps.ls.size < 1000) throw new Error('too little history');
  const out = { start: new Date(START).toISOString().slice(0, 10), days };
  for (const k of Object.keys(FILES)) {
    const arr = new Array(days).fill(null);
    for (const [d, v] of maps[k]) if (d < days) arr[d] = v;
    out[k] = arr;
  }
  return out;
}

async function load() {
  const keys = Object.keys(FILES);
  const res = await Promise.all(keys.map((k) => getJson(BASE + FILES[k] + '.json')));
  const raw = {};
  keys.forEach((k, i) => { raw[k] = res[i]; });
  return build(raw);
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'btc-holders:lastGood';

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
    const data = { ...(await load()), source: 'bgeometrics' };
    memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
    await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || (await kvGetGood(event, KV_KEY, 14 * 86400000));
    if (good) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { build, FILES, START, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
