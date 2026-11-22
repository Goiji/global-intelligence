// Shiller PE (CAPE) card (markets: cape ← multpl.com monthly table) — run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const markets = require('../netlify/functions/markets.js');
const T = markets.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Same shape as https://www.multpl.com/shiller-pe/table/by-month (newest first, odd/even rows,
// the number on its own line, today's estimate as the first row).
function multplHtml(rows) {
  return '<div class="tcol">\n\n<table id="datatable">\n\n<tbody><tr>\n<th>Date</th>\n<th>Value</th>\n</tr>\n\n\n'
    + rows.map(([d, v], i) => {
      const [y, m, day] = d.split('-').map(Number);
      return `<tr class="${i % 2 ? 'even' : 'odd'}">\n<td>${MON[m - 1]} ${day}, ${y}</td>\n<td>\n ${i === 0 ? '&#x2002;' : ''}\n${v.toFixed(2)}\n</td>\n</tr>\n`;
    }).join('\n') + '</tbody></table></div>';
}
// month-start rows 2000-01 … 2026-11 (value 10 + month index / 20), Dec 1999 peak 44.19, today's estimate 36.44
function sampleRows() {
  const rows = [['2026-11-20', 36.44]];
  let k = 0;
  const monthly = [];
  for (let y = 2000; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
    if (y === 2026 && m > 11) break;
    monthly.push([`${y}-${String(m).padStart(2, '0')}-01`, 10 + (k++) / 20]);
  }
  monthly.push(['1999-12-01', 44.19]);
  return rows.concat(monthly.sort((a, b) => (a[0] < b[0] ? 1 : -1)));
}

test('parseMultplTable: reads every row (dates, estimate marker, junk skipped) oldest first', () => {
  const html = multplHtml(sampleRows()) + '<tr><td>Not a date</td><td>12</td></tr><tr><td>Jan 1, 1990</td><td>n/a</td></tr>';
  const rows = T.parseMultplTable(html);
  assert.equal(rows.length, sampleRows().length);
  assert.deepEqual(rows[0], { date: '1999-12-01', value: 44.19 });
  assert.deepEqual(rows[rows.length - 1], { date: '2026-11-20', value: 36.44 });
  assert.deepEqual(T.parseMultplTable('<html>blocked</html>'), []);
});

test('capeSummary: latest estimate, change vs month start, long-run stats from month-start rows only', () => {
  const rows = T.parseMultplTable(multplHtml(sampleRows()));
  const s = T.capeSummary(rows);
  assert.equal(s.latest, 36.44);
  assert.equal(s.date, '2026-11-20');
  assert.equal(s.prevDate, '2026-11-01');
  const monthly = rows.filter((o) => o.date.endsWith('-01')).map((o) => o.value);
  const mean = monthly.reduce((a, b) => a + b, 0) / monthly.length;
  assert.equal(s.mean, Math.round(mean * 100) / 100);     // the live 36.44 row is not in the average
  assert.equal(s.months, monthly.length);
  assert.equal(s.peak, 44.19);
  assert.equal(s.peakDate, '1999-12-01');
  assert.equal(s.since, '1999-12-01');
  assert.equal(s.change, Math.round((36.44 - s.prev) * 100) / 100);
  assert.equal(s.timesMean, Math.round(36.44 / mean * 100) / 100);
  assert.ok(s.pctile > 0 && s.pctile < 100);
  assert.ok(s.yearAgo > 0);
  assert.equal(s.hist[0][0], '2016-12-01');                // 10 years of months
  assert.deepEqual(s.hist[s.hist.length - 1], ['2026-11-20', 36.44]);
  assert.throws(() => T.capeSummary(rows.slice(0, 5)), /too few/);
});

test('markets handler: cape series from multpl; a failed fetch leaves the rest of the payload alone', async (t) => {
  T._clearCache();
  const realFetch = global.fetch;
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    if (url === T.MULTPL_CAPE) return { ok: true, status: 200, text: async () => multplHtml(sampleRows()) };
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const body = JSON.parse((await markets.handler()).body);
  assert.equal(body.series.cape.latest, 36.44);
  assert.equal(body.series.cape.source, 'multpl');
  assert.equal(seen.filter((u) => u === T.MULTPL_CAPE).length, 1);

  T._clearCache();
  global.fetch = async (url) => (url === T.MULTPL_CAPE ? { ok: false, status: 403, text: async () => '' }
    : url.includes('fredgraph.csv?id=VIXCLS') ? { ok: true, status: 200, text: async () => 'observation_date,VIXCLS\n2026-11-19,20\n2026-11-20,21' }
    : { ok: false, status: 503, text: async () => '' });
  const b2 = JSON.parse((await markets.handler()).body);
  assert.match(b2.errors.cape, /403/);
  assert.ok(b2.series.vix);
});

test('index.html: CAPE card with (i) colours, meaning line and source note; colour follows one verdict', async () => {
  for (const id of ['capeCard', 'mkCape', 'spCape', 'mkCapeZone', 'mkCapeInfo', 'mkCapeMeaning']) {
    assert.match(HTML, new RegExp(`id="${id}"`), `missing #${id}`);
  }
  const card = HTML.slice(HTML.indexOf('id="capeCard"'), HTML.indexOf('id="mkCapeMeaning"'));
  assert.match(card, /🟢 ต่ำกว่า 20/);
  assert.match(card, /🔴 30 ขึ้นไป/);
  assert.match(card, /🔴 30 or more/);
  assert.match(HTML, /Shiller PE จาก multpl\.com/);
  assert.match(HTML, /Shiller PE from multpl\.com/);

  const sb = makeSandbox();
  await runAllScripts(sb);
  assert.equal(sb.capeVerdict(19.99).key, 'fair');
  assert.equal(sb.capeVerdict(20).key, 'above');
  assert.equal(sb.capeVerdict(29.99).key, 'above');
  assert.equal(sb.capeVerdict(30).key, 'high');
  assert.equal(sb.capeVerdict(null), null);

  const els = sb.__elements;
  const base = { prev: 39.82, prevDate: '2026-11-01', change: -3.38, date: '2026-11-20', mean: 17.46, median: 16.15,
    peak: 44.19, peakDate: '1999-12-01', pctile: 96.8, months: 1870, yearAgo: 38.6, since: '1871-01-01',
    hist: [['2016-12-01', 28.1], ['2026-11-20', 36.44]] };
  for (const [latest, cls, dot] of [[36.44, 'tone-bad', /🔴/], [24, 'tone-warn', /🟡/], [15, 'tone-good', /🟢/]]) {
    sb.renderCape({ ...base, latest, timesMean: Math.round(latest / 17.46 * 100) / 100 });
    assert.equal(els.get('mkCape').textContent, latest.toFixed(2));
    assert.match(els.get('mkCape').className, new RegExp(cls));     // big number = status colour
    assert.match(els.get('mkCapeZone').className, new RegExp(cls));
    assert.match(els.get('mkCapeZone').textContent, dot);
    assert.match(els.get('mkCapeZone').textContent, /17\.46 \(ตั้งแต่ 1871\)/);
    assert.match(els.get('mkCapeInfo').textContent, /ต้นเดือน 39\.82 · สูงสุด 44\.19 \(ธ\.ค\. 1999\)/);
    assert.match(els.get('mkCapeMeaning').innerHTML, /^<b>ความหมาย:<\/b> /);
  }
  sb.renderCape({ ...base, latest: 36.44 });
  assert.match(els.get('mkCapeMeaning').innerHTML, /แพงกว่า 97% ของทุกเดือนในอดีต/);
  sb.renderCape(null);
  assert.match(els.get('mkCapeZone').textContent, /⚪/);
  assert.equal(els.get('mkCapeMeaning').innerHTML, '');
});
