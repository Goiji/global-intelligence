// Unit tests for news-feed.js — run with:  npm test
//
// The RSS parser is the risky part of that function (there is no XML library in a Netlify
// function bundle by default), so it is pinned down here with a realistic Google News snippet,
// including the entity escapes and the nested <source> node that Google always emits.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../netlify/functions/news-feed.js');

const { parseRssItems, decodeEntities, stripTags, cleanText } = __test;

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>opec - Google News</title>
    <item>
      <title>OPEC+ agrees to raise output by 137,000 bpd &amp; signals caution</title>
      <link>https://news.google.com/rss/articles/CBMiABC?oc=5</link>
      <guid isPermaLink="false">CBMiABC</guid>
      <pubDate>Fri, 11 Sep 2026 09:15:00 GMT</pubDate>
      <description>&lt;a href="https://example.com/x"&gt;OPEC+&lt;/a&gt;&amp;nbsp;agrees output hike</description>
      <source url="https://www.reuters.com">Reuters</source>
    </item>
    <item>
      <title><![CDATA[Oil slides as demand worries grow — &#39;traders wary&#39;]]></title>
      <link>https://news.google.com/rss/articles/CBMiDEF</link>
      <pubDate>Fri, 11 Sep 2026 08:00:00 GMT</pubDate>
      <description><![CDATA[<p>Brent fell 1.2%</p>]]></description>
      <source url="https://www.bloomberg.com">Bloomberg</source>
    </item>
    <item>
      <pubDate>Fri, 11 Sep 2026 07:00:00 GMT</pubDate>
      <description>headline-less item must be dropped</description>
    </item>
  </channel>
</rss>`;

test('decodeEntities handles named, decimal and hex escapes', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('&#39;quoted&#39;'), "'quoted'");
  assert.equal(decodeEntities('&#x2014;dash'), '\u2014dash');
  assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
  assert.equal(decodeEntities('x&nbsp;y'), 'x y');
  // ampersand replacement must run last, otherwise double-escaped text is decoded twice
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('stripTags and cleanText collapse markup and whitespace', () => {
  assert.equal(stripTags('<a href="x">hi</a> there'), ' hi  there');
  assert.equal(cleanText('<p>  a\n\n  b </p>', 100), 'a b');
  assert.equal(cleanText('abcdef', 3), 'abc');
});

test('parseRssItems extracts title/description/link/date/source', () => {
  const items = parseRssItems(SAMPLE);
  assert.equal(items.length, 2); // the headline-less third item is dropped
  assert.equal(items[0].title, 'OPEC+ agrees to raise output by 137,000 bpd & signals caution');
  assert.equal(items[0].description, 'OPEC+ agrees output hike'); // tags stripped, entities decoded
  assert.equal(items[0].pubDate, 'Fri, 11 Sep 2026 09:15:00 GMT');
  assert.equal(items[0].source, 'Reuters');
  assert.equal(items[1].title, "Oil slides as demand worries grow — 'traders wary'");
  assert.equal(items[1].description, 'Brent fell 1.2%');
});

test('parseRssItems never returns markup for the frontend to inject', () => {
  const items = parseRssItems(SAMPLE);
  for (const it of items) {
    for (const field of ['title', 'description', 'source']) {
      assert.ok(!/<[^>]*>/.test(it[field]), `${field} still contains markup: ${it[field]}`);
    }
  }
});

test('parseRssItems is tolerant of empty or broken documents', () => {
  assert.deepEqual(parseRssItems(''), []);
  assert.deepEqual(parseRssItems('<rss><channel></channel></rss>'), []);
  assert.deepEqual(parseRssItems(undefined), []);
});

test('Bing News fallback: used when Google answers 503, real article link unwrapped', async () => {
  const fn = require('../netlify/functions/news-feed.js');
  const BING_RSS = '<rss><channel><item><title>Oil rises on supply fears</title>' +
    '<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fexample.com%2fstory&amp;c=1&amp;mkt=en-us</link>' +
    '<description>Brent up 2%</description><pubDate>Sun, 16 Nov 2026 01:23:00 GMT</pubDate><News:Source>Reuters</News:Source></item></channel></rss>';
  const orig = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('news.google.com')) return new Response('busy', { status: 503 });
    if (String(url).includes('bing.com/news/search')) return new Response(BING_RSS, { status: 200 });
    return new Response('{}', { status: 429 });
  };
  try {
    const out = await fn.handler({ queryStringParameters: { q: 'oil' } });
    assert.equal(out.statusCode, 200);
    const body = JSON.parse(out.body);
    assert.equal(body.source, 'bing-news');
    assert.equal(body.items[0].title, 'Oil rises on supply fears');
    assert.equal(body.items[0].link, 'https://example.com/story');
    assert.equal(body.items[0].source, 'Reuters');
    assert.ok(seen[1].includes('format=rss'));
  } finally {
    global.fetch = orig;
  }
});

test('publisher RSS fallback: Google 503 → topic feeds merged newest-first, deduped', async () => {
  const fn = require('../netlify/functions/news-feed.js');
  const feed = (items) => '<rss><channel>' + items.map(([t, d]) => `<item><title>${t}</title><link>https://x/${encodeURIComponent(t)}</link><pubDate>${d}</pubDate></item>`).join('') + '</channel></rss>';
  const orig = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('news.google.com')) return new Response('busy', { status: 503 });
    if (u.includes('bbci.co.uk')) return new Response(feed([['Old war story', 'Sat, 15 Nov 2026 01:00:00 GMT'], ['Same headline', 'Sun, 16 Nov 2026 01:00:00 GMT']]), { status: 200 });
    if (u.includes('aljazeera')) return new Response(feed([['Fresh conflict news', 'Sun, 16 Nov 2026 02:00:00 GMT'], ['Same headline', 'Sun, 16 Nov 2026 01:00:00 GMT']]), { status: 200 });
    return new Response('nope', { status: 500 });
  };
  try {
    const out = await fn.handler({ queryStringParameters: { q: 'geopolitics OR war', cat: 'geopolitical' } });
    assert.equal(out.statusCode, 200);
    const body = JSON.parse(out.body);
    assert.equal(body.source, 'publisher-rss');
    // stories mentioning a search term ("war") come first, then the rest newest-first
    assert.deepEqual(body.items.map((i) => i.title), ['Old war story', 'Fresh conflict news', 'Same headline']);
  } finally {
    global.fetch = orig;
  }
});

test('every topic key used by the page has publisher feeds', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const keys = [...html.matchAll(/\{ key:'(\w+)',\s+label:tr\([^)]*\),\s+q:/g)].map((m) => m[1]);
  assert.ok(keys.length >= 5, 'found the feed list');
  for (const k of keys) assert.ok(require('../netlify/functions/news-feed.js').__test.CATEGORY_FEEDS[k], 'feeds for ' + k);
});
