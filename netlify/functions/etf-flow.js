// Netlify Function: US spot Bitcoin ETF daily net flow for the ₿ tab.
//
//   GET /.netlify/functions/etf-flow
//   → { date, net, prev, sum5, sum30, hist: [[YYYY-MM-DD, US$m], ...30], funds: [[ticker, US$m], ...], source }
//
// Flows are published once a day after the US close (issuers report creations/redemptions),
// so this is daily data, not real-time. Values are in US$ millions; negative = net outflow.
// Sources, tried in order (all free):
//   1. farside.co.uk/btc/ — the standard daily table, no API, HTML behind Cloudflare bot protection
//   2. the same page through allorigins.win (a different egress IP, for when Cloudflare refuses us)
//   3. SoSoValue's open API — free key from their developer dashboard, used only if SOSOVALUE_API_KEY is set
// The last good answer is kept in memory and (on Cloudflare Pages) in the STORE KV namespace for
// 3 days, because a refused scrape shouldn't blank a number that only changes once a day.

const TIMEOUT_MS = 8000;
const TTL_S = 1800;
const STALE_MS = 3 * 86400000;
const KV_KEY = 'etf-flow:lastGood';
const { kvGetGood, kvPutGood } = require('../lib/last-good.js'); // throttled: KV writes are metered
const FARSIDE = 'https://farside.co.uk/btc/';
const ALLORIGINS = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(FARSIDE);
const SOSO = 'https://openapi.sosovalue.com/openapi/v1/etfs/summary-history?symbol=BTC&country_code=US&limit=60';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function fetchText(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const decode = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#0*39;/g, "'").replace(/\s+/g, ' ').trim();

// "1,234.5" → 1234.5 · "(56.7)" → -56.7 · "-" / "" → null
function num(s) {
  const t = String(s).replace(/[,$\s]/g, '');
  if (!t || t === '-' || t === '–') return null;
  const m = t.match(/^\((\d+(?:\.\d+)?)\)$/);
  const v = m ? -Number(m[1]) : Number(t);
  return isFinite(v) ? v : null;
}

function isoDate(s) {
  const m = String(s).match(/^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})$/);
  const mo = m && MONTHS[m[2].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

// Farside's table: a header row of tickers ending in "Total", then one row per trading day
// ("13 Nov 2026", fund flows…, total), then Total/Average/Maximum/Minimum summary rows.
function parseFarside(html) {
  const rows = [];
  let tickers = null;
  for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(decode);
    if (cells.length < 3) continue;
    if (!tickers && /^total$/i.test(cells[cells.length - 1]) && cells.slice(1, -1).some((c) => /^[A-Z]{3,5}$/.test(c))) { tickers = cells; continue; }
    const date = isoDate(cells[0]);
    if (!date) continue;
    const vals = cells.slice(1).map(num);
    const total = vals[vals.length - 1];
    if (total == null || Math.abs(total) > 20000) continue; // blank (not reported yet) or garbage
    const funds = tickers && tickers.length === cells.length
      ? tickers.slice(1, -1).map((t, i) => [t, vals[i]]).filter((f) => f[1] != null && f[1] !== 0)
      : [];
    rows.push({ date, net: Math.round(total * 10) / 10, funds });
  }
  if (!rows.length) throw new Error(/challenge|cf-chl|Just a moment/i.test(html) ? 'cloudflare challenge' : 'no flow rows');
  return build(rows);
}

// SoSoValue: newest first, USD (not millions). Bare array or wrapped in { code, data }.
function parseSoso(text) {
  const j = JSON.parse(text);
  const list = Array.isArray(j) ? j : j && (Array.isArray(j.data) ? j.data : j.data && j.data.list);
  if (!Array.isArray(list)) throw new Error('sosovalue: ' + ((j && (j.message || j.msg)) || 'unexpected payload'));
  const rows = list
    .map((d) => ({ date: String(d.date || '').slice(0, 10), net: Number(d.total_net_inflow ?? d.totalNetInflow) / 1e6, funds: [] }))
    .filter((d) => /^\d{4}-\d\d-\d\d$/.test(d.date) && isFinite(d.net))
    .map((d) => ({ ...d, net: Math.round(d.net * 10) / 10 }));
  if (!rows.length) throw new Error('sosovalue: no rows');
  return build(rows);
}

function build(rows) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const days = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const last = days[days.length - 1];
  const sum = (n) => Math.round(days.slice(-n).reduce((s, d) => s + d.net, 0) * 10) / 10;
  return {
    unit: 'US$m',
    date: last.date,
    net: last.net,
    prev: days.length > 1 ? days[days.length - 2].net : null,
    sum5: sum(5),
    sum30: sum(30),
    hist: days.slice(-30).map((d) => [d.date, d.net]),
    funds: last.funds.slice().sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
  };
}

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=7200`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  const sources = [
    { name: 'farside', url: FARSIDE, headers: { Accept: 'text/html' }, parse: parseFarside },
    { name: 'farside:allorigins', url: ALLORIGINS, parse: parseFarside }
  ];
  const key = process.env.SOSOVALUE_API_KEY;
  if (key) sources.push({ name: 'sosovalue', url: SOSO, headers: { Accept: 'application/json', 'x-soso-api-key': key }, parse: parseSoso });

  const errors = {};
  for (const s of sources) {
    try {
      const data = { ...s.parse(await fetchText(s.url, s.headers)), source: s.name, fetchedAt: new Date(now).toISOString() };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      await kvPutGood(event, KV_KEY, data);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { errors[s.name] = e.message; }
  }
  let good = memCache.lastGood;
  if (!good) good = await kvGetGood(event, KV_KEY, STALE_MS);
  if (good && now - Date.parse(good.fetchedAt) < STALE_MS) {
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=600' }, body: JSON.stringify({ ...good, stale: true, errors }) };
  }
  return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'no source answered', errors }) };
};

module.exports.__test = { parseFarside, parseSoso, num, isoDate, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
