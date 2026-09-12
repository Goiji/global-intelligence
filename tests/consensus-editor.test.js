// Tests for the in-page consensus editor: the ✏️ button under the analysis block that lets the
// site owner change the "ที่คาด" (consensus) numbers themselves — no code edit, no GitHub, no
// rebuild. Values are stored in this browser's localStorage and take priority per field over the
// live Investing.com fetch and over the values baked into index.html.
//
// The fixtures are built *relative to* the baked CONSENSUS, so these tests keep working when those
// numbers are updated from Investing.com.

const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

function bakedConsensus() {
  const m = /const CONSENSUS = \{([\s\S]*?)\n  \};/.exec(HTML);
  assert.ok(m, 'CONSENSUS block not found in index.html');
  const body = m[1];
  const num = (key) => {
    const r = new RegExp(`\\b${key}:\\s*(-?[\\d.]+)`).exec(body);
    return r ? Number(r[1]) : null;
  };
  const fed = /fed:\s*\{\s*lo:\s*(-?[\d.]+),\s*hi:\s*(-?[\d.]+)\s*\}/.exec(body);
  return { cpi: num('cpi'), coreCpi: num('coreCpi'), unrate: num('unrate'), nfp: num('nfp'), fed: { lo: Number(fed[1]), hi: Number(fed[2]) } };
}
const C = bakedConsensus();

// FRED/BLS payload in which every print lands exactly on the consensus (i.e. all verdicts start
// out neutral) — any change of verdict in these tests must come from an edit the user made.
function fedPayload(overrides = {}) {
  return {
    fetchedAt: '2026-09-12T02:00:00.000Z',
    upper: { value: C.fed.hi, date: '2026-09-11', source: 'fred-csv', prevValue: C.fed.hi + 0.25, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    lower: { value: C.fed.lo, date: '2026-09-11', source: 'fred-csv', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    effr: { value: 3.63, date: '2026-09-11', source: 'fred-csv' },
    cpi: { value: C.cpi, date: '2026-08-01', source: 'fred-csv', prev: { value: C.cpi, date: '2026-07-01' }, changePp: 0 },
    coreCpi: { value: C.coreCpi, date: '2026-08-01', source: 'fred-csv' },
    unrate: { value: C.unrate, date: '2026-08-01', source: 'fred-csv', prev: { value: C.unrate, date: '2026-07-01' }, changeMoM: 0, change3m: 0 },
    nfp: { value: C.nfp, date: '2026-08-01', source: 'fred-csv', prevDate: '2026-07-01', unit: 'jobs', recentChanges: [C.nfp], prevChange: 0, avg3Change: C.nfp },
    fieldsOk: 7, fieldsTotal: 7,
    ...overrides
  };
}

function fetchStub({ fred = fedPayload(), consensus = null } = {}) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/.netlify/functions/consensus')) {
      if (!consensus) return { ok: false, status: 502, json: async () => ({ error: 'blocked' }), text: async () => '' };
      return { ok: true, status: 200, json: async () => consensus, text: async () => '' };
    }
    if (u.includes('/.netlify/functions/fred-data')) return { ok: true, status: 200, json: async () => fred, text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

const analysis = (sb) => sb.document.getElementById('fedAnalysis').innerHTML;
const panelHtml = (sb) => sb.document.getElementById('consensusEditPanel').innerHTML;

test('the page ships an edit button and a panel with one field per consensus number', async () => {
  assert.match(HTML, /id="consensusEditBtn"/, 'the ✏️ edit button is missing');
  assert.match(HTML, /id="consensusEditPanel"/, 'the edit panel container is missing');

  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));
  const panel = sb.document.getElementById('consensusEditPanel');

  assert.equal(panel.style.display, 'none', 'the panel should start hidden');
  for (const key of ['cpi', 'coreCpi', 'unrate', 'nfp', 'fedLo', 'fedHi', 'asOf']) {
    assert.match(panelHtml(sb), new RegExp(`data-ckey="${key}"`), `the panel has no input for ${key}`);
  }
  assert.match(panelHtml(sb), /id="consensusResetBtn"/, 'the panel has no reset button');

  sb.window.consensusOverride.open();
  assert.equal(panel.style.display, 'block', 'open() should reveal the panel');
  sb.window.consensusOverride.close();
  assert.equal(panel.style.display, 'none', 'close() should hide the panel again');
});

test('editing a number in the page re-runs the analysis against my number, not the automatic one', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));

  // ทุกอย่างตรงคาด → ยังไม่มีการตั้งค่าเอง จึงใช้ค่าอัตโนมัติ
  assert.match(analysis(sb), /ใกล้เคียงที่คาด/, 'the fixture should start out neutral');
  assert.ok(!analysis(sb).includes('ค่าที่คุณตั้งเอง'), 'nothing should be marked as user-set yet');

  sb.window.consensusOverride.set({ cpi: C.cpi - 1.0 });   // ผู้ใช้บอกว่า "ตลาดคาดต่ำกว่านี้"
  const html = analysis(sb);

  assert.match(html, /CPI เงินเฟ้อ — 🔴 สูงกว่าที่คาด/, 'the CPI verdict must follow the edited number');
  assert.match(html, /ตลาดคาด 2\.4%/, 'the footnote should print the edited forecast'); // C.cpi − 1
  assert.match(html, /ที่คาด: ✏️ ค่าที่คุณตั้งเอง \(CPI\)/, 'the footnote must disclose the edit');
  assert.deepEqual(sb.window.consensusOverride.get().cpi, C.cpi - 1.0, 'the value should be readable back');
});

test('my value wins over the live Investing.com value, while the other fields keep updating live', async () => {
  const live = {
    source: 'investing.com', sourceLabel: 'Investing.com',
    events: {
      cpi: { actual: C.cpi, forecast: C.cpi, previous: C.cpi, releaseDate: '2026-09-11' },
      coreCpi: { actual: C.coreCpi, forecast: C.coreCpi + 2.0, previous: C.coreCpi, releaseDate: '2026-09-11' },
      unrate: { actual: C.unrate, forecast: C.unrate, previous: C.unrate, releaseDate: '2026-09-04' },
      nfp: { actual: C.nfp, forecast: 99000, previous: 21000, releaseDate: '2026-09-04' },
      fed: { actual: C.fed.hi, forecast: C.fed.hi, previous: C.fed.hi, releaseDate: '2026-07-29' }
    }
  };
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub({ consensus: live }) }));
  assert.match(analysis(sb), /ดึงสด/, 'the live consensus should be in use');

  sb.window.consensusOverride.set({ unrate: C.unrate - 0.3 });   // ตลาดคาดต่ำกว่านี้ → ตัวเลขจริงแย่กว่าคาด
  const html = analysis(sb);

  assert.match(html, /Unemployment Rate — 🔴 แย่กว่าที่คาด/, 'the edited field must drive its own verdict');
  assert.match(html, /ที่คาด: ✏️ ค่าที่คุณตั้งเอง \(ว่างงาน\)/, 'only the edited field should be listed');
  assert.match(html, /อัตโนมัติ: Investing\.com \(ดึงสด/, 'the remaining fields should still be the live ones');
  assert.match(html, /Core 4\.4%/, 'a field I did not touch must still use the live value');      // C.coreCpi + 2.0
  assert.match(html, /NFP \+99,000/, 'a field I did not touch must still use the live value');
});

test('"คืนค่าเริ่มต้น" puts the automatic numbers back', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));
  sb.window.consensusOverride.set({ nfp: 10 });            // 10 พันตำแหน่ง
  assert.match(analysis(sb), /ค่าที่คุณตั้งเอง/, 'the override should be visible first');

  sb.window.consensusOverride.clear();
  const html = analysis(sb);

  assert.ok(!html.includes('ค่าที่คุณตั้งเอง'), 'clearing must remove the "set by me" line');
  assert.match(html, /ที่คาด: Investing\.com \(ค่าที่ฝังไว้/, 'the baked consensus should be back in use');
  assert.equal(sb.window.consensusOverride.get(), null, 'nothing should be stored any more');
  assert.equal(sb.window.localStorage.getItem('giConsensusOverride.v1'), null, 'localStorage must be cleared');
});

test('values I set survive a reload in the same browser', async () => {
  const first = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));
  first.window.consensusOverride.set({ cpi: C.cpi + 0.7, asOf: '2026-09-12' });
  const saved = first.window.localStorage.getItem('giConsensusOverride.v1');
  assert.ok(saved, 'the override should be persisted to localStorage');

  const second = makeSandbox({ fetchImpl: fetchStub() });
  second.window.localStorage.setItem('giConsensusOverride.v1', saved);
  await runAllScripts(second);

  assert.match(analysis(second), /ที่คาด: ✏️ ค่าที่คุณตั้งเอง \(CPI\)/, 'a reload must pick the value up again');
  assert.match(analysis(second), /ตลาดคาด 4\.1%/, 'the reloaded value should be used in the comparison'); // C.cpi + 0.7
  assert.equal(second.window.consensusOverride.get().asOf, '2026-09-12', 'the reference date should persist too');
});

test('nonsense or out-of-range input never gets saved', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));

  assert.equal(sb.window.consensusOverride.set({ cpi: 'abc' }), null, 'text must be rejected');
  assert.equal(sb.window.consensusOverride.set({ cpi: 5000 }), null, 'an impossible CPI must be rejected');
  assert.equal(sb.window.consensusOverride.set({ nfp: 900000 }), null, '900 ล้านตำแหน่ง = พิมพ์ผิด ต้องไม่บันทึก');

  sb.window.consensusOverride.set({ cpi: 5.5 });
  sb.window.consensusOverride.set({ cpi: 'abc' });
  assert.equal(sb.window.consensusOverride.get().cpi, 5.5, 'a bad edit must not wipe a good value');

  // และค่าที่เสียหายใน localStorage ก็ต้องไม่ทำให้หน้าเว็บพัง
  const broken = makeSandbox({ fetchImpl: fetchStub() });
  broken.window.localStorage.setItem('giConsensusOverride.v1', '{"cpi":"boom","unrate":9999}');
  await runAllScripts(broken);
  assert.equal(broken.window.consensusOverride.get(), null, 'corrupt stored values should be ignored');
  assert.match(analysis(broken), /ที่คาด: Investing\.com \(ค่าที่ฝังไว้/, 'the page must fall back to the baked values');
});

test('payrolls are typed in thousands but compared in positions', async () => {
  const sb = await runAllScripts(makeSandbox({ fetchImpl: fetchStub() }));
  sb.window.consensusOverride.set({ nfp: 55 });            // ผู้ใช้พิมพ์ 55 = 55,000 ตำแหน่ง
  assert.equal(sb.window.consensusOverride.get().nfp, 55000, 'the panel unit must be scaled to positions');

  sb.window.consensusOverride.open();
  assert.match(panelHtml(sb), /data-ckey="nfp"[^>]*value="55"/, 'the panel should show 55 in the thousands field');
  assert.match(panelHtml(sb), /จ้างงานใหม่ \(พัน\)/, 'the panel should label the unit');
  assert.ok(!/value="55000"/.test(panelHtml(sb)), 'the raw positions should not leak into the input');
});
