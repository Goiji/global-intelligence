# HL Funding Arb — บอทเก็บ Funding Rate Arbitrage บน Hyperliquid (Bookmarklet)

บอทฮีดจ์ **ซื้อสปอต + ชอร์ตเพอร์ปิวส์** ขนาดเท่ากันบน Hyperliquid เพื่อเก็บ funding rate บวก
ในรูปแบบ **bookmarklet** — JavaScript วางในช่อง URL ของบุ๊คมาร์คแล้วคลิกรันในเบราว์เซอร์ของคุณเอง
ไม่ต้องติดตั้งโปรแกรม ไม่ต้องมีเซิร์ฟเวอร์ ไม่มี dependency ภายนอก (crypto/signing ฝังในตัว)

## ไฟล์ที่ส่งมอบ

| ไฟล์ | คำอธิบาย |
|---|---|
| `hyperliquid-farb.bookmarklet.txt` | **ตัวหลัก** — URL บุ๊คมาร์คพร้อมวาง (~127KB, ใช้ได้ทุกเบราว์เซอร์) |
| `hyperliquid-farb-lite.bookmarklet.txt` | เวอร์ชันเล็ก gzip (~32KB, ต้องใช้เบราว์เซอร์รุ่นใหม่: Chrome 80+ / Firefox 113+ / Safari 16.4+) |
| `install.html` | หน้าติดตั้งภาษาไทย — ลากปุ่มไปวางที่แถบบุ๊คมาร์ค หรือกดคัดลอก URL |
| `app.min.js` | bundle ที่ minify แล้ว (ไฟล์เดียวกับที่ฝังใน bookmarklet) เปิดอ่านตรวจสอบได้ |
| `src/crypto-core.js` | ไลบรารี crypto ล้วน (keccak256, secp256k1 ECDSA RFC6979, msgpack, EIP-712, กฎปัดเศษของ HL) |
| `src/app.js` | แอปหลัก (UI ภาษาไทย, สแกน funding, ฮีดจ์, โหมดอัตโนมัติ, กระดานพลังงาน-ไม่ใช่) |
| `src/boot.js` | entry point ของ bookmarklet: เปิด popup → fallback overlay |
| `build.mjs` | สคริปต์ build + ตรวจสอบ (minify, ยืนยัน vector ลายเซ็นทางการ, สร้าง bookmarklet + install.html) |
| `test/crypto.test.mjs` | 76 tests — ลายเซ็น/กฎเศษ เทียบ vector ทางการ SDK + eth_account จริง |
| `test/app.smoke.test.mjs` | 38 tests — บูตแอปจริงใน jsdom + mock API + **ตรวจลายเซ็นที่ส่งถึง /exchange ด้วย ethers** |
| `test/boot.smoke.test.mjs` | 20 tests — popup/fallback/toggle ของ boot.js |
| `test/bundle.min.test.mjs` | 21 tests — รันตัวไฟล์ที่ส่งมอบจริง (app.min.js + bookmarklet ทั้ง 2 + install.html) |

## วิธีใช้ (สรุป)

1. เปิด `install.html` → ลากปุ่ม **⚡ HL Funding Arb** ไปวางบนแถบบุ๊คมาร์ค
   (หรือสร้างบุ๊คมาร์คใหม่เองแล้ววางเนื้อหาไฟล์ `.bookmarklet.txt` ที่ช่อง URL)
2. เปิดหน้าเว็บธรรมดา เช่น `example.com` (หลีกเลี่ยงหน้าที่ CSP เข้ม เช่น github.com)
3. คลิกบุ๊คมาร์ค → แดชบอร์ดเด้งเป็นหน้าต่างใหม่ (ถ้าโดนบล็อกจะกลายเป็น overlay บนหน้านั้น)
4. **ค่าเริ่มต้นคือโหมดจำลอง (dry-run)** — ทดลองได้แบบไม่เสียเงิน แล้วค่อยอ่านแท็บ "คู่มือ & ความเสี่ยง" ก่อนใช้เงินจริง
5. ใช้เงินจริง: สร้าง **API wallet** บน Hyperliquid (สั่งเทรดได้ แต่ถอนเงินไม่ได้) → วาง private key ในแท็บตั้งค่า → ปิด "โหมดจำลอง" (แนะนำทดลองบน Testnet ก่อน)

กลยุทธ์: เมื่อ funding ของเหรียญเป็นบวกสูง ผู้ถือฝั่ง long เพอร์ปิวส์จะจ่าย funding ให้ฝั่ง short
บอทจะซื้อสปอต + ชอร์ตเพอร์ปิวส์ขนาดเท่ากัน (delta ≈ 0) แล้วเก็บ funding ตามเวลาที่ถือ
โดยตารางสแกนแสดง APR ของ Hyperliquid เทียบ Binance/Bybit (display-only) เพื่อดูว่าอัตราผิดไปจากตลาดอื่นแค่ไหน

## Build / Test

```bash
# ต้องมี terser + jsdom + ethers ใน node_modules (เช่น symlink จากโปรเจกต์ npm ภายนอก)
node build.mjs                # สร้าง app.min.js + bookmarklet 2 เวอร์ชัน + install.html (ตรวจ vector ในตัว)
node test/crypto.test.mjs     # 76 tests
node test/app.smoke.test.mjs  # 38 tests (ต้องมี jsdom + ethers)
node test/boot.smoke.test.mjs # 20 tests (ต้องมี jsdom)
node test/bundle.min.test.mjs # 21 tests (ต้องมี jsdom)
```

## สิ่งที่ตรวจสอบแล้ว (verification)

- **ลายเซ็น L1 action**: ตรง vector ทางการจาก `hyperliquid-python-sdk` + ยืนยันกับ eth_account จริง 20/20 กรณี
  (keccak256, msgpack, nonce/vault/expiresAfter, phantom agent EIP-712, low-s + v flip, r/s hex ขั้นต่ำ)
- **End-to-end ใน DOM จำลอง**: บูตแอปจริง (minified) → คลิกปุ่มจริง → คำสั่งที่ส่งถึง `POST /exchange`
  ถูก mock จับไว้ตรวจ: โครงสร้าง order wire (asset id, IOC, reduceOnly), updateLeverage,
  และ **ลายเซ็นทุกคำสั่ง recover กลับมาได้เป็นที่อยู่เจ้าของ key ด้วย ethers.verifyTypedData**
- **Boot**: เปิด popup สำเร็จ / โดนบล็อกแล้ว fallback overlay / toggle ปิด-เปิด / focus หน้าต่างเดิม
- **Artifact**: bookmarklet decode กลับมาตรงกับ bundle เป๊ะ, เวอร์ชัน gzip คลายด้วย DecompressionStream ได้ตรงเป๊ะ

## ความปลอดภัย / ข้อควรระวัง

- ใช้ **API wallet** เท่านั้น (สร้างจากหน้า Hyperliquid → สิทธิ์เทรดอย่างเดียว ถอนไม่ได้) — อย่าใช้ private key ของกระเป๋าหลัก
- key ถูกเก็บใน `localStorage` ของหน้าเว็บที่รันเท่านั้น (และลบได้จากปุ่ม "ลบ key/รีเซ็ต") — แต่โดยธรรมชาติ bookmarklet
  **อย่ารันบนหน้าเว็บที่คุณไม่ไว้ใจ** เพราะหน้านั้นสามารถอ่านค่าในหน้าได้ แนะนำใช้ example.com หรือหน้าเปล่า
- บอทเทรดสกุลดิจิทัลจริงเมื่อปิดโหมดจำลอง — มีความเสี่ยงราคาหลุด (slippage), ค่า fee, สภาพคล่อง, และ liquidation ของขา short
  (แอปมีระบบเตือนระยะ liquidation + คำนวณ break-even ชั่วโมง + net APR หลัง fee ให้ก่อนสั่งเสมอ)
- ไม่มีใครอื่นเห็น key ของคุณ: โค้ดทั้งหมดรันในเบราว์เซอร์ของคุณ ยิง API ตรงไปที่ Hyperliquid/Binance/Bybit เท่านั้น
