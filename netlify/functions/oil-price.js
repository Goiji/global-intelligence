// Netlify Function: WTI oil price fallback via FRED public CSV or Alpha Vantage.
// The frontend tries free sources directly first. If those fail, this function provides
// reliable server-side fetching using keyless FRED (DCOILWTICO) or ALPHAVANTAGE_API_KEY.

let cache = { date: null, price: null, source: null };

function parseFredOilCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 1; i--) {
    const parts = lines[i].split(',');
    const raw = (parts[1] || '').trim().replace(/^"|"$/g, '').replace(/,/g, '');
    if (!raw || raw === '.' || raw === '-') continue;
    const value = parseFloat(raw);
    if (isFinite(value) && value > 0 && value < 500) {
      return { price: value, date: parts[0].trim() };
    }
  }
  return null;
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600'
  };

  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.price != null) {
    return { statusCode: 200, headers, body: JSON.stringify({ price: cache.price, source: cache.source, cached: true }) };
  }

  const errors = [];

  // 1) Try keyless official FRED public CSV (Crude Oil Prices: West Texas Intermediate)
  try {
    const r = await fetch('https://fred.stlouisfed.org/graph/fredgraph.csv?id=DCOILWTICO', {
      headers: { 'User-Agent': 'global-intelligence-dashboard (oil-price)', Accept: '*/*' }
    });
    if (r.ok) {
      const text = await r.text();
      const hit = parseFredOilCsv(text);
      if (hit && hit.price) {
        cache = { date: today, price: hit.price, source: 'FRED (DCOILWTICO)' };
        return { statusCode: 200, headers, body: JSON.stringify({ price: hit.price, date: hit.date, source: cache.source }) };
      }
    } else {
      errors.push(`FRED HTTP ${r.status}`);
    }
  } catch (e) {
    errors.push(`FRED: ${e.message}`);
  }

  // 2) Try Alpha Vantage if API key is provided
  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (apiKey) {
    try {
      const url = `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${encodeURIComponent(apiKey)}`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
      const j = await r.json();
      const latest = j.data && j.data[0] && parseFloat(j.data[0].value);
      if (!latest || isNaN(latest)) throw new Error('No price in Alpha Vantage response');
      cache = { date: today, price: latest, source: 'Alpha Vantage' };
      return { statusCode: 200, headers, body: JSON.stringify({ price: latest, source: cache.source }) };
    } catch (e) {
      errors.push(`Alpha Vantage: ${e.message}`);
    }
  }

  return {
    statusCode: 502,
    headers,
    body: JSON.stringify({ error: 'Failed to fetch oil price', details: errors })
  };
};
