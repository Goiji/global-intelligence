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
