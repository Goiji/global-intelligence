# วิธี Deploy ขึ้น Netlify (มี Function ซ่อน API key)

## โครงสร้างไฟล์
```
netlify-site/
├── index.html                          ← หน้าเว็บหลัก
├── netlify.toml                        ← ตั้งค่า Netlify
└── netlify/
    └── functions/
        ├── fred-data.js                ← Fed Rate / CPI (+core) / Unemployment / Payrolls
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

### 3. ตั้งค่า Environment Variables — **ไม่บังคับแล้ว** (ข้ามได้เลย)
ตั้งแต่รอบแก้ Sep 2026 ข้อมูลเศรษฐกิจสหรัฐ (Fed / CPI / ว่างงาน / จ้างงาน) **ดึงสดได้โดยไม่ต้องมี key ใดๆ**
เพราะ `netlify/functions/fred-data.js` ไล่แหล่งข้อมูลเป็นลำดับ:

| ลำดับ | แหล่ง | ต้องใช้ key | หมายเหตุ |
|---|---|---|---|
| 1 | FRED API (`api.stlouisfed.org`) | ✅ `FRED_API_KEY` | ข้ามอัตโนมัติถ้าไม่ได้ตั้ง key |
| 2 | FRED public CSV (`/graph/fredgraph.csv`) | ❌ | ข้อมูลชุดเดียวกับ API — ใช้งานได้ทุก deploy context รวม deploy preview |
| 3 | BLS public API v1 (`api.bls.gov`) | ❌ | แหล่งต้นทางของ CPI/จ้างงานจริงๆ (โควตา 25 ครั้ง/วัน/IP จึงไว้ท้ายสุด) |

ถ้าอยากใส่ key (เพื่อโควตาที่สูงขึ้นและใช้ API ทางการก่อน) ให้ไปที่
Site configuration → Environment variables → Add a variable:
   - `FRED_API_KEY` = key จาก [fred.stlouisfed.org](https://fred.stlouisfed.org/docs/api/api_key.html)
   - `ALPHAVANTAGE_API_KEY` = key จาก [alphavantage.co](https://www.alphavantage.co/support/#api-key) *(เฉพาะราคาน้ำมันสำรอง — ปกติใช้ Binance/OKX/Hyperliquid ฟรีอยู่แล้ว)*
   - `RSS2JSON_API_KEY` = key จาก [rss2json.com](https://rss2json.com/docs) *(ไม่ใส่ก็ได้ ใช้โควตาฟรีแทน)*

> ⚠️ ใส่ key แล้วต้อง **Trigger deploy** ใหม่เสมอ และเช็ค *Deploy contexts* ให้ครอบคลุม
> Deploy previews ด้วย ไม่งั้น preview จะมองไม่เห็น key (นี่คือสาเหตุที่ก่อนหน้านี้ขึ้น
> "FRED_API_KEY is not set" ทั้งที่ production ใช้ได้ปกติ)

### 4. เสร็จแล้ว!
เข้า URL ของเว็บที่ Netlify ให้มา (เช่น `your-site.netlify.app`) — ทุกคนที่เข้ามาจะเห็นข้อมูลชุดเดียวกัน
ไม่มีใครแก้ไขอะไรได้ (ไม่มีปุ่ม/ช่องกรอกให้แก้แล้ว) และไม่มีใครเห็น API key ของคุณเลย
แม้จะกด "View Page Source" ดู

## ข้อมูลเศรษฐกิจสหรัฐ (Fed / CPI / ว่างงาน / จ้างงาน) อัปเดตเองยังไง

`fred-data.js` คืนฟิลด์เหล่านี้ แล้ว `index.html` เอาไป render ลงการ์ด:

| ฟิลด์ | ซีรีส์ | เดิม | ตอนนี้ |
|---|---|---|---|
| `upper` / `lower` | DFEDTARU / DFEDTARL | รายวัน | รายวัน |
| `effr` | **EFFR** | FEDFUNDS (เฉลี่ยรายเดือน → ช้าได้ถึง 5 สัปดาห์) | รายวันทำการล่าสุด |
| `cpi` | CPIAUCSL | YoY เทียบ "แถวล่างที่ 12" แบบนับ index | YoY จาก `pc1` ของ FRED + ตรวจซ้ำกับระดับดัชนีโดย **เทียบตามวันที่จริง** |
| `coreCpi` | CPILFESL | *(ไม่มี — hardcode อยู่ในบทความ)* | เพิ่มใหม่ |
| `unrate` | UNRATE | รายเดือน | รายเดือน (มี BLS สำรอง) |
| `nfp` | PAYEMS | *(ไม่มี — hardcode `-23,000` ใน HTML)* | เพิ่มใหม่ = ส่วนต่างเดือนต่อเดือน × 1,000 |

**ทำไมต้องเทียบตามวันที่:** CPI เดือน ต.ค. 2025 หายไปทั้งเดือน (FRED ใส่ ".") เพราะหน่วยงานรัฐปิด
(lapse in appropriations) โค้ดเก่าที่ใช้ `levels[12]` จึงเลื่อนไปเทียบ **ก.ค. 2025** แทน ส.ค. 2025
→ ได้ 3.71% ทั้งที่ค่าถูกต้องคือ 3.35% ตอนนี้ lookup ตาม `YYYY-MM` ตรงๆ และถ้า `pc1` ต่างจากการคำนวณ
จากระดับดัชนีเกิน 0.15pp จะเชื่อเลขที่คำนวณเอง พร้อมส่ง `warning` กลับมาใน response

**รอบการแคช (ตั้งใจให้ทันเหตุการณ์):**
- ฝั่งเซิร์ฟเวอร์: 15 นาทีในวันประกาศตัวเลข (CPI ช่วงวันที่ 10–16, jobs report ศุกร์แรก, วันแถลง FOMC)
  และ 3 ชั่วโมงในวันปกติ + ส่ง `Cache-Control` ให้ Netlify CDN แคชซ้อนอีกชั้น
- ฝั่งเบราว์เซอร์: แคชตาม `refreshAfter` ที่เซิร์ฟเวอร์สั่ง (ไม่ใช่ "วันละครั้ง" แบบเดิม) · โพลซ้ำทุก
  10 นาที · ดึงใหม่ทันทีเมื่อสลับกลับเข้ามาที่แท็บ (`visibilitychange`) · มีปุ่ม `↻ ดึงค่าสดใหม่`
- ถ้าทุกแหล่งล่มพร้อมกัน จะคืนค่าล่าสุดที่เคยดึงได้พร้อม `stale:true` (HTTP 200) แทนการขึ้น error

**เช็คว่าทำงานไหม:** เปิด `https://<your-site>.netlify.app/.netlify/functions/fred-data`
ควรได้ JSON ที่มีตัวเลขจริง + ฟิลด์ `source` บอกว่ามาจาก `fred-api` / `fred-csv` / `bls`

## หมายเหตุ
- ค่า Fed Rate / CPI / Unemployment / Payrolls ถูกแคช 15 นาที–3 ชั่วโมงตามรอบประกาศตัวเลข
  (memory ของ Function + CDN + localStorage ฝั่งผู้ใช้) — ต่อให้มีคนเข้าพร้อมกันเยอะ ก็ยิง upstream
  จริงๆ แค่ไม่กี่ครั้งต่อวัน
- ราคา Gold, USD/THB, JPY/THB, CNY/THB, Oil (ผ่าน Binance/OKX/Hyperliquid), BTC ทุกอย่างในแท็บ BTC
  ยังคงดึงตรงจากเบราว์เซอร์ผู้ใช้เหมือนเดิม เพราะ API พวกนั้นไม่ติด CORS และไม่มี key ที่ต้องซ่อนอยู่แล้ว
- Netlify free tier ให้ Functions ฟรี 125,000 ครั้ง/เดือน — เพียงพอมากสำหรับเว็บนี้
