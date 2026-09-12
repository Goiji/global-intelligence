// Netlify Function: fetches Fed Funds Rate, CPI (YoY), and Unemployment Rate from FRED.
// The FRED API key lives ONLY in Netlify's environment variables (Site settings > Environment
// variables > FRED_API_KEY) — it never reaches the browser or the page source, and visitors
// can't see or change it.
//
// Also caches the result in memory for this function instance (resets on cold start, which is
// fine since we still want at most ~1 real FRED call per day; the frontend also caches in
// localStorage so most visitors won't even trigger this function to re-fetch).
//
// CPI NOTE (bug fix, Sep 2026): CPI YoY used to be fetched as
//   CPIAUCSL + units=pc1 + limit=1 + sort_order=desc
// That single transformed observation can come back as "." (FRED's literal string for
// "missing") — e.g. when the transform has no year-ago value inside the limited window.
// parseFloat(".") is NaN, JSON turns NaN into null, and the frontend's `cpi.value.toFixed()`
// then threw — which aborted the whole update, so CPI (and everything after it) looked
// "stuck" forever. Fix: fetch raw CPI *levels* (no transform) and compute YoY ourselves
// from the latest vs 12-months-ago observations, skipping any "." entries. The FRED-side
// pc1 transform is kept only as a fallback.

let cache = { date: null, data: null };

const SERIES = {
  upper: 'DFEDTARU',
  lower: 'DFEDTARL',
  effr: 'FEDFUNDS',
  unrate: 'UNRATE',
  cpiLevel: 'CPIAUCSL'
};

function isNumericObs(obs) {
  if (!obs || obs.value === '.' || obs.value == null) return false;
  const v = parseFloat(obs.value);
  return !isNaN(v) && isFinite(v);
}

async function fetchObservations(seriesId, apiKey, { units, limit = 5 } = {}) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}` +
    (units ? `&units=${units}` : '') +
    `&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${seriesId}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error_message) throw new Error(`${seriesId}: FRED error — ${j.error_message}`);
  const observations = j.observations || [];
  if (!observations.length) throw new Error(`${seriesId}: no observations in response`);
  return observations;
}

// Latest numeric observation, skipping "." / non-numeric entries.
async function fetchLatestNumeric(seriesId, apiKey, units) {
  const observations = await fetchObservations(seriesId, apiKey, { units, limit: 5 });
  const obs = observations.find(isNumericObs);
  if (!obs) throw new Error(`${seriesId}: latest observations are all missing (".")`);
  return { value: parseFloat(obs.value), date: obs.date };
}

// CPI YoY computed locally from raw levels: (latest - 12moAgo) / 12moAgo * 100.
// Needs ~13+ numeric monthly observations, so we fetch 24 to be safe against gaps.
async function fetchCpiYoy(apiKey) {
  let levelObs;
  try {
    const observations = await fetchObservations(SERIES.cpiLevel, apiKey, { limit: 24 });
    levelObs = observations.filter(isNumericObs);
  } catch (e) {
    levelObs = [];
  }

  if (levelObs.length >= 13) {
    const latest = levelObs[0];
    const yearAgo = levelObs[12]; // 12 monthly observations back ≈ same month last year
    const latestVal = parseFloat(latest.value);
    const yearAgoVal = parseFloat(yearAgo.value);
    if (yearAgoVal !== 0) {
      const yoy = ((latestVal - yearAgoVal) / yearAgoVal) * 100;
      if (!isNaN(yoy) && isFinite(yoy)) {
        return {
          value: yoy,
          date: latest.date,
          level: latestVal,
          yearAgoLevel: yearAgoVal,
          yearAgoDate: yearAgo.date,
          method: 'computed-from-levels'
        };
      }
    }
  }

  // Fallback: ask FRED to do the YoY transform, but take the first NUMERIC row out of
  // several (never blindly trust observations[0], which may be ".").
  const pc1Obs = await fetchObservations(SERIES.cpiLevel, apiKey, { units: 'pc1', limit: 5 });
  const good = pc1Obs.find(isNumericObs);
  if (!good) {
    throw new Error(
      `CPIAUCSL: could not compute YoY (only ${levelObs.length} numeric levels, need 13+) ` +
      `and FRED pc1 fallback also returned only missing values`
    );
  }
  return { value: parseFloat(good.value), date: good.date, method: 'fred-pc1-fallback' };
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

  // Fetch each series independently — one bad series (historically: CPI) must never
  // take down the whole response again. Partial data + per-field errors instead.
  const results = await Promise.allSettled([
    fetchLatestNumeric(SERIES.upper, apiKey),
    fetchLatestNumeric(SERIES.lower, apiKey),
    fetchLatestNumeric(SERIES.effr, apiKey),
    fetchCpiYoy(apiKey),
    fetchLatestNumeric(SERIES.unrate, apiKey)
  ]);

  const keys = ['upper', 'lower', 'effr', 'cpi', 'unrate'];
  const data = { fetchedAt: new Date().toISOString() };
  const errors = {};
  results.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      data[keys[i]] = res.value;
    } else {
      errors[keys[i]] = (res.reason && res.reason.message) || String(res.reason);
    }
  });

  if (Object.keys(errors).length) data.errors = errors;

  const okCount = keys.filter((k) => data[k]).length;
  if (okCount === 0) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'All FRED series failed', errors })
    };
  }

  cache = { date: today, data };
  return { statusCode: 200, headers, body: JSON.stringify(data) };
};
