// Netlify Function: live USD/JPY (yen per dollar) for the "📡 ราคาตลาด" panel.
//
//   GET /.netlify/functions/usdjpy
//   → { price, prevClose, pct, asOf, source }
//
// The other FX rows in that panel are ECB reference rates (once a day, ~21:00 Bangkok time). USD/JPY
// is read next to the US − Japan yield-spread tiles, where a yen move of 1–2% in an hour matters, so
// it gets an interbank quote delayed a few minutes instead. Same pattern as wti.js (no key, none of
// these send CORS headers, hence the function):
//   1. Yahoo Finance chart API, symbol JPY=X — query1 host, then the query2 mirror
//   2. CNBC quote service, symbol JPY=
//   3. Stooq CSV quote, symbol usdjpy
// The page falls back to the ECB rate (labelled as such) if this function fails.

const { parseCnbc, parseStooq, num } = require('./wti.js').__test;

const TIMEOUT_MS = 5000;
const TTL_S = 60;
// range=1d makes Yahoo put yesterday's close in meta.previousClose (FX daily bars start at
// midnight London, so "the bar before the last one" is not a reliable previous close).
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/JPY=X?interval=5m&range=1d';
const YAHOO2 = YAHOO.replace('//query1.', '//query2.');
const CNBC = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=JPY%3D&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';
const STOOQ = 'https://stooq.com/q/l/?s=usdjpy&f=sd2t2ohlcp&h&e=csv';
const RANGE = [50, 400];

let memCache = { data: null, expiresAt: 0, lastGood: null };

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

function sane(q) {
  if (!(q.price >= RANGE[0] && q.price <= RANGE[1])) throw new Error(`price ${q.price} outside ${RANGE.join('–')}`);
  if (q.prevClose != null && !(q.prevClose >= RANGE[0] && q.prevClose <= RANGE[1])) return { ...q, prevClose: null, pct: null };
  return q;
}

function parseYahooFx(text) {
  const res = JSON.parse(text).chart.result[0];
  const m = res.meta || {};
  const price = num(m.regularMarketPrice);
  let prev = num(m.previousClose);
  if (!isFinite(prev)) prev = num(m.chartPreviousClose);
  if (!isFinite(price) || price <= 0) throw new Error('no usable price');
  const pct = isFinite(prev) && prev > 0 ? Math.round((price - prev) / prev * 10000) / 100 : null;
  const asOf = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null;
  return { price, prevClose: isFinite(prev) ? prev : null, pct, asOf };
}

const SOURCES = [
  { name: 'yahoo:JPY=X', url: YAHOO, parse: parseYahooFx },
  { name: 'yahoo2:JPY=X', url: YAHOO2, parse: parseYahooFx },
  { name: 'cnbc:JPY=', url: CNBC, parse: parseCnbc },
  { name: 'stooq:usdjpy', url: STOOQ, parse: parseStooq }
];

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=600`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  const errors = {};
  for (const s of SOURCES) {
    try {
      const data = { ...sane(s.parse(await fetchText(s.url))), source: s.name };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { errors[s.name] = e.message; }
  }
  if (memCache.lastGood && now - memCache.expiresAt < 60 * 60 * 1000) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, stale: true }) };
  }
  return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'no source answered', errors }) };
};

module.exports.__test = { parseYahooFx, sane, SOURCES, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; } };
