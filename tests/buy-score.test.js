// BTC Buy Score: 4 independent angles (no double counting), shared MVRV source, honest labels,
// plus the rounding / confirmation rules on the GEX and miner cards. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

async function page() {
  const sb = makeSandbox();
  await runAllScripts(sb);
  return sb;
}
const g = (sb, id) => sb.document.getElementById(id);

function setValuation(sb, nupl, z, m) {
  for (const [id, v] of [['nuplNum', nupl], ['zNum', z], ['mNum', m]]) g(sb, id).value = String(v);
}

test('score = mean of the 4 angles; NUPL/MVRV/MVRV-Z count as one', async () => {
  const sb = await page();
  setValuation(sb, 0.15, 0.3, 1.18);
  sb.giBtcSignals = {};
  sb.__buyTest.recompute();
  const onlyValuation = parseFloat(g(sb, 'scoreNumber').textContent);
  assert.match(g(sb, 'breakdown').innerHTML, /1 จาก 4 มุม/);
  sb.giBtcSignals = { sthRatio: 0.8, plPos: 0.08, puell: 0.87 };
  sb.__buyTest.recompute();
  const all = parseFloat(g(sb, 'scoreNumber').textContent);
  assert.match(g(sb, 'breakdown').innerHTML, /4 จาก 4 มุม/);
  assert.ok(all > 0 && all <= 10);
  assert.notEqual(all, onlyValuation);
  assert.doesNotMatch(g(sb, 'breakdown').innerHTML, /โบนัส|bonus/i, 'no ATH bonus any more');
});

test('verdict describes price vs history, never "Strong Buy"', async () => {
  const sb = await page();
  setValuation(sb, -0.2, -1, 0.85);
  sb.giBtcSignals = { sthRatio: 0.7, plPos: 0.02, puell: 0.45 };
  sb.__buyTest.recompute();
  assert.match(g(sb, 'verdict').textContent, /ถูกมากเมื่อเทียบกับประวัติ/);
  assert.doesNotMatch(HTML, /Strong Buy|Accumulate\)/);
  setValuation(sb, 0.8, 8, 4);
  sb.giBtcSignals = { sthRatio: 2.2, plPos: 0.97, puell: 3.5 };
  sb.__buyTest.recompute();
  assert.match(g(sb, 'verdict').textContent, /แพงมาก/);
});

test('MVRV and NUPL follow the shared source used by the cost card', async () => {
  const sb = await page();
  g(sb, 'mManualRow').style.display = 'none';
  g(sb, 'nuplManualRow').style.display = 'none';
  sb.giBtcSignals = { mvrv: 1.11, nupl: 1 - 1 / 1.11 };
  sb.__buyTest.applySharedValuation();
  assert.equal(g(sb, 'mNum').value, '1.11');
  assert.equal(g(sb, 'nuplNum').value, (1 - 1 / 1.11).toFixed(3));
  // typed values win when the manual row is open
  g(sb, 'mManualRow').style.display = 'flex';
  g(sb, 'mNum').value = '2.00';
  sb.__buyTest.applySharedValuation();
  assert.equal(g(sb, 'mNum').value, '2.00');
});

test('GEX hedge sizes are rounded to two significant digits', async () => {
  const sb = await page();
  const r = sb.__optTest.gexRoughBtc;
  assert.equal(r(20389), '20k');
  assert.equal(r(-9888), '9.9k');
  assert.equal(r(6933), '6.9k');
  assert.equal(r(457), '460');
  assert.equal(r(0), '0');
  assert.match(HTML, /class="model-note"[^>]*>⚙️ เป็นแบบจำลอง/);
});

test('miners: a 1–2 day Hash Ribbons cross is only an early sign', async () => {
  const sb = await page();
  const M = sb.__mineTest;
  assert.equal(M.minerVerdict('capitulation', 0.87, 0.05, false, 1).key, 'watch');
  assert.equal(M.minerVerdict('capitulation', 0.87, 0.05, false, 3).key, 'stress');
  assert.equal(M.minerVerdict('capitulation', 0.87, 0.05, true, 1).key, 'stress', 'price below power still counts');
});

test('labels: no "Live" header over daily FX, gainers say they are a tracked list, og points at Cloudflare', () => {
  assert.doesNotMatch(HTML, /Live · เทียบ 24 ชม\./);
  assert.match(HTML, /จากหุ้นใหญ่ราว 260 ตัวที่ติดตาม/);
  assert.doesNotMatch(HTML, /netlify\.app/);
  assert.match(HTML, /<meta property="og:url" content="https:\/\/globalintelligence\.pages\.dev\/">/);
});
