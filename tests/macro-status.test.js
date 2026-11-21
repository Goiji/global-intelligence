// US Macro cards (Fed, CPI, Core PCE, PPI, jobs): big-number colour = status dot = analysis box,
// judged by level (what it means for markets), like the Real Yield card. Beat/miss vs forecast
// is text only. Also checks the card order (Core PCE, the Fed's target gauge, comes before CPI).
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

test('macro verdict thresholds', async () => {
  const sb = makeSandbox();
  await runAllScripts(sb);
  const V = sb.macroVerdicts;
  const dot = (v) => v.dot;
  assert.equal(dot(V.inflation(2.4)), '🟢');
  assert.equal(dot(V.inflation(2.5)), '🟡');
  assert.equal(dot(V.inflation(3.0)), '🔴');
  assert.equal(dot(V.ppi(6.5, 0.3)), '🔴');   // PPI 6.5% YoY must not read green
  assert.equal(dot(V.ppi(3.0, 0.3)), '🟡');
  assert.equal(dot(V.ppi(null, 0.2)), '🟢');
  assert.equal(dot(V.ppi(null, 0.5)), '🔴');
  assert.equal(dot(V.unrate(4.1, 0.1)), '🟢');
  assert.equal(dot(V.unrate(4.1, 0.3)), '🟡');
  assert.equal(dot(V.unrate(4.6, 0)), '🟡');
  assert.equal(dot(V.unrate(4.2, 0.5)), '🔴');
  assert.equal(dot(V.nfp(165000)), '🟢');
  assert.equal(dot(V.nfp(80000)), '🟡');
  assert.equal(dot(V.nfp(-10000)), '🔴');
  assert.equal(dot(V.claims(203000)), '🟢');
  assert.equal(dot(V.claims(250000)), '🟡');
  assert.equal(dot(V.claims(300000)), '🔴');
  assert.equal(dot(V.fed(0.25, true)), '🔴');
  assert.equal(dot(V.fed(-0.25, true)), '🟢');
  assert.equal(dot(V.fed(0.25, false)), '🟡');
});

test('every US Macro card has a status line and explains its colours in the (i) tooltip', () => {
  const grid = HTML.slice(HTML.indexOf('id="fedMetrics"'), HTML.indexOf('id="fedAsOf"'));
  for (const id of ['fedRange', 'fedEffr', 'corePce', 'cpiYoy', 'ppiHead', 'unrate', 'nfp', 'claims']) {
    assert.match(grid, new RegExp(`id="${id}Zone"`), `#${id}Zone missing`);
  }
  assert.equal((grid.match(/สีบนการ์ด \(ผลต่อตลาด\)/g) || []).length, 8);
  assert.equal((grid.match(/Colours on the card \(market effect\)/g) || []).length, 8);
});

test('Core PCE card comes before the CPI card', () => {
  const grid = HTML.slice(HTML.indexOf('id="fedMetrics"'), HTML.indexOf('id="fedAsOf"'));
  const order = [...grid.matchAll(/<div class="num" id="(\w+)">/g)].map((m) => m[1]);
  assert.deepEqual(order, ['fedRange', 'fedEffr', 'corePce', 'cpiYoy', 'ppiHead', 'unrate', 'nfp', 'claims']);
});
