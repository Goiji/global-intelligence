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
  // Seasonally adjusted (CUSR…), the exact BLS series FRED mirrors as CPIAUCSL / CPILFESL. The
  // old ids were the NOT-adjusted CUUR… series, so a BLS-sourced YoY could differ from the FRED one.
  cpi: { fred: 'CPIAUCSL', bls: 'CUSR0000SA0', cadence: 'monthly' },
  coreCpi: { fred: 'CPILFESL', bls: 'CUSR0000SA0L1E', cadence: 'monthly' },
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

// BLS v1 allows only 25 queries/day/IP, so the "is BLS already ahead of FRED?" check that runs
// while a release is pending is throttled per instance.
const BLS_RECHECK_MS = 10 * 60 * 1000;
let lastBlsRecheckAt = 0;

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
// observation for an exact date (monthly series are all first-of-month)
function atDate(obs, date) {
  return obs.find((o) => o.date === date) || null;
}
// n months before a given first-of-month date
function monthsBeforeIso(date, n) {
  let d = date;
  for (let i = 0; i < n; i++) d = monthBeforeIso(d);
  return d;
}
// the observation right after `date` (series are newest-first, so this is the previous period)
function previousObservation(obs, date) {
  const i = obs.findIndex((o) => o.date === date);
  return i >= 0 && i + 1 < obs.length ? obs[i + 1] : null;
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

// Monthly fields that should already show last month's print but don't yet.
// BLS publishes at 8:30 ET (12:30 UTC in summer, 13:30 in winter) and FRED mirrors it anywhere from
// minutes to a couple of hours later. Between 12:25 and 16:00 UTC on a CPI-window day (or the first
// Friday for jobs) a field whose latest month is older than last month is "awaiting" its new print:
// the handler then re-checks every few minutes and asks BLS directly instead of sitting on the old
// number for the normal 15-minute TTL. On window days before the actual release this just means a
// few extra cheap fetches during those hours.
const PENDING_TTL_S = 3 * 60;
function awaitingFields(data, now = new Date()) {
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 12 * 60 + 25 || mins >= 16 * 60) return [];
  const { cpiWindow, firstFriday } = isReleaseDay(now);
  const keys = [...(cpiWindow ? ['cpi', 'coreCpi'] : []), ...(firstFriday ? ['unrate', 'nfp'] : [])];
  const expected = monthsAgoIso(1, now);
  return keys.filter((k) => data && data[k] && data[k].date && data[k].date < expected);
}

// Seconds until the 12:25 UTC watch window opens on a CPI / jobs day (null if not applicable), so
// a payload built just before the release can't be cached past the moment the new print lands.
function secondsUntilWatch(now = new Date()) {
  const { cpiWindow, firstFriday } = isReleaseDay(now);
  if (!cpiWindow && !firstFriday) return null;
  const open = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 25);
  return now.getTime() < open ? Math.ceil((open - now.getTime()) / 1000) : null;
}

function cacheControl(seconds, release) {
  const s = Math.max(30, Math.round(seconds));
  // On release days a long stale-while-revalidate window would let the CDN keep handing out the
  // pre-release number after the TTL ran out, so keep it to a minute there.
  return `public, max-age=${s}, s-maxage=${s}, stale-while-revalidate=${release ? 60 : 6 * 60 * 60}`;
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
async function getObservations(key, { apiKey, deadline, transformation = null, limit = 400, preferBls = false } = {}) {
  const spec = TARGETS[key];
  const trail = [];

  // While a release is pending, BLS (the origin) is asked first: FRED can lag it by a while.
  if (preferBls && spec.bls && !transformation && Date.now() < deadline) {
    try {
      return { obs: parseBlsJson(await fetchText(`${BLS_API}${spec.bls}`, deadline), spec.bls), source: 'bls' };
    } catch (e) {
      trail.push(`bls: ${e.message}`);
    }
  }

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
      // Daily series need a window long enough to still contain the previous rate level (FOMC
      // meetings are ~6 weeks apart, so 120 days shows the last change and when it happened);
      // monthly ones need ~26 months so a by-date year-ago lookup works when a month is missing.
      const cosd = spec.cadence === 'daily' ? daysAgoIso(120) : monthsAgoIso(26);
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
// Besides the latest value we attach the context the page needs for its automatic
// "ดี/แย่แค่ไหน" analysis: when the rate last moved (and how many meetings it has been unchanged),
// or how unemployment moved versus the previous month and three months ago.
async function levelMetric(key, apiKey, deadline, opts = {}) {
  const { obs, source } = await getObservations(key, { apiKey, deadline, ...opts });
  const hit = latestOf(obs, SANITY.pctLevel);
  const out = { value: hit.value, date: hit.date, source };

  if (key === 'upper' || key === 'lower') {
    try {
      const info = rateChangeInfo(obs);
      if (info) Object.assign(out, info);
    } catch (e) { /* context is optional — never fail the metric over it */ }
  } else if (key === 'unrate') {
    const prev = atDate(obs, monthBeforeIso(hit.date));
    const prev3 = atDate(obs, monthsBeforeIso(hit.date, 3));
    if (prev) {
      out.prev = { value: prev.value, date: prev.date };
      out.changeMoM = +(hit.value - prev.value).toFixed(2);
    }
    if (prev3) {
      out.prev3 = { value: prev3.value, date: prev3.date };
      out.change3m = +(hit.value - prev3.value).toFixed(2);
    }
  }
  return out;
}

// How long has the fed funds target been at its current level, and by how much did it last move?
// Frequency is daily, so the level that differs from today's marks the rate *before* the last
// change; the row just newer than that one is the day the new level took effect.
function rateChangeInfo(obs) {
  const latest = obs[0];
  if (!latest) return null;
  let i = 0;
  while (i < obs.length && Math.abs(obs[i].value - latest.value) <= 0.004) i++;
  const before = obs[i] || null;
  const sinceDate = i > 0 ? obs[i - 1].date : latest.date;
  const todayIso = isoDay(new Date());
  return {
    prevValue: before ? before.value : null,
    prevDate: before ? before.date : null,
    changePp: before ? +(latest.value - before.value).toFixed(2) : 0,
    sinceDate,
    // how many scheduled FOMC statements have happened since the current level started
    meetingsSinceChange: before ? FOMC_STATEMENT_DATES.filter((d) => d > sinceDate && d <= todayIso).length : null
  };
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
async function yoyMetric(key, apiKey, deadline, opts = {}) {
  const attempts = await Promise.allSettled([
    getObservations(key, { apiKey, deadline, transformation: 'pc1' }),
    getObservations(key, { apiKey, deadline, ...opts })
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

  let final = null;
  if (official && computed && computed.date > official.date) {
    // The levels already carry a newer month than the pc1 series (e.g. BLS has the fresh print and
    // FRED doesn't yet) — the newer month wins; comparing two different months would be meaningless.
    final = computed;
  } else if (official && computed) {
    const drift = Math.abs(official.value - computed.value);
    const base = { ...official, level: computed.level, yearAgoDate: computed.yearAgoDate, yearAgoLevel: computed.yearAgoLevel };
    if (drift > 0.15) {
      // The published transform and the raw levels disagree — trust the arithmetic we can see,
      // and say so loudly rather than silently picking one.
      final = {
        ...computed,
        pc1Value: official.value,
        warning: `pc1 (${official.value.toFixed(2)}%) disagrees with by-date levels (${computed.value.toFixed(2)}%) by ${drift.toFixed(2)}pp — using by-date levels`
      };
    } else {
      final = { ...base, crossCheck: computed.value, method: 'fred-pc1 (cross-checked with levels)' };
    }
  } else if (computed) {
    final = computed;
  } else if (official) {
    final = official;
  }
  if (!final) throw new Error(trail.join(' | ') || 'both CPI paths failed');

  // Previous month's YoY, so the page can say "ชะลอ/เร่ง" without any human input. Taken from
  // whichever series produced the headline number (and, when that is the levels path, computed
  // with the same by-date lookup that protects against a missing month).
  let prev = null;
  if (pc1 && official && final.value === official.value) {
    prev = previousObservation(pc1.obs, final.date);
  } else if (levels) {
    const older = levels.obs.slice(1);
    if (older.length) {
      const r = yoyFromLevels(older, levels.source);
      if (r.result) prev = { value: r.result.value, date: r.result.date };
    }
  }
  if (prev) {
    final.prev = { value: prev.value, date: prev.date };
    final.changePp = +(final.value - prev.value).toFixed(2);
  }
  return final;
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

  // The last few months of changes (consecutive months only), so the page can compare this print
  // against the recent run-rate instead of judging it in isolation.
  const recentChanges = [];
  for (let i = 0; i + 1 < levels.length && recentChanges.length < 3; i++) {
    if (levels[i + 1].date !== monthBeforeIso(levels[i].date)) break; // month missing → stop
    recentChanges.push(Math.round((levels[i].value - levels[i + 1].value) * 1000));
  }
  const avg3 = recentChanges.length === 3 ? Math.round(recentChanges.reduce((a, b) => a + b, 0) / 3) : null;

  return {
    value: change,
    date: latest.date,
    prevDate: prev.date,
    level: Math.round(latest.value * 1000),
    prevLevel: Math.round(prev.value * 1000),
    unit: 'jobs',
    source,
    method: 'PAYEMS month-over-month change',
    recentChanges,
    prevChange: recentChanges.length > 1 ? recentChanges[1] : null,
    avg3Change: avg3,
    note: 'MoM change of the seasonally-adjusted PAYEMS level, so it is the net change after prior months are revised — it can differ slightly from the originally published headline print.'
  };
}

async function payrollsMetric(apiKey, deadline, opts = {}) {
  const { obs, source } = await getObservations('payrolls', { apiKey, deadline, ...opts });
  return payrollsFromLevels(obs, source);
}

const METRICS = {
  upper: (apiKey, deadline) => levelMetric('upper', apiKey, deadline),
  lower: (apiKey, deadline) => levelMetric('lower', apiKey, deadline),
  effr: (apiKey, deadline) => levelMetric('effr', apiKey, deadline),
  unrate: (apiKey, deadline, opts) => levelMetric('unrate', apiKey, deadline, opts),
  cpi: (apiKey, deadline, opts) => yoyMetric('cpi', apiKey, deadline, opts),
  coreCpi: (apiKey, deadline, opts) => yoyMetric('coreCpi', apiKey, deadline, opts),
  nfp: (apiKey, deadline, opts) => payrollsMetric(apiKey, deadline, opts)
};

// For fields still showing the previous month on a release morning, ask BLS directly and take its
// number when it is for a newer month. Best-effort: any failure keeps the FRED value.
async function refreshFromBls(data, keys, apiKey, deadline) {
  const results = await Promise.allSettled(keys.map((k) => METRICS[k](apiKey, deadline, { preferBls: true })));
  const updated = [];
  results.forEach((res, i) => {
    const k = keys[i];
    if (res.status === 'fulfilled' && res.value && res.value.date > data[k].date) {
      data[k] = res.value;
      updated.push(k);
    }
  });
  return updated;
}

async function buildPayload(apiKey) {
  const deadline = Date.now() + HARD_DEADLINE_MS;
  const errors = {};
  const data = { fetchedAt: new Date().toISOString(), keyConfigured: !!apiKey };

  const jobs = Object.keys(METRICS).map((k) => [k, () => METRICS[k](apiKey, deadline)]);

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
  let ttl = release ? 15 * 60 : 3 * 60 * 60; // seconds
  const untilWatch = secondsUntilWatch(now);
  if (untilWatch !== null) ttl = Math.max(30, Math.min(ttl, untilWatch));

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    // Lets Netlify's CDN cache the response, so a burst of visitors costs ~1 upstream fetch.
    'Cache-Control': cacheControl(ttl, release)
  };

  if (memCache.data && now.getTime() < memCache.expiresAt) {
    // Only the time this copy has LEFT — re-sending the full TTL let the CDN and the browser each
    // stack another full TTL on top of this one, so a fresh print could take 2-3x the TTL to show.
    const remaining = (memCache.expiresAt - now.getTime()) / 1000;
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': cacheControl(remaining, release) },
      body: JSON.stringify({ ...memCache.data, cached: true, refreshAfter: memCache.expiresAt, ttl: Math.round(remaining) })
    };
  }

  const apiKey = (process.env.FRED_API_KEY || '').trim();

  try {
    const { data, okCount } = await buildPayload(apiKey);

    if (okCount === 0) throw new Error(`every source failed for all ${data.fieldsTotal} fields: ${JSON.stringify(data.errors || {})}`);

    let pending = awaitingFields(data, now);
    // Stay inside Netlify's 10s function limit: only re-check BLS if there is time left.
    const blsDeadline = Math.min(Date.now() + 4000, now.getTime() + 9500);
    if (pending.length && blsDeadline - Date.now() > 1500 && Date.now() - lastBlsRecheckAt > BLS_RECHECK_MS) {
      lastBlsRecheckAt = Date.now();
      try {
        const updated = await refreshFromBls(data, pending, apiKey, blsDeadline);
        if (updated.length) data.updatedFromBls = updated;
      } catch (e) { /* best-effort */ }
      pending = awaitingFields(data, now);
    }
    if (pending.length) {
      data.awaiting = pending;
      ttl = PENDING_TTL_S;
      headers['Cache-Control'] = cacheControl(ttl, release);
    }

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
  monthsBeforeIso,
  previousObservation,
  isReleaseDay,
  awaitingFields,
  secondsUntilWatch,
  cacheControl,
  inRange,
  yoyFromLevels,
  payrollsFromLevels,
  rateChangeInfo,
  TARGETS,
  SANITY,
  FOMC_STATEMENT_DATES,
  // Lets tests exercise the "every source failed" path without waiting out the TTL.
  _expireCache: () => { memCache.expiresAt = 0; }
};
