// Netlify Function: BTC options positioning from Deribit, for the ₿ tab.
//
//   GET /.netlify/functions/options-gex
//   → { at, spot, gex: { total, byStrike, zeroGamma, callWall, putWall, curve, flows, expiries },
//       rr: { cm: { '7': {...}, '30': {...}, '90': {...} }, expiries: [...], hist: [[ts, rr30], ...] }, source }
//
// One public Deribit call (get_book_summary_by_currency, kind=option, no key) gives every listed BTC
// option with its open interest, mark IV and forward price. Greeks come from Black-76 on that
// forward with the mark IV (Deribit quotes options on the forward, so r = 0).
//
// GEX uses the standard convention (SqueezeMetrics / SpotGamma): customers mostly sell calls
// (covered calls, yield) and buy puts (protection), so dealers are LONG calls and SHORT puts.
// Call gamma counts +, put gamma counts −. It is a model of who holds what, not a ledger.
//   GEX($ per 1% move) = Σ sign × gamma × OI(BTC) × F² × 0.01
// Zero gamma = the spot where total GEX changes sign: above it dealers hedge against the move
// (sell rallies, buy dips, damping); below it they hedge with the move (amplifying).
// Hedge flow for a ±x% move = −(dealer delta after − dealer delta now), BTC and USD (+ = dealers buy).
//
// 25-delta risk reversal per expiry = IV(25Δ call) − IV(25Δ put), read off each expiry's smile;
// constant 7/30/90-day values are interpolated in time. Negative = puts cost more (downside cover
// in demand), positive = calls cost more. A small history (one point per ~3h, 30 days) is kept in
// the last-good store so the card can show the change.

const TIMEOUT_MS = 8000;
const TTL_S = 300;
const URL_BOOK = 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option';
const YEAR_MS = 365 * 86400000;
const MIN_T_MS = 3600000;          // skip options expiring within the hour (gamma blows up, OI about to vanish)
const STRIKE_BAND = 0.35;          // byStrike: strikes within ±35% of spot
const CURVE = [-0.3, 0.3, 0.005];  // zero-gamma sweep: spot −30%…+30% in 0.5% steps
const FLOW_MOVES = [-0.10, -0.05, 0.05, 0.10];
const CM_DAYS = [7, 30, 90];
const HIST_EVERY_MS = 3 * 3600000;
const HIST_KEEP_MS = 30 * 86400000;
const MON = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

let memCache = { data: null, expiresAt: 0, lastGood: null };
let histMem = null; // [[ts, rr30], ...] — loaded from the store once per instance

function ncdf(x) {
  // Abramowitz–Stegun 7.1.26 via erf, |error| < 1.5e-7
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const npdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// Black-76 on the forward: call delta, put delta, gamma (per 1 USD of forward)
function greeks(F, K, sigma, T) {
  if (!(F > 0 && K > 0 && sigma > 0 && T > 0)) return null;
  const sT = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sT * sT) / sT;
  const nd = ncdf(d1);
  return { callDelta: nd, putDelta: nd - 1, gamma: npdf(d1) / (F * sT) };
}

// "BTC-26MAR27-85000-P" → { expiry: ms at 08:00 UTC, strike, type: 'C'|'P', code: '26MAR27' }
function parseInstrument(name) {
  const m = /^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:\.\d+)?)-([CP])$/.exec(String(name || ''));
  if (!m || !(m[2] in MON)) return null;
  return { expiry: Date.UTC(2000 + Number(m[3]), MON[m[2]], Number(m[1]), 8), strike: Number(m[4]), type: m[5], code: m[1] + m[2] + m[3] };
}

// Deribit rows → usable options (OI > 0, sane IV, not about to expire)
function parseBook(text, now) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  if (j && j.error) throw new Error('deribit: ' + (j.error.message || JSON.stringify(j.error)));
  const rows = (j && j.result) || [];
  const out = [];
  let spot = 0;
  for (const r of rows) {
    const p = parseInstrument(r && r.instrument_name);
    if (!p) continue;
    const T = (p.expiry - now) / YEAR_MS;
    const F = Number(r.underlying_price), iv = Number(r.mark_iv) / 100, oi = Number(r.open_interest);
    const idx = Number(r.estimated_delivery_price);
    if (idx > 0) spot = idx;
    if (!(T * YEAR_MS > MIN_T_MS) || !(F > 0) || !(iv > 0.05 && iv < 5)) continue;
    out.push({ ...p, T, F, iv, oi: oi > 0 ? oi : 0 });
  }
  if (out.length < 20) throw new Error('too few options (' + out.length + ')');
  if (!(spot > 0)) spot = out.reduce((a, o) => (o.T < a.T ? o : a)).F;
  return { options: out, spot };
}

// Dealer net gamma ($ per 1% move) and dealer delta (BTC) with every forward scaled by f
function dealerAt(options, f) {
  let gex = 0, delta = 0;
  for (const o of options) {
    if (!o.oi) continue;
    const F = o.F * f, g = greeks(F, o.strike, o.iv, o.T);
    if (!g) continue;
    const sign = o.type === 'C' ? 1 : -1; // dealers long calls, short puts
    gex += sign * g.gamma * o.oi * F * F * 0.01;
    delta += sign * (o.type === 'C' ? g.callDelta : g.putDelta) * o.oi;
  }
  return { gex, delta };
}

function computeGex(options, spot) {
  const byK = new Map();
  for (const o of options) {
    if (!o.oi || Math.abs(o.strike / spot - 1) > STRIKE_BAND) continue;
    const g = greeks(o.F, o.strike, o.iv, o.T);
    if (!g) continue;
    const v = g.gamma * o.oi * o.F * o.F * 0.01;
    const row = byK.get(o.strike) || { k: o.strike, call: 0, put: 0, callOi: 0, putOi: 0 };
    if (o.type === 'C') { row.call += v; row.callOi += o.oi; } else { row.put -= v; row.putOi += o.oi; }
    byK.set(o.strike, row);
  }
  const byStrike = [...byK.values()].sort((a, b) => a.k - b.k).map((r) => ({ k: r.k, call: Math.round(r.call), put: Math.round(r.put), net: Math.round(r.call) + Math.round(r.put), callOi: Math.round(r.callOi * 10) / 10, putOi: Math.round(r.putOi * 10) / 10 }));

  const curve = [];
  for (let m = CURVE[0]; m <= CURVE[1] + 1e-9; m += CURVE[2]) {
    const mv = Math.round(m * 1000) / 1000;
    curve.push([Math.round(spot * (1 + mv)), Math.round(dealerAt(options, 1 + mv).gex)]);
  }
  // zero gamma: the sign change in the curve closest to spot, linearly interpolated
  let zeroGamma = null, best = Infinity;
  for (let i = 1; i < curve.length; i++) {
    const [p0, g0] = curve[i - 1], [p1, g1] = curve[i];
    if (g0 === 0 || (g0 < 0) === (g1 < 0)) continue;
    const z = p0 + (p1 - p0) * (g0 / (g0 - g1));
    if (Math.abs(z - spot) < best) { best = Math.abs(z - spot); zeroGamma = Math.round(z); }
  }

  const now0 = dealerAt(options, 1);
  const flows = FLOW_MOVES.map((mv) => {
    const d = dealerAt(options, 1 + mv).delta - now0.delta;
    const btc = -d; // the hedge moves against the dealer's delta change
    return { move: mv, price: Math.round(spot * (1 + mv)), btc: Math.round(btc), usd: Math.round(btc * spot * (1 + mv)) };
  });

  // walls: the strike above spot with the most call gamma, and below spot with the most put gamma
  const cw = byStrike.filter((r) => r.k >= spot).reduce((a, r) => (!a || r.call > a.call ? r : a), null);
  const pw = byStrike.filter((r) => r.k <= spot).reduce((a, r) => (!a || r.put < a.put ? r : a), null);

  // how much of today's gamma each expiry carries (top 6)
  const byExp = new Map();
  for (const o of options) {
    if (!o.oi) continue;
    const g = greeks(o.F, o.strike, o.iv, o.T);
    if (!g) continue;
    const v = (o.type === 'C' ? 1 : -1) * g.gamma * o.oi * o.F * o.F * 0.01;
    const e = byExp.get(o.code) || { code: o.code, expiry: o.expiry, net: 0, abs: 0, oi: 0 };
    e.net += v; e.abs += Math.abs(v); e.oi += o.oi;
    byExp.set(o.code, e);
  }
  const absAll = [...byExp.values()].reduce((s, e) => s + e.abs, 0) || 1;
  const expiries = [...byExp.values()].sort((a, b) => b.abs - a.abs).slice(0, 6)
    .map((e) => ({ code: e.code, expiry: new Date(e.expiry).toISOString(), net: Math.round(e.net), share: Math.round(e.abs / absAll * 1000) / 10, oi: Math.round(e.oi) }));

  return {
    total: Math.round(now0.gex),
    dealerDelta: Math.round(now0.delta),
    zeroGamma,
    callWall: cw && cw.call > 0 ? cw.k : null,
    putWall: pw && pw.put < 0 ? pw.k : null,
    byStrike, curve, flows, expiries
  };
}

// IV at a target delta on one side of one expiry's smile (linear in delta between listed strikes)
function ivAtDelta(points, target) {
  const pts = points.filter((p) => isFinite(p.d)).sort((a, b) => a.d - b.d);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (target >= a.d && target <= b.d) return b.d === a.d ? a.iv : a.iv + (b.iv - a.iv) * (target - a.d) / (b.d - a.d);
  }
  return null;
}

function computeRr(options, now) {
  const groups = new Map();
  for (const o of options) {
    const g = greeks(o.F, o.strike, o.iv, o.T);
    if (!g) continue;
    const e = groups.get(o.code) || { code: o.code, expiry: o.expiry, T: o.T, F: o.F, calls: [], puts: [] };
    (o.type === 'C' ? e.calls : e.puts).push({ k: o.strike, d: o.type === 'C' ? g.callDelta : g.putDelta, iv: o.iv * 100 });
    groups.set(o.code, e);
  }
  const rows = [];
  for (const e of [...groups.values()].sort((a, b) => a.expiry - b.expiry)) {
    const days = (e.expiry - now) / 86400000;
    if (days < 1.5 || e.calls.length < 4 || e.puts.length < 4) continue;
    const c25 = ivAtDelta(e.calls, 0.25), p25 = ivAtDelta(e.puts, -0.25);
    const atm = ivAtDelta(e.calls, 0.5);
    if (c25 == null || p25 == null) continue;
    rows.push({ code: e.code, expiry: new Date(e.expiry).toISOString(), days: Math.round(days * 10) / 10, call25: r2(c25), put25: r2(p25), atm: atm == null ? null : r2(atm), rr: r2(c25 - p25) });
  }
  const cm = {};
  for (const d of CM_DAYS) {
    let lo = null, hi = null;
    for (const r of rows) { if (r.days <= d) lo = r; if (r.days >= d && !hi) hi = r; }
    const a = lo || hi, b = hi || lo;
    if (!a) continue;
    const w = a === b || b.days === a.days ? 0 : (d - a.days) / (b.days - a.days);
    const mix = (k) => (a[k] == null || b[k] == null ? null : r2(a[k] + (b[k] - a[k]) * w));
    cm[d] = { rr: mix('rr'), call25: mix('call25'), put25: mix('put25'), atm: mix('atm'), from: a === b ? [a.code] : [a.code, b.code] };
  }
  return { cm, expiries: rows };
}
function r2(x) { return Math.round(x * 100) / 100; }

function compute(text, now) {
  const { options, spot } = parseBook(text, now);
  return { at: new Date(now).toISOString(), spot: Math.round(spot), count: options.length, gex: computeGex(options, spot), rr: computeRr(options, now) };
}

// keep one rr30 point per HIST_EVERY_MS for HIST_KEEP_MS
function addHist(hist, now, rr30) {
  const h = (Array.isArray(hist) ? hist : []).filter((p) => Array.isArray(p) && now - p[0] <= HIST_KEEP_MS && isFinite(p[1]));
  if (rr30 == null || !isFinite(rr30)) return h;
  if (!h.length || now - h[h.length - 1][0] >= HIST_EVERY_MS) h.push([now, rr30]);
  return h;
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(timer); }
}

const { kvGetGood, kvPutGood } = require('../lib/last-good.js');
const KV_KEY = 'options-gex:lastGood';

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=900`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  let stored;
  if (histMem == null) { stored = await kvGetGood(event, KV_KEY, 0); histMem = (stored && stored.rr && stored.rr.hist) || []; }
  try {
    const data = { ...compute(await fetchText(URL_BOOK), now), source: 'deribit' };
    const rr30 = data.rr.cm[30] && data.rr.cm[30].rr;
    histMem = addHist(histMem, now, rr30);
    data.rr.hist = histMem;
    memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
    await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    const good = (memCache.lastGood && now - memCache.expiresAt < 21600000) ? memCache.lastGood
      : (stored !== undefined ? (stored && now - Date.parse(stored.at) < 21600000 ? stored : null) : await kvGetGood(event, KV_KEY, 21600000));
    if (good) return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=60, s-maxage=60' }, body: JSON.stringify({ ...good, stale: true }) };
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { ncdf, greeks, parseInstrument, parseBook, dealerAt, computeGex, ivAtDelta, computeRr, compute, addHist, _clear: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; histMem = null; } };
