// Netlify Function: fetches Fed Funds Rate, CPI (YoY), and Unemployment Rate from FRED.
// The FRED API key lives ONLY in Netlify's environment variables (Site settings > Environment
// variables > FRED_API_KEY) — it never reaches the browser or the page source, and visitors
// can't see or change it.
//
// Also caches the result in memory for this function instance (resets on cold start, which is
// fine since we still want at most ~1 real FRED call per day; the frontend also caches in
// localStorage so most visitors won't even trigger this function to re-fetch).

let cache = { date: null, data: null };

const SERIES = {
  upper: 'DFEDTARU',
  lower: 'DFEDTARL',
  effr: 'FEDFUNDS',
  unrate: 'UNRATE'
};

async function fetchSeries(seriesId, apiKey, units) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
    (units ? `&units=${units}` : '') +
    `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=1`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${seriesId}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error_message) throw new Error(`${seriesId}: FRED error — ${j.error_message}`);
  const obs = j.observations && j.observations[0];
  if (!obs) throw new Error(`${seriesId}: no observation in response`);
  return { value: parseFloat(obs.value), date: obs.date };
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600' // browsers/CDN may cache for 1 hour too
  };

  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.data) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...cache.data, cached: true }) };
  }

  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'FRED_API_KEY is not set in Netlify environment variables' })
    };
  }

  try {
    const [upper, lower, effr, cpi, unrate] = await Promise.all([
      fetchSeries(SERIES.upper, apiKey),
      fetchSeries(SERIES.lower, apiKey),
      fetchSeries(SERIES.effr, apiKey),
      fetchSeries('CPIAUCSL', apiKey, 'pc1'),
      fetchSeries(SERIES.unrate, apiKey)
    ]);
    const data = { upper, lower, effr, cpi, unrate, fetchedAt: new Date().toISOString() };
    cache = { date: today, data };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
