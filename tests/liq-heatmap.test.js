// BTC liquidation heatmap: the estimate model (pure helpers exposed as window.__liqTest).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { HTML, SCRIPTS, makeSandbox } = require('./dom-stub.js');

async function load() {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const api = (sandbox.window && sandbox.window.__liqTest) || sandbox.__liqTest;
  assert.ok(api, '__liqTest helpers missing');
  return api;
}

const H = 3600000;
const flat = (n, px, extra = {}) => Array.from({ length: n }, (_, i) => ({ t: i * H, h: px * 1.001, l: px * 0.999, c: px, vol: 1e8, buy: 5e7, ...extra }));

test('liquidation price: long below entry, short above, tighter with more leverage', async () => {
  const { liqPrice } = await load();
  assert.ok(Math.abs(liqPrice(100000, 10, 'long') - 90500) < 1e-6);
  assert.ok(Math.abs(liqPrice(100000, 10, 'short') - 109500) < 1e-6);
  assert.ok(liqPrice(100000, 100, 'long') > liqPrice(100000, 25, 'long'));
});

test('heatmap: levels build up on both sides, and price running through wipes them', async () => {
  const { buildLiqHeatmap, liqClusters } = await load();
  const oi = new Map(flat(60, 100000).map((c, i) => [c.t, 1e9 + i * 1e7]));
  let hm = buildLiqHeatmap(flat(60, 100000), oi, { show: 24, bins: 100 });
  assert.equal(hm.cols, 24);
  assert.equal(hm.longM.length, 24 * 100);
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  assert.ok(sum(hm.curL) > 0 && sum(hm.curS) > 0);
  const cl = liqClusters(hm);
  assert.ok(cl.up.price > 100000 && cl.down.price < 100000);

  // a final candle that spikes +12% liquidates every short at or below its high
  const spike = flat(60, 100000);
  spike.push({ t: 60 * H, h: 112000, l: 100000, c: 111000, vol: 0, buy: 0 });
  hm = buildLiqHeatmap(spike, oi, { show: 24, bins: 100 });
  hm.curS.forEach((v, b) => { if (hm.lo + (b + 1) * hm.step < 112000) assert.equal(v, 0); });
});

test('scale multiplies the estimate; junk rows are dropped by the parsers', async () => {
  const { buildLiqHeatmap, parseBinanceKlines, parseBinanceOiHist, parseOkxCandles, fmtLiqUsd, liqColor } = await load();
  const a = buildLiqHeatmap(flat(30, 50000), null, { bins: 50 });
  const b = buildLiqHeatmap(flat(30, 50000), null, { bins: 50, scale: 3 });
  const s = (h) => h.curL.reduce((x, v) => x + v, 0);
  assert.ok(Math.abs(s(b) / s(a) - 3) < 1e-9);

  const k = parseBinanceKlines([[0, '1', '2', '0.5', '1.5', '10', 1, '15', 3, '6', '9'], [H, 'x', '0', '0', '0']]);
  assert.equal(k.length, 1);
  assert.deepEqual({ ...k[0] }, { t: 0, h: 2, l: 0.5, c: 1.5, vol: 15, buy: 9 });
  const oi = parseBinanceOiHist([{ sumOpenInterestValue: '7e9', timestamp: 2 * H }, { sumOpenInterestValue: 'bad', timestamp: 3 * H }]);
  assert.deepEqual([...oi.entries()], [[H, 7e9]]);
  const okx = parseOkxCandles({ data: [[String(H), '1', '2', '1', '1.5', '1', '1', '30', '1'], ['0', '1', '2', '1', '1.2', '1', '1', '20', '1']] });
  assert.deepEqual(okx.map((c) => c.t), [0, H]);
  assert.equal(fmtLiqUsd(1.25e9), '$1.25B');
  assert.equal(fmtLiqUsd(4.2e6), '$4.2M');
  assert.deepEqual([...liqColor(0)], [10, 7, 22]);
  assert.deepEqual([...liqColor(1)], [246, 228, 80]);
});

test('index.html: heatmap panel says it is an estimate and links to Coinglass', () => {
  for (const id of ['liqCanvas', 'liqWrap', 'liqHover', 'liqMsg', 'liqSum', 'liqSrc', 'liqRanges']) assert.match(HTML, new RegExp(`id="${id}"`));
  assert.match(HTML, /coinglass\.com\/pro\/futures\/LiquidationHeatMap/);
  assert.match(HTML, /เป็นค่าประมาณ/);
});
