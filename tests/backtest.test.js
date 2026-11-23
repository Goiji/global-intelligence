// Backtest tab: crisis vs normal stats computed from the embedded monthly data — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

test('backtest tab is wired into the tab bar and #backtest deep link', () => {
  assert.match(HTML, /data-tab="backtestTab"/);
  assert.match(HTML, /<section id="backtestTab" class="tabpage">/);
  assert.match(HTML, /h === 'backtest' \|\| h === 'backtesttab'\) return 'backtestTab'/);
});

test('backtest numbers match the source data', async () => {
  const sb = await runAllScripts(makeSandbox());
  const d = sb.BT_DATA;
  assert.equal(d.va.length, d.spx.length);
  assert.equal(d.spx[(2009 - 1990) * 12 + 1], 735.1);      // Feb 2009 month-end close
  assert.equal(d.ur[(2020 - 1990) * 12 + 3], 14.8);        // Apr 2020 unemployment
  const S = sb.btStats(d, sb.BT_CRISES);
  const c = Object.fromEntries(S.crises.map(r => [r.id, r]));
  assert.equal(c.gfc.peak, '2007-10'); assert.equal(c.gfc.trough, '2009-02');
  assert.equal(Math.round(c.gfc.drawdown * 1000), -526);
  assert.equal(c.gfc.vixMax, 80.9); assert.equal(c.gfc.recovered, '2013-03');
  assert.equal(c.dotcom.peak, '2000-08'); assert.equal(c.dotcom.trough, '2002-09');
  assert.equal(c.covid.trough, '2020-03'); assert.equal(c.covid.recovered, '2020-07');
  assert.equal(c.y2022.trough, '2022-09'); assert.equal(c.y2022.vixMax, 36.5);
  const top = S.zones[S.zones.length - 1];
  assert.deepEqual([...top.list], ['2008-10', '2008-11', '2008-12', '2009-01', '2009-02', '2009-03', '2020-03', '2020-04']);
  assert.equal(top.up12, 1);
  assert.ok(S.zones[2].up12 < S.zones[0].up12, '20–25 zone weaker than calm months');
  assert.ok(S.crisis.vixAvg > S.normal.vixAvg);
});

test('unemployment peaks after the market bottom in the job-loss crises', async () => {
  const sb = await runAllScripts(makeSandbox());
  const S = sb.btStats(sb.BT_DATA, sb.BT_CRISES);
  const lags = S.crises.filter(r => r.urMax - r.urStart >= 1).map(r => [r.id, r.urLag]);
  assert.deepEqual(JSON.parse(JSON.stringify(lags)), [['dotcom', 9], ['gfc', 8], ['covid', 1]]);
});
