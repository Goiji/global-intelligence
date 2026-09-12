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

  // 6) The TradingView bundle must not be fetched on page load any more.
  assert.doesNotMatch(HTML, /\n\s*loadTradingViewChart\(\);/, 'TradingView is being loaded eagerly again');
});
