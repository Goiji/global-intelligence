// Unit tests for consensus.js — run with:  npm test
//
// The fixtures below reproduce the markup the Investing.com event pages actually render, in both
// the Thai and the English variants, including the two traps that bit the first version:
//   • Nonfarm Payrolls is reported in thousands ("162.00 พัน" / "162K"), not as a raw count
//   • the Thai release date comes with a stray space inside the month abbreviation ("ก.ย. 2026")
// A parser failure here is not fatal in production (the page falls back to the baked-in
// consensus), which is exactly why it has to be covered by tests instead of by users.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../netlify/functions/consensus.js');

const { parseEventPage, parseNumber, parseDate, toText, EVENTS } = __test;

const THAI_CPI = `
<div class="summary">
  <h1>ดัชนีราคาผู้บริโภค (CPI) สหรัฐอเมริกา</h1>
  <div class="bold">ประกาศล่าสุด</div><div>11 ก.ย. 2026</div>
  <div class="bold">ตามจริง</div><div>3.4%</div>
  <div class="bold">คาดการณ์</div><div>3.4%</div>
  <div class="bold">ก่อนหน้า</div><div>3.4%</div>
</div>
<table>
  <tr><td>11 ก.ย. 2026 ( ส.ค.)</td><td>08:30</td><td>3.4%</td><td>3.4%</td><td>3.4%</td></tr>
  <tr><td>12 ส.ค. 2026 ( ก.ค.)</td><td>08:30</td><td>3.4%</td><td>3.4%</td><td>3.5%</td></tr>
</table>`;

const THAI_NFP = `
<div class="summary">
  <h1>การจ้างงานนอกภาคการเกษตร สหรัฐอเมริกา</h1>
  <div>ประกาศล่าสุด</div><div>04 ก.ย. 2026</div>
  <div>ตามจริง</div><div>162.00 พัน</div>
  <div>คาดการณ์</div><div>55.00 พัน</div>
  <div>ก่อนหน้า</div><div>21.00 พัน</div>
</div>`;

const EN_CORE_CPI = `
<div class="summary">
  <h2>U.S. Core Consumer Price Index (CPI) YoY</h2>
  <dl>
    <dt>Latest Release</dt><dd>Sep 11, 2026</dd>
    <dt>Actual</dt><dd>2.4%</dd>
    <dt>Forecast</dt><dd>2.4%</dd>
    <dt>Previous</dt><dd>2.5%</dd>
  </dl>
</div>`;

test('toText strips scripts/styles/tags and collapses whitespace', () => {
  const text = toText('<style>a{}</style><div>กาแฟ  &amp; ชา</div><script>x=1</script>');
  assert.equal(text, 'กาแฟ & ชา');
});

test('parseNumber understands percent, Thai thousands and K/M suffixes', () => {
  assert.deepEqual(parseNumber('3.4% 3.4% ก่อนหน้า'), { value: 3.4, unit: '%' });
  assert.deepEqual(parseNumber('162.00 พัน'), { value: 162000, unit: 'พัน' });
  assert.deepEqual(parseNumber('55.00 พัน'), { value: 55000, unit: 'พัน' });
  assert.deepEqual(parseNumber('-23.00 พัน'), { value: -23000, unit: 'พัน' });
  assert.deepEqual(parseNumber('162K'), { value: 162000, unit: 'K' });
  assert.equal(parseNumber('ไม่มีข้อมูล'), null);
  assert.equal(parseNumber(''), null);
});

test('parseDate handles Thai and English release dates', () => {
  assert.equal(parseDate('11 ก.ย. 2026'), '2026-09-11');
  assert.equal(parseDate('04 ก.ย. 2026'), '2026-09-04');
  assert.equal(parseDate('02 ต.ค. 2026 (ก.ย.)'), '2026-10-02');
  assert.equal(parseDate('Sep 11, 2026'), '2026-09-11');
  assert.equal(parseDate('Dec 18, 2025'), '2025-12-18');
  assert.equal(parseDate('ไม่มี'), null);
});

test('parseEventPage reads the Thai CPI page', () => {
  assert.deepEqual(parseEventPage(THAI_CPI), {
    actual: 3.4,
    forecast: 3.4,
    previous: 3.4,
    unit: '%',
    releaseDate: '2026-09-11',
    hasAnyValue: true
  });
});

test('parseEventPage scales Nonfarm Payrolls from thousands to jobs', () => {
  const p = parseEventPage(THAI_NFP);
  assert.equal(p.actual, 162000);
  assert.equal(p.forecast, 55000);
  assert.equal(p.previous, 21000);
  assert.equal(p.releaseDate, '2026-09-04');
});

test('parseEventPage reads the English Core CPI page', () => {
  const p = parseEventPage(EN_CORE_CPI);
  assert.deepEqual([p.actual, p.forecast, p.previous], [2.4, 2.4, 2.5]);
  assert.equal(p.releaseDate, '2026-09-11');
});

test('parseEventPage is honest about pages it cannot read', () => {
  const p = parseEventPage('<html><body><h1>Just a moment…</h1><p>Checking your browser</p></body></html>');
  assert.equal(p.hasAnyValue, false, 'a Cloudflare challenge page must not look like data');
  assert.equal(p.actual, null);
  assert.equal(p.forecast, null);
});

test('the event table points at the five pages the dashboard needs', () => {
  assert.deepEqual(Object.keys(EVENTS).sort(), ['coreCpi', 'cpi', 'fed', 'nfp', 'unrate']);
  for (const [key, spec] of Object.entries(EVENTS)) {
    assert.match(spec.slug, /-\d+$/, `${key} must end with the Investing.com event id`);
    assert.ok(Array.isArray(spec.range) && spec.range.length === 2, `${key} needs a sanity range`);
  }
  assert.equal(EVENTS.cpi.slug, 'cpi-733');            // the page the user linked
  assert.equal(EVENTS.coreCpi.slug.endsWith('-736'), true);
  assert.equal(EVENTS.nfp.slug, 'nonfarm-payrolls-227');
});
