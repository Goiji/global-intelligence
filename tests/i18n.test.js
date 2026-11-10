// Tests for the ไทย / Eng language switch (top-right of the page).
//
//   • Thai stays the default; the choice is remembered in localStorage ('gi-lang') and ?lang= wins
//   • in English mode the script-generated text (Fed analysis, cards, news status…) has no Thai left
//   • every data-en attribute and every i18n-th block has an English counterpart
//   • English mode never calls the MyMemory translator (headlines stay in their original English)

const test = require('node:test');
const assert = require('node:assert/strict');
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const THAI = /[฀-๿]/;

function fred() {
  return {
    upper: { value: 3.75, date: '2026-09-11', prevValue: 4.0, changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    lower: { value: 3.5, date: '2026-09-11', prevValue: 3.75, changePp: -0.25, sinceDate: '2026-06-18', meetingsSinceChange: 1 },
    effr: { value: 3.63, date: '2026-09-11' },
    cpi: { value: 3.8, date: '2026-08-01', prev: { value: 4.0, date: '2026-07-01' }, changePp: -0.2 },
    coreCpi: { value: 2.7, date: '2026-08-01' },
    corePce: { value: 2.9, date: '2026-07-01', changePp: 0.1 },
    pce: { value: 2.6, date: '2026-07-01' },
    ppi: { value: 0.5, yoy: 2.9, date: '2026-08-01', prev: { value: 0.2, date: '2026-07-01' } },
    unrate: { value: 4.4, date: '2026-08-01', changeMoM: 0.3, change3m: 0.4 },
    nfp: { value: -65000, date: '2026-08-01', prevChange: -5000, avg3Change: 12000 },
    claims: { value: 245000, date: '2026-09-06', prev: { value: 238000 }, avg4: 240000, prevAvg4: 236000 }
  };
}

function fetchStub(calls) {
  return async (url) => {
    const u = String(url);
    if (calls) calls.push(u);
    if (u.includes('/.netlify/functions/fred-data')) return { ok: true, status: 200, json: async () => fred(), text: async () => '' };
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
}

async function load({ lang, search, calls } = {}) {
  const sb = makeSandbox({ fetchImpl: fetchStub(calls) });
  if (lang) sb.localStorage.setItem('gi-lang', lang);
  if (search) sb.location.search = search;
  await runAllScripts(sb);
  return sb;
}

const text = (sb, id) => {
  const e = sb.document.getElementById(id);
  return String(e.innerHTML || '') + ' ' + String(e.textContent || '');
};

test('Thai is the default and English is opt-in', async () => {
  const th = await load();
  assert.equal(th.GI_LANG, 'th');
  assert.equal(th.tr('ไทย', 'English'), 'ไทย');
  assert.equal(th.document.documentElement.lang, 'th');

  const en = await load({ lang: 'en' });
  assert.equal(en.GI_LANG, 'en');
  assert.equal(en.GI_LOCALE, 'en-GB');
  assert.equal(en.tr('ไทย', 'English'), 'English');
  assert.equal(en.document.documentElement.lang, 'en');
});

test('?lang= in the link overrides and is remembered', async () => {
  const sb = await load({ lang: 'en', search: '?lang=th' });
  assert.equal(sb.GI_LANG, 'th');
  assert.equal(sb.localStorage.getItem('gi-lang'), 'th');
  const sb2 = await load({ search: '?x=1&lang=en' });
  assert.equal(sb2.GI_LANG, 'en');
  assert.equal(sb2.localStorage.getItem('gi-lang'), 'en');
});

test('the toggle sits in the top bar with both choices', () => {
  const nav = /<nav class="tabbar">([\s\S]*?)<\/nav>/.exec(HTML);
  assert.ok(nav, 'tab bar missing');
  assert.match(nav[1], /class="lang-toggle"/, 'language toggle should be inside the top bar');
  assert.match(nav[1], /data-lang="th"[^>]*>ไทย</);
  assert.match(nav[1], /data-lang="en"[^>]*>Eng</);
  assert.match(HTML, /\.lang-toggle\{margin-left:auto/, 'toggle should be pushed to the right');
});

test('English mode: the Fed analysis and macro cards have no Thai left', async () => {
  const sb = await load({ lang: 'en' });
  const h = text(sb, 'fedAnalysis');
  assert.match(h, /CPI inflation — 🔴 Above forecast|CPI inflation — ⚪ No forecast/, 'CPI card should be in English');
  assert.match(h, /Market impact:/);
  assert.match(h, /Nonfarm Payrolls/);
  assert.ok(!THAI.test(h), 'Thai text left in the English analysis: ' + (h.match(/.{0,40}[฀-๿]+.{0,40}/) || [''])[0]);
  for (const id of ['corePceInfo', 'ppiYoy', 'fedAsOf', 'claimsInfo', 'fredFetchStatus', 'fomcDateLabel', 'riskTrend']) {
    const t = text(sb, id);
    assert.ok(!THAI.test(t), `#${id} still has Thai: ${t}`);
  }
});

test('English mode: status lines written by the scripts are English', async () => {
  const sb = await load({ lang: 'en' });
  for (const id of ['lpGold', 'lpUsdThb', 'lpGoldTh', 'lpOil', 'mktNote', 'newsStatus', 'status', 'halvingBlockInfo', 'verdict', 'breakdown', 'fngLabel', 'fundingLabel', 'oiLabel', 'consensusEditPanel', 'consensusEditBtn']) {
    const t = text(sb, id);
    assert.ok(!THAI.test(t), `#${id} still has Thai in English mode: ${t.slice(0, 200)}`);
  }
});

test('English mode never calls the Thai translation API', async () => {
  const calls = [];
  await load({ lang: 'en', calls });
  assert.ok(!calls.some((u) => u.includes('mymemory')), 'MyMemory must not be called in English mode');
});

test('Thai mode is unchanged (the analysis is still Thai)', async () => {
  const sb = await load();
  assert.match(text(sb, 'fedAnalysis'), /ผลต่อตลาด/);
});

test('every data-en / i18n block in the markup has an English side', () => {
  const empty = [...HTML.matchAll(/data-en="([^"]*)"/g)].filter((m) => !m[1].trim() || THAI.test(m[1]));
  assert.deepEqual(empty.map((m) => m[0]), [], 'data-en values must be non-empty English');
  const thBlocks = (HTML.match(/class="[^"]*\bi18n-th\b/g) || []).length;
  const enBlocks = (HTML.match(/class="[^"]*\bi18n-en\b/g) || []).length;
  // .h-en subtitles that only duplicate the English title are hidden in English mode (i18n-th with no pair)
  const hiddenSubtitles = (HTML.match(/class="h-en i18n-th"/g) || []).length;
  assert.equal(thBlocks - hiddenSubtitles, enBlocks, 'each i18n-th block needs a matching i18n-en block');
  assert.match(HTML, /html\[lang="en"\] \.i18n-th\{display:none/);
  assert.match(HTML, /html:not\(\[lang="en"\]\) \.i18n-en\{display:none/);
});
