// World Risk Score keyword engine (index.html) — real-looking headlines, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = require('../tools/stamp.js').readPage();
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

// ---- Nov 2026 review: real headlines from 20 Nov 2026 (S&P 500 −3.7%, AI sell-off) ----
const NOW = Date.parse('2026-11-21T01:00:00Z');
const at = (h) => new Date(NOW - h * 3600e3).toUTCString();

test('market-news wording is recognised (the old rules scored these 0)', () => {
  for (const t of [
    'Japan core inflation soars to highest this year as energy subsidy expiry pushes up consumer prices',
    'Anthropic shares fall after blockbuster opening',
    "Anthropic's IPO Turmoil Caps $4 Trillion AI Wipeout on Wall Street",
    'Stocks Skid Into a Correction, as A.I. Worries Intensify',
    'S&P 500 Is Set for Longest Losing Run Since 2020: Markets Wrap',
    'The Federal Reserve Is Expected to Raise Interest Rates Next Month',
    'White House removes cyber-security chief after series of tech outages'
  ]) assert.ok(net(t) > 0, t);
});

test('a calm word that is negated or undone does not lower risk', () => {
  assert.ok(net('Why Anthropic’s blockbuster debut didn’t ease Wall Street’s AI fears') > 0, "didn't ease fears");
  assert.ok(!terms('Trump’s Ukraine Energy Truce Unravels as Russian Missiles Hit Kyiv').includes('truce'));
  assert.ok(net('Trump’s Ukraine Energy Truce Unravels as Russian Missiles Hit Kyiv') >= 2);
  assert.ok(net('Ceasefire holds as talks end war in Gaza') < 0, 'an intact ceasefire still lowers risk');
});

test('lifestyle pieces, listicles and names that contain "war" are not risk', () => {
  for (const t of [
    'These little-known investments could be among the best bargains in a crash',
    'Six AI-powered gadgets that could make your home office smarter',
    'The War Is Ravaging Ukraine’s Wildlife, Too',
    "Airbnb's divisive new house rules come into force"
  ]) assert.ok(api.isOffTopic(t), t);
  assert.equal(net('Department of War Publishes Eighth Release of Unidentified Anomalous Phenomena Files'), 0);
  assert.equal(net('Stocks hit a losing streak of five sessions'), 1, '"losing streak" is market news, not only sports');
});

test('the outlet name after " - " is not scored', () => {
  const r = api.scoreCategoryDetail([
    { title: 'Russian Offensive Campaign Assessment, November 19 - Institute for the Study of War', source: 'Institute for the Study of War', pubDate: at(2) }
  ], NOW);
  assert.equal(r.score, 50);
});

test('the five newest stories are scored, not the first five in feed order', () => {
  const calm = (n) => ({ title: `Diplomats meet in Geneva for round ${n} of routine consultations`, pubDate: at(20 + n) });
  const items = [calm(1), calm(2), calm(3), calm(4), calm(5),
    { title: 'Russian missiles land in Poland. NATO calls it a violation', pubDate: at(3) }];
  const r = api.scoreCategoryDetail(items, NOW);
  assert.ok(r.drivers.some((d) => d.title.startsWith('Russian missiles')), 'the newest story is counted');
  assert.ok(r.score > 50);
});

test("the category's own search word counts half, and stale or flagged items are skipped", () => {
  const items = [{ title: 'Leaders discuss war', pubDate: at(1) }];
  const plain = api.scoreCategoryDetail(items, NOW).score;
  const echoed = api.scoreCategoryDetail(items, NOW, 'geopolitics OR conflict OR war').score;
  assert.ok(echoed < plain && echoed > 50, `plain=${plain} echoed=${echoed}`);
  const r = api.scoreCategoryDetail([
    { title: 'Market crash wipes out savings', pubDate: at(24 * 30) },
    { title: 'Bank run fears grip regional lender', pubDate: at(2), onTopic: false },
    { title: 'Central bank holds steady', pubDate: at(1) }
  ], NOW);
  assert.equal(r.used, 1);
  assert.equal(r.score, 50);
});

test('one lone risky headline cannot push a category to the top of the scale', () => {
  const r = api.scoreCategoryDetail([{ title: 'Oil prices crash after surprise output hike', pubDate: at(1) }], NOW);
  assert.ok(r.score < 85, `got ${r.score}`);
});

test('a genuine sell-off day scores clearly high', () => {
  const r = api.scoreCategoryDetail([
    { title: "Anthropic's IPO Turmoil Caps $4 Trillion AI Wipeout on Wall Street - WSJ", source: 'WSJ', pubDate: at(1) },
    { title: 'Wall St ends sharply lower on AI selloff, S&P 500, Dow in correction - Reuters', source: 'Reuters', pubDate: at(2) },
    { title: 'S&P 500 sinks 3.7% and Nasdaq composite goes negative for the year as tech sell-off worsens - AP News', source: 'AP News', pubDate: at(2) },
    { title: 'S&P 500 Is Set for Longest Losing Run Since 2020: Markets Wrap - Bloomberg.com', source: 'Bloomberg.com', pubDate: at(1) }
  ], NOW, 'stock market OR wall street OR bonds');
  assert.ok(r.score >= 85, `got ${r.score}`);
});

test('chip shipment pauses and export curbs count as tech risk without the words ban or sanction', () => {
  for (const t of [
    'Nvidia hits pause on chip shipments to Southeast Asia',
    'TSMC halts exports of advanced chips to Chinese customers',
    'US tightens export curbs on AI chips',
    'Automakers warn of supply disruptions as chip shortage deepens'
  ]) assert.ok(net(t) >= 1, t + ' → ' + net(t));
  assert.deepEqual(terms('Nvidia hits pause on chip shipments to Southeast Asia'), ['halt shipments']);
  assert.ok(net('Washington lifts export curbs on Nvidia chips') <= 0, 'lifting curbs is not a risk');
});

test('tech gadget, deal and game headlines stay neutral', () => {
  for (const t of [
    'Apple MacBook Air drops to its lowest price ever in Black Friday deal',
    'GTA 6 trailer breaks YouTube record',
    'Samsung Galaxy S26 review: the best Android phone you can buy'
  ]) assert.equal(net(t), 0, t);
});

test('personal finance advice columns are skipped, not scored as market risk', () => {
  for (const t of [
    "I'm terrified of a market crash. Should I put $400,000 from my 401(k) into an annuity?",
    'I’m worried about a recession. Should I move my retirement savings to cash?',
    'My husband wants to sell all our stocks before the crash. Who is right?'
  ]) {
    assert.ok(api.isOffTopic(t), t);
    assert.equal(net(t), 0, t);
  }
  assert.ok(!api.isOffTopic('Stock market crash wipes out $2 trillion as Nasdaq plunges'));
  assert.ok(net('Stock market crash wipes out $2 trillion as Nasdaq plunges') >= 2);
});

test('shopping deals and holiday market-hours explainers are skipped, retail sales news is not', () => {
  for (const t of [
    'Is the stock market open on Black Friday? Here are the holiday trading hours - USA Today',
    'Our favorite headphones and earbuds are cheaper than ever ahead of Black Friday - The Verge',
    'Best Black Friday deals on TVs, laptops and AirPods',
    'Apple Watch drops to its lowest price ever, $100 off the Series 11',
    'Are stock markets open on Thanksgiving?'
  ]) {
    assert.ok(api.isOffTopic(t), t);
    assert.equal(net(t), 0, t);
  }
  for (const t of [
    'Black Friday online sales hit record $11 billion as shoppers pull back in stores',
    'Retailers brace for weak holiday sales as tariffs push prices higher',
    'US and China reach trade deal on chip export controls'
  ]) assert.ok(!api.isOffTopic(t), t);
});

test('review fixes (Nov 28): shopping discounts, fading worries, plural -ies', () => {
  assert.ok(api.isOffTopic('The M5 MacBook Air just got its biggest discount since Apple raised the price'));
  assert.ok(!api.isOffTopic('Fed cuts discount rate in emergency move'));
  assert.ok(net('China growth slows to weakest pace in decades') >= 0, 'slowing growth is not good news');
  assert.ok(net('Fed rate cut hopes fade as inflation stays hot') >= 0, 'fading cut hopes are not good news');
  assert.ok(!terms('Stocks climb as tensions fade').includes('tension'), 'fading tension is not a risk');
  assert.ok(terms('Asian stocks rallies after Wall Street rebound').includes('rally'));
});

test('a category whose feed failed is left out instead of scoring 50', () => {
  const src = require('../tools/stamp.js').readPage();
  assert.match(src, /feedResults = allFeeds\.filter\(f => !f\.listOnly && \(\(f\.items && f\.items\.length\) \|\| \(f\.titles && f\.titles\.length\)\)\)/);
});
