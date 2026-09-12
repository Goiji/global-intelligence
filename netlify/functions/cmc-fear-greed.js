// Netlify Function: CoinMarketCap Fear & Greed Index (keyless public API)
// Frontend ขอใช้ค่านี้แทน alternative.me ตามคำขอให้ "เอาค่าจาก coinmarketcap มาอัพเดตอัตโนมัติ"
// ใช้ public-api path ที่ไม่ต้องใช้ API key: /public-api/v3/fear-and-greed/latest
// ถ้า CMC ล่ม จะ fallback ไป alternative.me ฝั่งเซิร์ฟเวอร์ แล้วค่อยให้ frontend fallback ซ้ำอีกชั้น

const CMC_LATEST = 'https://pro-api.coinmarketcap.com/public-api/v3/fear-and-greed/latest';
const CMC_HISTORICAL = 'https://pro-api.coinmarketcap.com/public-api/v3/fear-and-greed/historical?limit=1';
const ALT_FNG = 'https://api.alternative.me/fng/?limit=1';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // Fear & Greed อัปเดตวันละครั้ง เก็บ 6 ชม.พอ
let memCache = { expiresAt: 0, data: null };

async function fetchJsonWithTimeout(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'global-intelligence-dashboard (cmc-fear-greed)', Accept: 'application/json' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

function normalizeCmcResponse(j) {
  // รองรับทั้ง { data: { value, value_classification, timestamp } } และ { data: [ { value, ... } ] }
  let entry = null;
  if (j && j.data) {
    if (Array.isArray(j.data)) entry = j.data[0];
    else if (typeof j.data === 'object') entry = j.data;
  }
  // บาง response อาจห่อใน j.data.data (เผื่อ schema เปลี่ยน)
  if (!entry && j && j.data && j.data.data) {
    const d = j.data.data;
    entry = Array.isArray(d) ? d[0] : d;
  }
  if (!entry) throw new Error('CMC: no data entry');
  const value = parseInt(entry.value ?? entry.score ?? entry.fear_and_greed ?? '', 10);
  const classification = entry.value_classification || entry.classification || entry.valueClassification || '';
  const timestamp = entry.timestamp || entry.update_time || entry.time_until_update || null;
  if (!isFinite(value)) throw new Error('CMC: value is not a number');
  return { value, classification, timestamp, raw: entry, source: 'coinmarketcap' };
}

function normalizeAltResponse(j) {
  const entry = j && j.data && j.data[0];
  if (!entry) throw new Error('alternative.me: no data entry');
  const value = parseInt(entry.value, 10);
  const classification = entry.value_classification || entry.classification || '';
  if (!isFinite(value)) throw new Error('alternative.me: value not a number');
  return { value, classification, timestamp: entry.timestamp || null, raw: entry, source: 'alternative.me (fallback)' };
}

exports.handler = async function () {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // ให้ CDN แคช 1 ชม. และ stale-while-revalidate อีก 6 ชม. — ลดการยิง CMC ซ้ำๆ
    'Cache-Control': 'public, max-age=3600, s-maxage=3600, stale-while-revalidate=21600'
  };

  if (memCache.data && now < memCache.expiresAt) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...memCache.data, cached: true })
    };
  }

  let result = null;
  let errors = [];

  // 1) ลอง CMC latest (keyless)
  try {
    const j = await fetchJsonWithTimeout(CMC_LATEST, 6000);
    result = normalizeCmcResponse(j);
  } catch (e) {
    errors.push(`cmc-latest: ${e.message}`);
    // 2) ลอง CMC historical (บางที latest มีปัญหา แต่ historical ยังได้)
    try {
      const j2 = await fetchJsonWithTimeout(CMC_HISTORICAL, 6000);
      result = normalizeCmcResponse(j2);
    } catch (e2) {
      errors.push(`cmc-historical: ${e2.message}`);
    }
  }

  // 3) ถ้า CMC ทั้งสองทางล้ม ให้ fallback ไป alternative.me ฝั่งเซิร์ฟเวอร์ (ผู้ใช้จะได้ค่าอยู่ดี)
  if (!result) {
    try {
      const j3 = await fetchJsonWithTimeout(ALT_FNG, 5000);
      result = normalizeAltResponse(j3);
      result.fallback = true;
      result.cmcErrors = errors;
    } catch (e3) {
      errors.push(`alternative.me: ${e3.message}`);
    }
  }

  if (!result) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'All Fear & Greed sources failed', details: errors })
    };
  }

  const payload = {
    value: result.value,
    classification: result.classification,
    value_classification: result.classification,
    timestamp: result.timestamp,
    source: result.source,
    fallback: !!result.fallback,
    fetchedAt: new Date().toISOString(),
    ttl: CACHE_TTL_MS / 1000
  };
  if (result.cmcErrors) payload.cmcErrors = result.cmcErrors;

  memCache = { data: payload, expiresAt: now + CACHE_TTL_MS };

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(payload)
  };
};
