// Netlify Function: upcoming US economic releases for the dashboard's calendar card.
//
//   GET /.netlify/functions/calendar
//   → { events: [{ key, label, date: 'YYYY-MM-DD', at: ISO-UTC|null, source }], sources: [...] }
//
// Sources, merged and de-duplicated by (key, date):
//   1. BLS release calendar (public iCalendar feed) — CPI, Employment Situation, PPI, JOLTS.
//      Carries exact 8:30 / 10:00 ET times.
//   2. FRED release dates API — only when FRED_API_KEY is set. Adds the BEA releases
//      (PCE / personal income, GDP) that BLS doesn't publish, and backs up CPI / jobs.
//   3. FOMC statement dates (2:00 pm ET) — the same list fred-data.js keeps.
//   4. Weekly initial jobless claims (DOL, Thursday 8:30 ET; Wednesday in holiday weeks) — computed
//      from the fixed weekly schedule, so it needs no upstream. Only the next two are listed so the
//      weekly entries don't crowd the monthly releases out of the card.
//   5. ISM Manufacturing / Services PMI (10:00 ET on the 1st / 3rd US business day of the month) —
//      computed from that fixed rule (ISM is a private survey with no feed of its own). The page also
//      cross-checks the date against Investing.com's next-release row.
// If 1 and 2 both fail the card still shows FOMC, so it never comes back empty.

const { __test: fred } = require('./fred-data.js');

const BLS_ICS = 'https://www.bls.gov/schedule/news_release/bls.ics';
const FRED_DATES = 'https://api.stlouisfed.org/fred/release/dates';
const TIMEOUT_MS = 6000;
const TTL_S = 6 * 60 * 60;
const HORIZON_DAYS = 75;

// BLS release title → our key. Matched case-insensitively against the event SUMMARY.
const BLS_MATCH = [
  [/consumer price index/i, 'cpi'],
  [/employment situation/i, 'jobs'],
  [/producer price index/i, 'ppi'],
  [/job openings and labor turnover/i, 'jolts']
];
// FRED release ids → our key (10 CPI · 50 Employment Situation · 53 GDP · 54 Personal Income & Outlays/PCE)
// 9 = Advance Monthly Sales for Retail and Food Services (Census)
const FRED_RELEASES = { 10: 'cpi', 50: 'jobs', 53: 'gdp', 54: 'pce', 9: 'retail' };
// Usual release time (ET) when a source gives only a date.
const DEFAULT_ET = { cpi: '08:30', jobs: '08:30', ppi: '08:30', jolts: '10:00', gdp: '08:30', pce: '08:30', fomc: '14:00', claims: '08:30', retail: '08:30', ismMfg: '10:00', ismSvc: '10:00' };

let memCache = { data: null, expiresAt: 0, lastGood: null };

async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      // BLS rejects requests without a descriptive User-Agent.
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard; +https://global-intelligence-dashboard.netlify.app)', Accept: 'text/calendar, application/json, */*' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Offset (minutes) of America/New_York from UTC at a given instant (handles DST).
function nyOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(utcMs));
  const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
  return Math.round((asUtc - utcMs) / 60000);
}
// Eastern wall-clock time → ISO UTC.
function etToUtcIso(date, hhmm) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (hhmm || '08:30').split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off = nyOffsetMinutes(guess);
  return new Date(guess - off * 60000).toISOString();
}

// Minimal iCalendar reader: unfolds continuation lines, returns [{summary, dtstart, tzid}].
function parseIcs(text) {
  const lines = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const head = line.slice(0, i), value = line.slice(i + 1);
      const name = head.split(';')[0].toUpperCase();
      if (name === 'SUMMARY') cur.summary = value.replace(/\\,/g, ',').replace(/\\n/g, ' ').trim();
      if (name === 'DTSTART') {
        cur.dtstart = value.trim();
        const tz = /TZID=([^;:]+)/i.exec(head);
        cur.tzid = tz ? tz[1] : null;
      }
    }
  }
  return events;
}

// One iCalendar DTSTART → { date (ET calendar day), at (ISO UTC) }.
function icsStart(dtstart) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(dtstart || '');
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { date, at: null };
  if (m[7]) {
    const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])).toISOString();
    // the ET calendar day can differ from the UTC one for late-evening times
    const etDay = new Date(Date.parse(at) + nyOffsetMinutes(Date.parse(at)) * 60000).toISOString().slice(0, 10);
    return { date: etDay, at };
  }
  // floating or TZID time — BLS publishes Eastern
  return { date, at: etToUtcIso(date, `${m[4]}:${m[5]}`) };
}

function blsEvents(text) {
  const out = [];
  parseIcs(text).forEach((ev) => {
    const hit = BLS_MATCH.find(([re]) => re.test(ev.summary || ''));
    if (!hit) return;
    const s = icsStart(ev.dtstart);
    if (!s) return;
    out.push({ key: hit[1], date: s.date, at: s.at || etToUtcIso(s.date, DEFAULT_ET[hit[1]]), title: ev.summary, source: 'bls' });
  });
  return out;
}

function fredEvents(json, key) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  if (j.error_message) throw new Error(j.error_message);
  return (j.release_dates || [])
    .map((r) => r.date)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .map((date) => ({ key, date, at: etToUtcIso(date, DEFAULT_ET[key]), source: 'fred' }));
}

function fomcEvents() {
  return (fred.FOMC_STATEMENT_DATES || []).map((date) => ({ key: 'fomc', date, at: etToUtcIso(date, DEFAULT_ET.fomc), source: 'fomc' }));
}

function claimsEvents(now = new Date()) {
  return fred.upcomingClaimsDates(2, now).map((date) => ({ key: 'claims', date, at: etToUtcIso(date, DEFAULT_ET.claims), source: 'dol-schedule' }));
}

// US federal holidays that can fall in the first days of a month (when ISM publishes): New Year's
// Day and Independence Day (each observed on the Friday/Monday when it lands on a weekend) and Labor Day.
function isEarlyMonthHoliday(y, m, d) {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const fixed = (fm, fd) => {
    const fdow = new Date(Date.UTC(y, fm - 1, fd)).getUTCDay();
    const observed = fdow === 6 ? fd - 1 : fdow === 0 ? fd + 1 : fd;
    return m === fm && d === observed;
  };
  if (fixed(1, 1) || fixed(7, 4)) return true;
  if (m === 9 && dow === 1 && d <= 7) return true; // Labor Day, first Monday of September
  return false;
}
// The n-th US business day (Mon–Fri, not a holiday above) of month m (1-12) of year y → 'YYYY-MM-DD'.
function nthBusinessDay(y, m, n) {
  let count = 0;
  for (let d = 1; d <= 15; d++) {
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (dow === 0 || dow === 6 || isEarlyMonthHoliday(y, m, d)) continue;
    if (++count === n) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}
// ISM Manufacturing (1st business day) and Services (3rd business day) for this month and the next two.
function ismEvents(now = new Date()) {
  const out = [];
  for (let k = 0; k < 3; k++) {
    const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const y = t.getUTCFullYear(), m = t.getUTCMonth() + 1;
    [['ismMfg', 1], ['ismSvc', 3]].forEach(([key, n]) => {
      const date = nthBusinessDay(y, m, n);
      if (date) out.push({ key, date, at: etToUtcIso(date, DEFAULT_ET[key]), source: 'ism-schedule' });
    });
  }
  return out;
}

// Keep upcoming events within the horizon, one per (key, date), soonest first.
function mergeEvents(lists, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const until = new Date(now.getTime() + HORIZON_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Map();
  lists.flat().forEach((e) => {
    if (!e || e.date < today || e.date > until) return;
    const id = e.key + '|' + e.date;
    if (!seen.has(id) || (seen.get(id).source !== 'bls' && e.source === 'bls')) seen.set(id, e);
  });
  return [...seen.values()].sort((a, b) => (a.at || a.date).localeCompare(b.at || b.date));
}

async function buildPayload(apiKey) {
  const lists = [fomcEvents(), claimsEvents(), ismEvents()], sources = ['fomc', 'dol-schedule', 'ism-schedule'], errors = {};
  try { lists.push(blsEvents(await fetchText(BLS_ICS))); sources.push('bls'); }
  catch (e) { errors.bls = e.message; }
  if (apiKey) {
    const today = new Date().toISOString().slice(0, 10);
    await Promise.all(Object.entries(FRED_RELEASES).map(async ([id, key]) => {
      try {
        const url = `${FRED_DATES}?release_id=${id}&api_key=${encodeURIComponent(apiKey)}&file_type=json`
          + `&realtime_start=${today}&include_release_dates_with_no_data=true&sort_order=asc&limit=20`;
        lists.push(fredEvents(await fetchText(url), key));
        if (!sources.includes('fred')) sources.push('fred');
      } catch (e) { errors['fred-' + key] = e.message; }
    }));
  }
  const out = { events: mergeEvents(lists), sources, asOf: new Date().toISOString() };
  if (Object.keys(errors).length) out.errors = errors;
  return out;
}

exports.handler = async function () {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=${24 * 60 * 60}`
  };
  const now = Date.now();
  if (memCache.data && now < memCache.expiresAt) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.data, cached: true }) };
  }
  try {
    const data = await buildPayload((process.env.FRED_API_KEY || '').trim());
    // Only the computed sources (FOMC + claims schedule) means the release feeds failed — cache that
    // briefly so we retry soon.
    const fetched = data.sources.some((s) => s === 'bls' || s === 'fred');
    const ttl = fetched ? TTL_S : 30 * 60;
    memCache = { data, expiresAt: now + ttl * 1000, lastGood: fetched ? data : memCache.lastGood };
    if (!fetched && memCache.lastGood) {
      // the claims dates are computed, so always take today's rather than the cached copy's
      const kept = memCache.lastGood.events.filter((e) => e.key !== 'claims' && e.key !== 'ismMfg' && e.key !== 'ismSvc');
      return { statusCode: 200, headers, body: JSON.stringify({ ...memCache.lastGood, events: mergeEvents([kept, claimsEvents(), ismEvents()]), stale: true }) };
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    return { statusCode: 200, headers, body: JSON.stringify({ events: mergeEvents([fomcEvents(), claimsEvents(), ismEvents()]), sources: ['fomc', 'dol-schedule', 'ism-schedule'], errors: { all: e.message } }) };
  }
};

module.exports.__test = { nthBusinessDay, ismEvents, parseIcs, icsStart, blsEvents, fredEvents, fomcEvents, claimsEvents, mergeEvents, etToUtcIso, nyOffsetMinutes };
