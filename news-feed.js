// Netlify Function: fetches one Google News RSS feed via rss2json, using RSS2JSON_API_KEY from
// Netlify's environment variables so every visitor shares your higher quota instead of the
// public anonymous limit — and the key itself never reaches the browser.
//
// Usage from the frontend: /.netlify/functions/news-feed?q=<url-encoded search query>

exports.handler = async function (event) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=600' // headlines refresh every 10 min at most
  };

  const q = (event.queryStringParameters && event.queryStringParameters.q) || '';
  if (!q) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'missing q parameter' }) };
  }

  const gnews = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-US&gl=US&ceid=US:en';
  const key = process.env.RSS2JSON_API_KEY; // optional — works without one too, just lower quota
  const url = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(gnews) +
    (key ? '&api_key=' + encodeURIComponent(key) : '');

  try {
    const r = await fetch(url);
    const j = await r.json();
    return { statusCode: 200, headers, body: JSON.stringify(j) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
