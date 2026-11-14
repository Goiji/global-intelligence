// Netlify Function: the "more US economy" cards — housing, consumer spending, business surveys and
// market inflation expectations.
//
//   GET /.netlify/functions/econ-extra
//   → { items: { homeSales, mort30, mort15, retail, ismMfg, ismSvc, be5, be10 }, errors?, ttl, fetchedAt }
//     each item: { value, date, prev?, change?, hist: [[isoDate, value], ...], source, ... }
//
// Sources (all public, no key needed; FRED_API_KEY is used first when it is set, like fred-data.js):
//   • homeSales  Existing Home Sales, SAAR (NAR) — FRED EXHOSLUSM495S. NAR only lets FRED carry about
//                a year of history, which is all the sparkline needs. Value in homes/year; the page
//                shows millions like every news headline ("4.06M").
//   • mort30/15  Freddie Mac PMMS 30-year / 15-year fixed mortgage rate, weekly (Thursday noon ET) —
//                FRED MORTGAGE30US / MORTGAGE15US. Each carries `spread10y` = rate − the 10-year
//                Treasury yield (FRED DGS10) on the same day or the last trading day before it.
//   • retail     Retail Sales, headline month-over-month % (Census, ~mid-month 8:30 ET) — computed by
//                date from the FRED level RSAFS (seasonally adjusted, NOT inflation-adjusted).
//   • ismMfg/Svc ISM Manufacturing and Services PMI (1st / 3rd business day, 10:00 ET). Not on FRED
//                (ISM pulled it in 2016), so the chain is: Investing.com's public chart data for the
//                event (sbcharts…/events_charts/us/173|176.json: full history + actual + forecast)
//                → ISM's own Report On Business page (the "PMI® registered 48.7 percent" sentence).
//   • be5/be10   5-year / 10-year breakeven inflation, daily — FRED T5YIE / T10YIE.
//
// Investing.com's chart data also gives the analyst forecast of each past release, so the page can say
// "ดีกว่า/แย่กว่าที่คาด" for retail sales, home sales and ISM without another lookup. The forecast for the
// NEXT release still comes from /consensus (the event page's history table), like the other cards.
//
// Every item is independent: one failed source drops one card, never the payload. If everything fails
// the last good payload is served marked stale.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const SBCHARTS = 'https://sbcharts.investing.com/events_charts/us/';
const ISM_ROB = 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/';
const ATTEMPT_TIMEOUT_MS = 6000;
const HARD_DEADLINE_MS = 8500;
const TTL_S = 30 * 60;

const { parseFredCsv, parseFredApiJson, monthBeforeIso, inRange } = require('./fred-data.js').__test;

// Investing.com event ids (the number at the end of the event page slug).
const INVESTING_IDS = { ismMfg: 173, ismSvc: 176, retail: 256, homeSales: 99 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const RANGE = {
  homeSales: [1e6, 1e7], // homes per year (SAAR)
  mortgage: [0.5, 25], // %
  retailMom: [-25, 25], // % MoM (Apr 2020 was −14.6%)
  pmi: [20, 80],
  breakeven: [-3, 8] // %
};

let memCache = { data: null, expiresAt: 0, lastGood: null };

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgoIso(n, from = new Date()) { return isoDay(new Date(from.getTime() - n * 86400000)); }
function monthStart(date) { return String(date).slice(0, 7) + '-01'; }

async function fetchText(url, deadline, accept = '*/*') {
  const ms = Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now());
  if (ms <= 250) throw new Error('deadline exceeded');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)', Accept: accept }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// FRED observations newest-first: API (only with a key) → public CSV.
async function fredObs(id, { apiKey, deadline, start }) {
  const trail = [];
  if (apiKey) {
    try {
      const url = `${FRED_API}?series_id=${id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${start}`;
      return { obs: parseFredApiJson(await fetchText(url, deadline)), source: 'fred-api' };
    } catch (e) { trail.push(`fred-api: ${e.message}`); }
  }
  try {
    const obs = parseFredCsv(await fetchText(`${FRED_CSV}?id=${id}&cosd=${start}`, deadline));
    if (!obs.length) throw new Error('empty CSV');
    return { obs, source: 'fred-csv' };
  } catch (e) { trail.push(`fred-csv: ${e.message}`); }
  throw new Error(`${id}: ${trail.join(' | ')}`);
}

// ── pure helpers (exported for tests) ─────────────────────────────────────────────────────────
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

// Keep the last observation of each ISO week (a year of daily data → ~52 points). Input oldest-first.
function weeklyThin(obs) {
  const byWeek = new Map();
  obs.forEach((o) => {
    const d = new Date(o.date + 'T00:00:00Z');
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    byWeek.set(isoDay(monday), o);
  });
  const out = [...byWeek.values()];
  const last = obs[obs.length - 1];
  if (last && out[out.length - 1] !== last) out.push(last);
  return out;
}

// Generic level series (newest-first in): latest, previous observation, one year of history.
function levelSummary(obsNewestFirst, range, { thinDaily = false, digits = 3 } = {}) {
  const obs = obsNewestFirst.filter((o) => inRange(o.value, range));
  const latest = obs[0];
  if (!latest) throw new Error('no observation inside the expected range');
  const prev = obs[1] || null;
  const yearAgo = daysAgoIso(372, new Date(latest.date + 'T00:00:00Z'));
  let window = obs.filter((o) => o.date >= yearAgo).reverse();
  if (thinDaily) window = weeklyThin(window);
  return {
    value: round(latest.value, digits),
    date: latest.date,
    prev: prev ? { value: round(prev.value, digits), date: prev.date } : null,
    change: prev ? round(latest.value - prev.value, digits) : null,
    hist: window.map((o) => [o.date, round(o.value, digits)])
  };
}

// The value of a newest-first series on `date`, or on the closest earlier date (max 7 days back).
function valueOnOrBefore(obsNewestFirst, date) {
  const floor = daysAgoIso(7, new Date(date + 'T00:00:00Z'));
  const hit = obsNewestFirst.find((o) => o.date <= date && o.date >= floor);
  return hit || null;
}

// Mortgage rate + spread over the 10-year Treasury on the survey date.
function mortgageSummary(mortObs, dgs10Obs) {
  const s = levelSummary(mortObs, RANGE.mortgage, { digits: 2 });
  if (dgs10Obs && dgs10Obs.length) {
    const t = valueOnOrBefore(dgs10Obs, s.date);
    if (t && inRange(t.value, [0, 20])) {
      s.us10y = { value: t.value, date: t.date };
      s.spread10y = round(s.value - t.value, 2);
      if (s.prev) {
        const tp = valueOnOrBefore(dgs10Obs, s.prev.date);
        if (tp && inRange(tp.value, [0, 20])) s.prevSpread10y = round(s.prev.value - tp.value, 2);
      }
    }
  }
  return s;
}

// Retail sales MoM % from the RSAFS level, matched by date (a missing month can't fake a swing).
function retailFromLevels(obsNewestFirst) {
  const levels = obsNewestFirst.filter((o) => o.value > 1e5 && o.value < 1e7); // $ millions (~700k in 2025)
  const byDate = new Map(levels.map((o) => [o.date, o.value]));
  const moms = [];
  for (const o of levels) {
    const before = byDate.get(monthBeforeIso(o.date));
    if (!before) continue;
    const mom = ((o.value - before) / before) * 100;
    if (inRange(mom, RANGE.retailMom)) moms.push({ date: o.date, value: mom });
  }
  if (!moms.length) throw new Error('no usable RSAFS month pair');
  const latest = moms[0];
  const prev = moms.find((m) => m.date === monthBeforeIso(latest.date)) || null;
  const yearAgoDate = `${Number(latest.date.slice(0, 4)) - 1}${latest.date.slice(4)}`;
  const ya = byDate.get(yearAgoDate);
  const out = {
    value: round(latest.value, 4),
    date: latest.date,
    prev: prev ? { value: round(prev.value, 4), date: prev.date } : null,
    hist: moms.slice(0, 12).reverse().map((m) => [m.date, round(m.value, 2)]),
    level: byDate.get(latest.date),
    method: 'RSAFS month-over-month (SA, nominal)'
  };
  if (ya) out.yoy = round(((byDate.get(latest.date) - ya) / ya) * 100, 2);
  return out;
}

// Investing.com chart data → [{ release, ref, actual, forecast }] oldest-first. `release` is the
// release day (UTC date of a US-morning timestamp), `ref` the month the number is about (the month
// before the release month — true for retail sales, existing home sales and both ISM surveys).
function parseSbcharts(text) {
  const j = typeof text === 'string' ? JSON.parse(text) : text;
  const byRelease = new Map();
  const put = (ts, actual, forecast) => {
    if (!isFinite(ts)) return;
    const release = isoDay(new Date(ts));
    const cur = byRelease.get(release) || { release, ref: monthBeforeIso(monthStart(release)), actual: null, forecast: null };
    if (isFinite(actual) && actual !== null) cur.actual = Number(actual);
    if (isFinite(forecast) && forecast !== null) cur.forecast = Number(forecast);
    byRelease.set(release, cur);
  };
  for (const row of j.data || []) {
    if (Array.isArray(row)) put(Number(row[0]), row[1] === null ? null : Number(row[1]), null);
  }
  for (const a of j.attr || []) {
    if (!a) continue;
    const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    put(Number(a.timestamp), num(a.actual), num(a.forecast));
  }
  const out = [...byRelease.values()].sort((a, b) => a.release.localeCompare(b.release));
  if (!out.some((r) => r.actual !== null)) throw new Error('no actual values in chart data');
  return out;
}

// The latest 12 printed months from the chart data, plus the latest release's forecast.
function summaryFromReleases(rows, range, digits = 1) {
  const printed = rows.filter((r) => r.actual !== null && inRange(r.actual, range));
  const latest = printed[printed.length - 1];
  if (!latest) throw new Error('no printed value inside the expected range');
  const prev = printed[printed.length - 2] || null;
  return {
    value: round(latest.actual, digits + 2),
    date: latest.ref,
    releaseDate: latest.release,
    prev: prev ? { value: prev.actual, date: prev.ref } : null,
    change: prev ? round(latest.actual - prev.actual, digits + 1) : null,
    forecast: latest.forecast !== null && inRange(latest.forecast, range) ? latest.forecast : null,
    hist: printed.slice(-12).map((r) => [r.ref, r.actual])
  };
}

// The release row (from Investing.com chart data) that published reference month `ref`.
function releaseFor(rows, ref) {
  return (rows || []).find((r) => r.ref === ref) || null;
}

// ISM Report On Business page → { value, ref } — the "PMI® registered 48.7 percent" sentence.
function parseIsmPage(html, kind) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&reg;|®/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const name = kind === 'svc' ? 'Services PMI' : 'Manufacturing PMI';
  const rx = new RegExp(name + '\\s*(?:at|registered|was|came in at|stood at)\\s*(\\d{2}(?:\\.\\d)?)\\s*(?:percent|%)', 'i');
  const m = rx.exec(text);
  if (!m) return null;
  const value = parseFloat(m[1]);
  return inRange(value, RANGE.pmi) ? value : null;
}

async function ismFromIsmWorld(kind, deadline, now = new Date()) {
  // The report for month M comes out early in M+1, so try last month first, then the one before.
  const trail = [];
  for (let back = 1; back <= 2; back++) {
    const ref = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
    const month = MONTHS[ref.getUTCMonth()];
    const paths = kind === 'svc' ? [`services/${month}/`] : [`pmi/${month}/`, `manufacturing/${month}/`];
    for (const p of paths) {
      try {
        const v = parseIsmPage(await fetchText(ISM_ROB + p, deadline, 'text/html'), kind);
        if (v !== null) return { value: v, date: isoDay(ref), hist: [], source: 'ismworld' };
        trail.push(`${p}: no PMI sentence`);
      } catch (e) { trail.push(`${p}: ${e.message}`); }
    }
  }
  throw new Error(trail.join(' | '));
}

async function chartRows(key, deadline) {
  return parseSbcharts(await fetchText(`${SBCHARTS}${INVESTING_IDS[key]}.json`, deadline, 'application/json'));
}

// ── items ─────────────────────────────────────────────────────────────────────────────────────
async function loadIsm(key, deadline) {
  const kind = key === 'ismSvc' ? 'svc' : 'mfg';
  try {
    const rows = await chartRows(key, deadline);
    return { ...summaryFromReleases(rows, RANGE.pmi, 1), source: 'investing.com' };
  } catch (e) {
    try {
      return await ismFromIsmWorld(kind, deadline);
    } catch (e2) {
      throw new Error(`investing: ${e.message} | ismworld: ${e2.message}`);
    }
  }
}

// Monthly FRED series + Investing.com chart data: FRED is the history; a newer Investing.com print
// (FRED can lag a release by hours) is appended, and the analyst forecast is attached by month.
function mergeMonthly(fred, rows, range, scale = 1) {
  const out = { ...fred };
  if (!rows) return out;
  const printed = rows.filter((r) => r.actual !== null && inRange(r.actual * scale, range));
  const newest = printed[printed.length - 1];
  if (newest && newest.ref > out.date) {
    out.prev = { value: out.value, date: out.date };
    out.value = round(newest.actual * scale, 4);
    out.date = newest.ref;
    out.hist = out.hist.concat([[newest.ref, round(newest.actual * scale, 4)]]).slice(-13);
    out.source = 'investing.com';
    out.fresherThanFred = true;
  }
  const rel = releaseFor(rows, out.date);
  if (rel) {
    out.releaseDate = rel.release;
    if (rel.forecast !== null && inRange(rel.forecast * scale, range)) out.forecast = round(rel.forecast * scale, 4);
    if (rel.actual !== null) out.firstPrint = round(rel.actual * scale, 4);
  }
  return out;
}

async function loadHomeSales(apiKey, deadline) {
  const [fred, chart] = await Promise.allSettled([
    fredObs('EXHOSLUSM495S', { apiKey, deadline, start: daysAgoIso(450) }),
    chartRows('homeSales', deadline)
  ]);
  const rows = chart.status === 'fulfilled' ? chart.value : null;
  if (fred.status === 'fulfilled') {
    const s = levelSummary(fred.value.obs, RANGE.homeSales, { digits: 0 });
    s.source = fred.value.source;
    // Investing.com prints millions ("4.06M"); FRED has homes.
    return mergeMonthly(s, rows, RANGE.homeSales, 1e6);
  }
  if (!rows) throw new Error(`fred: ${fred.reason.message} | investing: ${chart.reason.message}`);
  const s = summaryFromReleases(rows.map((r) => ({ ...r, actual: r.actual === null ? null : round(r.actual * 1e6, 0), forecast: r.forecast === null ? null : round(r.forecast * 1e6, 0) })), RANGE.homeSales, 0);
  return { ...s, source: 'investing.com' };
}

async function loadRetail(apiKey, deadline) {
  const [fred, chart] = await Promise.allSettled([
    fredObs('RSAFS', { apiKey, deadline, start: daysAgoIso(30 * 26) }),
    chartRows('retail', deadline)
  ]);
  const rows = chart.status === 'fulfilled' ? chart.value : null;
  if (fred.status === 'fulfilled') {
    const s = retailFromLevels(fred.value.obs);
    s.source = fred.value.source;
    const merged = mergeMonthly(s, rows, RANGE.retailMom);
    // The news headline is the FIRST print; FRED's latest month is that same print, earlier months
    // are revised. Show the headline number when Investing.com has it for the same month.
    if (isFinite(merged.firstPrint) && merged.firstPrint !== null && Math.abs(merged.firstPrint - merged.value) <= 0.15) merged.value = merged.firstPrint;
    if (merged.fresherThanFred) delete merged.yoy;
    return merged;
  }
  if (!rows) throw new Error(`fred: ${fred.reason.message} | investing: ${chart.reason.message}`);
  return { ...summaryFromReleases(rows, RANGE.retailMom, 1), source: 'investing.com' };
}

async function loadMortgages(apiKey, deadline) {
  const start = daysAgoIso(380);
  const [m30, m15, t10] = await Promise.allSettled([
    fredObs('MORTGAGE30US', { apiKey, deadline, start }),
    fredObs('MORTGAGE15US', { apiKey, deadline, start }),
    fredObs('DGS10', { apiKey, deadline, start })
  ]);
  const ten = t10.status === 'fulfilled' ? t10.value.obs : null;
  const out = {};
  if (m30.status === 'fulfilled') out.mort30 = { ...mortgageSummary(m30.value.obs, ten), source: m30.value.source };
  else out.mort30Error = m30.reason.message;
  if (m15.status === 'fulfilled') out.mort15 = { ...mortgageSummary(m15.value.obs, ten), source: m15.value.source };
  else out.mort15Error = m15.reason.message;
  return out;
}

async function loadBreakeven(id, apiKey, deadline) {
  const { obs, source } = await fredObs(id, { apiKey, deadline, start: daysAgoIso(380) });
  return { ...levelSummary(obs, RANGE.breakeven, { thinDaily: true, digits: 2 }), source };
}

async function buildPayload(apiKey) {
  const deadline = Date.now() + HARD_DEADLINE_MS;
  const jobs = {
    homeSales: () => loadHomeSales(apiKey, deadline),
    mortgages: () => loadMortgages(apiKey, deadline),
    retail: () => loadRetail(apiKey, deadline),
    ismMfg: () => loadIsm('ismMfg', deadline),
    ismSvc: () => loadIsm('ismSvc', deadline),
    be5: () => loadBreakeven('T5YIE', apiKey, deadline),
    be10: () => loadBreakeven('T10YIE', apiKey, deadline)
  };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]()));
  const items = {};
  const errors = {};
  settled.forEach((r, i) => {
    const k = keys[i];
    if (r.status !== 'fulfilled') { errors[k === 'mortgages' ? 'mort30' : k] = (r.reason && r.reason.message) || String(r.reason); return; }
    if (k === 'mortgages') {
      if (r.value.mort30) items.mort30 = r.value.mort30; else errors.mort30 = r.value.mort30Error;
      if (r.value.mort15) items.mort15 = r.value.mort15; else errors.mort15 = r.value.mort15Error;
    } else items[k] = r.value;
  });
  return { items, errors };
}

exports.handler = async function () {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=3600`
  };
  if (memCache.data && now < memCache.expiresAt) {
    const remaining = Math.max(30, Math.round((memCache.expiresAt - now) / 1000));
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${remaining}, s-maxage=${remaining}, stale-while-revalidate=3600` }, body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining }) };
  }
  try {
    const { items, errors } = await buildPayload((process.env.FRED_API_KEY || '').trim());
    if (!Object.keys(items).length) throw new Error(`every source failed: ${JSON.stringify(errors)}`);
    const data = { items, fetchedAt: new Date().toISOString(), ttl: TTL_S };
    if (Object.keys(errors).length) data.errors = errors;
    memCache = { data, expiresAt: Date.now() + TTL_S * 1000, lastGood: data };
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    if (memCache.lastGood) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...memCache.lastGood, stale: true, staleReason: e.message, ttl: 300 }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = {
  weeklyThin,
  levelSummary,
  valueOnOrBefore,
  mortgageSummary,
  retailFromLevels,
  parseSbcharts,
  summaryFromReleases,
  releaseFor,
  mergeMonthly,
  parseIsmPage,
  RANGE,
  INVESTING_IDS,
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; }
};
