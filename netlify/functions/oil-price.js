// Netlify Function: WTI oil price fallback via Alpha Vantage.
// The frontend tries Binance/OKX/Hyperliquid directly first (those are free, no-key, and
// CORS-friendly, so there's no reason to route them through a function). This function only
// runs if all of those fail, using ALPHAVANTAGE_API_KEY from Netlify's environment variables
// (never exposed to the browser).

let cache = { date: null, price: null };

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=3600'
  };

  const today = new Date().toISOString().slice(0, 10);
  if (cache.date === today && cache.price != null) {
    return { statusCode: 200, headers, body: JSON.stringify({ price: cache.price, cached: true }) };
  }

  const apiKey = process.env.ALPHAVANTAGE_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'ALPHAVANTAGE_API_KEY is not set in Netlify environment variables' })
    };
  }

  try {
    const url = `https://www.alphavantage.co/query?function=WTI&interval=daily&apikey=${apiKey}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Alpha Vantage HTTP ${r.status}`);
    const j = await r.json();
    const latest = j.data && j.data[0] && parseFloat(j.data[0].value);
    if (!latest || isNaN(latest)) throw new Error('No price in Alpha Vantage response');
    cache = { date: today, price: latest };
    return { statusCode: 200, headers, body: JSON.stringify({ price: latest }) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
