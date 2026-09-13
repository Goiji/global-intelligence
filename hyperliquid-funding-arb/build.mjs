/**
 * build.mjs — ประกอบไฟล์ src/* ให้เป็น bookmarklet
 *   node build.mjs
 * ผลลัพธ์:
 *   hyperliquid-farb.bookmarklet.txt  ← คัดลอกไปวางใน Bookmark URL
 *   app.min.js                        ← ซอร์สรวมบีบอัด (อ่าน/ตรวจสอบได้)
 *   install.html                       ← หน้าติดตั้งแบบลากวาง
 * ต้องมี terser (npm i terser)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

let terser;
try { terser = await import('terser'); }
catch (e) {
  try {
    const { createRequire } = await import('node:module');
    const req = createRequire('/tmp/x/node_modules/.terser-probe');
    terser = { minify: req('terser').minify };
  } catch (e2) { console.error('ต้องติดตั้ง terser ก่อน: npm i terser'); process.exit(1); }
}

const parts = {
  crypto: SRC('src', 'crypto-core.js'),
  app: SRC('src', 'app.js'),
  boot: SRC('src', 'boot.js')
};
const bundle = `${parts.crypto}\n${parts.app}\n${parts.boot}\n`;

// ---------- minify ----------
const min = await terser.minify(bundle, {
  compress: { passes: 2, drop_debugger: true },
  mangle: true,
  format: { comments: false }
});
if (!min.code) { console.error('minify failed', min.error); process.exit(1); }
fs.writeFileSync(path.join(__dirname, 'app.min.js'), min.code);

// ---------- ตรวจสอบว่า bundle ยังทำงานได้หลังบีบอัด ----------
// 1) eval ใน context เปล่า: ต้องได้ HLFARB_APP เป็น function + HLCrypto ใช้ได้ + ผ่าน vector ทางการ
const ctx = {
  TextEncoder, console, setTimeout, clearTimeout,
  window: undefined, document: undefined, localStorage: undefined,
  fetch: undefined, confirm: undefined, alert: undefined, location: undefined
};
ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(min.code, ctx, { filename: 'bundle.min.js' });
if (typeof ctx.HLFARB_APP !== 'function') { console.error('✘ HLFARB_APP หายหลัง minify'); process.exit(1); }
if (typeof ctx.HLCrypto?.keccak256 !== 'function') { console.error('✘ HLCrypto หายหลัง minify'); process.exit(1); }
// vector ทางการ (order mainnet, nonce 0)
{
  const action = { type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
  const sig = ctx.HLCrypto.signL1Action('0x0123456789012345678901234567890123456789012345678901234567890123', action, null, 0, null, true);
  const ok = sig.r === '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e' &&
    sig.s === '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e' && sig.v === 28;
  if (!ok) { console.error('✘ minified bundle ผ่าน vector ทางการไม่ได้', sig); process.exit(1); }
}
// 2) เส้นทาง re-inject ของ boot (popup): HLCryptoFactory.toString() ต้อง eval ได้และใช้งานได้
{
  const ctx2 = { TextEncoder, console };
  ctx2.self = ctx2; ctx2.globalThis = ctx2;
  vm.createContext(ctx2);
  vm.runInContext('var HLCrypto = (' + ctx.HLCryptoFactory.toString() + ')();', ctx2, { filename: 'reinjected.js' });
  const h = ctx2.HLCrypto.hex(ctx2.HLCrypto.keccak256(new Uint8Array(0)));
  if (h !== 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470') { console.error('✘ HLCryptoFactory re-inject ผิด'); process.exit(1); }
  const srcApp = '(' + ctx.HLFARB_APP.toString() + ')';
  try { new (vm.runInContext('Function', ctx2))('return ' + srcApp); } catch (e) { console.error('✘ HLFARB_APP.toString() ไม่ valid:', e.message); process.exit(1); }
}

// ---------- bookmarklet (2 เวอร์ชัน) ----------
const wrapped = '(function(){\n' + min.code + '\n})();';
// 1) เวอร์ชันหลัก: encode ตรง ๆ — เข้ากันได้ทุกเบราว์เซอร์ (ยาวหน่อยแต่ชัวร์)
const bmMain = 'javascript:' + encodeURIComponent(wrapped);
if (decodeURIComponent(bmMain.slice('javascript:'.length)) !== wrapped) { console.error('✘ roundtrip encode ผิด'); process.exit(1); }
fs.writeFileSync(path.join(__dirname, 'hyperliquid-farb.bookmarklet.txt'), bmMain);

// 2) เวอร์ชันเล็ก: gzip + base64 + DecompressionStream (เบราว์เซอร์สมัยใหม่)
import zlib from 'node:zlib';
const gzB64 = zlib.gzipSync(Buffer.from(wrapped, 'utf8'), { level: 9 }).toString('base64');
const bmLite = 'javascript:' + encodeURIComponent(
  '(async()=>{try{const b="' + gzB64 + '";' +
  'const u=Uint8Array.from(atob(b),c=>c.charCodeAt(0));' +
  'const s=new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip"));' +
  'const t=await new Response(s).text();(0,eval)(t);' +
  '}catch(e){alert("HL Funding Arb: ไม่สามารถรันได้ (เบราว์เซอร์เก่า หรือหน้าเว็บบล็อกสคริปต์) — ลองเปิดหน้า example.com แล้วคลิกใหม่ ["+e.message+"]")}})()'
);
fs.writeFileSync(path.join(__dirname, 'hyperliquid-farb-lite.bookmarklet.txt'), bmLite);
// ตรวจว่า b64 คลายกลับได้ตรงเป๊ะ
if (zlib.gunzipSync(Buffer.from(gzB64, 'base64')).toString('utf8') !== wrapped) { console.error('✘ gzip roundtrip ผิด'); process.exit(1); }

// ---------- install.html ----------
const escH = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const bmAttr = escH(bmMain), bmLiteAttr = escH(bmLite);
const installHtml = `<!doctype html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ติดตั้งบุ๊คมาร์ค HL Funding Arb</title>
<style>
body{font-family:'Segoe UI',system-ui,'Noto Sans Thai',sans-serif;background:#0b0e14;color:#dbe2ef;margin:0;padding:40px 20px;display:flex;justify-content:center}
.card{max-width:780px;background:#101623;border:1px solid #1e2635;border-radius:16px;padding:28px 32px}
h1{color:#97fce4;font-size:22px;margin:0 0 6px}
h2{color:#97fce4;font-size:16px;margin:24px 0 8px}
p,li{color:#a9bad2;line-height:1.7;font-size:14.5px}
a.bm{display:inline-block;background:#0e4f43;border:1px solid #1d6f60;color:#97fce4;font-weight:700;padding:12px 22px;border-radius:12px;text-decoration:none;font-size:15px;cursor:grab}
a.bm:hover{background:#116255}
a.bm.lite{background:#2a2340;border-color:#463a6e;color:#cdc4ff}
code{background:#141b29;padding:2px 7px;border-radius:6px;font-size:13px}
.step{background:#0e1420;border:1px solid #1c2637;border-radius:12px;padding:14px 18px;margin:12px 0}
.step b{color:#c6d4e8}
textarea{width:100%;height:90px;background:#0e1420;color:#8fa3c0;border:1px solid #26334a;border-radius:10px;font-size:10px;font-family:ui-monospace,monospace;word-break:break-all}
button{background:#1a2333;color:#cfe0f5;border:1px solid #28374f;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer}
.warn{background:#2b1f0e;border:1px solid #57431d;color:#f7d948;padding:10px 14px;border-radius:10px;font-size:13px}
details summary{cursor:pointer;color:#97fce4;font-size:14px}
</style></head><body><div class="card">
<h1>⚡ HL Funding Arb — บอทเก็บ Funding Hyperliquid (Bookmarklet)</h1>
<p>ติดตั้งเป็นบุ๊คมาร์ค แล้วเปิดจากหน้าเว็บใดก็ได้ (แนะนำ <code>example.com</code>) ไม่ต้องติดตั้งโปรแกรมใด ๆ ทั้งสิ้น</p>

<h2>วิธีที่ 1 — ลากปุ่มนี้ไปวางบนแถบบุ๊คมาร์คของเบราว์เซอร์</h2>
<div class="step">
<a class="bm" href="${bmAttr}" draggable="true" onclick="return false">⚡ HL Funding Arb</a>
<p class="lite" style="font-size:12.5px">หากลากไม่ได้/บุ๊คมาร์คใช้ไม่ได้ ลองเวอร์ชันเล็ก:
<a class="bm lite" href="${bmLiteAttr}" draggable="true" onclick="return false">⚡ HL Funding Arb (เล็ก)</a></p>
</div>

<h2>วิธีที่ 2 — คัดลอก URL ไปสร้างบุ๊คมาร์คเอง</h2>
<div class="step">
<b>ขั้นตอน:</b> กด Ctrl+Shift+O (จัดการบุ๊คมาร์คใน Chrome/Edge) → เมนู ⋮ → "เพิ่มบุ๊คมาร์คใหม่" → ตั้งชื่อ เช่น <code>HL Funding Arb</code> → วาง URL ด้านล่างในช่อง URL → บันทึก<br><br>
<button onclick="var t=document.getElementById('bm');t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):document.execCommand('copy'));this.textContent='คัดลอกแล้ว ✓';">คัดลอก URL บุ๊คมาร์ค</button><br><br>
<textarea id="bm" readonly spellcheck="false">${bmAttr}</textarea>
<details style="margin-top:8px"><summary>เวอร์ชันเล็ก (กรณี URL ยาวเกินไป)</summary>
<button onclick="var t=document.getElementById('bml');t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):document.execCommand('copy'));this.textContent='คัดลอกแล้ว ✓';">คัดลอก URL เวอร์ชันเล็ก</button><br><br>
<textarea id="bml" readonly spellcheck="false">${bmLiteAttr}</textarea>
<p style="font-size:12px">เวอร์ชันเล็กบีบอัดข้อมูล (gzip) ต้องใช้เบราว์เซอร์รุ่นใหม่ (Chrome 80+, Firefox 113+, Safari 16.4+)</p>
</details>
</div>

<h2>วิธีใช้</h2>
<div class="step">
1) เปิดหน้าเว็บธรรมดา เช่น <code>example.com</code> → 2) คลิกบุ๊คมาร์ค → แดชบอร์ดจะเปิดขึ้นมาในหน้าต่างใหม่ →
3) เริ่มด้วย <b>โหมดจำลอง</b> (ค่าเริ่มต้น ปลอดภัย) ดูแท็บ "สแกน Funding" และ "ฮีดจ์" →
4) อ่านแท็บ "คู่มือ & ความเสี่ยง" ก่อนใช้เงินจริง
</div>

<div class="warn">⚠️ ใช้กับเงินที่พอจะเสียได้ — เมื่อปิด "โหมดจำลอง" บอทจะส่งคำสั่งซื้อขายจริง ควรใช้ API wallet (สั่งได้แต่ถอนไม่ได้) เท่านั้น และทดลองบน Testnet ก่อน</div>
</div></body></html>`;
fs.writeFileSync(path.join(__dirname, 'install.html'), installHtml);

const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log('✔ ตรวจสอบ bundle หลัง minify ผ่าน (vector ทางการ + re-inject + encode roundtrip)');
console.log('  source รวม  : ' + kb(bundle.length));
console.log('  minified    : ' + kb(Buffer.byteLength(min.code)));
console.log('  bookmarklet : ' + kb(bmMain.length) + '  (เวอร์ชันหลัก — เข้ากันได้ทุกเบราว์เซอร์)');
console.log('  bookmarklet : ' + kb(bmLite.length) + '  (เวอร์ชันเล็ก gzip — เบราว์เซอร์รุ่นใหม่)');
console.log('  ไฟล์: hyperliquid-farb.bookmarklet.txt, hyperliquid-farb-lite.bookmarklet.txt, app.min.js, install.html');
