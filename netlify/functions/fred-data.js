// Netlify Function: live US macro data for the dashboard —
// Fed funds target range, effective fed funds rate, CPI (headline + core), unemployment, nonfarm payrolls.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THIS WAS REWRITTEN (Sep 2026)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// 1) IT NO LONGER NEEDS AN API KEY.
//    FRED_API_KEY used to be a hard requirement, so any deploy context that didn't have the
//    variable (deploy previews, branch deploys, a fresh site, a local `netlify dev` without .env)
//    returned 500 "FRED_API_KEY is not set…" and the page fell back to hardcoded numbers forever.
//    FRED's public graph endpoint serves the exact same observations with NO credentials:
//      https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL&transformation=pc1
//    so the source chain is now:  fred-api (only if a key is configured) → fred-csv (keyless)
//    → BLS public API v1 (keyless, and the actual origin of the CPI/jobs numbers).
//
// 2) YEAR-AGO LOOKUP IS BY DATE, NOT BY ARRAY INDEX.
//    The old code computed CPI YoY as `levels[0]` vs `levels[12]` after filtering out non-numeric
//    observations. October 2025 CPI is missing (".") because of the 2025 lapse in appropriations,
//    so index 12 silently pointed at **July 2025** instead of August 2025 → 3.71% instead of the
//    correct 3.35%. Any future missing month would have skewed it the same way. We now resolve the
//    year-ago observation by its actual date, and prefer FRED's own `pc1` transform when available
//    (cross-checked against the by-date computation).
//
// 3) NEW FIELDS the page used to hardcode: `nfp` (monthly change in total nonfarm payrolls, from
//    PAYEMS, in jobs) and `coreCpi` (CPILFESL YoY). EFFR is now the **daily** series instead of
//    FEDFUNDS (a monthly average that could be up to ~5 weeks behind).
//
// 4) RELEASE-AWARE CACHING + NEVER A HARD FAILURE.
//    TTL is short (15 min) on days when CPI / jobs / FOMC data lands and 3 h otherwise, and the
//    deadline is sent to the client as `refreshAfter` so the page re-polls at the right time.
//    If every source fails we serve the last known-good payload flagged `stale:true` rather than
//    a 500, so the dashboard degrades gracefully instead of showing an error banner.
//
// Nothing here is secret: all keyless sources are public, and FRED_API_KEY (if set) still never
// reaches the browser.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const BLS_API = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';

// Per-attempt timeout, and a global deadline so the whole handler stays inside Netlify's
// default 10s function limit even when several sources are slow at once.
const ATTEMPT_TIMEOUT_MS = 5000;
const HARD_DEADLINE_MS = 8500;

// Official FOMC statement dates (day 2 of each meeting, 2:00pm ET) — mirrors index.html.
// The Fed publishes its calendar ~2 years ahead, so 2027 is already fixed:
// Jan 26–27, Mar 16–17, Apr 27–28, Jun 8–9, Jul 27–28, Sep 14–15, Oct 26–27, Dec 7–8.
// Without the 2027 entries the "release day → 15 min TTL" shortcut silently stopped working on
// 2027-01-01 (the countdown card in index.html would also go blank). Add 2028 when published.
const FOMC_STATEMENT_DATES = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
  '2027-01-27', '2027-03-17', '2027-04-28', '2027-06-09',
  '2027-07-28', '2027-09-15', '2027-10-27', '2027-12-08'
];

// series id per source. `bls` is only used for monthly series (BLS has no daily rates).
const TARGETS = {
  upper: { fred: 'DFEDTARU', cadence: 'daily' },
  lower: { fred: 'DFEDTARL', cadence: 'daily' },
  effr: { fred: 'EFFR', cadence: 'daily' },
  unrate: { fred: 'UNRATE', bls: 'LNS14000000', cadence: 'monthly' },
  cpi: { fred: 'CPIAUCSL', bls: 'CUUR0000SA0', cadence: 'monthly' },
  coreCpi: { fred: 'CPILFESL', bls: 'CUUR0000SA0L1E', cadence: 'monthly' },
  // FIX (verified Sep 2026): this used to be CES0500000003, which is "Average HOURLY EARNINGS of
  // All Employees, Total Private" (~$37/hour) — not employment at all. payrollsMetric() filters
  // levels to 50,000–500,000 (thousands of jobs), so that series was always thrown away and the
  // BLS fallback could only ever fail with "no usable PAYEMS level". The correct BLS id for the
  // headline payroll number (FRED: PAYEMS) is CES0000000001 — "All Employees, Total Nonfarm".
  payrolls: { fred: 'PAYEMS', bls: 'CES0000000001', cadence: 'monthly' }
};

// Cheap sanity ranges: if a "value" falls outside these we treat the fetch as failed instead of
// publishing garbage (e.g. an HTML error page that somehow parsed into a number).
const SANITY = {
  pctLevel: [-5, 30], // fed funds / unemployment, in %
  pctYoy: [-20, 30], // inflation YoY, in %
  jobsChange: [-4e6, 4e6] // monthly payroll change, in jobs
};

// In-memory cache for this function instance (resets on cold start — fine, the CDN + browser
// caches below do the heavy lifting). `lastGood` survives TTL expiry so we can serve stale
// rather than failing outright.
let memCache = { expiresAt: 0, data: null, lastGood: null, lastGoodAt: 0 };

// ── small date helpers ────────────────────────────────────────────────────────────────────────
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}
function daysAgoIso(n, from = new Date()) {
  return isoDay(new Date(from.getTime() - n * 86400000));
}
function monthsAgoIso(n, from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - n, 1));
  return isoDay(d);
}
// '2026-08-01' -> '2025-08-01' (same month, previous year). Leap-day safe enough for monthly series.
function yearAgoIso(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return `${y - 1}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// '2026-08-01' -> '2026-07-01'
function monthBeforeIso(date) {
  const [y, m] = String(date).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return isoDay(d);
}

// ── caching policy ────────────────────────────────────────────────────────────────────────────
// US macro releases cluster on predictable days: CPI between the 10th and 16th, the jobs report
// on the first Friday, FOMC statements on the dates above (all ~8:30am / 2:00pm ET, i.e. UTC-4/-5).
// On those days we shrink the TTL so a freshly published number reaches the page within minutes;
// otherwise 3 hours is plenty for monthly/daily series. Heuristic on the UTC date, documented as
// such — being off by a day at a month boundary only costs one extra fetch.
function isReleaseDay(now = new Date()) {
  const day = now.getUTCDate();
  const dow = now.getUTCDay();
  const cpiWindow = day >= 10 && day <= 16;
  const firstFriday = dow === 5 && day <= 7;
  const fomc = FOMC_STATEMENT_DATES.includes(isoDay(now));
  return { release: cpiWindow || firstFriday || fomc, cpiWindow, firstFriday, fomc };
}

// ── fetching ──────────────────────────────────────────────────────────────────────────────────
async function fetchText(url, deadline) {
  const ms = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
  if (ms <= 250) throw new Error('deadline exceeded');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'global-intelligence-dashboard (netlify function)', Accept: '*/*' }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// Minimal RFC4180-ish field splitter: keeps quoted values intact so "159,075" stays one field
// instead of being cut at the thousands separator.
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// FRED public CSV. Values may be empty, "." (FRED's literal "missing"), or quoted with thousands
// separators — all three are handled. Sorted newest-first.
function parseFredCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = splitCsvLine(lines[i]);
    const date = (parts[0] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const raw = (parts[1] || '').trim().replace(/^"|"$/g, '').replace(/,/g, '');
    if (!raw || raw === '.' || raw === '-') continue;
    const value = parseFloat(raw);
    if (!isFinite(value)) continue;
    out.push({ date, value });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

function parseFredApiJson(text) {
  const j = JSON.parse(text);
  if (j.error_message) throw new Error(`FRED error — ${j.error_message}`);
  const out = (j.observations || [])
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && isFinite(o.value));
  out.sort((a, b) => b.date.localeCompare(a.date));
  if (!out.length) throw new Error('no usable observations');
  return out;
}

// BLS public API v1 (no key; 25 queries/day/IP — that's why it's the last resort, and why we only
// ever ask it for one series at a time). Periods look like "M08"; "M13" (annual) and "-" are skipped.
function parseBlsJson(text, seriesId) {
  const j = JSON.parse(text);
  if (j.status !== 'REQUEST_SUCCEEDED') throw new Error(`BLS status ${j.status}`);
  const series = ((j.Results || {}).series || []).find((s) => s.seriesID === seriesId);
  if (!series) throw new Error(`BLS: series ${seriesId} missing from response`);
  const out = [];
  for (const d of series.data || []) {
    const m = /^M(0[1-9]|1[0-2])$/.exec(d.period || '');
    if (!m) continue;
    const raw = String(d.value).trim();
    if (!raw || raw === '-' || raw === '.') continue;
    const value = parseFloat(raw);
    if (!isFinite(value)) continue;
    out.push({ date: `${d.year}-${m[1]}-01`, value });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  if (!out.length) throw new Error('BLS: no usable observations');
  return out;
}

// Try every source for one series, first success wins. Never throws for a missing API key —
// the keyless sources cover it.
async function getObservations(key, { apiKey, deadline, transformation = null, limit = 400 } = {}) {
  const spec = TARGETS[key];
  const trail = [];

  if (apiKey && Date.now() < deadline) {
    try {
      const url =
        `${FRED_API}?series_id=${spec.fred}&api_key=${encodeURIComponent(apiKey)}` +
        `&file_type=json&sort_order=desc&limit=${limit}` +
        (transformation ? `&units=${transformation}` : '');
      return { obs: parseFredApiJson(await fetchText(url, deadline)), source: 'fred-api' };
    } catch (e) {
      trail.push(`fred-api: ${e.message}`);
    }
  }

  if (Date.now() < deadline) {
    try {
      // Daily series need a short window; monthly ones need ~26 months so a by-date year-ago
      // lookup still works when a month is missing.
      const cosd = spec.cadence === 'daily' ? daysAgoIso(40) : monthsAgoIso(26);
      const url =
        `${FRED_CSV}?id=${spec.fred}&cosd=${cosd}` + (transformation ? `&transformation=${transformation}` : '');
      const obs = parseFredCsv(await fetchText(url, deadline));
      if (!obs.length) throw new Error('empty CSV');
      return { obs, source: 'fred-csv' };
    } catch (e) {
      trail.push(`fred-csv: ${e.message}`);
    }
  }

  if (spec.bls && !transformation && Date.now() < deadline) {
    try {
      return { obs: parseBlsJson(await fetchText(`${BLS_API}${spec.bls}`, deadline), spec.bls), source: 'bls' };
    } catch (e) {
      trail.push(`bls: ${e.message}`);
    }
  }

  throw new Error(trail.join(' | ') || `no source attempted for ${key}`);
}

// ── metric builders ───────────────────────────────────────────────────────────────────────────
function inRange(v, [lo, hi]) {
  return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi;
}

function latestOf(obs, range) {
  const hit = obs.find((o) => inRange(o.value, range));
  if (!hit) throw new Error('no observation inside the expected range');
  return hit;
}

// Simple level series (fed funds bounds, EFFR, unemployment).
async function levelMetric(key, apiKey, deadline) {
  const { obs, source } = await getObservations(key, { apiKey, deadline });
  const hit = latestOf(obs, key === 'unrate' ? SANITY.pctLevel : SANITY.pctLevel);
  return { value: hit.value, date: hit.date, source };
}

// By-date YoY from a raw level series (e.g. CPIAUCSL). Pulled out as a pure function so it can be
// unit-tested without the network — this is the exact bug class that made Oct-2025's missing CPI
// print skew the number (index-12 lookup instead of a real date lookup).
function yoyFromLevels(obs, source) {
  const latest = latestOf(obs, [1, 10000]);
  const target = yearAgoIso(latest.date);
  const prior = obs.find((o) => o.date === target);
  if (!prior || !prior.value) return { error: `no year-ago level for ${target}` };
  return {
    result: {
      value: ((latest.value - prior.value) / prior.value) * 100,
      date: latest.date,
      level: latest.value,
      yearAgoDate: prior.date,
      yearAgoLevel: prior.value,
      source,
      method: 'computed-from-levels-by-date'
    }
  };
}

// Inflation YoY: prefer the official pc1 transform, then verify it against a by-date computation
// from raw levels. If the two disagree materially we trust the by-date math and flag it.
async function yoyMetric(key, apiKey, deadline) {
  const attempts = await Promise.allSettled([
    getObservations(key, { apiKey, deadline, transformation: 'pc1' }),
    getObservations(key, { apiKey, deadline })
  ]);

  const pc1 = attempts[0].status === 'fulfilled' ? attempts[0].value : null;
  const levels = attempts[1].status === 'fulfilled' ? attempts[1].value : null;
  const trail = [];
  if (attempts[0].status === 'rejected') trail.push(`pc1(${attempts[0].reason.message})`);
  if (attempts[1].status === 'rejected') trail.push(`levels(${attempts[1].reason.message})`);

  let computed = null;
  if (levels && levels.obs.length) {
    try {
      const r = yoyFromLevels(levels.obs, levels.source);
      if (r.result) computed = r.result;
      else trail.push(r.error);
    } catch (e) {
      trail.push(`levels: ${e.message}`);
    }
  }

  let official = null;
  if (pc1 && pc1.obs.length) {
    try {
      const hit = latestOf(pc1.obs, SANITY.pctYoy);
      official = { value: hit.value, date: hit.date, source: pc1.source, method: 'fred-pc1' };
    } catch (e) {
      trail.push(`pc1: ${e.message}`);
    }
  }

  if (official && computed) {
    const drift = Math.abs(official.value - computed.value);
    const base = { ...official, level: computed.level, yearAgoDate: computed.yearAgoDate, yearAgoLevel: computed.yearAgoLevel };
    if (drift > 0.15) {
      // The published transform and the raw levels disagree — trust the arithmetic we can see,
      // and say so loudly rather than silently picking one.
      return {
        ...computed,
        pc1Value: official.value,
        warning: `pc1 (${official.value.toFixed(2)}%) disagrees with by-date levels (${computed.value.toFixed(2)}%) by ${drift.toFixed(2)}pp — using by-date levels`
      };
    }
    return { ...base, crossCheck: computed.value, method: 'fred-pc1 (cross-checked with levels)' };
  }
  if (computed) return computed;
  if (official) return official;
  throw new Error(trail.join(' | ') || 'both CPI paths failed');
}

// Nonfarm payrolls: monthly *change* in jobs, derived from the PAYEMS level (thousands of jobs).
// The previous month is matched by date too, so a missing month can't masquerade as a huge swing.
// Pure (no network) so the tests can pin down the behaviour — including the case where a caller
// hands us a series that is plainly not an employment level.
function payrollsFromLevels(obs, source) {
  const levels = obs.filter((o) => o.value > 50000 && o.value < 500000); // PAYEMS is ~150-170k (thousands)
  const latest = levels[0]; // parsers return newest-first
  if (!latest) throw new Error('no usable PAYEMS level');
  const prevDate = monthBeforeIso(latest.date);
  const prev = levels.find((o) => o.date === prevDate);
  if (!prev) throw new Error(`no previous month (${prevDate}) to diff against`);

  const change = Math.round((latest.value - prev.value) * 1000);
  if (!inRange(change, SANITY.jobsChange)) throw new Error(`implausible payroll change ${change}`);
  return {
    value: change,
    date: latest.date,
    prevDate: prev.date,
    level: Math.round(latest.value * 1000),
    prevLevel: Math.round(prev.value * 1000),
    unit: 'jobs',
    source,
    method: 'PAYEMS month-over-month change',
    note: 'MoM change of the seasonally-adjusted PAYEMS level, so it is the net change after prior months are revised — it can differ slightly from the originally published headline print.'
  };
}

async function payrollsMetric(apiKey, deadline) {
  const { obs, source } = await getObservations('payrolls', { apiKey, deadline });
  return payrollsFromLevels(obs, source);
}

async function buildPayload(apiKey) {
  const deadline = Date.now() + HARD_DEADLINE_MS;
  const errors = {};
  const data = { fetchedAt: new Date().toISOString(), keyConfigured: !!apiKey };

  const jobs = [
    ['upper', () => levelMetric('upper', apiKey, deadline)],
    ['lower', () => levelMetric('lower', apiKey, deadline)],
    ['effr', () => levelMetric('effr', apiKey, deadline)],
    ['unrate', () => levelMetric('unrate', apiKey, deadline)],
    ['cpi', () => yoyMetric('cpi', apiKey, deadline)],
    ['coreCpi', () => yoyMetric('coreCpi', apiKey, deadline)],
    ['nfp', () => payrollsMetric(apiKey, deadline)]
  ];

  const results = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  results.forEach((res, i) => {
    const key = jobs[i][0];
    if (res.status === 'fulfilled') data[key] = res.value;
    else errors[key] = (res.reason && res.reason.message) || String(res.reason);
  });

  if (Object.keys(errors).length) data.errors = errors;
  const okCount = jobs.filter(([k]) => data[k]).length;
  data.fieldsOk = okCount;
  data.fieldsTotal = jobs.length;
  return { data, okCount };
}

exports.handler = async function () {
  const now = new Date();
  const { release } = isReleaseDay(now);
  const ttl = release ? 15 * 60 : 3 * 60 * 60; // seconds

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // Lets Netlify's CDN cache the response, so a burst of visitors costs ~1 upstream fetch.
    'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}, stale-while-revalidate=${6 * 60 * 60}`
  };

  if (memCache.data && now.getTime() < memCache.expiresAt) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...memCache.data, cached: true, refreshAfter: memCache.expiresAt, ttl })
    };
  }

  const apiKey = (process.env.FRED_API_KEY || '').trim();

  try {
    const { data, okCount } = await buildPayload(apiKey);

    if (okCount === 0) throw new Error(`every source failed for all ${data.fieldsTotal} fields: ${JSON.stringify(data.errors || {})}`);

    data.ttl = ttl;
    data.releaseDay = release;
    data.refreshAfter = Date.now() + ttl * 1000;

    memCache = { ...memCache, data, expiresAt: data.refreshAfter, lastGood: data, lastGoodAt: Date.now() };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    // Degrade, don't break: serve the last payload we managed to build (marked stale) so the
    // dashboard keeps showing real numbers instead of an error banner.
    if (memCache.lastGood) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...memCache.lastGood,
          stale: true,
          staleReason: e.message,
          lastGoodAt: new Date(memCache.lastGoodAt).toISOString(),
          cached: true,
          refreshAfter: Date.now() + 5 * 60 * 1000,
          ttl: 5 * 60
        })
      };
    }
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: e.message,
        hint: 'All upstream sources (FRED API, FRED public CSV, BLS) failed for this invocation. No API key is required — this is a network/upstream problem, not a configuration one.',
        retryAfterSeconds: 300
      })
    };
  }
};

// Exported for local unit testing (node --test / plain require). Netlify ignores extra exports.
module.exports.__test = {
  parseFredCsv,
  parseFredApiJson,
  parseBlsJson,
  splitCsvLine,
  yearAgoIso,
  monthBeforeIso,
  isReleaseDay,
  inRange,
  yoyFromLevels,
  payrollsFromLevels,
  TARGETS,
  SANITY,
  FOMC_STATEMENT_DATES,
  // Lets tests exercise the "every source failed" path without waiting out the TTL.
  _expireCache: () => { memCache.expiresAt = 0; }
};
