// Tests for the SHARED consensus store: the ✏️ editor now writes to the server
// (/.netlify/functions/consensus-override) so that EVERY visitor sees the same "ที่คาด" values,
// guarded by a password. Local behavior (localStorage fallback, validation, priority order)
// must stay intact when the server is unavailable — the existing consensus-editor tests cover
// that path; this file covers the shared-store path.

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

function fedPayload() {
  return {
    fetchedAt: '2026-09-12T02:00:00.000Z',
    upper: { value: C.fed.hi, date: '2026-09-11', source: 'fred-csv', prevValue: C.fed.hi + 0.25, prevDate: '2026-06-17', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    lower: { value: C.fed.lo, date: '2026-09-11', source: 'fred-csv', changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    effr: { value: 3.63, date: '2026-09-11', source: 'fred-csv' },
    cpi: { value: C.cpi, date: '2026-08-01', source: 'fred-csv', prev: { value: C.cpi, date: '2026-07-01' }, changePp: 0 },
    coreCpi: { value: C.coreCpi, date: '2026-08-01', source: 'fred-csv' },
    unrate: { value: C.unrate, date: '2026-08-01', source: 'fred-csv', prev: { value: C.unrate, date: '2026-07-01' }, changeMoM: 0, change3m: 0 },
    nfp: { value: C.nfp, date: '2026-08-01', source: 'fred-csv', prevDate: '2026-07-01', unit: 'jobs', recentChanges: [C.nfp], prevChange: 0, avg3Change: C.nfp },
    fieldsOk: 7, fieldsTotal: 7
  };
}

// `store` mimics the server side of consensus-override.js: a shared value every visitor reads,
// plus a patch-merge write (null clears a field, clearFirst wipes before applying).
function makeStore(value) {
  return { enabled: true, backend: 'github', value, updatedAt: value ? '2026-09-12T09:00:00.000Z' : null, failWith: null, failError: null };
}
function serverApply(store, body) {
  if (body.action === 'clear') { store.value = null; store.updatedAt = '2026-09-12T10:00:00.000Z'; return; }
  if (body.clearFirst) store.value = null;
  const cur = Object.assign({}, store.value || {});
  const patch = body.patch || {};
  for (const k of Object.keys(patch)) {
    if (patch[k] === null || patch[k] === undefined || patch[k] === '') delete cur[k];
    else cur[k] = patch[k];
  }
  store.value = Object.keys(cur).length ? cur : null;
  store.updatedAt = '2026-09-12T10:00:00.000Z';
}
function stubFetch({ store, posts = [] } = {}) {
  return async (url, opts) => {
    const u = String(url);
    const o = opts || {};
    if (u.includes('/consensus-override')) {
      if (String(o.method || 'GET').toUpperCase() === 'POST') {
        const body = JSON.parse(o.body);
        posts.push(body);
        if (store && store.failWith) return { ok: false, status: store.failWith, json: async () => ({ error: store.failError || 'x' }), text: async () => '' };
        if (store && body.password === 'secret') { serverApply(store, body); return { ok: true, status: 200, json: async () => ({ ok: true, backend: 'github', value: store.value, updatedAt: store.updatedAt }), text: async () => '' }; }
        return { ok: false, status: 401, json: async () => ({ error: 'bad-password' }), text: async () => '' };
      }
      if (!store) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ enabled: store.enabled, backend: store.backend, value: store.value, updatedAt: store.updatedAt }), text: async () => '' };
    }
    if (u.includes('/fred-data')) return { ok: true, status: 200, json: async () => fedPayload(), text: async () => '' };
    if (u.includes('/consensus')) return { ok: false, status: 502, json: async () => ({ error: 'blocked' }), text: async () => '' };
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
}

const analysis = (sb) => sb.document.getElementById('fedAnalysis').innerHTML;
const panelHtml = (sb) => sb.document.getElementById('consensusEditPanel').innerHTML;
async function ticks(n = 25) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

test('every visitor sees the shared value — no local storage at all', async () => {
  const store = makeStore({ cpi: C.cpi - 1.0, savedAt: '2026-09-11' });
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store }) }));

  assert.equal(sb.window.consensusOverride.shared().enabled, true, 'the page must have loaded the shared store');
  const html = analysis(sb);
  assert.match(html, /CPI เงินเฟ้อ — 🔴 สูงกว่าที่คาด/, 'the shared consensus must drive the verdict');
  assert.match(html, /ที่คาด: ☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI\)/, 'the footnote must disclose the shared source');
  assert.match(html, /ตลาดคาด 2\.4%/, 'the shared number must be the one compared against'); // C.cpi − 1.0

  // A second visitor (fresh browser, no localStorage) sees exactly the same verdict.
  const second = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store }) }));
  assert.match(analysis(second), /CPI เงินเฟ้อ — 🔴 สูงกว่าที่คาด/);
  assert.match(analysis(second), /ที่คาด: ☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI\)/);
});

test('editing sends only the changed field, after the password is confirmed', async () => {
  const store = makeStore({ unrate: C.unrate, savedAt: '2026-09-11' });   // an existing shared field
  const posts = [];
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store, posts }) }));

  sb.window.consensusOverride.set({ cpi: 4.0 });
  assert.equal(sb.window.consensusOverride.status(), 'needs-password', 'no password yet → must wait for 🔑, must not push');
  assert.equal(posts.length, 0, 'nothing may be sent before the password is confirmed');

  sb.window.prompt = () => 'secret';
  sb.window.consensusOverride.authorize();
  await ticks();

  assert.equal(posts.length, 1, 'exactly one push');
  assert.equal(posts[0].password, 'secret');
  assert.equal(posts[0].action, 'set');
  assert.deepEqual(posts[0].patch, { cpi: 4.0 }, 'only the edited field goes up');
  assert.equal(store.value.cpi, 4.0);
  assert.equal(store.value.unrate, C.unrate, 'untouched shared fields must survive the merge');
  assert.equal(sb.window.consensusOverride.status(), 'ok');

  const html = analysis(sb);
  assert.match(html, /CPI เงินเฟ้อ — 🟢 ต่ำกว่าที่คาด/, 'the pushed value must drive the verdict'); // actual C.cpi < 4.0
  assert.match(html, /ตลาดคาด 4\.0%/);
  assert.match(html, /ที่คาด: ☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI, ว่างงาน\)/);
});

test('wrong password: nothing is shared, the local value stays, retrying works', async () => {
  const store = makeStore(null);
  const posts = [];
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store, posts }) }));

  sb.window.consensusOverride.set({ cpi: 4.0 });
  sb.window.prompt = () => 'wrong';
  sb.window.consensusOverride.authorize();
  await ticks();

  assert.equal(sb.window.consensusOverride.status(), 'bad-password');
  assert.equal(store.value, null, 'the shared store must stay empty');
  assert.equal(sb.window.consensusOverride.get().cpi, 4.0, 'the local value stays (it is just not shared yet)');
  sb.window.consensusOverride.open();   // re-render the (hidden) panel for the assertion
  assert.match(panelHtml(sb), /รหัสไม่ถูกต้อง/);

  // fix the password and retry — the pending change goes up now
  sb.window.prompt = () => 'secret';
  sb.window.consensusOverride.authorize();
  await ticks();

  assert.equal(store.value.cpi, 4.0);
  assert.equal(sb.window.consensusOverride.status(), 'ok');
  assert.equal(posts.length, 2);
});

test('no shared store → legacy local behavior: no prompt, no push, local-only disclosure', async () => {
  const posts = [];
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store: null, posts }) }));
  let promptCalls = 0;
  sb.window.prompt = () => { promptCalls += 1; return 'x'; };

  sb.window.consensusOverride.set({ cpi: 4.0 });
  await ticks();

  assert.equal(posts.length, 0, 'no store → nothing may be sent');
  assert.equal(promptCalls, 0, 'no store → nobody should be asked for a password');
  assert.match(analysis(sb), /ที่คาด: ✏️ ค่าที่คุณตั้งเอง \(CPI\)/);
  assert.equal(sb.window.consensusOverride.shared().enabled, false);
  sb.window.consensusOverride.open();   // re-render the (hidden) panel for the assertion
  assert.match(panelHtml(sb), /ที่เก็บค่ากลาง \(เซิร์ฟเวอร์\) ยังไม่พร้อม/);
});

test('clearing the shared store needs the password and wipes it for everyone', async () => {
  const store = makeStore({ cpi: C.cpi, savedAt: '2026-09-11' });
  const posts = [];
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store, posts }) }));

  assert.match(analysis(sb), /☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI\)/, 'starts with the shared value in use');
  sb.window.consensusOverride.clear();
  assert.equal(sb.window.consensusOverride.status(), 'needs-password', 'clearing the shared store must wait for the password');
  assert.equal(posts.length, 0);
  assert.match(analysis(sb), /☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI\)/, 'until the clear is pushed, the shared value is still what everyone sees');
  sb.window.consensusOverride.open();
  assert.match(panelHtml(sb), /การล้างค่ากลางยังไม่ได้บันทึก/);

  sb.window.prompt = () => 'secret';
  sb.window.consensusOverride.authorize();
  await ticks();

  assert.equal(posts.length, 1);
  assert.equal(posts[0].action, 'clear');
  assert.equal(store.value, null, 'the shared store must be empty for every visitor now');
  assert.equal(sb.window.consensusOverride.status(), 'ok');
  assert.match(analysis(sb), /ที่คาด: Investing\.com/, 'the automatic numbers are back for everyone');
  assert.match(panelHtml(sb), /ล้างค่ากลางแล้ว/);
});

test('my local edit wins over the shared value while the rest of the set stays shared', async () => {
  const store = makeStore({ cpi: C.cpi + 1.0, unrate: C.unrate, savedAt: '2026-09-11' });
  const sb = await runAllScripts(makeSandbox({ fetchImpl: stubFetch({ store }) }));

  sb.window.consensusOverride.set({ cpi: C.cpi - 1.0 });   // local: market expected lower
  const html = analysis(sb);

  assert.match(html, /CPI เงินเฟ้อ — 🔴 สูงกว่าที่คาด/, 'local must beat shared for the edited field');
  assert.match(html, /ที่คาด: ☁️ ที่แชร์จากเซิร์ฟเวอร์ \(CPI, ว่างงาน\) เมื่อ 2026-09-11 · ✏️ ค่าที่คุณตั้งเอง \(CPI\)/, 'both sources must be disclosed');
  // unrate: local has none → the shared value is used (fixture print lands exactly on it → neutral)
  assert.match(html, /Unemployment Rate — 🟡 ใกล้เคียงที่คาด/);
  assert.match(html, /ตลาดคาด 4\.1%/);
});
