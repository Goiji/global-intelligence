// Netlify Function: headlines from Google News RSS.
//
// Usage from the frontend: /.netlify/functions/news-feed?q=<url-encoded search query>
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS WAS REWRITTEN (Sep 2026)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1) IT NO LONGER DEPENDS ON rss2json. That service used to be the only way to read Google News
//    RSS from a browser (Google sends no CORS headers), which meant every headline was behind a
//    third party's quota — and the free anonymous tier is small, shared per IP, and it can start
//    answering with an error object in the middle of a traffic spike. The function runs on the
//    server, where CORS does not exist, so it now fetches the RSS document itself and parses the
//    <item> elements. rss2json is kept ONLY as a fallback if our own parse comes back empty.
// 2) HARD TIMEOUT + BOUNDED INPUT. The old code awaited fetch() with no timeout at all (a hung
//    upstream held the whole invocation open until Netlify's 10s limit) and forwarded the raw
//    upstream body. Now: 8s abort, `q` capped at 200 chars, per-item text capped, and the payload
//    is trimmed to what the page actually renders.
// 3) RESPONSE SHAPE IS VALIDATED BEFORE IT IS CACHED. An HTML error page or an rss2json error
//    object must not be cached by the CDN for 10 minutes as if it were news.
//
// Nothing here is secret. RSS2JSON_API_KEY is optional and only raises the fallback's quota.

const GNEWS = 'https://news.google.com/rss/search';
const RSS2JSON = 'https://api.rss2json.com/v1/api.json';
const TIMEOUT_MS = 8000;
const MAX_ITEMS = 10;
const MAX_Q = 200;

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': statusCode === 200 ? 'public, max-age=600, s-maxage=600, stale-while-revalidate=3600' : 'no-store',
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

// Minimal XML entity decoder — RSS from Google is full of &#39; / &amp; / &quot;.
// Order matters: numeric codes first, then &amp; LAST so "&amp;lt;" becomes the text "&lt;"
// rather than a literal "<" (never re-introduce markup), and only then the named entities that
// Google double-escapes inside <description> (it ships "&amp;nbsp;" as often as "&nbsp;").
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ');
}

function cleanText(s, max) {
  const out = stripTags(decodeEntities(s)).replace(/\s+/g, ' ').trim();
  return max && out.length > max ? out.slice(0, max).trim() : out;
}

function pickTag(block, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  return m ? m[1] : '';
}

function pickAttr(block, tag, attr) {
  const m = new RegExp(`<${tag}[^>]*\\b${attr}=["']([^"']*)["'][^>]*>`, 'i').exec(block);
  return m ? m[1] : '';
}

// Parse an RSS/Atom-ish document into the flat item shape the frontend consumes.
// Exported for unit tests; tolerant of missing nodes rather than throwing.
function parseRssItems(xml) {
  const doc = String(xml || '');
  const blocks = doc.match(/<item[\s>][\s\S]*?<\/item>/gi) || doc.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = cleanText(pickTag(b, 'title'), 300);
    const description = cleanText(pickTag(b, 'description') || pickTag(b, 'summary') || pickTag(b, 'content'), 400);
    let link = cleanText(pickTag(b, 'link'), 500);
    if (!link) link = decodeEntities(pickAttr(b, 'link', 'href')).trim();
    return {
      title,
      description,
      link,
      pubDate: cleanText(pickTag(b, 'pubDate') || pickTag(b, 'published') || pickTag(b, 'updated'), 60),
      source: cleanText(pickTag(b, 'source'), 80) || cleanText(pickAttr(b, 'source', 'url'), 120)
    };
  }).filter((it) => it.title);
}

async function fetchWithTimeout(url, ms, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: headers || { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard)', Accept: 'application/rss+xml, application/xml, text/xml, */*' }
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fromGoogleNews(q) {
  const url = `${GNEWS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!r.ok) throw new Error(`Google News HTTP ${r.status}`);
  const items = parseRssItems(await r.text()).slice(0, MAX_ITEMS);
  if (!items.length) throw new Error('no <item> elements in the Google News response');
  return items;
}

// Last-resort fallback. Kept because it already proved it can work when Google answers a given
// datacenter with an interstitial page; it needs no key either, a key only raises the quota.
async function fromRss2Json(q) {
  const gnews = `${GNEWS}?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const key = (process.env.RSS2JSON_API_KEY || '').trim();
  const url = `${RSS2JSON}?rss_url=${encodeURIComponent(gnews)}` + (key ? `&api_key=${encodeURIComponent(key)}` : '');
  const r = await fetchWithTimeout(url, TIMEOUT_MS, { Accept: 'application/json' });
  if (!r.ok) throw new Error(`rss2json HTTP ${r.status}`);
  const j = await r.json();
  if (!j || j.status !== 'ok' || !Array.isArray(j.items)) throw new Error(`rss2json status ${j && j.status}`);
  const items = j.items.slice(0, MAX_ITEMS).map((it) => ({
    title: cleanText(it.title, 300),
    description: cleanText(it.description, 400),
    link: cleanText(it.link, 500),
    pubDate: cleanText(it.pubDate, 60),
    source: cleanText((it.author || '').toString(), 80)
  })).filter((it) => it.title);
  if (!items.length) throw new Error('rss2json returned no usable items');
  return items;
}

exports.handler = async function (event) {
  const rawQ = (event && event.queryStringParameters && event.queryStringParameters.q) || '';
  const q = String(rawQ).replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_Q);
  if (!q) return json(400, { status: 'error', error: 'missing q parameter' });

  const errors = [];
  for (const [name, fn] of [['google-news', fromGoogleNews], ['rss2json', fromRss2Json]]) {
    try {
      const items = await fn(q);
      return json(200, { status: 'ok', source: name, query: q, count: items.length, items });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Both paths failed — say so, and let the 10-minute CDN cache be bypassed for this answer so a
  // transient upstream hiccup is not frozen into every visitor's page.
  return json(502, { status: 'error', error: 'all news sources failed', details: errors }, { 'Cache-Control': 'no-store' });
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = { parseRssItems, decodeEntities, stripTags, cleanText };
