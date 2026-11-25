// Netlify Function: Strategy (MSTR) bitcoin holdings, cost and purchase history, plus the largest
// public-company holders, for the BTC tab.
//
//   GET /.netlify/functions/btc-treasury
//   → { strategy: { holdings, cost, avgCost, value, pnl, mnav, pctSupply },
//       tx: [{ date, type, btc, usd, balance, url }, ...]  (oldest first),
//       top: [{ name, symbol, country, btc, avgCost }, ...], fetchedAt }
//
// Source: CoinGecko's public treasury endpoints (free, no key). Cached 3 hours (filings come weekly
// at most); the page calls CoinGecko itself if this function is down.

const TIMEOUT_MS = 9000;
const TTL_S = 3 * 3600;
const API = 'https://api.coingecko.com/api/v3/';

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

const num = (v) => { const n = Number(v); return isFinite(n) ? n : null; };

// CoinGecko answers → the compact shape above. Pure, so it is unit-tested.
function shape(entity, history, list) {
  const h = ((entity && entity.holdings) || []).find((x) => x && x.coin_id === 'bitcoin');
  if (!h || !(num(h.amount) > 0)) throw new Error('no bitcoin holdings in the answer');
  const strategy = {
    holdings: num(h.amount),
    cost: num(h.total_entry_value_usd),
    avgCost: num(h.average_entry_value_usd),
    value: num(h.current_value_usd),
    pnl: num(h.unrealized_pnl),
    mnav: num(entity.m_nav),
    pctSupply: num(h.percentage_of_total_supply)
  };
  const tx = ((history && history.transactions) || [])
    .filter((t) => t && t.coin_id === 'bitcoin' && num(t.date) && num(t.holding_net_change) != null)
    .map((t) => ({
      date: new Date(Number(t.date)).toISOString().slice(0, 10),
      type: t.type === 'sell' ? 'sell' : 'buy',
      btc: Math.abs(num(t.holding_net_change)),
      usd: num(t.transaction_value_usd),
      balance: num(t.holding_balance),
      url: /^https:\/\//.test(String(t.source_url || '')) ? String(t.source_url) : null
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const top = ((list && list.companies) || []).slice(0, 8).map((c) => ({
    name: String(c.name || ''),
    symbol: String(c.symbol || ''),
    country: String(c.country || ''),
    btc: num(c.total_holdings),
    avgCost: num(c.total_entry_value_usd) > 0 && num(c.total_holdings) > 0 ? c.total_entry_value_usd / c.total_holdings : null
  }));
  return { strategy, tx, top, totalCompanies: num(list && list.total_holdings) };
}

async function load() {
  const [entity, history, list] = await Promise.all([
    getJson(API + 'public_treasury/strategy'),
    getJson(API + 'public_treasury/strategy/transaction_history?per_page=250')
      .catch(() => new Promise((r) => setTimeout(r, 1500)).then(() => getJson(API + 'public_treasury/strategy/transaction_history')))
      .catch(() => null),
    getJson(API + 'companies/public_treasury/bitcoin').catch(() => null)
  ]);
  return shape(entity, history, list);
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'btc-treasury:lastGood';

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=1800, s-maxage=${TTL_S}, stale-while-revalidate=86400`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const data = { ...(await load()), source: 'coingecko', fetchedAt: new Date(now).toISOString() };
    if (!data.tx.length) {
      // CoinGecko often rate-limits the history call from shared server IPs: reuse the last list that had one.
      const prev = (memCache.lastGood && memCache.lastGood.tx.length && memCache.lastGood) || (await kvGetGood(event, KV_KEY, 30 * 86400000));
      if (prev && Array.isArray(prev.tx) && prev.tx.length) data.tx = prev.tx;
    }
    memCache = { data, expiresAt: now + (data.tx.length ? TTL_S : 300) * 1000, lastGood: data.tx.length ? data : (memCache.lastGood || data) };
    if (data.tx.length) await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || (await kvGetGood(event, KV_KEY, 14 * 86400000));
    if (good) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { shape, _expire: () => { memCache.expiresAt = 0; }, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
