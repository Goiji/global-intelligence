/**
 * Integration test (jsdom): boot.js — entry point ของ bookmarklet
 * ทดสอบ: popup-first (สคริปต์ที่ inject ต้องรันได้เองในหน้าต่างใหม่),
 * fallback เป็น overlay เมื่อ popup ล้มเหลว, toggle ปิด, และ focus หน้าต่างเดิม
 *
 * Run: node test/boot.smoke.test.mjs
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

let pass = 0, fail = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (extra ? ' — ' + extra : '')); }
};
const mkWin = () => {
  const d = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://example.com/', runScripts: 'outside-only', pretendToBeVisual: true
  });
  const w = d.window;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  w.AbortController = AbortController; w.TextEncoder = TextEncoder;
  w.alert = () => { }; w.confirm = () => true;
  return w;
};

/* ---------- หน้าต่างหลัก: มีโค้ด crypto + app + boot (เหมือน bookmarklet จริง) ---------- */
const W = mkWin();
W.eval(SRC('crypto-core.js'));
W.eval(SRC('app.js'));
ok(typeof W.HLFARB_APP === 'function' && typeof W.HLCryptoFactory === 'function', 'โค้ดหลักโหลดพร้อม (HLFARB_APP + HLCryptoFactory)');

/* ---------- 1) popup-first: window.open สำเร็จ → สคริปต์ถูก inject ---------- */
let injectedScript = null, popupClosed = false, popupFocused = false;
const popup = mkWin(); // หน้าต่าง popup จำลอง (จะรันสคริปต์ที่ได้รับ)
popup.close = () => { popupClosed = true; };
popup.focus = () => { popupFocused = true; };
// stub document ขอ popup ให้ boot เขียน shell + script ได้ (จับ script ที่ append)
let wrote = '';
popup.document.open = () => { };
popup.document.write = (h) => { wrote += h; };
popup.document.close = () => { };
const realCreate = popup.document.createElement.bind(popup.document);
popup.document.createElement = (t) => {
  const el = realCreate(t);
  const realAppend = el.appendChild.bind(el);
  return el; // ใช้ appendChild ของ body จริงแทน
};
const realBodyAppend = popup.document.body.appendChild.bind(popup.document.body);
popup.document.body.appendChild = (el) => {
  if (el && el.tagName === 'SCRIPT' && el.textContent) injectedScript = el.textContent;
  return realBodyAppend(el);
};
W.open = () => popup;

W.eval(SRC('boot.js')); // คลิกครั้งที่ 1
ok(W.__HLFARB_WIN === popup, 'เปิด popup และจำหน้าต่างไว้ (__HLFARB_WIN)');
ok(wrote.includes('<title>⚡ HL Funding Arb</title>'), 'เขียน HTML shell ลง popup');
ok(!!injectedScript, 'inject <script> ลง popup สำเร็จ');
ok(injectedScript && injectedScript.startsWith('window.HLCrypto = (function'), 'สคริปต์ขึ้นต้นด้วยการสร้าง HLCrypto ใน popup');
// ★ พิสูจน์ว่า payload ที่ inject รันได้เองในหน้าต่างใหม่ (self-contained)
const probe = mkWin();
probe.__HLFARB_MODE = 'window'; // เหมือน boot จริงที่ตั้งค่าก่อน inject
let payloadOk = false;
try { probe.eval(injectedScript); payloadOk = probe.__HLFARB_OK === true; } catch (e) { payloadOk = false; }
ok(payloadOk, 'payload ที่ inject รันในหน้าต่างใหม่ได้ → __HLFARB_OK = true');
ok(!!probe.document.getElementById('hlfarb-host-w'), 'payload สร้างแดชบอร์ด (host id hlfarb-host-w) ในหน้าต่างใหม่');
ok(!!probe.HLCrypto && typeof probe.HLCrypto.signL1Action === 'function', 'HLCrypto ถูกสร้างใน popup และ signL1Action ใช้ได้');

// จำลองว่า popup รันสำเร็จ → boot ต้องไม่ปิด popup / ไม่สร้าง overlay
popup.__HLFARB_OK = true;
await new Promise((r) => setTimeout(r, 650)); // รอ setTimeout 500ms ของ boot
ok(!popupClosed, 'popup รันสำเร็จ → ไม่ถูกปิด');
ok(!W.document.getElementById('hlfarb-host-o'), 'ไม่มี overlay บนหน้าหลัก');

/* ---------- 2) คลิกซ้ำขณะ popup เปิด → focus ---------- */
W.eval(SRC('boot.js'));
ok(popupFocused, 'คลิกซ้ำ → focus หน้าต่างเดิม');
ok(W.__HLFARB_WIN === popup, 'ยังใช้หน้าต่างเดิม (ไม่เปิดใหม่)');

/* ---------- 3) popup ล้ม (ถูกบล็อก/รันไม่ได้) → fallback overlay ---------- */
const W2 = mkWin();
W2.eval(SRC('crypto-core.js'));
W2.eval(SRC('app.js'));
let closed2 = false;
const popup2 = mkWin();
popup2.close = () => { closed2 = true; };
popup2.document.open = () => { };
popup2.document.write = () => { };
popup2.document.close = () => { };
popup2.document.body.appendChild = () => { }; // ไม่จับ script → __HLFARB_OK ไม่เซ็ต (จำลอง CSP บล็อก)
W2.open = () => popup2;
W2.eval(SRC('boot.js'));
await new Promise((r) => setTimeout(r, 650));
ok(closed2, 'popup ล้ม (ไม่มี __HLFARB_OK) → ปิด popup');
ok(!!W2.document.getElementById('hlfarb-host-o'), 'fallback สร้าง overlay บนหน้าปัจจุบัน');
ok(W2.__HLFARB_WIN === null || W2.__HLFARB_WIN === undefined, 'ล้าง __HLFARB_WIN');

/* ---------- 4) toggle: คลิกซ้ำเมื่อมี overlay → ปิด overlay ---------- */
W2.eval(SRC('boot.js'));
ok(!W2.document.getElementById('hlfarb-host-o'), 'คลิกซ้ำ → overlay ถูกปิด (toggle)');
ok(W2.__HLFARB_OK === false, 'รีเซ็ต __HLFARB_OK พร้อมรันใหม่ครั้งหน้า');
closed2 = false;
W2.eval(SRC('boot.js')); // เปิดใหม่ → ลอง popup ก่อน (mock ยังบล็อก) → รอ 500ms → overlay
await new Promise((r) => setTimeout(r, 650));
ok(closed2, 'รอบใหม่: ลอง popup ก่อนตามปกติ แล้วปิดเมื่อล้มอีก');
ok(!!W2.document.getElementById('hlfarb-host-o'), 'คลิกอีกครั้ง → overlay กลับมา');

/* ---------- 5) window.open คืน null (popup blocker หนัก) → overlay ทันที ---------- */
const W3 = mkWin();
W3.eval(SRC('crypto-core.js'));
W3.eval(SRC('app.js'));
W3.open = () => null;
W3.eval(SRC('boot.js'));
ok(!!W3.document.getElementById('hlfarb-host-o'), 'window.open คืน null → overlay บนหน้าปัจจุบันทันที');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
