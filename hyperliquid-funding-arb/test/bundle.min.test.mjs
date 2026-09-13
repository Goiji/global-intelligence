/**
 * Integration test: ทดสอบ "ตัวไฟล์ที่ส่งมอบจริง" — app.min.js + bookmarklet ทั้ง 2 เวอร์ชัน
 * - รัน app.min.js (รวม boot) ใน jsdom → boot fallback overlay → แอปเริ่มทำงาน → เปิดฮีดจ์จำลองได้
 * - ตรวจ hyperliquid-farb.bookmarklet.txt: decode กลับมาตรงกับ bundle + eval ไม่พัง
 * - ตรวจ hyperliquid-farb-lite.bookmarklet.txt: gzip+base64 คลายกลับมาตรงเป๊ะ + eval ไม่พัง
 *
 * Run: node test/bundle.min.test.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const { JSDOM } = await import(
  fs.existsSync('/tmp/x/node_modules/jsdom') ? '/tmp/x/node_modules/jsdom/lib/api.js' : 'jsdom'
);

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
};

/* ---------- mock ตลาด ---------- */
const HL = 'https://api.hyperliquid.xyz';
const perps = [{
  universe: [
    { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
    { name: 'HYPE', szDecimals: 2, maxLeverage: 3 }
  ]
}, [
  { dayNtlVlm: '5000000000', funding: '0.000004', markPx: '60000', oraclePx: '60000', openInterest: '100', prevDayPx: '60000' },
  { dayNtlVlm: '80000000', funding: '0.0001', markPx: '20.4', oraclePx: '20.4', openInterest: '2000000', prevDayPx: '20' }
]];
const spotMeta = {
  tokens: [
    { name: 'USDC', szDecimals: 6, index: 0, tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
    { name: 'HYPE', szDecimals: 2, index: 1, tokenId: '0x2222222222222222222222222222222222222222' }
  ],
  universe: [
    { name: 'HYPE/USDC', tokens: [1, 0], index: 0 }
  ]
};
const book = (mid) => {
  const bid = +(mid * 0.999).toFixed(4), ask = +(mid * 1.001).toFixed(4);
  return { levels: [[{ n: 1, px: String(bid), sz: '500' }], [{ n: 1, px: String(ask), sz: '500' }]] };
};
const mockFetch = async (url, opts) => {
  const b = opts && opts.body ? JSON.parse(opts.body) : null;
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (url === HL + '/info') {
    if (b.type === 'metaAndAssetCtxs') return json(perps);
    if (b.type === 'spotMeta') return json(spotMeta);
    if (b.type === 'spotMetaAndAssetCtxs') return json({ assetCtxs: [{ dayNtlVlm: '30000000', markPx: '20.5', midPx: '20.5' }] });
    if (b.type === 'l2Book') return json(book(20.5));
    if (b.type === 'clearinghouseState') return json({ assetPositions: [], marginSummary: { accountValue: '0' } });
    if (b.type === 'spotClearinghouseState') return json({ balances: [] });
    return json({});
  }
  if (url === 'https://fapi.binance.com/fapi/v1/premiumIndex') return json([{ symbol: 'HYPEUSDT', lastFundingRate: '0.00005', markPrice: '20.4' }]);
  if (url.startsWith('https://api.bybit.com/')) return json({ result: { list: [] } });
  return json({});
};

/* ---------- 1) รัน app.min.js (bundle จริง) ใน jsdom ---------- */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true
});
const w = dom.window;
w.fetch = mockFetch; w.AbortController = AbortController; w.TextEncoder = TextEncoder;
w.alert = () => { }; w.confirm = () => true;
w.open = () => null; // จำลอง popup blocker → boot ต้อง fallback เป็น overlay เอง
const minCode = read('app.min.js');
w.eval(minCode);
ok(w.__HLFARB_OK === true, 'bundle รัน → boot fallback overlay → แอปเริ่ม (จริง, ไม่ใช่แค่ src)');
ok(!!w.document.getElementById('hlfarb-host-o'), 'สร้าง overlay บนหน้าหลัก');
ok(typeof w.HLCrypto?.signL1Action === 'function', 'HLCrypto global ใช้ได้ในเวอร์ชัน minify');
ok(typeof w.HLFARB_APP === 'function', 'HLFARB_APP global ไม่โดน mangle');

await new Promise((r) => setTimeout(r, 300));
const sh = w.document.getElementById('hlfarb-host-o').shadowRoot;
ok(sh.innerHTML.includes('HYPE'), 'สแกนพบ HYPE');
ok(/87\.6/.test(sh.innerHTML), 'APR 87.6% แสดงผลถูกในเวอร์ชัน minify');

sh.querySelector('[data-tab=hedge]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
sh.querySelector('[data-act=open][data-coin=HYPE]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
const saved = JSON.parse(w.localStorage.getItem('hlfarb.v1'));
ok(saved.records.length === 1 && saved.records[0].coin === 'HYPE' && saved.records[0].status === 'open', 'เปิดฮีดจ์จำลองสำเร็จบน bundle จริง');

// ลายเซ็นในเวอร์ชัน minify ต้องตรง vector ทางการเป๊ะ (เดียวกับที่ build.mjs ใช้ตรวจ)
const C = w.HLCrypto;
const sig = C.signL1Action(
  '0x0123456789012345678901234567890123456789012345678901234567890123',
  { type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' },
  null, 0, null, 'mainnet'
);
ok(sig.r === '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e' &&
  sig.s === '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e' && sig.v === 28,
  'signL1Action minify ตรง vector ทางการเป๊ะ (r,s,v)', JSON.stringify(sig));

/* ---------- 2) ไฟล์ bookmarklet หลัก ---------- */
const bmMain = read('hyperliquid-farb.bookmarklet.txt');
ok(bmMain.startsWith('javascript:'), 'bookmarklet หลักขึ้นต้น javascript:');
ok(!/[\r\n]/.test(bmMain), 'bookmarklet หลักบรรทัดเดียว ไม่มี newline');
const expectMain = '(function(){\n' + minCode + '\n})();';
const gotMain = decodeURIComponent(bmMain.slice('javascript:'.length));
ok(gotMain === expectMain, 'decode กลับมาตรงกับ bundle เป๊ะ');
let mainEvalOk = true;
try { (0, eval)(gotMain); } catch (e) { mainEvalOk = false; }
ok(mainEvalOk, 'eval โค้ดที่ decode แล้วไม่พัง (สภาพแวดล้อมไม่มี window → boot เงียบออก)');

/* ---------- 3) ไฟล์ bookmarklet เวอร์ชันเล็ก (gzip) ---------- */
const bmLite = read('hyperliquid-farb-lite.bookmarklet.txt');
ok(bmLite.startsWith('javascript:'), 'bookmarklet เล็กขึ้นต้น javascript:');
ok(!/[\r\n]/.test(bmLite), 'bookmarklet เล็กบรรทัดเดียว');
const m = decodeURIComponent(bmLite.slice('javascript:'.length)).match(/"([A-Za-z0-9+/=]+)"/);
ok(!!m, 'มี payload base64 ฝังอยู่');
const gunzipped = zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8');
ok(gunzipped === expectMain, 'gzip คลายกลับมาตรงกับ bundle เป๊ะ');
// จำลอง bootstrap เหมือนเบราว์เซอร์ทุกขั้น (atob → Uint8Array → DecompressionStream)
const u = Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0));
const stream = new Blob([u]).stream().pipeThrough(new DecompressionStream('gzip'));
const text = await new Response(stream).text();
ok(text === expectMain, 'DecompressionStream (แบบเดียวกับใน bookmarklet) คลายได้ตรงเป๊ะ');
let liteEvalOk = true;
try { (0, eval)(text); } catch (e) { liteEvalOk = false; }
ok(liteEvalOk, 'eval ผลลัพธ์เวอร์ชันเล็กไม่พัง');

/* ---------- 4) install.html ---------- */
const html = read('install.html');
ok(html.includes('javascript:') && html.includes('HL Funding Arb'), 'install.html มีลิงก์บุ๊คมาร์ค');
ok(html.includes(bmMain.slice(11, 60)), 'install.html ฝัง URL เวอร์ชันหลัก');
ok((html.match(/href="javascript:/g) || []).length === 2, 'มีลิงก์ drag ได้ 2 เวอร์ชัน');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
