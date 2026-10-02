// Netlify Function: Thai gold prices (baht per baht-weight, 96.5%) as announced by the Gold
// Traders Association of Thailand (สมาคมค้าทองคำ).
//
//   GET /.netlify/functions/gold-th
//   → { barBuy, barSell, ornamentBuy, ornamentSell, updated, source }
//
// Sources, in order:
//   1. goldtraders.or.th — the association's own page (server-rendered ASP.NET; the prices sit in
//      spans whose ids end in lblBLBuy / lblBLSell / lblOMBuy / lblOMSell).
//   2. api.chnwt.dev thai-gold-api — a community JSON mirror of the same announcement.
// The page shows its own estimate from world gold × USD/THB if this function fails, so a 502
// here only means "no official number right now", never a blank card.

const SOURCES = [
  { name: 'goldtraders', url: 'https://www.goldtraders.or.th/', parse: parseGoldtraders },
  { name: 'chnwt', url: 'https://api.chnwt.dev/thai-gold-api/latest', parse: parseChnwt }
];
const TIMEOUT_MS = 6000;
const TTL_S = 10 * 60; // the association re-announces several times a day on volatile days

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)', Accept: 'text/html,application/json,*/*', 'Accept-Language': 'th,en;q=0.8' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

const num = (s) => {
  const v = parseFloat(String(s == null ? '' : s).replace(/[^\d.]/g, ''));
  return isFinite(v) ? v : null;
};
// Thai bar gold trades roughly 20k–200k baht per baht-weight; anything else is a parse error.
const plausible = (v) => v != null && v > 10000 && v < 500000;

function validate(out) {
  if (!plausible(out.barBuy) || !plausible(out.barSell)) throw new Error('no plausible bar price');
  if (out.barSell < out.barBuy) throw new Error('sell below buy — parse error');
  if (!plausible(out.ornamentSell)) out.ornamentSell = null;
  if (!plausible(out.ornamentBuy)) out.ornamentBuy = null;
  return out;
}

function parseGoldtraders(html) {
  const pick = (suffix) => {
    const m = new RegExp(`id="[^"]*${suffix}"[^>]*>\\s*([^<]+?)\\s*<`, 'i').exec(html);
    return m ? m[1] : null;
  };
  const updated = (pick('lblAsTime') || pick('lblAsDate') || '').trim() || null;
  return validate({
    barBuy: num(pick('lblBLBuy')),
    barSell: num(pick('lblBLSell')),
    ornamentBuy: num(pick('lblOMBuy')),
    ornamentSell: num(pick('lblOMSell')),
    updated
  });
}

function parseChnwt(text) {
  const j = JSON.parse(text);
  const r = (j && (j.response || j.data)) || {};
  const p = r.price || {};
  const bar = p.gold_bar || p.goldBar || {};
  const orn = p.gold || p.ornament || {};
  return validate({
    barBuy: num(bar.buy),
    barSell: num(bar.sell),
    ornamentBuy: num(orn.buy),
    ornamentSell: num(orn.sell),
    updated: [r.date, r.update_time].filter(Boolean).join(' ') || null
  });
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=3600`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  const errors = {};
  for (const s of SOURCES) {
    try {
      const data = { ...s.parse(await fetchText(s.url)), source: s.name, fetchedAt: new Date().toISOString() };
      memCache = { data, expiresAt: now + TTL_S * 1000, lastGood: data };
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) { errors[s.name] = e.message; }
  }
  if (memCache.lastGood) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, stale: true }) };
  }
  return { statusCode: 502, headers, body: JSON.stringify({ error: 'no source answered', errors }) };
};

module.exports.__test = { parseGoldtraders, parseChnwt, num };
