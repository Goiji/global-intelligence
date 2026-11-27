// Hash Ribbons backtest: history function + the stats behind its Backtest tab section. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fn = require('../netlify/functions/hash-history.js');
const T = fn.__test;
const { HTML, makeSandbox, runAllScripts } = require('./dom-stub.js');

const DAY = 86400;
const s0 = Date.UTC(2019, 0, 1) / 1000;
const iso = (i) => new Date((s0 + i * DAY) * 1000).toISOString().slice(0, 10);

// synthetic history: hashrate dips for 60 days from day 400 (price falls meanwhile), then recovers;
// a one-day dip-then-bounce at day 700 is noise (30d < 60d for single days) and must be ignored
function series(n) {
  const hash = [], btc = [];
  for (let i = 0; i < n; i++) {
    hash.push(i >= 400 && i < 460 ? 60 : i === 700 ? 99 : i === 701 ? 101 : 100);
    btc.push(i < 400 ? 10000 : i < 450 ? 10000 - (i - 400) * 100 : 5000 + (i - 450) * 50);
  }
  return { dates: hash.map((_, i) => iso(i)), hash, btc };
}

test('align keeps days in both feeds, converts TH/s to EH/s and drops zeros', () => {
  const n = 1200;
  const h = { values: Array.from({ length: n }, (_, i) => ({ x: s0 + i * DAY, y: i === 7 ? 0 : 123456789 })) };
  const p = { values: Array.from({ length: n - 1 }, (_, i) => ({ x: s0 + (i + 1) * DAY, y: 20000 })) };
  const d = T.align(h, p);
  assert.equal(d.dates[0], iso(1));
  assert.ok(!d.dates.includes(iso(7)));
  assert.equal(d.dates.length, n - 2);
  assert.equal(d.hash[0], 123.5);
  assert.throws(() => T.align({ values: h.values.slice(0, 10) }, p), /too little history/);
});

test('handler fetches hashrate and price; serves last good copy; 502 when nothing', async (t) => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; T._clearCache(); });
  const n = 1100, ok = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
  const seen = [];
  global.fetch = async (url) => {
    seen.push(url);
    const y = url.includes('hash-rate') ? 5e8 : 30000;
    return ok({ values: Array.from({ length: n }, (_, i) => ({ x: s0 + i * DAY, y })) });
  };
  T._clearCache();
  const body = JSON.parse((await fn.handler({})).body);
  assert.equal(body.dates.length, n);
  assert.equal(body.hash[0], 500);
  assert.equal(body.source, 'blockchain.com');
  assert.ok(seen.some((u) => u.includes('/charts/hash-rate?')) && seen.some((u) => u.includes('/charts/market-price?')));
  global.fetch = async () => ({ ok: false, status: 503 });
  T._clearCache();
  assert.equal((await fn.handler({})).statusCode, 502);
});

test('hrStats: capitulation, buy signal after recovery + momentum, noise ignored', async () => {
  const sb = await runAllScripts(makeSandbox());
  const D = series(1200);
  const S = sb.hrStats(D);
  assert.equal(S.rows.length, 1, 'the one-day blip is ignored');
  const r = S.rows[0];
  assert.equal(r.from, iso(400));
  assert.ok(r.to > iso(440) && r.to < iso(480));
  assert.equal(r.low, iso(450));
  assert.equal(Math.round(r.lowFromStart * 100), -50);
  assert.ok(r.signal, 'signal fires');
  assert.ok(r.signal.date >= r.to);
  assert.ok(r.signal.fwd.every((x) => x > 0));
  assert.equal(S.eras[0].sigs.length, 1);
  assert.equal(S.eras[0].cmp[3].h, 365);
  assert.equal(S.now.under, false);
  assert.equal(S.now.lastSignal.date, r.signal.date);
});

test('hrStats: a capitulation still running has no signal and shows in "now"', async () => {
  const sb = await runAllScripts(makeSandbox());
  const D = series(1200);
  for (let i = 1150; i < 1200; i++) D.hash[i] = 50;
  const S = sb.hrStats(D);
  const last = S.rows[S.rows.length - 1];
  assert.equal(last.ongoing, true); assert.equal(last.signal, null);
  assert.equal(S.now.under, true);
  assert.equal(S.now.since, iso(1150));
});

test('Hash Ribbons section is wired: cards, lazy load, nav button, Cloudflare route', () => {
  for (const id of ['hrNow', 'hrChart', 'hrSignals', 'hrCompare', 'hrPoints', 'hrNote', 'btGrpHr']) assert.match(HTML, new RegExp('id="' + id + '"'));
  assert.match(HTML, /data-go="btGrpHr"/);
  assert.match(HTML, /tabId === 'backtestTab' && typeof window\.btHashActivate === 'function'/);
  assert.ok(HTML.indexOf('id="bdvNote"') < HTML.indexOf('id="hrChart"'), 'after the DVOL backtest');
  const cf = fs.readFileSync(path.join(__dirname, '..', 'functions', '[[path]].js'), 'utf8');
  assert.match(cf, /'hash-history': hashHistory/);
});
