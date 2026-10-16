// Tests for the PPI tile and the "ประกาศครั้งถัดไป · ตลาดคาด …" lines in index.html: the forecast for a
// release that hasn't happened yet must show up BEFORE the number is out (tiles, analysis, calendar),
// and must never be attached to a different release than the one on the calendar.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
// releases relative to "now" so the tests don't rot: PPI in 3 days, CPI in 4, jobs in 10
const NOW = Date.now();
const PPI_AT = NOW + 3 * DAY;
const CPI_AT = NOW + 4 * DAY;
const JOBS_AT = NOW + 10 * DAY;

function calendar() {
  return {
    events: [
      { key: 'ppi', date: iso(PPI_AT), at: new Date(PPI_AT).toISOString() },
      { key: 'cpi', date: iso(CPI_AT), at: new Date(CPI_AT).toISOString() },
      { key: 'jobs', date: iso(JOBS_AT), at: new Date(JOBS_AT).toISOString() }
    ]
  };
}

function fred(overrides = {}) {
  return {
    fetchedAt: new Date(NOW).toISOString(),
    cpi: { value: 3.1, date: '2026-09-01', source: 'fred-csv' },
    ppi: { value: 0.52, date: '2026-09-01', source: 'fred-csv', yoy: 2.7, prev: { value: -0.1, date: '2026-08-01' }, changePp: 0.62 },
    unrate: { value: 4.2, date: '2026-09-01', source: 'fred-csv' },
    fieldsOk: 3, fieldsTotal: 8,
    ...overrides
  };
}

function consensus(upcomingPpiDate = iso(PPI_AT)) {
  return {
    source: 'investing.com', sourceLabel: 'Investing.com', ttl: 600,
    events: {
      cpi: { actual: 3.1, forecast: 3.0, previous: 2.9, releaseDate: '2026-10-14', upcoming: { releaseDate: iso(CPI_AT), forecast: 3.2, previous: 3.1 } },
      coreCpi: { actual: 2.9, forecast: 2.9, previous: 2.9, releaseDate: '2026-10-14', upcoming: { releaseDate: iso(CPI_AT), forecast: 3.0, previous: 2.9 } },
      ppi: { actual: 0.5, forecast: 0.2, previous: -0.1, releaseDate: '2026-10-15', upcoming: { releaseDate: upcomingPpiDate, forecast: 0.3, previous: 0.5 } },
      unrate: { actual: 4.2, forecast: 4.2, previous: 4.1, releaseDate: '2026-10-02', upcoming: { releaseDate: iso(JOBS_AT), forecast: 4.3, previous: 4.2 } },
      nfp: { actual: 90000, forecast: 60000, previous: 162000, releaseDate: '2026-10-02', upcoming: { releaseDate: iso(JOBS_AT), forecast: 70000, previous: 90000 } },
      fed: { actual: 3.75, forecast: 3.75, previous: 3.75, releaseDate: '2026-09-16' }
    }
  };
}

function stub({ fredPayload = fred(), cons = consensus(), cal = calendar() } = {}) {
  return async (url) => {
    const u = String(url);
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
    if (u.includes('/.netlify/functions/consensus-override')) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    if (u.includes('/.netlify/functions/consensus')) return cons ? ok(cons) : { ok: false, status: 502, json: async () => ({}), text: async () => '' };
    if (u.includes('/.netlify/functions/fred-data')) return ok(fredPayload);
    if (u.includes('/.netlify/functions/calendar')) return cal ? ok(cal) : { ok: false, status: 502, json: async () => ({}), text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

const node = (sb, id) => sb.document.getElementById(id);

test('the PPI tile shows the headline MoM print with its month and YoY', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub() }));
  assert.equal(node(sb, 'ppiMom').textContent, '+0.5%');
  assert.match(node(sb, 'ppiYoy').textContent, /ก\.ย\. 2026 · YoY 2\.7%/);
  assert.match(node(sb, 'fedAsOf').innerHTML, /PPI ก\.ย\. 2026 \+0\.5% MoM/);
});

test('tiles show the next release date and the forecast before the number is out', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub() }));
  assert.match(node(sb, 'nextPpi').innerHTML, /ครั้งถัดไป .* น\. · ตลาดคาด <b>\+0\.3%<\/b>/);
  assert.match(node(sb, 'nextCpi').innerHTML, /ตลาดคาด <b>3\.2%<\/b> \(Core 3\.0%\)/);
  assert.match(node(sb, 'nextNfp').innerHTML, /ตลาดคาด <b>\+70,000 ตำแหน่ง<\/b>/);
  assert.match(node(sb, 'nextUnrate').innerHTML, /ตลาดคาด <b>4\.3%<\/b>/);
});

test('the analysis judges PPI against its consensus and carries the next forecast', async () => {
  const h = node(await runAllScripts(makeSandbox({ fetchImpl: stub() })), 'fedAnalysis').innerHTML;
  // 0.52 → 0.5 vs forecast 0.2 → above expectations by 0.3pp
  assert.match(h, /PPI ราคาผู้ผลิต — 🔴 สูงกว่าที่คาด/);
  assert.match(h, /ตลาดคาด \+0\.2% → สูงกว่าที่คาด 0\.3pp/);
  assert.match(h, /เร่งขึ้น/);
  assert.match(h, /ครั้งถัดไป .* ตลาดคาด <b>\+0\.3%<\/b> · ครั้งก่อน \+0\.5%/);
  assert.match(h, /ตรวจแล้วว่าค่าคาดตรงรอบเดียวกับตัวเลขบนการ์ด/, 'PPI 0.52 rounds to the published 0.5 — not a mismatch');
});

test('a forecast for a different release date is not attached to the next release', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ cons: consensus(iso(NOW - 30 * DAY)) }) }));
  const h = node(sb, 'nextPpi').innerHTML;
  assert.match(h, /ครั้งถัดไป/, 'the calendar date is still shown');
  assert.match(h, /ยังไม่มีค่าคาด/);
  assert.doesNotMatch(h, /\+0\.3%/);
});

test('the economic calendar lists the forecast next to each release', async () => {
  const cal = node(await runAllScripts(makeSandbox({ fetchImpl: stub() })), 'calList').innerHTML;
  assert.match(cal, /ตลาดคาด: MoM \+0\.3%/);
  assert.match(cal, /ตลาดคาด: CPI YoY 3\.2% · Core 3\.0%/);
  assert.match(cal, /ตลาดคาด: NFP \+70,000 ตำแหน่ง · ว่างงาน 4\.3%/);
});

test('without the consensus function the tiles still show when the next release is', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stub({ cons: null }) }));
  assert.match(node(sb, 'nextPpi').innerHTML, /ครั้งถัดไป .* · ยังไม่มีค่าคาด/);
  assert.match(node(sb, 'fedAnalysis').innerHTML, /PPI ราคาผู้ผลิต/, 'PPI is still analysed against the baked consensus');
});
