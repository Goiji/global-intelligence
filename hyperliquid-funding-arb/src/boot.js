/* ============================================================================
 * boot.js — bookmarklet entry point.
 * เปิดแดชบอร์ดในหน้าต่างใหม่ (popup) โดยคัดลอกโค้ดทั้งหมดไปรันในหน้าต่างนั้น
 * ถ้าเปิดไม่ได้ (ถูก popup blocker / CSP บล็อก) จะ fallback เป็น overlay บนหน้าปัจจุบัน
 * คลิกซ้ำ = focus หน้าต่างเดิม (หรือ toggle overlay เปิด/ปิด)
 * ==========================================================================*/
(function () {
  'use strict';
  // ไม่มีสภาพแวดล้อมเบราว์เซอร์ (เช่น node) → เงียบออก
  if (typeof window === 'undefined' || !window || !window.document) return;
  var W = window;

  // มีแดชบอร์ดเปิดอยู่แล้วจากหน้านี้ → focus
  if (W.__HLFARB_WIN && !W.__HLFARB_WIN.closed) { try { W.__HLFARB_WIN.focus(); } catch (e) { } return; }
  // มี overlay อยู่ → toggle ปิด
  var old = document.getElementById('hlfarb-host-o');
  if (old && old.parentNode) { old.parentNode.removeChild(old); W.__HLFARB_OK = false; return; }

  function overlayMode() {
    try {
      W.__HLFARB_MODE = 'overlay';
      HLFARB_APP();
    } catch (e) {
      alert('HL Funding Arb: เปิดไม่สำเร็จบนหน้าเว็บนี้ — ลองเปิดหน้า example.com แล้วคลิกบุ๊คมาร์คใหม่\n(' + e.message + ')');
    }
  }

  var w = null;
  try { w = W.open('', '_blank', 'width=1280,height=860,menubar=no,toolbar=no'); } catch (e) { w = null; }
  if (!w || !w.document) { overlayMode(); return; }

  W.__HLFARB_WIN = w;
  try {
    w.__HLFARB_MODE = 'window';
    var d = w.document;
    d.open();
    d.write('<!doctype html><html lang="th"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>⚡ HL Funding Arb</title>' +
      '<style>html,body{margin:0;height:100%;background:#0b0e14}</style></head><body></body></html>');
    d.close();
    var s = d.createElement('script');
    s.textContent =
      'window.HLCrypto = (' + W.HLCryptoFactory.toString() + ')();\n' +
      '(' + HLFARB_APP.toString() + ')();';
    (d.body || d.documentElement).appendChild(s);
  } catch (e) { overlayMode(); return; }

  // ตรวจว่าสคริปต์รันสำเร็จในหน้าต่างใหม่ (CSP บางเว็บอาจบล็อก) — ไม่สำเร็จกลับไป overlay
  setTimeout(function () {
    var ok = false;
    try { ok = w.__HLFARB_OK === true; } catch (e) { ok = false; }
    if (!ok) { try { w.close(); } catch (e) { } W.__HLFARB_WIN = null; overlayMode(); }
  }, 500);
})();
