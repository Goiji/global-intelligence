// Netlify Function: Bitcoin on-chain metrics (NUPL / MVRV Z-Score / MVRV Ratio) via BGeometrics.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (Sep 2026)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The BTC tab used to call api.bgeometrics.com straight from the browser. That endpoint does not
// send CORS headers, so every attempt actually had to go through a free third-party proxy
// (api.allorigins.win) — and when that proxy is down or rate-limits, the metrics card silently
// falls back to "ใช้ค่าเก่า" / manual entry. Two more problems with the old setup:
//   • The anonymous BGeometrics quota is per IP: 8 requests/hour and 15/day. Each visitor burned
//     their own, plus every metric cost TWO upstream hits (the doomed direct call, then the proxy
//     call), and the free proxy has its own limits on top.
//   • api.bgeometrics.com returns a small JSON object, but the browser had to guess which field
//     held the number (`extractLatestValue` skipped anything matching /date|time|unix/).
// Server-side there is no CORS at all, so this function calls BGeometrics directly, picks the
// value out itself, and caches the result in memory for 8 hours — one upstream call serves every
// visitor. An optional BGEOMETRICS_TOKEN env var raises the quota for the whole site (set it once
// in Netlify; visitors no longer need to paste a token into the page).
//
// Usage: /.netlify/functions/onchain?metric=nupl|mvrv-zscore|mvrv

const API = 'https://api.bgeometrics.com/v1/';
const TIMEOUT_MS = 7000;
const TTL_MS = 8 * 60 * 60 * 1000; // these metrics only change ~once a day at the source

// Whitelist — the query string must never be able to reach an arbitrary upstream path.
const METRICS = {
  'nupl': ['nupl', 'nupl/last'],
  'mvrv-zscore': ['mvrv-zscore', 'mvrv-zscore/last', 'mvrv-z-score'],
  'mvrv': ['mvrv', 'mvrv/last']
};

// In-memory cache, one entry per metric. Cold starts simply refetch — the CDN cache (below)
// absorbs the bursts.
const memCache = {};

function inRange(v) {
  return typeof v === 'number' && isFinite(v) && v > -100 && v < 1000;
}

// Pull the metric out of whatever shape BGeometrics answers with. Kept as a pure function so it
// can be unit-tested without the network. Field preference is explicit first, then "first numeric
// field that is not a timestamp".
function extractValue(json) {
  let item = json;
  if (Array.isArray(item)) item = item[item.length - 1];
  else if (item && Array.isArray(item.data)) item = item.data[item.data.length - 1];
  else if (item && item.data && typeof item.data === 'object' && !Array.isArray(item.data)) item = item.data;
  if (item == null) return null;
  if (typeof item !== 'object') {
    const v = parseFloat(item);
    return isFinite(v) ? v : null;
  }
  for (const key of ['value', 'last', 'close', 'y', 'current', 'nupl', 'mvrv', 'zscore', 'z_score']) {
    if (item[key] !== undefined) {
      const v = parseFloat(item[key]);
      if (isFinite(v)) return v;
    }
  }
  for (const key of Object.keys(item)) {
    if (/date|time|unix|timestamp/i.test(key)) continue;
    const v = parseFloat(item[key]);
    if (isFinite(v)) return v;
  }
  return null;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'global-intelligence-dashboard (netlify function)', Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  const metric = String((event && event.queryStringParameters && event.queryStringParameters.metric) || '').toLowerCase();
  const slugs = METRICS[metric];

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=1800, s-maxage=1800, stale-while-revalidate=86400'
  };

  if (!slugs) {
    return {
      statusCode: 400,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'unknown metric', allowed: Object.keys(METRICS) })
    };
  }

  const hit = memCache[metric];
  if (hit && (Date.now() - hit.at) < TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...hit.payload, cached: true }) };
  }

  const token = (process.env.BGEOMETRICS_TOKEN || '').trim();
  const trail = [];

  for (const slug of slugs) {
    const url = `${API}${slug}` + (token ? `?token=${encodeURIComponent(token)}` : '');
    try {
      const json = await fetchWithTimeout(url, TIMEOUT_MS);
      const value = extractValue(json);
      if (value == null) throw new Error('no numeric value in response');
      if (!inRange(value)) throw new Error(`implausible value ${value}`);
      const payload = {
        metric,
        value,
        slug,
        source: 'bgeometrics',
        tokenConfigured: !!token,
        fetchedAt: new Date().toISOString()
      };
      memCache[metric] = { at: Date.now(), payload };
      return { statusCode: 200, headers, body: JSON.stringify(payload) };
    } catch (e) {
      trail.push(`${slug}: ${e.message}`);
    }
  }

  // Serve the last good value rather than an error — the page has its own localStorage cache and
  // a manual-entry fallback, so a 502 here just means "keep showing what you had".
  if (hit) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...hit.payload, stale: true, staleReason: trail.join(' | '), lastGoodAt: new Date(hit.at).toISOString() })
    };
  }

  return {
    statusCode: 502,
    headers: { ...headers, 'Cache-Control': 'no-store' },
    body: JSON.stringify({
      error: 'all BGeometrics endpoints failed',
      details: trail,
      hint: 'Free anonymous quota is 8 requests/hour and 15/day per IP. Setting the optional BGEOMETRICS_TOKEN env var raises it for the whole site.'
    })
  };
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = { extractValue, METRICS, _clearCache: () => { Object.keys(memCache).forEach((k) => delete memCache[k]); } };
