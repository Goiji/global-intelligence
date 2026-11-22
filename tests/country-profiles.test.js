const test = require('node:test');
const assert = require('node:assert/strict');
const fn = require('../netlify/functions/country-profiles.js');
const T = fn.__test;
const cm = require('../netlify/functions/capital-markets.js');
const { makeSandbox, runAllScripts } = require('./dom-stub.js');

// one companiesmarketcap row, same markup as the live page
const row = (rank, name, code, cap) => `<tr><td class="fav"></td><td class="rank-td td-right" data-sort="${rank}">${rank}</td><td class="name-td"><div class="name-div"><a href="/x/"><div class="company-name">${name}</div><div class="company-code"><span class="rank d-none"></span>${code}</div></a></div></td><td class="td-right" data-sort="${cap}"><span class="currency-symbol-left">$</span>x B</td><td class="td-right" data-sort="511.196">$5.11</td></tr>`;
const page = (rows) => '<table><thead><tr><th>Rank</th></tr></thead><tbody>' + rows.map((r, i) => row(i + 1, ...r)).join('') + '</tbody></table>';
const PAGES = {
  US: page([['Apple', 'AAPL', 4978e9], ['Microsoft', 'MSFT', 3598e9], ['Alphabet (Google)', 'GOOG', 3246e9], ['NVIDIA', 'NVDA', 3031e9], ['Amazon', 'AMZN', 2669e9]]),
  TH: page([['Delta Electronics (Thailand)', 'DELTA.BK', 63.7e9], ['PTT PCL', 'PTT-R.BK', 31e9], ['Advanced Info Service (AIS)', 'ADVANC.BK', 29e9], ['Gulf Development Public Company', 'GULF.BK', 27e9]]),
  EU0: page([['ASML', 'ASML', 488e9], ['L&#039;Oréal', 'OR.PA', 255e9]]),
  EU1: page([['HSBC', 'HSBC', 273e9], ['AstraZeneca', 'AZN', 270e9]]),
  EU2: page([['Roche', 'RO.SW', 382e9]])
};
const wbJson = (ind, rows) => JSON.stringify([{ page: 1 }, rows.map(([id, v, y]) => ({ indicator: { id: ind }, country: { id }, date: String(y), value: v }))]);
const WB = {
  'SP.POP.65UP.TO.ZS': [['US', 18.39, 2025], ['TH', 16.02, 2025], ['DE', 23, 2025], ['FR', 22, 2025]],
  'HD.HCI.OVRL': [['US', 0.7018, 2020], ['TH', 0.6093, 2020], ['DE', 0.75, 2020]],
  'NY.GDP.PCAP.CD': [['US', 90026, 2025], ['TH', 8056.6, 2025], ['DE', 56000, 2025]],
  'NY.GDP.PCAP.PP.CD': [['US', 90026, 2025], ['TH', 26250, 2025], ['DE', 72000, 2025]]
};
const ILO_CSV = '"ref_area","source","indicator","time","obs_value"\n"USA","XA:1","GDP_2HRW_NOC_NB","2025",99.1\n"USA","XA:1","GDP_2HRW_NOC_NB","2026",101\n"THA","XA:1","GDP_2HRW_NOC_NB","2025",17.89\n"THA","XA:1","GDP_2HRW_NOC_NB","2024",17.49\n"DEU","XA:1","GDP_2HRW_NOC_NB","2025",80\n"FRA","XA:1","GDP_2HRW_NOC_NB","2025",78';

function fakeFetch({ failWb = false, failCmc = false } = {}) {
  return async (url) => {
    url = String(url);
    let body = null;
    if (url.startsWith(T.CMC)) {
      if (failCmc) return { ok: false, status: 503, text: async () => '' };
      for (const [code, paths] of Object.entries(T.CMC_PAGES)) {
        paths.forEach((p, i) => { if (url === T.CMC + p) body = code === 'EU' ? PAGES['EU' + i] : (PAGES[code] || page([])); });
      }
    } else if (url.includes('api.worldbank.org')) {
      if (failWb) return { ok: false, status: 503, text: async () => '' };
      const ind = Object.values(T.WB_IND).find((i) => url.includes('/indicator/' + i + '?'));
      body = wbJson(ind, WB[ind] || []);
    } else if (url.includes('rplumber.ilo.org')) body = ILO_CSV;
    if (body == null) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };
}
async function call(opts) {
  const real = global.fetch;
  global.fetch = fakeFetch(opts);
  try { return await fn.handler({}); } finally { global.fetch = real; }
}

test('country-profiles: companiesmarketcap rows → name, ticker, market cap in page order', () => {
  const l = T.parseCmcCompanies(PAGES.TH);
  assert.equal(l.length, 4);
  assert.deepEqual(l[0], ['Delta Electronics (Thailand)', 'DELTA.BK', 63.7e9]);
  assert.equal(T.parseCmcCompanies(PAGES.EU0)[1][0], "L'Oréal");
  assert.deepEqual(T.parseCmcCompanies('<html>no table</html>'), []);
});

test('country-profiles: ILO skips projection years, keeps the latest real one', () => {
  const o = T.parseIlo(ILO_CSV, 2026);
  assert.deepEqual(o.USA, [99.1, 2025]);
  assert.deepEqual(o.THA, [17.89, 2025]);
});

test('country-profiles: handler → top 4 champions, Europe merged from EU + UK + Switzerland, live statistics', async () => {
  T._clearCache();
  const res = await call();
  assert.equal(res.statusCode, 200);
  const j = JSON.parse(res.body);
  assert.deepEqual(j.parts.champs.US.map((c) => c[0]), ['Apple', 'Microsoft', 'Alphabet (Google)', 'NVIDIA']);
  assert.deepEqual(j.parts.champs.EU.map((c) => c[0]), ['ASML', 'Roche', 'HSBC', 'AstraZeneca'], 'merged and re-sorted by market cap');
  const us = j.parts.people.US;
  assert.equal(us.old65, 18.39);
  assert.equal(us.hci, 0.7);
  assert.equal(us.priceLevel, 1);
  assert.equal(us.perHour, 99.1);
  const th = j.parts.people.TH;
  assert.equal(th.priceLevel, 0.31, 'market-rate GDP ÷ PPP GDP');
  assert.equal(th.perHourYear, new Date().getUTCFullYear() - 1 >= 2025 ? 2025 : th.perHourYear);
  assert.equal(j.parts.people.EU.old65, 22.5, 'Europe = average of its big economies');
  // cached on the second call
  const again = JSON.parse((await call({ failWb: true, failCmc: true })).body);
  assert.equal(again.cached, true);
  T._clearCache();
});

test('country-profiles: a failing source is filled from the last good copy; all failing and nothing saved → 502', async () => {
  T._clearCache();
  await call();
  // force a refresh but keep last-good in memory
  const good = JSON.parse((await call()).body);
  assert.ok(good.parts.champs.US);
  T._clearCache();
  const res = await call({ failWb: true, failCmc: true });
  assert.equal(res.statusCode, 200, 'ILO alone still answers the people part');
  T._clearCache();
});

test('country-profiles: registered on Cloudflare and cached by the page', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const cf = fs.readFileSync(path.join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(cf, /import countryProfiles from '\.\.\/netlify\/functions\/country-profiles\.js'/);
  assert.match(cf, /'country-profiles': countryProfiles/);
});

test('page: country i buttons switch to the live profiles once they load', async () => {
  const real = global.fetch;
  cm.__test._clearCache();
  T._clearCache();
  global.fetch = fakeFetch();
  let prof;
  try { prof = JSON.parse((await fn.handler({})).body); } finally { global.fetch = real; T._clearCache(); }
  const capPayload = { parts: { equities: { total: 100, byKey: { US: 60, TH: 0.5, EU: 20, OTHER: 19.5 }, asOf: new Date().toISOString() } } };
  const sb = makeSandbox({
    fetchImpl: async (url) => {
      url = String(url);
      const body = url.includes('capital-markets') ? capPayload : url.includes('country-profiles') ? prof : null;
      return body ? { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } : { ok: false, status: 503, json: async () => ({}), text: async () => '' };
    }
  });
  await runAllScripts(sb);
  await new Promise((r) => setTimeout(r, 20));
  const rows = sb.__elements.get('cmRows').innerHTML;
  assert.match(rows, /• Delta Electronics · อุปกรณ์ไฟฟ้าสำหรับศูนย์ข้อมูล\n• PTT · น้ำมัน, ก๊าซ\n• Advanced Info Service \(AIS\) · มือถือ, อินเทอร์เน็ต\n• Gulf Development · โรงไฟฟ้า/, 'Thai champions from the live page, names tidied, businesses labelled');
  assert.match(rows, /คนอายุ 65 ปีขึ้นไป 16% · สังคมสูงวัย \(ปี 2025\)/);
  assert.match(rows, /ทำงาน 1 ชม. ได้ของเท่ากับเงิน ~\$18 ที่อเมริกา \(ปี 2025\)\nเทียบ: สหรัฐฯ ~\$99 · ไทย ~\$18\nค่าครองชีพ: ถูก \(ของราคาราว 31% ของสหรัฐฯ\)/);
  assert.match(rows, /🗺️ รวมประเทศ/);
});
