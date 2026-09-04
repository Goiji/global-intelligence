# วิธี Deploy ขึ้น Netlify (มี Function ซ่อน API key)

## โครงสร้างไฟล์
```
netlify-site/
├── index.html                          ← หน้าเว็บหลัก
├── netlify.toml                        ← ตั้งค่า Netlify
└── netlify/
    └── functions/
        ├── fred-data.js                ← Fed Rate / CPI / Unemployment
        ├── oil-price.js                ← ราคาน้ำมัน WTI (สำรอง)
        └── news-feed.js                ← ข่าว RSS
```

## ทำไมต้องใช้วิธีนี้ (ไม่ใช่ลากไฟล์ธรรมดา)
วิธีนี้ทำให้ API key ของคุณอยู่แค่บนเซิร์ฟเวอร์ของ Netlify เท่านั้น ไม่โผล่ในโค้ดที่คนอื่นเปิดดูได้เลย
(ต่างจากก่อนหน้านี้ที่ key ฝังอยู่ในไฟล์ HTML ตรงๆ)

## ขั้นตอน Deploy

### 1. อัปโหลดขึ้น GitHub (จำเป็น — ลาก-วางแบบ Netlify Drop ใช้กับ Functions ไม่ได้)
- สร้าง repo ใหม่บน GitHub
- อัปโหลดไฟล์ทั้งหมดในโฟลเดอร์นี้ (รวมโฟลเดอร์ `netlify/` ด้วย) ขึ้น repo นั้น

### 2. เชื่อม Netlify กับ GitHub repo
1. เข้า [app.netlify.com](https://app.netlify.com) → "Add new site" → "Import an existing project"
2. เลือก GitHub แล้วเลือก repo ที่เพิ่งสร้าง
3. Build settings ปล่อยว่างไว้ได้เลย (ไม่ต้อง build command, publish directory ใส่ `.`)
4. กด Deploy

### 3. ตั้งค่า Environment Variables (ใส่ API key ตรงนี้ — ไม่ใช่ในโค้ด)
1. ไปที่ Site settings → Environment variables → Add a variable
2. เพิ่มทีละตัว:
   - `FRED_API_KEY` = key จาก [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html)
   - `ALPHAVANTAGE_API_KEY` = key จาก [alphavantage.co](https://www.alphavantage.co/support/#api-key)
   - `RSS2JSON_API_KEY` = key จาก [rss2json.com](https://rss2json.com/docs) *(ไม่ใส่ก็ได้ ใช้โควตาฟรีแทน)*
3. กด "Redeploy site" ให้ค่าใหม่มีผล (Site settings ด้านบน → Trigger deploy)

### 4. เสร็จแล้ว!
เข้า URL ของเว็บที่ Netlify ให้มา (เช่น `your-site.netlify.app`) — ทุกคนที่เข้ามาจะเห็นข้อมูลชุดเดียวกัน
ไม่มีใครแก้ไขอะไรได้ (ไม่มีปุ่ม/ช่องกรอกให้แก้แล้ว) และไม่มีใครเห็น API key ของคุณเลย
แม้จะกด "View Page Source" ดู

## หมายเหตุ
- ค่า Fed Rate / CPI / Unemployment และราคาน้ำมัน (ถ้าใช้ Alpha Vantage) จะถูกแคชไว้ 1 วันฝั่งเซิร์ฟเวอร์
  (ในตัวแปร memory ของ Function) — ทำให้เรียก FRED/Alpha Vantage จริงๆ ไม่เกินวันละไม่กี่ครั้งต่อวัน
  ต่อให้มีคนเข้าเว็บพร้อมกันเยอะแค่ไหนก็ตาม
- ราคา Gold, USD/THB, JPY/THB, CNY/THB, Oil (ผ่าน Binance/OKX/Hyperliquid), BTC ทุกอย่างในแท็บ BTC
  ยังคงดึงตรงจากเบราว์เซอร์ผู้ใช้เหมือนเดิม เพราะ API พวกนั้นไม่ติด CORS และไม่มี key ที่ต้องซ่อนอยู่แล้ว
- Netlify free tier ให้ Functions ฟรี 125,000 ครั้ง/เดือน — เพียงพอมากสำหรับเว็บนี้
