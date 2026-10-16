// Netlify Function: analyst consensus ("ที่คาด") for the US releases shown on the dashboard,
// read from Investing.com's economic-calendar event pages.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────────────────────
// The automatic "ดี/แย่แค่ไหน เทียบกับที่คาด" analysis needs a consensus number, and no free API
// publishes one (they all come from analyst surveys behind paid terminals). Investing.com shows
// them publicly per event, so this function reads the six event pages we care about and returns
// the latest release's Actual / Forecast / Previous, server-side (no CORS, one shared cache).
// It also returns `upcoming`: the next scheduled release's date and Forecast, read from the history
// table at the bottom of the event page (that row has an empty Actual until the number is out), so
// the page can show "ตลาดคาด …" BEFORE the release instead of only after it.
//
// IMPORTANT — this is a best-effort convenience layer, never the source of truth:
//   • The page always keeps a baked-in CONSENSUS (with a date and the same links) and falls back
//     to it whenever this function fails. Cloudflare can and does challenge datacenter IPs, and
//     the markup can change, so a failure here is expected sometimes and must stay harmless.
//   • The frontend compares `events[key].actual` with the number on the card: if they disagree,
//     the consensus belongs to a different print and the page says so instead of pretending.
//   • robots.txt does not disallow /economic-calendar, and we make 6 requests per 3 hours per
//     instance, cached in front of the CDN, so the load on the upstream is negligible.
//
// Usage: /.netlify/functions/consensus

const TIMEOUT_MS = 8000;
const TTL_MS = 3 * 60 * 60 * 1000;
const { isReleaseDay } = require('./fred-data.js').__test;

const BASE = 'https://www.investing.com/economic-calendar/';
const EVENTS = {
  cpi: { slug: 'cpi-733', label: 'CPI YoY', kind: 'pct', range: [-5, 30] },
  coreCpi: { slug: 'united-states-core-consumer-price-index-(cpi)-yoy-736', label: 'Core CPI YoY', kind: 'pct', range: [-5, 30] },
  unrate: { slug: 'unemployment-rate-300', label: 'Unemployment Rate', kind: 'pct', range: [-5, 30] },
  nfp: { slug: 'nonfarm-payrolls-227', label: 'Nonfarm Payrolls', kind: 'jobs', range: [-4e6, 4e6] },
  fed: { slug: 'interest-rate-decision-168', label: 'Fed Interest Rate Decision', kind: 'pct', range: [0, 25] },
  ppi: { slug: 'ppi-238', label: 'PPI MoM', kind: 'pct', range: [-5, 5] }
};

const THAI_MONTHS = {
  'ม.ค.': 1, 'ก.พ.': 2, 'มี.ค.': 3, 'เม.ย.': 4, 'พ.ค.': 5, 'มิ.ย.': 6,
  'ก.ค.': 7, 'ส.ค.': 8, 'ก.ย.': 9, 'ต.ค.': 10, 'พ.ย.': 11, 'ธ.ค.': 12
};
const EN_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function toText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// The value that follows a label, e.g. "ตามจริง 3.4%" / "Actual 162K" / "Forecast -23.00 พัน".
// Deliberately small: we only ever read the "latest release" summary block, whose labels are
// stable in both the Thai and the English version of the page.
function valueAfter(text, labels) {
  const hay = text.toLowerCase();
  for (const label of labels) {
    const i = hay.indexOf(label.toLowerCase());
    if (i === -1) continue;
    const tail = text.slice(i + label.length, i + label.length + 40).trim();
    if (tail) return tail;
  }
  return '';
}

function parseNumber(raw) {
  const m = /^([+\-−]?\d[\d.,]*)\s*(%|พัน|ล้าน|K|M|mn)?/i.exec(String(raw || '').trim());
  if (!m) return null;
  const value = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(value)) return null;
  const unit = (m[2] || '').toLowerCase();
  let mult = 1;
  if (unit === 'พัน' || unit === 'k') mult = 1e3;
  if (unit === 'ล้าน' || unit === 'm' || unit === 'mn') mult = 1e6;
  return { value: value * mult, unit: m[2] || '' };
}

// "11 ก.ย. 2026" (Thai, sometimes with a stray space inside the abbreviation) or "Sep 11, 2026".
function parseDate(raw) {
  const s = String(raw || '').slice(0, 40).replace(/\s+/g, ' ').trim();

  const en = /([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (en) {
    const month = EN_MONTHS[en[1].slice(0, 3).toLowerCase()];
    if (month) return `${en[3]}-${String(month).padStart(2, '0')}-${String(Number(en[2])).padStart(2, '0')}`;
  }

  const th = /(\d{1,2})\s*([^\s0-9]+(?:\s*[^\s0-9]+)*?)\s*(\d{4})/.exec(s);
  if (th) {
    const month = THAI_MONTHS[th[2].replace(/\s+/g, '')];
    if (month) return `${th[3]}-${String(month).padStart(2, '0')}-${String(Number(th[1])).padStart(2, '0')}`;
  }
  return null;
}

// The next scheduled release from the event's history table. Rows read
//   Release date (period) | Time | Actual | Forecast | Previous
// newest first; a row whose Actual is still empty but has a Forecast is a release that hasn't happened
// yet. If there are several, the earliest one is "next". null when the table isn't there.
function parseUpcoming(html) {
  const rows = String(html || '').match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let best = null;
  for (const row of rows) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/gi) || []).map(toText);
    if (cells.length < 5) continue;
    const releaseDate = parseDate(cells[0]);
    if (!releaseDate) continue;
    if (parseNumber(cells[2])) continue; // already released
    const forecast = parseNumber(cells[3]);
    if (!forecast) continue;
    const previous = parseNumber(cells[4]);
    if (!best || releaseDate < best.releaseDate) {
      best = { releaseDate, forecast: forecast.value, previous: previous ? previous.value : null };
    }
  }
  return best;
}

// Pure parser — exported for tests. Returns nulls for anything it cannot read.
function parseEventPage(html) {
  const text = toText(html);
  const actual = parseNumber(valueAfter(text, ['ตามจริง', 'Actual']));
  const forecast = parseNumber(valueAfter(text, ['คาดการณ์', 'Forecast']));
  const previous = parseNumber(valueAfter(text, ['ก่อนหน้า', 'Previous']));
  const releaseDate = parseDate(valueAfter(text, ['ประกาศล่าสุด', 'Latest Release']));
  return {
    actual: actual ? actual.value : null,
    forecast: forecast ? forecast.value : null,
    previous: previous ? previous.value : null,
    unit: (actual && actual.unit) || (forecast && forecast.unit) || '',
    releaseDate,
    upcoming: parseUpcoming(html),
    hasAnyValue: !!(actual || forecast)
  };
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)',
        'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml'
      }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

let memCache = { at: 0, payload: null, ttlMs: TTL_MS };

// Right after a CPI / jobs / FOMC release Investing.com's "latest release" block switches to the new
// print. With a flat 3 h cache the page kept comparing the NEW number against the PREVIOUS print's
// forecast for hours (and flagged a round mismatch), exactly when the comparison matters most. So on
// release days the cache is 10 min between 12:25 and 20:00 UTC, and before 12:25 it never outlives
// 12:25. Same calendar heuristic as fred-data.js.
const RELEASE_TTL_MS = 10 * 60 * 1000;
function consensusTtlMs(now = new Date()) {
  const { release } = isReleaseDay(now);
  if (!release) return TTL_MS;
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins >= 12 * 60 + 25 && mins < 20 * 60) return RELEASE_TTL_MS;
  if (mins < 12 * 60 + 25) {
    const open = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 25);
    return Math.max(60 * 1000, Math.min(TTL_MS, open - now.getTime()));
  }
  return TTL_MS;
}

function cacheHeader(ttlS, release) {
  const s = Math.max(30, Math.round(ttlS));
  return release
    ? `public, max-age=${s}, s-maxage=${s}, stale-while-revalidate=60`
    : `public, max-age=${Math.min(s, 1800)}, s-maxage=${s}, stale-while-revalidate=86400`;
}

exports.handler = async function () {
  const now = new Date();
  const { release } = isReleaseDay(now);
  const ttlMs = consensusTtlMs(now);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheHeader(ttlMs / 1000, release)
  };

  // A copy cached on a quiet day (3 h) must not run past a release window that has since opened.
  const age = now.getTime() - memCache.at;
  if (memCache.payload && age < Math.min(memCache.ttlMs, ttlMs)) {
    const remainingS = (Math.min(memCache.ttlMs, ttlMs) - age) / 1000;
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': cacheHeader(remainingS, release) },
      body: JSON.stringify({ ...memCache.payload, cached: true, ttl: Math.round(remainingS) })
    };
  }

  const entries = Object.entries(EVENTS);
  const settled = await Promise.allSettled(entries.map(async ([key, spec]) => {
    const url = BASE + spec.slug;
    const parsed = parseEventPage(await fetchWithTimeout(url, TIMEOUT_MS));
    if (!parsed.hasAnyValue) throw new Error('no Actual/Forecast block found (page shape changed or blocked)');
    const inRange = (v) => v == null || (isFinite(v) && v >= spec.range[0] && v <= spec.range[1]);
    if (!inRange(parsed.actual) || !inRange(parsed.forecast) || !inRange(parsed.previous)) {
      throw new Error(`implausible values: actual=${parsed.actual} forecast=${parsed.forecast}`);
    }
    // an implausible upcoming row only drops the pre-release forecast, not the whole event
    if (parsed.upcoming && !inRange(parsed.upcoming.forecast)) parsed.upcoming = null;
    return [key, { ...parsed, label: spec.label, kind: spec.kind, url }];
  }));

  const events = {};
  const errors = {};
  settled.forEach((res, i) => {
    const key = entries[i][0];
    if (res.status === 'fulfilled') events[key] = res.value[1];
    else errors[key] = (res.reason && res.reason.message) || String(res.reason);
  });

  if (!Object.keys(events).length) {
    // Nothing usable: tell the caller so it can keep using its baked-in consensus.
    return {
      statusCode: 502,
      headers: { ...headers, 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        error: 'could not read any Investing.com event page',
        details: errors,
        hint: 'The page falls back to the consensus baked into index.html — this is not fatal.'
      })
    };
  }

  const payload = {
    source: 'investing.com',
    sourceLabel: 'Investing.com',
    fetchedAt: new Date().toISOString(),
    events,
    ttl: Math.round(ttlMs / 1000)
  };
  if (Object.keys(errors).length) payload.errors = errors;

  memCache = { at: Date.now(), payload, ttlMs };
  return { statusCode: 200, headers, body: JSON.stringify(payload) };
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = { parseEventPage, parseUpcoming, parseNumber, parseDate, toText, EVENTS, consensusTtlMs, _clearCache: () => { memCache = { at: 0, payload: null, ttlMs: TTL_MS }; } };
