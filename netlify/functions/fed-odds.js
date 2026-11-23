// Netlify Function: prediction-market odds for the next FOMC decisions (Macro Map tab).
//
//   GET /.netlify/functions/fed-odds
//   → { kalshi: { meetings: [{ date, ticker, odds: { cut50, cut25, hold, hike25, hike50 }, volume }] },
//       polymarket: { meetings: [{ date, slug, odds, volume }] }, errors?, ttl, fetchedAt }
//
// Sources (public, no key):
//   • Kalshi    /trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&with_nested_markets=true
//               market tickers end in C26 (cut >25), C25, H0 (hold), H25, H26 (hike >25)
//   • Polymarket gamma public-search for "fed decision" → events whose slug starts "fed-decision-in-",
//               then /events?slug=… for prices. groupItemTitle: "50+ bps decrease" … "50+ bps increase"
// Each outcome's probability = bid/ask midpoint when both exist and the spread is ≤ 10¢, else the
// last trade; the buckets are then normalised to sum to 100%.

const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=KXFEDDECISION&status=open&with_nested_markets=true&limit=20';
const POLY_SEARCH = 'https://gamma-api.polymarket.com/public-search?q=fed%20decision&limit_per_type=20&events_status=active';
const POLY_EVENT = 'https://gamma-api.polymarket.com/events?slug=';
const TTL_S = 5 * 60;
const TIMEOUT_MS = 6000;
const MEETINGS = 3;

let memCache = { data: null, expiresAt: 0 };

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

const n = (v) => { const x = typeof v === 'string' ? parseFloat(v) : v; return typeof x === 'number' && isFinite(x) ? x : null; };
function price(bid, ask, last) {
  bid = n(bid); ask = n(ask); last = n(last);
  if (bid != null && ask != null && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  return last;
}
function normalise(raw) {
  const keys = Object.keys(raw).filter((k) => raw[k] != null && raw[k] >= 0);
  const sum = keys.reduce((s, k) => s + raw[k], 0);
  if (keys.length < 2 || sum <= 0) return null;
  const out = {};
  keys.forEach((k) => { out[k] = Math.round(raw[k] / sum * 1000) / 10; });
  return out;
}

const KALSHI_BUCKET = { C26: 'cut50', C25: 'cut25', H0: 'hold', H25: 'hike25', H26: 'hike50' };
function parseKalshi(j, now = Date.now()) {
  const events = (j && j.events) || [];
  return events
    .filter((e) => e.strike_date && Date.parse(e.strike_date) > now - 3600000 && Array.isArray(e.markets))
    .sort((a, b) => Date.parse(a.strike_date) - Date.parse(b.strike_date))
    .slice(0, MEETINGS)
    .map((e) => {
      const raw = {}; let volume = 0;
      e.markets.forEach((m) => {
        const k = KALSHI_BUCKET[String(m.ticker || '').split('-').pop()];
        if (!k) return;
        raw[k] = price(m.yes_bid_dollars, m.yes_ask_dollars, m.last_price_dollars);
        volume += n(m.volume_fp) || 0;
      });
      return { date: e.strike_date.slice(0, 10), ticker: e.event_ticker, odds: normalise(raw), volume: Math.round(volume) };
    })
    .filter((m) => m.odds);
}

function polyBucket(title) {
  const t = String(title || '').toLowerCase();
  if (/no change|maintain/.test(t)) return 'hold';
  const big = /50\+|>\s*25|50 bps|75/.test(t);
  if (/decrease|cut/.test(t)) return big ? 'cut50' : 'cut25';
  if (/increase|hike/.test(t)) return big ? 'hike50' : 'hike25';
  return null;
}
function parsePolyEvent(ev) {
  const raw = {};
  (ev.markets || []).forEach((m) => {
    if (m.closed) return;
    const k = polyBucket(m.groupItemTitle);
    if (!k) return;
    let last = m.lastTradePrice;
    try { const op = JSON.parse(m.outcomePrices || '[]'); if (op.length) last = op[0]; } catch (e) { /* keep lastTradePrice */ }
    raw[k] = price(m.bestBid, m.bestAsk, last);
  });
  return { date: String(ev.endDate || '').slice(0, 10), slug: ev.slug, odds: normalise(raw), volume: Math.round(n(ev.volume) || 0) };
}
function pickPolyEvents(search, now = Date.now()) {
  return ((search && search.events) || [])
    .filter((e) => /^fed-decision-in-/.test(e.slug || '') && !e.closed && e.endDate && Date.parse(e.endDate) > now)
    .sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate))
    .slice(0, MEETINGS);
}

async function buildPayload() {
  const errors = {};
  const out = {};
  const [k, p] = await Promise.allSettled([
    getJson(KALSHI).then((j) => parseKalshi(j)),
    getJson(POLY_SEARCH).then(async (s) => {
      const picks = pickPolyEvents(s);
      const evs = await Promise.all(picks.map((e) => getJson(POLY_EVENT + encodeURIComponent(e.slug)).then((a) => a[0]).catch(() => e)));
      return evs.filter(Boolean).map(parsePolyEvent).filter((m) => m.odds);
    })
  ]);
  if (k.status === 'fulfilled' && k.value.length) out.kalshi = { meetings: k.value }; else errors.kalshi = k.status === 'rejected' ? k.reason.message : 'no open meetings';
  if (p.status === 'fulfilled' && p.value.length) out.polymarket = { meetings: p.value }; else errors.polymarket = p.status === 'rejected' ? p.reason.message : 'no open meetings';
  return { out, errors };
}

exports.handler = async function () {
  const now = Date.now();
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' };
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=60, s-maxage=${TTL_S}` }, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const { out, errors } = await buildPayload();
    if (!out.kalshi && !out.polymarket) throw new Error(`both markets failed: ${JSON.stringify(errors)}`);
    const data = { ...out, fetchedAt: new Date().toISOString(), ttl: TTL_S };
    if (Object.keys(errors).length) data.errors = errors;
    memCache = { data, expiresAt: now + TTL_S * 1000 };
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=60, s-maxage=${TTL_S}` }, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.data) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=60' }, body: JSON.stringify({ ...memCache.data, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { parseKalshi, parsePolyEvent, pickPolyEvents, polyBucket, price, normalise, _clearCache: () => { memCache = { data: null, expiresAt: 0 }; } };
