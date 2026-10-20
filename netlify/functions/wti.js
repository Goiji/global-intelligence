// Netlify Function: the real WTI price — NYMEX crude oil futures (CL), front month.
//
//   GET /.netlify/functions/wti
//   → { price, prevClose, pct, asOf, source }
//
// The card used to read CLUSDT / CL-USDT-SWAP perpetuals on crypto exchanges. Those track CL but
// trade on their own order books (and through NYMEX's weekend close), so they drift from the WTI
// number the news quotes. Neither source below sends CORS headers, hence the function.
// Sources, in order (both delayed ~10 min by the exchange, no key):
//   1. Yahoo Finance chart API, symbol CL=F (continuous front month)
//   2. CNBC quote service, symbol @CL.1 (front month)
// The page falls back to the crypto perpetuals (labelled as such) if this function fails.

const TIMEOUT_MS = 5000;
const TTL_S = 60;
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=5d';
const CNBC = 'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=%40CL.1&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json';

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

const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[,%+\s]/g, ''));
  return isFinite(n) ? n : NaN;
};

function finish(price, prevClose, asOf) {
  if (!isFinite(price) || price <= 0) throw new Error('no usable price');
  const pct = isFinite(prevClose) && prevClose > 0 ? Math.round((price - prevClose) / prevClose * 10000) / 100 : null;
  return { price, prevClose: isFinite(prevClose) ? prevClose : null, pct, asOf: asOf || null };
}

// Daily bars: the last bar is the current session, so yesterday's settle is the bar before it —
// unless the last bar is already a finished day older than regularMarketTime's session.
function parseYahoo(text) {
  const res = JSON.parse(text).chart.result[0];
  const m = res.meta || {};
  const price = num(m.regularMarketPrice);
  const ts = res.timestamp || [];
  const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0]) || {}).close || [];
  const bars = ts.map((t, i) => [t, closes[i]]).filter((b) => isFinite(b[1]) && b[1] != null);
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  let prev = NaN;
  if (bars.length) {
    const last = bars[bars.length - 1];
    if (m.regularMarketTime && day(last[0]) !== day(m.regularMarketTime)) prev = last[1];
    else if (bars.length >= 2) prev = bars[bars.length - 2][1];
  }
  if (!isFinite(prev)) prev = num(m.previousClose);
  const asOf = m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null;
  return finish(price, prev, asOf);
}

function parseCnbc(text) {
  const j = JSON.parse(text);
  const q = j.FormattedQuoteResult.FormattedQuote[0];
  return finish(num(q.last), num(q.previous_day_closing), q.last_time || null);
}

const SOURCES = [
  { name: 'yahoo:CL=F', url: YAHOO, parse: parseYahoo },
  { name: 'cnbc:@CL.1', url: CNBC, parse: parseCnbc }
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
      const data = { ...s.parse(await fetchText(s.url)), source: s.name };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { errors[s.name] = e.message; }
  }
  // A last good price up to an hour old beats dropping to the crypto proxies.
  if (memCache.lastGood && now - memCache.expiresAt < 60 * 60 * 1000) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, stale: true }) };
  }
  return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'no source answered', errors }) };
};

module.exports.__test = { parseYahoo, parseCnbc, num };
