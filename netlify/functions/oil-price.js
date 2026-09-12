// Netlify Function: WTI oil price fallback via Alpha Vantage.
// The frontend tries Binance (CLUSDT) / OKX (CL-USDT-SWAP) / Hyperliquid (XYZ:CL-USD) directly
// first — those are free, keyless and CORS-friendly, so there's no reason to proxy them. This
// function only runs if all of those fail, using ALPHAVANTAGE_API_KEY from Netlify's environment
// variables (never exposed to the browser).
//
// Two things the old version got wrong (fixed Sep 2026):
//   • no timeout: a stalled Alpha Vantage response held the invocation open until Netlify's 10s
//     limit, so the page sat on "ลองฟรีหมดแล้ว กำลังดึง WTI ผ่านเซิร์ฟเวอร์…" and then failed anyway.
//   • the upstream's own explanation was thrown away. Alpha Vantage answers HTTP 200 with
//     {"Note": "…25 requests/day…"} or {"Information": "…premium endpoint…"} — that looks like
//     success to `r.ok` and used to surface as the useless "No price in Alpha Vantage response".
//     Those messages are now echoed back so the failure is diagnosable from the browser.

const TIMEOUT_MS = 8000;
let cache = { date: null, price: null, source: null };

async function fetchJsonWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // Daily data + a 25-requests/day free tier: cache hard in the browser/CDN as well.
    'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=86400'
  };

  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.price != null) {
    return { statusCode: 200, headers, body: JSON.stringify({ price: cache.price, source: cache.source, cached: true }) };
  }

  const apiKey = (process.env.ALPHAVANTAGE_API_KEY || '').trim();
  if (!apiKey) {
    return {
      statusCode: 503,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'ALPHAVANTAGE_API_KEY is not set in Netlify environment variables',
        hint: 'Optional: WTI is normally read from Binance/OKX/Hyperliquid with no key at all. Set the key only if you want this server-side fallback.',
        retryAfterSeconds: 0
      })
    };
  }

  try {
    const url = `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
    const j = await fetchJsonWithTimeout(url, TIMEOUT_MS);

    // Alpha Vantage reports rate limits / plan problems inside a 200 response.
    const upstreamMsg = j && (j.Note || j.Information || j['Error Message']);
    if (upstreamMsg) throw new Error(String(upstreamMsg).replace(/\s+/g, ' ').slice(0, 200));

    const entry = j && Array.isArray(j.data) ? j.data[0] : null;
    const latest = entry ? parseFloat(entry.value) : NaN;
    if (!isFinite(latest) || latest <= 0) throw new Error('no usable price in the Alpha Vantage response');

    cache = { date: today, price: latest, source: 'alphavantage:WTI' };
    return { statusCode: 200, headers, body: JSON.stringify({ price: latest, asOf: entry.date || today, source: cache.source }) };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return {
      statusCode: 502,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: aborted ? `Alpha Vantage timed out after ${TIMEOUT_MS / 1000}s` : e.message,
        retryAfterSeconds: 300
      })
    };
  }
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = { _cache: () => cache };
