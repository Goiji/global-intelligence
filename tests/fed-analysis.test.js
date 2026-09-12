// Tests for the automatic "🔍 วิเคราะห์: ตัวเลขออกมาดี/แย่แค่ไหน เทียบกับที่คาด" block in index.html,
// including the consensus values that come from Investing.com.
//
// Properties under test:
//   • the analysis builds itself from the numbers that actually arrived (no hardcoded prints)
//   • good/bad/neutral is judged against the consensus, the previous month and the recent run-rate
//   • when the numbers move, the text moves with them (no code edit required)
//   • the consensus source is disclosed, and a consensus belonging to a different print is flagged
//   • when data is missing it says so instead of showing stale prose
//
// The fixtures are built *relative to* the CONSENSUS block baked into index.html, so these tests
// keep working when those five numbers are updated from Investing.com.

const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

// Pull the baked CONSENSUS out of the page (it is plain data, so a narrow regex is enough).
function bakedConsensus() {
  const m = /const CONSENSUS = \{([\s\S]*?)\n  \};/.exec(HTML);
  assert.ok(m, 'CONSENSUS block not found in index.html');
  const body = m[1];
  const num = (key) => {
    const r = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(body);
    return r ? Number(r[1]) : null;
  };
  const fed = /fed:\s*\{\s*lo:\s*(-?[\d.]+),\s*hi:\s*(-?[\d.]+)\s*\}/.exec(body);
  return {
    cpi: num('cpi'), coreCpi: num('coreCpi'), unrate: num('unrate'), nfp: num('nfp'),
    fed: fed ? { lo: Number(fed[1]), hi: Number(fed[2]) } : null,
    asOf: (/asOf:\s*'([^']+)'/.exec(body) || [])[1] || null
  };
}

const C = bakedConsensus();

// A payload in which every metric is worse than the consensus (sticky inflation, weak jobs).
function payload(overrides = {}) {
  return {
    fetchedAt: '2026-09-12T02:00:00.000Z',
    upper: { value: 3.75, date: '2026-09-11', source: 'fred-csv', prevValue: 4.0, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    lower: { value: 3.5, date: '2026-09-11', source: 'fred-csv', prevValue: 3.75, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    effr: { value: 3.63, date: '2026-09-11', source: 'fred-csv' },
    cpi: { value: C.cpi + 0.4, date: '2026-08-01', source: 'fred-csv', prev: { value: C.cpi + 0.6, date: '2026-07-01' }, changePp: -0.2 },
    coreCpi: { value: C.coreCpi + 0.3, date: '2026-08-01', source: 'fred-csv' },
    unrate: { value: C.unrate + 0.3, date: '2026-08-01', source: 'fred-csv', prev: { value: C.unrate, date: '2026-07-01' }, changeMoM: 0.3, change3m: 0.4 },
    nfp: { value: C.nfp - 120000, date: '2026-08-01', source: 'fred-csv', prevDate: '2026-07-01', unit: 'jobs', recentChanges: [C.nfp - 120000, -5000, 90000], prevChange: -5000, avg3Change: 12000 },
    fieldsOk: 7, fieldsTotal: 7,
    ...overrides
  };
}

function fetchStub({ fred = payload(), consensus = null } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/.netlify/functions/consensus')) {
      if (!consensus) return { ok: false, status: 502, json: async () => ({ error: 'blocked' }), text: async () => '' };
      return { ok: true, status: 200, json: async () => consensus, text: async () => '' };
    }
    if (u.includes('/.netlify/functions/fred-data')) {
      return { ok: true, status: 200, json: async () => fred, text: async () => '' };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

function consensusPayload(events) {
  return { source: 'investing.com', sourceLabel: 'Investing.com', fetchedAt: '2026-09-12T02:00:00.000Z', events };
}

const html = (sb) => sb.document.getElementById('fedAnalysis').innerHTML;

test('the baked consensus is real data with a date, and comes from Investing.com', () => {
  assert.ok(C.asOf, 'CONSENSUS needs an asOf date so the page can disclose its age');
  assert.ok(C.cpi > 0 && C.cpi < 15, 'implausible CPI consensus');
  assert.ok(C.coreCpi > 0 && C.coreCpi < 15, 'implausible core CPI consensus');
  assert.ok(C.unrate > 1 && C.unrate < 15, 'implausible unemployment consensus');
  assert.ok(Math.abs(C.nfp) < 2e6, 'implausible payrolls consensus');
  assert.ok(C.fed && C.fed.hi > C.fed.lo, 'the fed funds consensus range looks wrong');
  assert.match(HTML, /investing\.com/, 'the Investing.com source links are missing');
  for (const key of ['cpi', 'coreCpi', 'unrate', 'nfp', 'fed']) {
    assert.match(HTML, new RegExp(`links:[\\s\\S]*?${key}:\\s*'https://`), `CONSENSUS.links.${key} is missing`);
  }
});

test('analysis is generated from the live numbers for all four metrics', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));
  const h = html(sb);

  assert.match(h, /Fed Funds Rate/, 'Fed card missing');
  assert.match(h, /CPI เงินเฟ้อ/, 'CPI card missing');
  assert.match(h, /Unemployment Rate/, 'unemployment card missing');
  assert.match(h, /Nonfarm Payrolls/, 'payrolls card missing');

  assert.match(h, /3\.50–3\.75%|3\.50-3\.75%/, 'the live target range is not shown');
  assert.match(h, /6\.8% YoY|3\.8% YoY/, 'the live CPI print is not shown'); // C.cpi + 0.4
  assert.doesNotMatch(h, /\+162,000|3\.63% YoY/, 'hardcoded placeholder numbers leaked into the analysis');
});

test('verdicts are computed against the consensus in both directions', async () => {
  // ทุกตัวแย่กว่าที่คาด: เงินเฟ้อสูงกว่า, ว่างงานสูงกว่า, จ้างงานต่ำกว่า
  const bearish = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub() })));
  assert.match(bearish, /CPI เงินเฟ้อ — 🔴 สูงกว่าที่คาด/, 'CPI above consensus must be flagged');
  assert.match(bearish, /Unemployment Rate — 🔴 แย่กว่าที่คาด/, 'unemployment above consensus must be flagged');
  assert.match(bearish, /Nonfarm Payrolls — 🔴 แย่กว่าที่คาด/, 'payrolls below consensus must be flagged');

  // กลับกันทั้งหมด: เงินเฟ้อต่ำกว่าคาด, ว่างงานต่ำกว่าคาด, จ้างงานเกินคาด
  const bullishPayload = payload({
    cpi: { value: C.cpi - 0.5, date: '2026-09-01', source: 'fred-csv', prev: { value: C.cpi - 0.2, date: '2026-08-01' }, changePp: -0.3 },
    coreCpi: { value: C.coreCpi - 0.4, date: '2026-09-01', source: 'fred-csv' },
    unrate: { value: C.unrate - 0.3, date: '2026-09-01', source: 'fred-csv', prev: { value: C.unrate - 0.1, date: '2026-08-01' }, changeMoM: -0.2, change3m: -0.3 },
    nfp: { value: C.nfp + 180000, date: '2026-09-01', source: 'fred-csv', prevDate: '2026-08-01', unit: 'jobs', recentChanges: [C.nfp + 180000, 120000, 150000], prevChange: 120000, avg3Change: 100000 }
  });
  const bullish = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ fred: bullishPayload }) })));
  assert.match(bullish, /CPI เงินเฟ้อ — 🟢 ต่ำกว่าที่คาด/, 'CPI below consensus must be flagged');
  assert.match(bullish, /Unemployment Rate — 🟢 ดีกว่าที่คาด/, 'unemployment below consensus must be flagged');
  assert.match(bullish, /Nonfarm Payrolls — 🟢 ดีกว่าที่คาด/, 'a payroll beat must be flagged');
});

test('the text moves with the numbers — no code edit needed when a new print lands', async () => {
  const before = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub() })));
  const after = html(await runAllScripts(makeSandbox({
    fetchImpl: fetchStub({
      fred: payload({
        cpi: { value: C.cpi + 1.1, date: '2026-09-01', source: 'fred-csv', prev: { value: C.cpi, date: '2026-08-01' }, changePp: 1.1 },
        nfp: { value: 80000, date: '2026-09-01', source: 'fred-csv', prevDate: '2026-08-01', unit: 'jobs', recentChanges: [80000, 60000, 90000], prevChange: 60000, avg3Change: 76666 }
      })
    })
  })));
  assert.notEqual(before, after, 'the analysis should change when the underlying numbers change');
  assert.match(after, /เร่งขึ้น/, 'a rise in inflation should be described as accelerating');
});

test('a live consensus from Investing.com replaces the baked one and is labelled as live', async () => {
  // "ตามจริง" ตรงกับตัวเลขบนการ์ด (เหมือนสถานการณ์จริง 11 ก.ย. 2026) แต่ "คาดการณ์" ต่างจากค่าที่ฝังไว้
  const live = consensusPayload({
    cpi: { actual: C.cpi + 0.4, forecast: C.cpi + 1.0, previous: C.cpi, releaseDate: '2026-09-11', label: 'CPI YoY', kind: 'pct', url: 'x' },
    coreCpi: { actual: C.coreCpi + 0.3, forecast: C.coreCpi, previous: C.coreCpi, releaseDate: '2026-09-11' },
    unrate: { actual: C.unrate + 0.3, forecast: C.unrate, previous: C.unrate, releaseDate: '2026-09-04' },
    nfp: { actual: 162000, forecast: 55000, previous: 21000, releaseDate: '2026-09-04' },
    fed: { actual: 3.75, forecast: 3.75, previous: 3.75, releaseDate: '2026-07-29' }
  });
  const h = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ consensus: live }) })));

  assert.match(h, /ดึงสด/, 'the footnote should say the consensus was fetched live');
  assert.match(h, /ตรวจแล้วว่าค่าคาดตรงรอบเดียวกับตัวเลขบนการ์ด/, 'the print-match check should be reported');
  // คาดการณ์สด (4.4%) สูงกว่าตัวเลขบนการ์ด (3.8%) → ต้องออกเป็น "ต่ำกว่าที่คาด"
  // (ถ้าใช้ค่าที่ฝังไว้ 3.4% จะออกเป็น "สูงกว่าที่คาด" — เทสต์นี้จึงพิสูจน์ว่าใช้ค่าสดจริง)
  assert.match(h, /CPI เงินเฟ้อ — 🟢 ต่ำกว่าที่คาด/, 'the live forecast must be the one used for the verdict');
  assert.ok(!h.includes('ค่าที่ฝังไว้'), 'the baked-consensus wording must not appear when live data was used');
});

test('a consensus belonging to a different print is flagged, not silently applied', async () => {
  const stale = consensusPayload({
    cpi: { actual: C.cpi + 1.0, forecast: C.cpi + 0.9, previous: C.cpi, releaseDate: '2026-10-13' }, // newer print than the card shows
    coreCpi: { actual: C.coreCpi, forecast: C.coreCpi, previous: C.coreCpi, releaseDate: '2026-10-13' },
    unrate: { actual: C.unrate, forecast: C.unrate, previous: C.unrate, releaseDate: '2026-10-02' },
    nfp: { actual: 90000, forecast: 70000, previous: 21000, releaseDate: '2026-10-02' },
    fed: { actual: 3.75, forecast: 3.75, previous: 3.75, releaseDate: '2026-07-29' }
  });
  const h = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ consensus: stale }) })));
  assert.match(h, /รอบที่ใหม่\/เก่ากว่าตัวเลขบนการ์ด/, 'a mismatched print must be disclosed');
});

test('when the consensus endpoint is blocked, the page keeps the baked values and says so', async () => {
  const h = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ consensus: null }) })));
  assert.match(h, /ค่าที่ฝังไว้/, 'the footnote must disclose that the baked consensus is in use');
  assert.match(h, /Investing\.com/, 'the source must still be named');
  assert.match(h, /CPI เงินเฟ้อ/, 'the analysis must still render');
});

test('a stale/partial payload still produces an honest analysis', async () => {
  const partial = payload({ nfp: undefined, errors: { nfp: 'no usable PAYEMS level' }, stale: true, staleReason: 'all sources timed out' });
  const h = html(await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ fred: partial }) })));
  assert.doesNotMatch(h, /Nonfarm Payrolls/, 'a missing metric must not be analysed from stale prose');
  assert.match(h, /ที่ดึงไม่ได้: nfp/, 'the missing field should be disclosed');
  assert.match(h, /ตอบช้า|ค่าล่าสุดที่เคยดึงได้/, 'the stale flag should be disclosed');
});

test('with no data at all the block says it is waiting instead of showing an old article', async () => {
  const sb = await runAllScripts(makeSandbox({
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}), text: async () => '' })
  }));
  const h = html(sb);
  assert.match(h, /กำลังรอตัวเลขจริง|วิเคราะห์อัตโนมัติยังทำไม่ได้/, 'expected the waiting/failed message');
  assert.doesNotMatch(h, /CPI เดือน|Nonfarm Payrolls/, 'nothing should be analysed without data');
});
