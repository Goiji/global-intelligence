// World Risk Score keyword engine (index.html) — real-looking headlines, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const i = html.indexOf('  const HIGH_RISK_TERMS'), j = html.indexOf('  function scoreCategory(titles)');
// eslint-disable-next-line no-new-func
const api = new Function(html.slice(i, j) + '\nreturn { scoreHeadline, scoreCategoryDetail, isOffTopic };')();
const net = (t) => api.scoreHeadline(t).net;
const terms = (t) => api.scoreHeadline(t).hits.map((h) => h.term);

test('sports, entertainment and history stories are not counted as risk', () => {
  for (const t of [
    'Bills rally past Chiefs as defense recalls the War of 1812 in pregame tribute',
    'Premier League: Arsenal crash out of cup after penalty shootout',
    'Box office: war epic tops weekend with $60m debut',
    'Museum marks anniversary of World War II invasion of Normandy'
  ]) {
    assert.equal(net(t), 0, t);
    assert.ok(api.isOffTopic(t), t);
  }
});

test('phrases that only look risky score zero', () => {
  assert.equal(net('Apple and Google strike a deal on default search engine'), 0);
  assert.equal(net('Retailers brace for holiday price war'), 0);
  assert.equal(net('Former senator dies of heart attack, family says'), 0);
  assert.equal(net('Germany extends nuclear power plant life to 2030'), 0);
  assert.equal(net('Small plane crash kills two in Texas'), 1, 'only "kill" counts, not "crash"');
});

test('military phrases outweigh bare words and are not double-counted', () => {
  assert.deepEqual(terms('Israel launches military strikes on Lebanon'), ['military strike']);
  assert.equal(net('Israel launches military strikes on Lebanon'), 2);
  assert.ok(net('Russia launches missile strikes on Kyiv power grid') >= 2);
  assert.ok(net('China and US trade war deepens with new tariffs') >= 2.5);
  assert.equal(net('Leaders discuss war'), 1, 'bare "war" is a weak signal now');
});

test('negations do not count as risk', () => {
  assert.equal(net('Congress averts shutdown with last-minute bill'), 0);
  assert.equal(net('Economists see no recession in 2027'), 0);
  assert.ok(net('Ceasefire holds as talks end war in Gaza') < 0);
});

test('the same story from several outlets counts once', () => {
  const now = Date.parse('2026-11-16T09:00:00Z');
  const items = [
    { title: 'Iran launches missile attack on Israel - BBC News', pubDate: 'Mon, 16 Nov 2026 08:00:00 GMT' },
    { title: 'Iran launches missile attack on Israel, Israeli military says - Al Jazeera', pubDate: 'Mon, 16 Nov 2026 07:50:00 GMT' },
    { title: 'Missile attack: Iran launches strikes on Israel - The New York Times', pubDate: 'Mon, 16 Nov 2026 07:40:00 GMT' },
    { title: 'Global markets rally as oil prices stabilize', pubDate: 'Mon, 16 Nov 2026 07:00:00 GMT' }
  ];
  const r = api.scoreCategoryDetail(items, now);
  assert.equal(r.used, 2, 'three copies of the Iran story collapse into one');
  assert.ok(r.score > 50 && r.score < 80, `one risky + one calm story should land mid-high, got ${r.score}`);
});

test('newer headlines weigh more than old ones', () => {
  const now = Date.parse('2026-11-16T09:00:00Z');
  const freshRisk = api.scoreCategoryDetail([
    { title: 'Coup attempt reported in capital as troops seize state TV', pubDate: 'Mon, 16 Nov 2026 08:30:00 GMT' },
    { title: 'Peace deal reached after months of talks', pubDate: 'Sat, 14 Nov 2026 08:30:00 GMT' }
  ], now).score;
  const staleRisk = api.scoreCategoryDetail([
    { title: 'Peace deal reached after months of talks', pubDate: 'Mon, 16 Nov 2026 08:30:00 GMT' },
    { title: 'Coup attempt reported in capital as troops seize state TV', pubDate: 'Sat, 14 Nov 2026 08:30:00 GMT' }
  ], now).score;
  assert.ok(freshRisk > 50 && staleRisk < 50, `fresh=${freshRisk} stale=${staleRisk}`);
});

test('off-topic items are skipped so they do not dilute the category', () => {
  const r = api.scoreCategoryDetail([
    'NBA: Lakers beat Celtics in overtime thriller',
    'Russia launches missile strikes on Kyiv power grid',
    'Movie review: a quiet war drama'
  ]);
  assert.equal(r.used, 1);
  assert.ok(r.score >= 80, `got ${r.score}`);
  assert.equal(r.drivers[0].title, 'Russia launches missile strikes on Kyiv power grid');
});
