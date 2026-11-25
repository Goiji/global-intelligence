// Smoke tests for index.html — run with:  npm test
//
// The page's JavaScript lives inline in index.html, so there is no compiler and no bundler to
// catch a typo, a renamed element id, or a function called before it is defined. These tests:
//   1) parse every inline <script> (syntax errors fail here)
//   2) execute every inline <script> against a small DOM stub and fail on any thrown error
//   3) cross-check that every id referenced from JS actually exists in the markup
//   4) enforce a couple of invariants that were real bugs before (@import placement, one writer
//      for #today, all FOMC 2027 dates present, no duplicate ids)
//
// It is deliberately dumb: no jsdom, no network, no browser. It cannot prove the page *looks*
// right — it proves the scripts run and the wiring is internally consistent.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { HTML, SCRIPTS, makeSandbox } = require('./dom-stub.js');

test('index.html has inline scripts and they all parse', () => {
  assert.ok(SCRIPTS.length >= 3, `expected several inline scripts, found ${SCRIPTS.length}`);
  SCRIPTS.forEach((src, i) => {
    assert.doesNotThrow(() => new vm.Script(src, { filename: `index.html#script${i}` }), `script #${i} has a syntax error`);
  });
});

test('every inline script runs against a DOM stub without throwing', async () => {
  for (let i = 0; i < SCRIPTS.length; i++) {
    const sandbox = makeSandbox();
    assert.doesNotThrow(() => vm.runInNewContext(SCRIPTS[i], sandbox, { filename: `index.html#script${i}` }), `script #${i} threw at load time`);
    // Let the async work started at the end of each script settle *inside* the test, so an
    // unhandled rejection in a .catch() path fails here instead of leaking into the next test.
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('the shared header stamp and chart hooks are wired up', async () => {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof sandbox.setHeaderStamp, 'function', 'setHeaderStamp (single writer of #today) is missing');
  assert.equal(typeof sandbox.loadTvChart, 'function', 'loadTvChart (lazy TradingView loader) is missing');
});

test('every element id referenced from JS exists in the markup', () => {
  const ids = new Set([...HTML.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const refs = new Set([
    ...[...HTML.matchAll(/el\('([^']+)'\)/g)].map((m) => m[1]),
    ...[...HTML.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
  ]);
  const missing = [...refs].filter((r) => !ids.has(r));
  assert.deepEqual(missing, [], `JS references ids that do not exist: ${missing.join(', ')}`);
  assert.ok(ids.size > 50, 'sanity: expected the page to define many ids');
});

test('no duplicate ids and no unclosed tags', () => {
  // Comments legitimately contain strings like "<style>" while explaining a fix, so strip them
  // before counting tags.
  const markup = HTML.replace(/<!--[\s\S]*?-->/g, '');
  const ids = [...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
  // Cheap balance check for the containers that actually nest in this page.
  for (const tag of ['div', 'section', 'script', 'style', 'details']) {
    const open = (markup.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
    const close = (markup.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    assert.equal(open, close, `<${tag}> is unbalanced (${open} open vs ${close} close)`);
  }
});

test('the Fed analysis section is generated, not hand-written', () => {
  // The old version of this block was a hand-written article about the July 2026 print with the
  // numbers baked into the prose. It must stay gone.
  assert.match(HTML, /id="fedAnalysis"/, 'the analysis container is missing');
  assert.doesNotMatch(HTML, /ออกมาจริง<b>ติดลบ 23,000<\/b>/, 'the hand-written July-2026 NFP paragraph is back');
  assert.doesNotMatch(HTML, /เขียนไว้ ณ ตอนที่ทำฟีเจอร์นี้/, 'the hand-written analysis footer is back');
  assert.match(HTML, /const CONSENSUS/, 'the CONSENSUS block (the only thing a human edits) is missing');
});

test('regressions that were fixed once must not come back', () => {
  // 1) @import must not appear as a rule inside a <style> block (browsers ignore it there).
  for (const m of HTML.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    assert.doesNotMatch(m[1], /(^|\n)\s*@import/, '@import is back inside a <style> block — it will be ignored');
  }
  // 2) The Google Fonts stylesheet must be linked from <head>.
  const head = HTML.split('</head>')[0];
  assert.match(head, /fonts\.googleapis\.com\/css2/, 'Google Fonts <link> is missing from <head>');

  // 3) #today must be written from exactly one place.
  const writers = [...HTML.matchAll(/getElementById\('today'\)[^;]*;/g)].length;
  assert.equal(writers, 1, `#today has ${writers} writers; it must have exactly one`);

  // 4) FOMC calendar: 2027 dates must be present so the countdown does not go blank in Jan 2027.
  for (const d of ['2027-01-27', '2027-03-17', '2027-06-09', '2027-12-08']) {
    assert.ok(HTML.includes(d), `index.html is missing the 2027 FOMC date ${d}`);
  }

  // 5) Untrusted feed text must be escaped before it reaches innerHTML.
  assert.match(HTML, /esc\(safeTitleTh\)/, 'Top Events titles are no longer escaped');
  assert.match(HTML, /esc\(safeDescTh\)/, 'Top Events descriptions are no longer escaped');
  // Latest-news list: titles escaped, and only http(s) links become clickable (no javascript: URLs).
  assert.match(HTML, /esc\(hasTh \? th : n\.title\)/, 'Latest-news titles are no longer escaped');
  assert.match(HTML, /\/\^https\?:\\\/\\\/\/i\.test\(it\.link/, 'Latest-news links are no longer restricted to http(s)');

  // 6) The TradingView bundle must not be fetched on page load any more.
  assert.doesNotMatch(HTML, /\n\s*loadTradingViewChart\(\);/, 'TradingView is being loaded eagerly again');
});

test('FX % change compares against the business day before the newest one', async () => {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const { pickFxPair } = sandbox;
  assert.equal(typeof pickFxPair, 'function');
  const d16 = { THB: 33.415, JPY: 158.02, CNY: 6.6862 };
  const d19 = { THB: 33.555, JPY: 158.24, CNY: 6.6807 };
  const series = { '2026-10-15': { THB: 33.54, JPY: 157.98, CNY: 6.691 }, '2026-10-16': d16, '2026-10-19': d19 };
  // "latest" served stale (16 Oct) while the range already has 19 Oct: used to show 0.00%.
  let p = pickFxPair({ date: '2026-10-16', rates: d16 }, series);
  assert.equal(p.date, '2026-10-19');
  assert.equal(p.now.THB, 33.555);
  assert.equal(p.prevDate, '2026-10-16');
  // Range lagging behind latest: compare latest with the range's newest day.
  p = pickFxPair({ date: '2026-10-20', rates: { ...d19, THB: 33.6 } }, series);
  assert.equal(p.date, '2026-10-20');
  assert.equal(p.prevDate, '2026-10-19');
  // Range failed: still show the price, no %.
  p = pickFxPair({ date: '2026-10-19', rates: d19 }, null);
  assert.equal(p.prev, null);
  assert.equal(pickFxPair(null, null), null);
});

// Owner's rule (Nov 2026): never show a number baked into the page. Before live data arrives, and
// when it can't be fetched and nothing was saved, the macro cards show "–", not an old figure that
// looks current (the CPI card used to read 3.4% while the real figure was 3.7%).
{
  const { makeSandbox: mk, runAllScripts: run } = require('./dom-stub.js');
  const MACRO_IDS = ['fedRange', 'fedEffr', 'cpiYoy', 'unrate', 'nfp'];

  test('macro cards have no baked-in numbers in the markup', () => {
    const { HTML: page } = require('./dom-stub.js');
    for (const id of MACRO_IDS) {
      const m = new RegExp(`id="${id}">([^<]*)<`).exec(page);
      assert.ok(m, `#${id} not found`);
      assert.equal(m[1], '–', `#${id} must start empty, not "${m[1]}"`);
    }
  });

  test('when fred-data fails and nothing is cached, the cards stay at "–"', async () => {
    const sb = await run(mk({ fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({ error: 'down' }), text: async () => '' }) }));
    // (the DOM stub starts elements empty, so check that nothing wrote a number into them)
    for (const id of MACRO_IDS) assert.doesNotMatch(sb.document.getElementById(id).textContent, /\d/, `#${id}`);
    assert.match(sb.document.getElementById('fredFetchStatus').textContent, /อัปเดตตัวเลขล่าสุดไม่ได้/);
  });
}

// Oct-2026 CPI MoM showed "+0.3%" while BLS printed +0.4%: 0.35 in binary is 0.3499…, so toFixed(1)
// rounded it down. signedPct must round half away from zero like BLS does.
test('signedPct rounds halves away from zero (0.35 → +0.4, −0.35 → −0.4)', async () => {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const { signedPct } = sandbox;
  assert.equal(typeof signedPct, 'function');
  assert.equal(signedPct(0.35, 1), '+0.4');
  assert.equal(signedPct(0.3503, 1), '+0.4');
  assert.equal(signedPct(0.2997, 1), '+0.3');
  assert.equal(signedPct(-0.35, 1), '−0.4');
  assert.equal(signedPct(1.005, 2), '+1.01');
  assert.equal(signedPct(0, 1), '+0.0');
});

test('"new version available" banner: shows when the page ETag changes, not before', async () => {
  const src = SCRIPTS.find((s) => s.includes('window.giCheckUpdate'));
  assert.ok(src, 'update-check script is missing');
  let etag = 'W/"abc-ssl-df"';
  const calls = [];
  const sandbox = makeSandbox({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init && init.method });
      return { ok: true, status: 200, headers: { get: (h) => (h.toLowerCase() === 'etag' ? etag : null) } };
    }
  });
  sandbox.location.pathname = '/';
  const appended = [];
  sandbox.document.body.appendChild = (n) => appended.push(n);
  sandbox.tr = (th, en) => en;   // English UI
  vm.runInNewContext(src, sandbox, { filename: 'index.html#update' });
  await new Promise((resolve) => setImmediate(resolve));   // baseline request settles
  assert.equal(calls[0].method, 'HEAD');
  assert.equal(calls[0].url, '/');

  assert.equal(await sandbox.giCheckUpdate(), false, 'same ETag must not show the banner');
  etag = '"abc"';   // same content, header just lost its weak/compression decoration
  assert.equal(await sandbox.giCheckUpdate(), false, 'W/ and -ssl-df suffixes must be ignored');
  assert.equal(appended.length, 0);

  etag = '"def"';   // new deploy
  assert.equal(await sandbox.giCheckUpdate(), true);
  assert.equal(appended.length, 1, 'banner appended once');
  assert.equal(appended[0].className, 'gi-update');
  assert.equal(await sandbox.giCheckUpdate(), false, 'no second banner while one is showing');
});

test('"new version available" check stays silent when the host sends no ETag/Last-Modified', async () => {
  const src = SCRIPTS.find((s) => s.includes('window.giCheckUpdate'));
  const sandbox = makeSandbox({ fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null } }) });
  const appended = [];
  sandbox.document.body.appendChild = (n) => appended.push(n);
  vm.runInNewContext(src, sandbox, { filename: 'index.html#update' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await sandbox.giCheckUpdate(), false);
  assert.equal(appended.length, 0);
});

test('source footers are collapsed behind an "ⓘ แหล่งข้อมูล" toggle, warnings stay visible', () => {
  const H = require('../tools/stamp.js').readPage();
  for (const id of ['livePricesNote', 'mktNote', 'fedAsOf', 'econExtraNote']) {
    const re = new RegExp('<details class="src-note"><summary data-en="ⓘ Sources">ⓘ แหล่งข้อมูล</summary><div[^>]*id="' + id + '"');
    assert.match(H, re, id + ' should sit inside a collapsed src-note');
  }
  for (const id of ['mktWarn', 'fedAsOfWarn', 'econExtraWarn']) {
    assert.match(H, new RegExp('<div class="src-warn" id="' + id + '"></div>'), id + ' should be outside the toggle');
  }
});

// "สรุปเช้านี้" used to restate the score, the category cards and the news-outlook bars that are all
// already on the page. It now leads with a warning level and what the news means for stocks and crypto,
// then says what changed since yesterday, what data is due, and what moved.
test('buildBrief gives a warning level, stock/crypto impact, changes, data due and price moves', async () => {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const { buildBrief } = sandbox;
  assert.equal(typeof buildBrief, 'function');
  const now = Date.parse('2026-11-22T02:00:00Z');   // 09:00 Bangkok
  const hot = buildBrief({
    score: 63,
    cats: { geopolitical: 76, economic: 64, energy: 63 },
    prev: { date: '2026-11-21', score: 54, cats: { geopolitical: 75, economic: 64, energy: 54 } },
    events: [
      { key: 'cpi', date: '2026-11-22', at: '2026-11-22T13:30:00Z' },      // 20:30 Bangkok today
      { key: 'fomc', date: '2026-11-26', at: '2026-11-26T19:00:00Z' }
    ],
    prices: { lpGold: 0.3, lpOil: -2.31, lpUsdThb: 0.6 }
  }, now);
  assert.equal(hot.alert.level, 2);                    // +9 in a day and CPI tonight
  assert.ok(hot.alert.reasons.some((r) => /\+9/.test(r)));
  assert.ok(hot.alert.reasons.some((r) => /20:30/.test(r)));
  const labels = hot.lines.map((l) => l.label);
  assert.equal(labels.length, 5);
  assert.match(hot.lines[0].text, /20:30/);            // stocks: CPI volatility first
  assert.match(hot.lines[1].text, /BTC|Nasdaq/);      // crypto: geopolitics risk-off
  assert.match(hot.lines[2].text, /63\/100/);
  assert.match(hot.lines[2].text, /\+9/);              // energy moved most
  assert.match(hot.lines[3].text, /20:30/);
  assert.doesNotMatch(hot.lines[3].text, /FOMC/);      // 4 days out: not "today/tomorrow"
  assert.match(hot.lines[4].text, /▼ 2\.31%/);
  assert.doesNotMatch(hot.lines[4].text, /0\.30%/);   // under 0.5% is left out

  const calm = buildBrief({ score: 35, cats: { geopolitical: 40 }, prev: null,
    events: [{ key: 'cpi', date: '2026-11-25', at: '2026-11-25T13:30:00Z' }], prices: { lpGold: 0.1 } }, now);
  assert.equal(calm.alert.level, 0);
  assert.match(calm.lines[0].text, /🟢/);
  assert.match(calm.lines[3].text, /25/);              // names the next release date instead
});
