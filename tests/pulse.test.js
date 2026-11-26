// 🧭 Market Pulse on the Overview tab + the new tab layout. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const sbCuts = (P) => P.cuts.vix;
async function page() { const sb = makeSandbox(); await runAllScripts(sb); return sb; }
const ser = (latest, change) => ({ latest, change });

test('levels follow each card\'s own bands', async () => {
  const { pulseLevel } = (await page()).__pulseTest;
  assert.equal(pulseLevel(14, [20, 30, 40]), 0);
  assert.equal(pulseLevel(26.4, [20, 30, 40]), 1);
  const vix = sbCuts((await page()).__pulseTest);
  assert.equal(pulseLevel(26.4, vix), 2, 'VIX 20–30 is what the VIX card calls nervous, not normal');
  assert.equal(pulseLevel(17, vix), 1);
  assert.equal(pulseLevel(49.4, [25, 40, 60]), 2);
  assert.equal(pulseLevel(150, [80, 110, 140]), 3);
});

test('overall state: the average, but never hiding hot gauges', async () => {
  const { pulseState } = (await page()).__pulseTest;
  assert.equal(pulseState([0, 0, 0, 1]).i, 0);
  assert.equal(pulseState([1, 1, 1, 2]).i, 1);
  assert.equal(pulseState([2, 1, 1, 2]).i, 2, 'two gauges worried → worried');
  assert.equal(pulseState([2, 1, 1, 2]).label, 'กังวล');
  assert.equal(pulseState([0, 0, 0, 3]).i, 2, 'one gauge in stress lifts the whole to at least worried');
  assert.equal(pulseState([2, 2, 2, 1]).i, 2);
  assert.equal(pulseState([3, 3, 2, 3]).i, 3);
  assert.equal(pulseState([]), null);
});

test('big moves: thresholds and direction', async () => {
  const { pulseMoves } = (await page()).__pulseTest;
  const mv = pulseMoves({ sp500: ser(7201, -36.2), nasdaq100: ser(26214, -532), vix: ser(26.4, -0.27), us10y: ser(4.90, -0.01), hyOas: ser(3.1, 0.2), dollar: ser(100, 0.1) });
  const t = mv.map((m) => m.txt).join(' | ');
  assert.doesNotMatch(t, /S&P 500/, '-0.5% is not unusual');
  assert.match(t, /Nasdaq 100 -2\.0%/);
  assert.doesNotMatch(t, /VIX|บอนด์|ดอลลาร์/);
  assert.match(t, /HY spread \+20 bp/);
  assert.equal(mv.find((m) => /HY/.test(m.txt)).bad, true);
});

test('render fills the card from the markets payload', async () => {
  const sb = await page();
  sb.__pulseTest.renderPulse({ vix: ser(26.36, -0.27), move: ser(98.8, -2), hyOas: ser(3.2, 0), ovx: ser(49.4, 0.2), sp500: ser(7201, -36) });
  const g = (id) => sb.document.getElementById(id);
  assert.equal(g('pulseState').dataset.level, '2', 'VIX 26 + OVX 49 is not a normal day');
  assert.match(g('pulseState').innerHTML, /กังวล/);
  assert.match(g('pulseWhy').textContent, /VIX[\s\S]*OVX/);
  assert.match(g('pulseGauges').innerHTML, /data-go="mkHy"/, 'tiles open their full card');
  for (const id of ['mkVix', 'mkMove', 'mkHy', 'mkOvx']) assert.match(HTML, new RegExp('id="' + id + '"'));
  assert.equal((g('pulseGauges').innerHTML.match(/class="pg" /g) || []).length, 4);
  assert.match(g('pulseMoves').innerHTML, /ไม่มีตัวไหนขยับผิดปกติ/);
});

test('layout: Overview leads with the pulse; headline scores live in the News tab with their caveats', () => {
  const over = HTML.slice(HTML.indexOf('<section id="newsTab"'), HTML.indexOf('<section id="marketsTab"'));
  const feed = HTML.slice(HTML.indexOf('<section id="feedTab"'), HTML.indexOf('<section id="newsTab"'));
  assert.ok(over.indexOf('id="pulseCard"') > -1 && over.indexOf('id="pulseCard"') < over.indexOf('data-en="Market Prices"'));
  assert.doesNotMatch(over, /data-en="World Risk Score"|data-en="News Outlook"/);
  assert.match(feed, /data-en="World Risk Score"[\s\S]*อ่านจากพาดหัวข่าว ไม่ใช่ราคา[\s\S]*data-en="Top Events"[\s\S]*data-en="Latest News"[\s\S]*data-en="News Outlook"[\s\S]*คิดต่อจาก World Risk Score/);
  assert.match(HTML, /data-tab="newsTab" data-en="🏠 Overview">🏠 ภาพรวม<[\s\S]*data-tab="feedTab"[\s\S]*data-tab="btcTab">₿ Bitcoin<[\s\S]*data-tab="backtestTab"/);
});
