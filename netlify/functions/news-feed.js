// Netlify Function: fetches one Google News RSS feed.
// Uses RSS2JSON if RSS2JSON_API_KEY is configured, or directly fetches and parses
// Google News RSS XML keylessly — ensuring news headlines always load with 0 quota limits.
//
// Usage from the frontend: /.netlify/functions/news-feed?q=<url-encoded search query>

function parseRssXml(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null && items.length < 10) {
    const block = match[1];
    const titleMatch = /<title(?:[^>]*)>([\s\S]*?)<\/title>/i.exec(block);
    const descMatch = /<description(?:[^>]*)>([\s\S]*?)<\/description>/i.exec(block);
    const linkMatch = /<link(?:[^>]*)>([\s\S]*?)<\/link>/i.exec(block);
    const pubDateMatch = /<pubDate(?:[^>]*)>([\s\S]*?)<\/pubDate>/i.exec(block);

    const clean = s => s ? s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() : '';
    const title = clean(titleMatch ? titleMatch[1] : '');
    const description = clean(descMatch ? descMatch[1] : '');
    const link = (linkMatch ? linkMatch[1] : '').trim();
    const pubDate = (pubDateMatch ? pubDateMatch[1] : '').trim();

    if (title) {
      items.push({ title, description, link, pubDate });
    }
  }
  return items;
}

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
  const key = process.env.RSS2JSON_API_KEY;

  // 1) Try rss2json if key is configured
  if (key) {
    try {
      const url = 'https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(gnews) + '&api_key=' + encodeURIComponent(key);
      const r = await fetch(url);
      const j = await r.json();
      if (j && j.status === 'ok') {
        return { statusCode: 200, headers, body: JSON.stringify(j) };
      }
    } catch (e) { /* fall through to direct Google News RSS */ }
  }

  // 2) Direct Google News RSS fetch & XML parse (keyless, no quota limits)
  try {
    const r = await fetch(gnews, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
    });
    if (!r.ok) throw new Error(`Google News HTTP ${r.status}`);
    const xml = await r.text();
    const items = parseRssXml(xml);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ status: 'ok', items, source: 'google-news-rss-direct' })
    };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};
