// Netlify Function: headlines from Google News RSS (Bing News RSS as the fallback).
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
const BING = 'https://www.bing.com/news/search';
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
      source: cleanText(pickTag(b, 'source') || pickTag(b, 'News:Source'), 80) || cleanText(pickAttr(b, 'source', 'url'), 120)
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

// ?lang=th asks Google News for the Thai edition (Thai-language headlines); default is US English.
const LOCALES = { en: 'hl=en-US&gl=US&ceid=US:en', th: 'hl=th&gl=TH&ceid=TH:th' };

async function fromGoogleNews(q, lang = 'en') {
  const url = `${GNEWS}?q=${encodeURIComponent(q)}&${LOCALES[lang] || LOCALES.en}`;
  const r = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!r.ok) throw new Error(`Google News HTTP ${r.status}`);
  const items = parseRssItems(await r.text()).slice(0, MAX_ITEMS);
  if (!items.length) throw new Error('no <item> elements in the Google News response');
  return items;
}

// Second source: Bing News RSS. Google News answers some datacenter ranges (Cloudflare Workers in
// particular) with HTTP 503, so this keeps headlines flowing there. Same item shape; Bing wraps each
// article link in an apiclick.aspx redirect, so the real URL is pulled out of its url= parameter.
const BING_LOCALES = { en: 'setlang=en-US&cc=US', th: 'setlang=th&cc=TH' };
function unwrapBingLink(link) {
  try {
    const u = new URL(link);
    if (/bing\.com$/i.test(u.hostname) && u.searchParams.get('url')) return u.searchParams.get('url');
  } catch (e) { /* keep as-is */ }
  return link;
}
async function fromBingNews(q, lang = 'en') {
  const url = `${BING}?q=${encodeURIComponent(q)}&format=rss&${BING_LOCALES[lang] || BING_LOCALES.en}`;
  const r = await fetchWithTimeout(url, TIMEOUT_MS);
  if (!r.ok) throw new Error(`Bing News HTTP ${r.status}`);
  const text = await r.text();
  const items = parseRssItems(text).slice(0, MAX_ITEMS).map((it) => ({ ...it, link: unwrapBingLink(it.link) }));
  if (!items.length) throw new Error('no <item> elements in the Bing News response (' + text.replace(/\s+/g, ' ').slice(0, 60) + ')');
  return items;
}

// Publisher RSS feeds per topic (the page sends its feed key as ?cat=). These are plain public RSS
// endpoints meant for machine readers, so they answer datacenter IPs that Google/Bing News refuse.
// Several feeds per topic are merged newest-first, so one feed being down only thins the list.
const CATEGORY_FEEDS = {
  geopolitical: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://www.aljazeera.com/xml/rss/all.xml', 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml'],
  economic: ['https://www.cnbc.com/id/20910258/device/rss/rss.html', 'https://feeds.bbci.co.uk/news/business/rss.xml', 'https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml'],
  energy: ['https://oilprice.com/rss/main', 'https://www.cnbc.com/id/19836768/device/rss/rss.html'],
  financial: ['https://www.cnbc.com/id/10000664/device/rss/rss.html', 'https://www.cnbc.com/id/15839069/device/rss/rss.html', 'https://feeds.content.dowjones.io/public/rss/mw_topstories'],
  techAi: ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'https://techcrunch.com/category/artificial-intelligence/feed/', 'https://www.theverge.com/rss/index.xml'],
  thai: ['https://www.prachachat.net/economy/feed', 'https://www.prachachat.net/finance/feed', 'https://www.prachachat.net/feed', 'https://www.thansettakij.com/rss', 'https://www.bangkokpost.com/rss/data/business.xml']
};
// The Thai feeds are whole-newspaper feeds full of PR, lifestyle and charity items, so for this
// topic only stories that match a market / economy / politics term are kept (not just ranked first).
const STRICT_TOPICS = {
  thai: ['เศรษฐกิจ', 'หุ้น', 'ตลาดหลักทรัพย์', 'ทอง', 'ค่าเงิน', 'เงินบาท', 'ดอลลาร์', 'ดอกเบี้ย', 'แบงก์ชาติ', 'ธปท', 'กนง',
    'เงินเฟ้อ', 'จีดีพี', 'ส่งออก', 'นำเข้า', 'การค้า', 'ภาษี', 'งบประมาณ', 'คลัง', 'หนี้', 'รัฐบาล', 'นายกฯ', 'นายกรัฐมนตรี', 'ครม',
    'สภา', 'เลือกตั้ง', 'น้ำมัน', 'พลังงาน', 'ลงทุน', 'ธนาคาร', 'สินเชื่อ', 'อสังหา', 'ท่องเที่ยว', 'ดัชนี', 'เฟด', 'ทรัมป์', 'กำแพงภาษี',
    'บีโอไอ', 'ค่าแรง', 'ชอร์ตเซล', 'บิตคอยน์', 'คริปโต', 'ชายแดน', 'กัมพูชา', 'ก.ล.ต', 'ตลาดทุน', 'ราคาสินค้า', 'ผู้บริโภค', 'ภาคอุตสาหกรรม',
    'economy', 'economic', 'baht', 'set index', 'stocks', 'gold', 'inflation', 'interest rate', 'bank of thailand', 'gdp', 'export', 'tariff',
    'budget', 'government', 'prime minister', 'oil', 'investment', 'investor', 'fed', 'bitcoin', 'crypto']
};
// The English publisher feeds are whole sections too (BBC Business carries GTA 6 sales and Airbnb
// house rules; The Verge carries gadget round-ups), so each topic also has a relevance list. Stories
// that match neither it nor the search terms are dropped when at least MIN_ON_TOPIC stories match;
// otherwise they are kept to fill the list but flagged onTopic:false, and the page does not score them.
const MIN_ON_TOPIC = 4;
const TOPIC_TERMS = {
  geopolitical: ['war', 'military', 'missile', 'missiles', 'troops', 'nato', 'sanction', 'sanctions', 'ceasefire', 'truce', 'invasion',
    'coup', 'election', 'president', 'prime minister', 'minister', 'government', 'diplomat', 'diplomatic', 'summit', 'border', 'attack',
    'strike', 'strikes', 'nuclear', 'iran', 'israel', 'gaza', 'ukraine', 'russia', 'china', 'taiwan', 'korea', 'protest', 'protests',
    'refugee', 'refugees', 'un', 'treaty', 'talks', 'drone', 'drones', 'army', 'rebels', 'killed'],
  economic: ['fed', 'federal reserve', 'central bank', 'inflation', 'cpi', 'ppi', 'interest rate', 'interest rates', 'rate hike', 'rate cut',
    'rates', 'gdp', 'economy', 'economic', 'economist', 'economists', 'recession', 'jobs', 'unemployment', 'payrolls', 'wages', 'retail sales',
    'consumer spending', 'consumer prices', 'tariff', 'tariffs', 'trade', 'deficit', 'debt', 'treasury', 'budget', 'tax', 'taxes', 'boj',
    'ecb', 'bank of england', 'bank of japan', 'imf', 'growth', 'manufacturing', 'pmi', 'housing market', 'mortgage', 'mortgages',
    'cost of living', 'prices', 'shares', 'stocks', 'markets', 'ipo'],
  energy: ['oil', 'crude', 'brent', 'wti', 'opec', 'gas', 'lng', 'lpg', 'energy', 'fuel', 'gasoline', 'petrol', 'diesel', 'refinery',
    'refineries', 'pipeline', 'power grid', 'electricity', 'coal', 'nuclear', 'hormuz', 'barrel', 'barrels', 'iea', 'solar', 'wind power', 'utilities'],
  financial: ['stock', 'stocks', 'shares', 'market', 'markets', 'wall st', 'wall street', 's&p', 'nasdaq', 'dow', 'bond', 'bonds', 'yield',
    'yields', 'treasury', 'treasuries', 'investor', 'investors', 'ipo', 'earnings', 'bank', 'banks', 'credit', 'dollar', 'currency', 'yen',
    'euro', 'bitcoin', 'crypto', 'gold', 'hedge fund', 'fund', 'index', 'selloff', 'sell-off', 'rally', 'fed', 'rates', 'valuation'],
  techAi: [' ai ', 'ai', 'a.i.', 'artificial intelligence', 'chip', 'chips', 'semiconductor', 'semiconductors', 'nvidia', 'openai', 'anthropic',
    'google', 'microsoft', 'apple', 'meta', 'amazon', 'tesla', 'tsmc', 'data center', 'data centers', 'tech', 'big tech', 'regulation',
    'antitrust', 'cyber', 'cyberattack', 'hack', 'hackers', 'outage', 'outages', 'ipo', 'shares', 'stocks', 'export controls', 'startup', 'funding']
};
function termTester(t) {
  if (!/^[\x00-\x7f]+$/.test(t)) return (text) => text.includes(t);
  const re = new RegExp('(?:^|[^a-z0-9])' + t.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])', 'i');
  return (text) => re.test(text);
}
async function fromCategoryFeeds(q, lang, cat) {
  const urls = CATEGORY_FEEDS[cat];
  if (!urls) throw new Error('no publisher feeds for this topic');
  const settled = await Promise.allSettled(urls.map(async (u) => {
    const r = await fetchWithTimeout(u, TIMEOUT_MS);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return parseRssItems(await r.text()).slice(0, MAX_ITEMS);
  }));
  const seen = new Set();
  const items = settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
    .filter((it) => { const k = it.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0));
  // These feeds are whole sections, not a search, so put the stories that mention one of the
  // page's search terms ("oil price OR OPEC" → oil price, opec) first, newest first within each group.
  const terms = String(q).toLowerCase().split(/\s+or\s+/).map((t) => t.trim()).filter(Boolean);
  // whole words for English ("war" must not match "software"); plain substring for Thai, which has no word breaks
  const res = terms.map((t) => (/^[\x00-\x7f]+$/.test(t) ? new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null));
  const hit = (it) => {
    const text = (it.title + ' ' + it.description).toLowerCase();
    return terms.some((t, i) => (res[i] ? res[i].test(text) : text.includes(t)));
  };
  let ranked = items.filter(hit).concat(items.filter((it) => !hit(it)));
  const strict = STRICT_TOPICS[cat];
  const topic = TOPIC_TERMS[cat];
  if (!strict && topic) {
    const testers = topic.map(termTester);
    const onTopic = (it) => { const text = it.title + ' ' + it.description; return hit(it) || testers.some((f) => f(text)); };
    const yes = ranked.filter(onTopic);
    ranked = yes.length >= MIN_ON_TOPIC ? yes : yes.concat(ranked.filter((it) => !onTopic(it)).map((it) => ({ ...it, onTopic: false })));
  }
  if (strict) {
    const relevant = (it) => {
      const text = (it.title + ' ' + it.description).toLowerCase();
      return hit(it) || strict.some((t) => (/^[\x00-\x7f]+$/.test(t) ? new RegExp('\\b' + t + '\\b', 'i').test(text) : text.includes(t)));
    };
    ranked = ranked.filter(relevant);
  }
  ranked = ranked.slice(0, MAX_ITEMS);
  if (!ranked.length) {
    throw new Error('publisher feeds failed: ' + settled.map((s) => (s.status === 'rejected' ? s.reason.message : 'empty')).join(', '));
  }
  return ranked;
}

// Last-resort fallback. Kept because it already proved it can work when Google answers a given
// datacenter with an interstitial page; it needs no key either, a key only raises the quota.
async function fromRss2Json(q, lang = 'en') {
  const gnews = `${GNEWS}?q=${encodeURIComponent(q)}&${LOCALES[lang] || LOCALES.en}`;
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
  const lang = (event && event.queryStringParameters && event.queryStringParameters.lang) === 'th' ? 'th' : 'en';
  const cat = String((event && event.queryStringParameters && event.queryStringParameters.cat) || '');

  const errors = [];
  for (const [name, fn] of [['google-news', fromGoogleNews], ['publisher-rss', fromCategoryFeeds], ['bing-news', fromBingNews], ['rss2json', fromRss2Json]]) {
    try {
      const items = await fn(q, lang, cat);
      return json(200, { status: 'ok', source: name, query: q, lang, count: items.length, items });
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  // Both paths failed — say so, and let the 10-minute CDN cache be bypassed for this answer so a
  // transient upstream hiccup is not frozen into every visitor's page.
  return json(502, { status: 'error', error: 'all news sources failed', details: errors }, { 'Cache-Control': 'no-store' });
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = { parseRssItems, decodeEntities, stripTags, cleanText, unwrapBingLink, CATEGORY_FEEDS, STRICT_TOPICS, TOPIC_TERMS, MIN_ON_TOPIC, fromCategoryFeeds };
