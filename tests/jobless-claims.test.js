// Weekly Initial Jobless Claims: FRED ICSA parsing, the Thursday (holiday → Wednesday) schedule,
// the calendar entries, the Investing.com consensus parse, and the dashboard tile + analysis card.
// No network access is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test: fred } = require('../netlify/functions/fred-data.js');
const { __test: cal } = require('../netlify/functions/calendar.js');
const { __test: cons } = require('../netlify/functions/consensus.js');
const { makeSandbox, runAllScripts } = require('./dom-stub.js');

// ── server: ICSA ──────────────────────────────────────────────────────────────────────────────
const CSV = [
  'observation_date,ICSA',
  '2026-09-26,201000', '2026-10-03,198000', '2026-10-10,197000',
  '2026-10-17,196000', '2026-10-24,194000', '2026-10-31,189000'
].join('\n');

test('claimsFromLevels reads the latest week, the week before and the 4-week averages', () => {
  const r = fred.claimsFromLevels(fred.parseFredCsv(CSV), 'fred-csv');
  assert.equal(r.value, 189000);
  assert.equal(r.date, '2026-10-31');
  assert.deepEqual(r.prev, { value: 194000, date: '2026-10-24' });
  assert.equal(r.change, -5000);
  assert.equal(r.avg4, Math.round((189000 + 194000 + 196000 + 197000) / 4));
  assert.equal(r.prevAvg4, Math.round((194000 + 196000 + 197000 + 198000) / 4));
});

test('a missing week stops the run instead of faking a week-over-week change', () => {
  const obs = fred.parseFredCsv('observation_date,ICSA\n2026-10-17,196000\n2026-10-31,189000');
  const r = fred.claimsFromLevels(obs, 'fred-csv');
  assert.equal(r.value, 189000);
  assert.equal(r.prev, undefined);
  assert.equal(r.avg4, undefined);
});

test('implausible values are rejected', () => {
  assert.throws(() => fred.claimsFromLevels([{ date: '2026-10-31', value: 189 }], 'x'), /no usable ICSA/);
});

test('claims are fetched from FRED ICSA (weekly window)', () => {
  assert.equal(fred.TARGETS.claims.fred, 'ICSA');
  assert.equal(fred.TARGETS.claims.cadence, 'weekly');
});

// ── server: schedule ──────────────────────────────────────────────────────────────────────────
test('claims come out on Thursday, or Wednesday when Thursday is a holiday', () => {
  assert.equal(fred.claimsReleaseDate(new Date('2026-11-02T00:00:00Z')), '2026-11-05'); // normal week
  assert.equal(fred.claimsReleaseDate(new Date('2026-11-23T00:00:00Z')), '2026-11-25'); // Thanksgiving Thu 26
  assert.equal(fred.claimsReleaseDate(new Date('2026-12-21T00:00:00Z')), '2026-12-24'); // Christmas is a Friday
  assert.equal(fred.claimsReleaseDate(new Date('2025-06-16T00:00:00Z')), '2025-06-18'); // Juneteenth Thu
  assert.deepEqual(fred.upcomingClaimsDates(2, new Date('2026-11-05T15:00:00Z')), ['2026-11-05', '2026-11-12']);
});

test('Thursday counts as a release day and claims are awaited after 12:25 UTC', () => {
  const thu = new Date('2026-11-05T13:00:00Z');
  const r = fred.isReleaseDay(thu);
  assert.equal(r.claimsDay, true);
  assert.equal(r.release, true);
  assert.deepEqual(fred.awaitingFields({ claims: { date: '2026-10-24' } }, thu), ['claims']);
  assert.deepEqual(fred.awaitingFields({ claims: { date: '2026-10-31' } }, thu), []);
});

test('the calendar lists the next two claims releases at 8:30 ET', () => {
  // 5 Nov 2026 is after the DST change → 8:30 ET = 13:30 UTC = 20:30 Bangkok
  const ev = cal.claimsEvents(new Date('2026-11-04T00:00:00Z'));
  assert.deepEqual(ev.map((e) => e.date), ['2026-11-05', '2026-11-12']);
  assert.equal(ev[0].at, '2026-11-05T13:30:00.000Z');
  assert.equal(ev[0].key, 'claims');
  // summer: 12:30 UTC = 19:30 Bangkok
  assert.equal(cal.claimsEvents(new Date('2026-07-06T00:00:00Z'))[0].at, '2026-07-09T12:30:00.000Z');
});

test('the consensus parser reads Investing.com\'s "189K" style numbers', () => {
  const html = '<div>Latest Release Nov 05, 2026 Actual 189K Forecast 196K Previous 194K</div>';
  const p = cons.parseEventPage(html);
  assert.equal(p.actual, 189000);
  assert.equal(p.forecast, 196000);
  assert.equal(p.previous, 194000);
  assert.equal(p.releaseDate, '2026-11-05');
});

// ── frontend ──────────────────────────────────────────────────────────────────────────────────
const DAY = 86400000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function stub({ fredClaims, claimsEv, calendar = { events: [] } }) {
  return async (url) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    const no = { ok: false, status: 502, json: async () => ({}), text: async () => '' };
    if (u.includes('/.netlify/functions/consensus-override')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (u.includes('/.netlify/functions/consensus')) return claimsEv ? ok({ source: 'investing.com', sourceLabel: 'Investing.com', ttl: 600, events: { claims: claimsEv } }) : no;
    if (u.includes('/.netlify/functions/fred-data')) {
      return ok({ fetchedAt: new Date(NOW).toISOString(), unrate: { value: 4.2, date: '2026-09-01', source: 'fred-csv' }, claims: fredClaims, fieldsOk: 2, fieldsTotal: 9 });
    }
    if (u.includes('/.netlify/functions/calendar')) return calendar ? ok(calendar) : no;
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}
const node = (sb, id) => sb.document.getElementById(id);

const WEEK_END = iso(NOW - 5 * DAY);
const RELEASE = iso(NOW);
const FRED_CLAIMS = { value: 189000, date: WEEK_END, prev: { value: 194000, date: iso(NOW - 12 * DAY) }, change: -5000, avg4: 194000, prevAvg4: 196250, source: 'fred-csv' };
const LIVE = { actual: 189000, forecast: 196000, previous: 194000, releaseDate: RELEASE };

test('the claims tile shows actual, forecast and previous', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ fredClaims: FRED_CLAIMS, claimsEv: LIVE }) }));
  assert.equal(node(sb, 'claims').textContent, '189K');
  assert.match(node(sb, 'claims').className, /\bup\b/, 'below forecast = better than expected');
  const info = node(sb, 'claimsInfo').innerHTML;
  assert.match(info, /สัปดาห์สิ้นสุด/);
  assert.match(info, /คาด <b>196K<\/b>/);
  assert.match(info, /ครั้งก่อน 194K/);
});

test('the analysis card judges claims against the forecast', async () => {
  const h = node(await runAllScripts(makeSandbox({ fetchImpl: stub({ fredClaims: FRED_CLAIMS, claimsEv: LIVE }) })), 'fedAnalysis').innerHTML;
  assert.match(h, /Initial Jobless Claims — 🟢 ต่ำกว่าคาด \(ดี\)/);
  assert.match(h, /ตลาดคาด 196K \(ต่ำกว่าคาด 7K\)/);
  assert.match(h, /สัปดาห์ก่อน = 194K \(−5K\)/);
  assert.match(h, /ค่าเฉลี่ย 4 สัปดาห์ = 194K \(ลดลง\)/);
});

test('when FRED has not caught up yet, Investing.com\'s actual is shown', async () => {
  const old = { ...FRED_CLAIMS, value: 194000, date: iso(NOW - 12 * DAY), prev: null };
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ fredClaims: old, claimsEv: LIVE }) }));
  assert.equal(node(sb, 'claims').textContent, '189K');
  assert.match(node(sb, 'claimsInfo').innerHTML, /ประกาศ .* · คาด <b>196K<\/b> · ครั้งก่อน 194K/);
});

test('a forecast from another week is never attached to the FRED print', async () => {
  const stale = { ...LIVE, releaseDate: iso(NOW - 14 * DAY), actual: 200000 };
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ fredClaims: FRED_CLAIMS, claimsEv: stale }) }));
  assert.equal(node(sb, 'claims').textContent, '189K');
  assert.match(node(sb, 'claimsInfo').innerHTML, /ยังไม่มีค่าคาด/);
});

test('the calendar falls back to a computed Thursday when the server has no claims', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ fredClaims: FRED_CLAIMS, claimsEv: null, calendar: null }) }));
  assert.match(node(sb, 'calList').innerHTML, /ผู้ขอรับสวัสดิการว่างงาน \(รายสัปดาห์\)/);
  assert.match(node(sb, 'nextClaims').innerHTML, /(ครั้งถัดไป|ประกาศ)/);
});
