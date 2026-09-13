/**
 * Integration test (jsdom): บูตแอปจริงใน DOM จำลอง + mock API
 * ทดสอบ: UI render, สแกน funding, เปิด/ปิดฮีดจ์แบบจำลอง,
 * และ "โหมดของจริง" แบบ end-to-end — ตรวจว่าคำขอ POST /exchange ที่แอปสร้าง
 * มีลายเซ็นที่ถูกต้องจริง (recover กลับมาได้เป็นที่อยู่เจ้าของ key ด้วย ethers)
 *
 * Run: node test/app.smoke.test.mjs   (ต้องมี jsdom ใน /tmp/x/node_modules หรือ ./node_modules)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SRC = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const { JSDOM } = await import(
  fs.existsSync('/tmp/x/node_modules/jsdom') ? '/tmp/x/node_modules/jsdom/lib/api.js' : 'jsdom'
);
const { verifyTypedData, computeAddress } = await import(
  fs.existsSync('/tmp/x/node_modules/ethers') ? '/tmp/x/node_modules/ethers/lib.commonjs/index.js' : 'ethers'
);

const HL = 'https://api.hyperliquid.xyz';
const TEST_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- ข้อมูลจำลองตลาด ---------- */
const perps = {
  metaAndAssetCtxs: [{
    universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'HYPE', szDecimals: 2, maxLeverage: 3 },
      { name: 'ETH', szDecimals: 4, maxLeverage: 50 }
    ]
  }, [
    { dayNtlVlm: '5000000000', funding: '0.000004', markPx: '60000', oraclePx: '60000', openInterest: '100', prevDayPx: '60000' },
    { dayNtlVlm: '80000000', funding: '0.0001', markPx: '20.4', oraclePx: '20.4', openInterest: '2000000', prevDayPx: '20' },
    { dayNtlVlm: '2000000000', funding: '-0.00001', markPx: '3000', oraclePx: '3000', openInterest: '50', prevDayPx: '3000' }
  ]],
  spotMeta: {
    tokens: [
      { name: 'USDC', szDecimals: 6, index: 0, tokenId: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
      { name: 'HYPE', szDecimals: 2, index: 1, tokenId: '0x2222222222222222222222222222222222222222' },
      { name: 'PURR', szDecimals: 0, index: 2, tokenId: '0x3333333333333333333333333333333333333333' }
    ],
    universe: [
      { name: 'PURR/USDC', tokens: [2, 0], index: 0 },
      { name: 'HYPE/USDC', tokens: [1, 0], index: 1 }
    ]
  },
  spotMetaAndAssetCtxs: {
    assetCtxs: [
      { dayNtlVlm: '1000000', markPx: '0.5', midPx: '0.5' },
      { dayNtlVlm: '30000000', markPx: '20.5', midPx: '20.5' }
    ]
  }
};
function book(mid, spread) {
  const bid = +(mid * (1 - spread)).toFixed(4), ask = +(mid * (1 + spread)).toFixed(4);
  return { coin: 'x', levels: [
    [{ n: 1, px: String(bid), sz: '500' }, { n: 1, px: String(+(bid * 0.999).toFixed(4)), sz: '500' }],
    [{ n: 1, px: String(ask), sz: '500' }, { n: 1, px: String(+(ask * 1.001).toFixed(4)), sz: '500' }]
  ] };
}
let spotState = { balances: [{ coin: 'USDC', token: '@1', hold: '0', total: '5000' }] };
let perpState = () => ({ assetPositions: [], marginSummary: { accountValue: '5000', totalNtlPos: '0' }, withdrawable: '5000' });
let exchangeCalls = [];

async function mockFetch(url, opts) {
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  const json = (o) => ({ ok: true, status: 200, json: async () => o });
  if (url === HL + '/info') {
    const t = body.type;
    if (t === 'metaAndAssetCtxs') return json(perps.metaAndAssetCtxs);
    if (t === 'spotMeta') return json(perps.spotMeta);
    if (t === 'spotMetaAndAssetCtxs') return json(perps.spotMetaAndAssetCtxs);
    if (t === 'l2Book') return json(body.coin === 'HYPE/USDC' ? book(20.5, 0.001) : book(20.4, 0.001));
    if (t === 'clearinghouseState') return json(perpState());
    if (t === 'spotClearinghouseState') return json(spotState);
    if (t === 'userFunding') return json([]);
    return json({});
  }
  if (url === HL + '/exchange') {
    exchangeCalls.push(body);
    if (body.action.type === 'updateLeverage') return json({ status: 'ok', response: { type: 'updateLeverage', data: 'Success' } });
    const ord = body.action.orders[0];
    const isSpot = ord.a >= 10000;
    const px = isSpot ? 20.5 : 20.4;
    return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 99, avgPx: String(px), totalSz: ord.s, dir: ord.b ? 'B' : 'A', closedPnl: '0' } }] } } });
  }
  if (url === 'https://fapi.binance.com/fapi/v1/premiumIndex')
    return json([{ symbol: 'HYPEUSDT', lastFundingRate: '0.00005', markPrice: '20.4' }, { symbol: 'BTCUSDT', lastFundingRate: '0.00001', markPrice: '60000' }]);
  if (url.startsWith('https://api.bybit.com/'))
    return json({ result: { list: [{ symbol: 'HYPEUSDT', fundingRate: '0.00002', lastPrice: '20.4' }] } });
  return json({});
}

/* ---------- สร้าง DOM + รันแอป ---------- */
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://example.com/',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const w = dom.window;
w.fetch = mockFetch;
w.AbortController = w.AbortController || AbortController;
w.TextEncoder = TextEncoder;
w.alert = () => { }; w.confirm = () => true;
w.eval(SRC('crypto-core.js'));
ok(typeof w.HLCrypto?.signL1Action === 'function' && typeof w.HLCryptoFactory === 'function', 'crypto-core โหลดใน window สำเร็จ');
w.eval(SRC('app.js'));
ok(typeof w.HLFARB_APP === 'function', 'app โหลด (HLFARB_APP defined)');

w.__HLFARB_MODE = 'overlay';
w.HLFARB_APP();
await new Promise((r) => setTimeout(r, 250)); // รอ tick แรก

const host = w.document.querySelector('[id^=hlfarb-host-]');
ok(!!host, 'สร้าง host element');
const sh = host.shadowRoot;
ok(!!sh, 'มี shadow root');
ok(sh.querySelector('.brand')?.textContent.includes('HL Funding Arb'), 'หัวเอกสาร render');

/* ---------- 1) สแกน ---------- */
const scanHtml = sh.querySelector('[data-panel=scan]').innerHTML;
ok(scanHtml.includes('HYPE'), 'ตารางสแกนมี HYPE');
ok(scanHtml.includes('+87.6') || scanHtml.includes('+87.61'), 'APR HYPE ≈ +87.6% (0.0001×24×365)', scanHtml.match(/\+8\d\.\d+%/) ? '' : scanHtml.slice(0, 400));
ok(scanHtml.includes('APR Binance'), 'แสดงคอลัมน์ Binance');
ok(scanHtml.includes('ได้ · เก็บ funding'), 'มีป้ายฮีดจ์ได้');

/* ---------- 2) แท็บฮีดจ์ + เปิดแบบจำลอง ---------- */
sh.querySelector('[data-tab=hedge]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
let hedgeHtml = sh.querySelector('[data-panel=hedge]').innerHTML;
ok(hedgeHtml.includes('HYPE/USDC'), 'แท็บฮีดจ์มีคู่ HYPE/USDC');
ok(hedgeHtml.includes('เปิดฮีดจ์'), 'มีปุ่มเปิดฮีดจ์');
// หมายเหตุ APR: 87.6/1.333 = 65.7
ok(/65\.7/.test(hedgeHtml), 'APR สุทธิ ~65.7% (87.6/1.33)');

let openBtn = sh.querySelector('[data-act=open][data-coin=HYPE]');
ok(!!openBtn, 'ปุ่มเปิดฮีดจ์ HYPE ปรากฏ');
openBtn.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 150));
const saved1 = JSON.parse(w.localStorage.getItem('hlfarb.v1'));
ok(saved1.records.length === 1 && saved1.records[0].coin === 'HYPE' && saved1.records[0].mode === 'dry' && saved1.records[0].status === 'open', 'เปิดฮีดจ์จำลอง → บันทึก record (dry/open)');
ok(saved1.records[0].qty > 4 && saved1.records[0].qty < 5, 'ขนาด ~$100/20.5 ≈ 4.87 HYPE ต่อขา', 'qty=' + saved1.records[0].qty);
ok(Math.abs(saved1.records[0].entrySpot - 20.53) < 0.05, 'entry สปอต = VWAP หน้าตัก ~20.53', 'entry=' + saved1.records[0].entrySpot);
hedgeHtml = sh.querySelector('[data-panel=hedge]').innerHTML;
ok(hedgeHtml.includes('Funding สะสม') && hedgeHtml.includes('ปิดทั้งหมด'), 'ตารางโพซิชันแสดง');
ok(hedgeHtml.includes('จำลอง'), 'โพซิชันติดป้ายจำลอง');

/* ปิดโพซิชันจำลอง */
sh.querySelector('[data-act=close-pos]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 100));
const saved2 = JSON.parse(w.localStorage.getItem('hlfarb.v1'));
ok(saved2.records[0]?.status === 'closed' && saved2.records.length === 1, 'ปิดโพซิชันจำลอง → record เป็น closed (เก็บประวัติ)');

/* ---------- 3) โหมดของจริง end-to-end (mock exchange + ตรวจลายเซ็น) ---------- */
const dom2 = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
const w2 = dom2.window;
w2.fetch = mockFetch; w2.AbortController = AbortController; w2.TextEncoder = TextEncoder;
w2.alert = () => { }; w2.confirm = () => true;
w2.eval(SRC('crypto-core.js'));
w2.eval(SRC('app.js'));
w2.localStorage.setItem('hlfarb.v1', JSON.stringify({
  cfg: { net: 'mainnet', dryRun: false, key: TEST_KEY, rememberKey: true, notional: 100, lev: 3, slip: 0.3, takerFee: 0.045, refreshSec: 30, auto: false },
  records: [], lastClose: {}
}));
w2.__HLFARB_MODE = 'overlay';
w2.HLFARB_APP();
await new Promise((r) => setTimeout(r, 250));
const sh2 = w2.document.querySelector('[id^=hlfarb-host-]').shadowRoot;
ok(sh2.innerHTML.includes('0x1479…9325'), 'แสดงที่อยู่ API wallet ที่อนุพันธ์จาก key');
ok(sh2.querySelector('[data-b-mode]')?.textContent.includes('ของจริง'), 'ป้ายโหมด = ของจริง');
ok(sh2.innerHTML.includes('โหมดของจริง'), 'มีกรอบเตือนโหมดของจริง');

sh2.querySelector('[data-tab=hedge]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 50));
const openBtn2 = sh2.querySelector('[data-act=open][data-coin=HYPE]');
ok(!!openBtn2, 'ปุ่มเปิดฮีดจ์ (live)');
openBtn2.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 300));

const saved3 = JSON.parse(w2.localStorage.getItem('hlfarb.v1'));
ok(saved3.records.length === 1 && saved3.records[0].mode === 'live' && saved3.records[0].status === 'open', 'เปิดฮีดจ์ live สำเร็จ (record live/open)');
ok(exchangeCalls.length === 3, 'ส่งคำสั่ง 3 ครั้ง (ซื้อสปอต + updateLeverage + ชอร์ตเพอร์ป)', 'จำนวน=' + exchangeCalls.length);

const [cSpot, cLev, cPerp] = exchangeCalls;
if (exchangeCalls.length >= 3) {
  ok(cSpot.action.type === 'order' && cSpot.action.grouping === 'na', 'คำสั่งซื้อ: type=order, grouping=na');
  const ow = cSpot.action.orders[0];
  ok(ow.a === 10000 + 1 && ow.b === true && ow.r === false && ow.t?.limit?.tif === 'Ioc', 'order wire สปอต: a=10001 (10000+index คู่), buy, IOC', JSON.stringify(ow));
  ok(/^\d+(\.\d+)?$/.test(ow.p) && !ow.p.includes('e'), 'ราคาเป็น string ทศนิยมปกติ: ' + ow.p);
  ok(cLev.action.type === 'updateLeverage' && cLev.action.asset === 1 && cLev.action.leverage === 3 && cLev.action.isCross === true, 'updateLeverage asset=1 (HYPE), 3x, cross');
  ok(cPerp.action.orders[0].a === 1 && cPerp.action.orders[0].b === false, 'order wire เพอร์ป: a=1, sell');
  ok(Number.isInteger(cSpot.nonce) && cSpot.nonce > 1700000000000, 'nonce เป็น int (ms ปัจจุบัน)');
  ok(cSpot.action.orders[0].s === cPerp.action.orders[0].s, 'ขนาดสองขาเท่ากัน: ' + cSpot.action.orders[0].s);
}

// ★ ตรวจลายเซ็นทุกคำสั่ง: recover ต้องได้ที่อยู่เจ้าของ key
const expectedAddr = computeAddress(TEST_KEY);
let allValid = true, badCall = -1;
for (let i = 0; i < exchangeCalls.length; i++) {
  const b = exchangeCalls[i];
  try {
    const connId = w2.HLCrypto.actionHash(b.action, null, b.nonce, null);
    const sig = b.signature;
    const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
    const types = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
    const value = { source: 'a', connectionId: '0x' + w2.HLCrypto.hex(connId) };
    const pad = (h) => h.replace(/^0x/, '').padStart(64, '0');
    const recovered = verifyTypedData(domain, types, value,
      '0x' + pad(sig.r) + pad(sig.s) + (sig.v - 27).toString(16).padStart(2, '0'));
    if (recovered.toLowerCase() !== expectedAddr.toLowerCase()) { allValid = false; badCall = i; }
  } catch (e) { allValid = false; badCall = i; }
}
ok(allValid, 'ลายเซ็นทุกคำสั่ง /exchange valid — recover ได้เจ้าของ key จริง' + (badCall >= 0 ? ' (ผิดที่คำสั่งที่ ' + badCall + ')' : ''));

/* ปิดโพซิชัน live: mock มีโพซิชันชอร์ต + สต็อกสปอต */
spotState = { balances: [{ coin: 'USDC', token: '@1', total: '5000' }, { coin: 'HYPE', token: '0x2222', total: String(saved3.records[0].qty) }] };
perpState = () => ({
  assetPositions: [{ position: { coin: 'HYPE', szi: String(-saved3.records[0].qty), entryPx: '20.4', leverage: { type: 'cross', value: 3 }, liquidationPx: '28', marginUsed: '33', positionValue: '99', unrealizedPnl: '0' }, type: 'oneWay' }],
  marginSummary: { accountValue: '5000', totalNtlPos: '99' }, withdrawable: '4900'
});
exchangeCalls = [];
sh2.querySelector('[data-act=close-pos]')?.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
await new Promise((r) => setTimeout(r, 400));
const saved4 = JSON.parse(w2.localStorage.getItem('hlfarb.v1'));
ok(saved4.records[0]?.status === 'closed', 'ปิดโพซิชัน live สำเร็จ → status closed');
ok(exchangeCalls.length === 2, 'ปิดใช้ 2 คำสั่ง (ขายสปอต + ปิดเพอร์ป reduce-only)', 'จำนวน=' + exchangeCalls.length);
ok(exchangeCalls[1]?.action.orders[0].r === true && exchangeCalls[1]?.action.orders[0].b === true, 'ปิดเพอร์ป: reduceOnly=true, buy');
ok(exchangeCalls[0]?.action.orders[0].a === 10001 && exchangeCalls[0]?.action.orders[0].b === false, 'ขายสปอต: a=10001, sell');

/* ---------- 4) โหมดอัตโนมัติ (จำลอง) ---------- */
w.localStorage.clear();
const dom3 = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true });
const w3 = dom3.window;
w3.fetch = mockFetch; w3.AbortController = AbortController; w3.TextEncoder = TextEncoder;
w3.alert = () => { }; w3.confirm = () => true;
w3.eval(SRC('crypto-core.js')); w3.eval(SRC('app.js'));
w3.localStorage.setItem('hlfarb.v1', JSON.stringify({ cfg: { dryRun: true, auto: true, autoOpenApr: 50, autoCloseApr: 0.5, maxPos: 2, minHoldH: 0, notional: 100 }, records: [], lastClose: {} }));
w3.__HLFARB_MODE = 'overlay';
w3.HLFARB_APP();
await new Promise((r) => setTimeout(r, 400));
const saved5 = JSON.parse(w3.localStorage.getItem('hlfarb.v1'));
ok(saved5.records.length === 1 && saved5.records[0].coin === 'HYPE' && saved5.records[0].auto === true, 'อัตโนมัติเปิดฮีดจ์ HYPE (APR 87.6% ≥ 50%) แบบจำลอง');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
