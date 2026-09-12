// Tests for the automatic "🔍 วิเคราะห์: ตัวเลขออกมาดี/แย่แค่ไหน เทียบกับที่คาด" block in index.html.
//
// This is the feature that replaces a hand-written article, so the important properties are:
//   • it builds itself from the numbers that actually arrived (no hardcoded prints)
//   • it says good/bad/neutral relative to consensus, to the previous month, and to the recent run
//   • when the numbers move, the text moves with them (no code edit required)
//   • when data is missing it says so instead of showing stale prose
//
// Approach: run the page's inline scripts in a DOM stub whose `fetch` answers with a fixture, the
// same way the browser would receive it from /.netlify/functions/fred-data.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSandbox, runAllScripts } = require('./dom-stub.js');

// A realistic payload for a weak-jobs / sticky-inflation month (deliberately the opposite of a
// "everything is great" fixture, so the verdict logic is exercised in both directions).
function fredPayload(overrides = {}) {
  return {
    fetchedAt: '2026-09-12T02:00:00.000Z',
    keyConfigured: false,
    upper: { value: 3.75, date: '2026-09-11', source: 'fred-csv', prevValue: 4.0, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    lower: { value: 3.5, date: '2026-09-11', source: 'fred-csv', prevValue: 3.75, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    effr: { value: 3.63, date: '2026-09-11', source: 'fred-csv' },
    cpi: { value: 3.4, date: '2026-08-01', source: 'fred-csv', prev: { value: 3.5, date: '2026-07-01' }, changePp: -0.1 },
    coreCpi: { value: 2.5, date: '2026-08-01', source: 'fred-csv', prev: { value: 2.6, date: '2026-07-01' }, changePp: -0.1 },
    unrate: { value: 4.1, date: '2026-08-01', source: 'fred-csv', prev: { value: 4.2, date: '2026-07-01' }, changeMoM: -0.1, prev3: { value: 4.3, date: '2026-05-01' }, change3m: -0.2 },
    nfp: { value: -23000, date: '2026-08-01', source: 'fred-csv', prevDate: '2026-07-01', unit: 'jobs', recentChanges: [-23000, -13000, 40000], prevChange: -13000, avg3Change: 1333 },
    fieldsOk: 7,
    fieldsTotal: 7,
    ttl: 900,
    releaseDay: true,
    ...overrides
  };
}

function fetchReturning(payload, { ok = true } = {}) {
  return async (url) => {
    if (String(url).includes('/.netlify/functions/fred-data')) {
      return { ok, status: ok ? 200 : 502, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

function analysisHtml(sandbox) {
  return sandbox.document.getElementById('fedAnalysis').innerHTML;
}

test('analysis is generated from the live numbers for all four metrics', async () => {
  const sandbox = await runAllScripts(makeSandbox({ fetchImpl: fetchReturning(fredPayload()) }));
  const html = analysisHtml(sandbox);

  assert.match(html, /Fed Funds Rate/, 'Fed card missing');
  assert.match(html, /CPI เงินเฟ้อ/, 'CPI card missing');
  assert.match(html, /Unemployment Rate/, 'unemployment card missing');
  assert.match(html, /Nonfarm Payrolls/, 'payrolls card missing');

  // Values must come from the payload, not from any hardcoded prose.
  assert.match(html, /3\.50–3\.75%|3\.50-3\.75%/, 'the live target range is not shown');
  assert.match(html, /3\.4% YoY/, 'the live CPI print is not shown');
  assert.match(html, /−23,000|−23,000|23,000/, 'the live payrolls change is not shown');
  assert.doesNotMatch(html, /\+162,000|3\.63% YoY/, 'hardcoded placeholder numbers leaked into the analysis');
});

test('verdicts are computed against consensus in both directions', async () => {
  // Sticky inflation above consensus + a negative payroll print = warn/caution.
  const bearish = analysisHtml(await runAllScripts(makeSandbox({ fetchImpl: fetchReturning(fredPayload()) })));
  assert.match(bearish, /สูงกว่าที่คาด/, 'CPI above consensus should read as "สูงกว่าที่คาด"');
  assert.match(bearish, /แย่กว่าที่คาด/, 'negative payrolls should read as "แย่กว่าที่คาด"');
  assert.match(bearish, /ดีกว่าที่คาด/, 'unemployment below consensus should read as "ดีกว่าที่คาด"');

  // Opposite month: inflation cools below consensus, jobs beat, unemployment ticks up.
  const bullish = analysisHtml(await runAllScripts(makeSandbox({
    fetchImpl: fetchReturning(fredPayload({
      cpi: { value: 3.0, date: '2026-09-01', source: 'fred-csv', prev: { value: 3.2, date: '2026-08-01' }, changePp: -0.2 },
      coreCpi: { value: 2.4, date: '2026-09-01', source: 'fred-csv' },
      unrate: { value: 4.4, date: '2026-09-01', source: 'fred-csv', prev: { value: 4.2, date: '2026-08-01' }, changeMoM: 0.2, change3m: 0.3 },
      nfp: { value: 250000, date: '2026-09-01', source: 'fred-csv', prevDate: '2026-08-01', unit: 'jobs', recentChanges: [250000, 120000, 150000], prevChange: 120000, avg3Change: 173333 }
    }))
  })));
  assert.match(bullish, /ต่ำกว่าที่คาด/, 'CPI below consensus should read as "ต่ำกว่าที่คาด"');
  assert.match(bullish, /ดีกว่าที่คาด/, 'a payroll beat should read as "ดีกว่าที่คาด" for NFP');
});

test('the text moves with the numbers — no code edit needed when a new print lands', async () => {
  const before = analysisHtml(await runAllScripts(makeSandbox({ fetchImpl: fetchReturning(fredPayload()) })));
  const after = analysisHtml(await runAllScripts(makeSandbox({
    fetchImpl: fetchReturning(fredPayload({
      cpi: { value: 4.1, date: '2026-09-01', source: 'fred-csv', prev: { value: 3.4, date: '2026-08-01' }, changePp: 0.7 },
      nfp: { value: 80000, date: '2026-09-01', source: 'fred-csv', prevDate: '2026-08-01', unit: 'jobs', recentChanges: [80000, 60000, 90000], prevChange: 60000, avg3Change: 76666 }
    }))
  })));
  assert.notEqual(before, after, 'the analysis should change when the underlying numbers change');
  assert.match(after, /4\.1% YoY/, 'the new CPI print is not reflected');
  assert.match(after, /เร่งขึ้น/, 'a rise in inflation should be described as accelerating');
});

test('a stale/partial payload still produces an honest analysis', async () => {
  const partial = fredPayload({
    nfp: undefined,
    errors: { nfp: 'no usable PAYEMS level' },
    stale: true,
    staleReason: 'all sources timed out'
  });
  const html = analysisHtml(await runAllScripts(makeSandbox({ fetchImpl: fetchReturning(partial) })));
  assert.doesNotMatch(html, /Nonfarm Payrolls/, 'a missing metric must not be analysed from stale prose');
  assert.match(html, /ดึงได้เท่านั้น|ที่ดึงไม่ได้: nfp/, 'the missing field should be disclosed');
  assert.match(html, /ตอบช้า|ค่าล่าสุดที่เคยดึงได้/, 'the stale flag should be disclosed');
});

test('with no data at all the block says it is waiting instead of showing an old article', async () => {
  const sandbox = await runAllScripts(makeSandbox({ fetchImpl: fetchReturning({}, { ok: false }) }));
  const html = analysisHtml(sandbox);
  assert.match(html, /กำลังรอตัวเลขจริง|วิเคราะห์อัตโนมัติยังทำไม่ได้/, 'expected the waiting/failed message');
  assert.doesNotMatch(html, /CPI เดือน|Nonfarm Payrolls/, 'nothing should be analysed without data');
});
