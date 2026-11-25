// Netlify Function: US market snapshot + 12-month histories for the dashboard's sparklines.
//
//   GET /.netlify/functions/markets
//   → { series: { sp500, nasdaq100, cape, us10y, us2y, vix, ovx, hyOas, move, sofrSpread, levShort, dollar, cpi, unrate, fedUpper }, asOf, ttl }
//     each series: { label, unit, latest, date, prev, change, hist: [[isoDate, value], ...] }
//
// Every series comes from FRED. The public graph CSV needs no key; FRED_API_KEY (optional, the
// same one fred-data.js uses) is tried first when it's set. Daily series are thinned to one point
// per week so a year of history stays ~52 points. Market series (10y/2y/VIX/dollar) are daily
// closes and FRED files each one the next day, so on their own they lag the live market by about a
// day. Live overlays close that gap: Cboe's delayed quotes (~15 min behind) for VIX and the 10-year
// (TNX), and the Treasury's own daily par yield curve (out the same evening, a day before FRED) for
// the 2-year and as the 10-year fallback. FRED stays the history behind each sparkline.
// Stock indices work the same way: FRED's SP500 / NASDAQ100 daily closes are the history, and
// Cboe's delayed index quotes (_SPX / _NDX, ~15 min behind) lay today's level on top.
// The dollar is the ICE DXY formula applied to the ECB's daily reference rates (via Frankfurter,
// out the same afternoon in Europe) — FRED's broad index (DTWEXBGS) is published once a week and
// ran up to a week behind. FRED's broad index is the fallback if Frankfurter fails.
// hyOas = ICE BofA US High Yield Index option-adjusted spread (FRED BAMLH0A0HYM2, %, daily close,
// filed the next morning): the extra yield junk bonds pay over Treasuries, i.e. the credit market's
// price of default risk. Plain FRED series, same path as VIX / OVX.
// Funding-stress gauges (proxies for repo haircuts, which have no public daily number):
//   • sofrSpread = SOFR − IORB in basis points, both from FRED, joined by date (IORB carried forward
//     to each SOFR day). Positive and widening = cash is scarce and repo is tight. The payload also
//     carries the latest sofr / iorb levels it was built from.
//   • move = ICE BofA MOVE index (Treasury implied volatility, the "VIX of bonds"). FRED doesn't
//     carry it, so it comes from Yahoo Finance's chart API (^MOVE, query1 then the query2 mirror).
//   • levShort = leveraged funds' NET SHORT in US Treasury futures (2Y, 5Y, 10Y, Ultra 10Y, Bond,
//     Ultra Bond), the usual proxy for the size of the cash-futures basis trade (long cash bonds
//     financed in repo, short futures). From the CFTC Traders in Financial Futures report (futures
//     only, Socrata open-data API, no key), weekly: positions as of Tuesday, published Friday.
//     Value = (short − long) × face value per contract ($200k for the 2Y, $100k for the rest), in
//     $ billions, positive = net short. A week is used only when all six contracts are reported.
//     The payload also carries the record since 2016 (Ultra 10Y launched then) and its date.
//
// US − Japan yield spreads (usjp2y / usjp10y, percentage points) — the carry-trade gauge:
//   US side = the same daily 2Y / 10Y series above (FRED history + Treasury / Cboe overlay for the
//   latest day). Japan side = the Ministry of Finance's JGB constant-maturity yields (jgbcme.csv for
//   this month, published each Tokyo business day after the close; jgbcme_all.csv for the history,
//   ~1 MB since 1974, kept in memory for 12 h). FRED has no daily JGB series. Each US day is paired
//   with the JGB yield of the same date (or the last Tokyo business day before it, at most 7 days).
//   Each spread also carries chg1w / chg1m (change over 7 / 30 calendar days) — a fast narrowing is
//   what forces yen carry trades to unwind (Aug 2024).
//
// Market breadth (spxew): S&P 500 Equal Weight (^SPXEW, every stock 0.2%) from Yahoo's chart API
// (query1 then query2), joined by date with Yahoo's ^GSPC (same feed, same trading days; FRED + Cboe
// S&P 500 only if ^GSPC fails). ^SPXEW is checked against RSP (the ETF that tracks it): if its last
// few daily moves are off RSP's by more than 0.75 pp the index feed is treated as bad and RSP is used. Raw
// points aren't comparable (different base dates), so the payload carries % changes: ew1m / spx1m
// (1 month = 30 calendar days), rel1m = ew1m − spx1m in percentage points (positive = the average
// stock beats the cap-weighted index = broad market), the same over 3 months, and relHist = the
// EW / S&P ratio indexed to 100 a year ago (weekly) for the sparkline. Same KV entry as everything
// else here (markets:lastGood): no new KV reads or writes.
//
// Shiller PE (cape) = S&P 500 price ÷ the 10-year average of inflation-adjusted earnings (CAPE).
// From multpl.com's monthly table (one page, every month since 1871, plus a live estimate for today
// as the first row). Long-run mean / median / peak / percentile are worked out from the monthly rows
// (not hard-coded), hist = last 10 years monthly for the sparkline. The page is ~700 KB, so the
// parsed rows are kept in memory for 3 h. Same KV entry as everything else (markets:lastGood).
//
// Buffett Indicator (buffett) = US stock market value ÷ US GDP, in %. Both from FRED (full history,
// fetched whole): NCBEILQ027S = market value of nonfinancial corporate equities (Fed Z.1, $ millions,
// end of quarter, ~10 weeks late) and GDP (BEA, $ billions, annual rate). FRED dates a quarter by its
// first day, so the equity level belongs to that quarter's last day. To keep the card current between
// Z.1 releases, the last quarter's equity value is moved with the S&P 500 (same series as the S&P
// tile) from that quarter end to today, over the latest GDP. History = the quarterly ratio; long-run
// mean / median / peak / percentile come from it. Same KV entry (markets:lastGood).
//
// Caching: memory + CDN for 1 h, but only 15 min on CPI / jobs / FOMC days (same calendar as
// fred-data.js) so the CPI / unemployment / Fed sparklines don't trail the cards for hours after a
// release. If every source fails we serve the last good payload marked stale instead of an error.

const FRED_API = 'https://api.stlouisfed.org/fred/series/observations';
const FRED_CSV = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const ATTEMPT_TIMEOUT_MS = 5000;
const FRANKFURTER = 'https://api.frankfurter.dev/v1/';
// ICE US Dollar Index: 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091
// × USDSEK^0.042 × USDCHF^0.036. With USD-based rates (units per dollar) every exponent is positive.
const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
const CBOE_VIX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json';
const CBOE_OVX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_OVX.json';
const CBOE_TNX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_TNX.json';
const CBOE_SPX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_SPX.json';
const CBOE_NDX = 'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_NDX.json';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const YAHOO_MOVE = YAHOO_CHART + '%5EMOVE?interval=1d&range=13mo';
const YAHOO_SPXEW = YAHOO_CHART + '%5ESPXEW?interval=1d&range=13mo';
const YAHOO_GSPC = YAHOO_CHART + '%5EGSPC?interval=1d&range=13mo';
const YAHOO_RSP = YAHOO_CHART + 'RSP?interval=1d&range=13mo';
// ^SPXEW is an index Yahoo carries with no volume / day range; RSP (the Invesco ETF that tracks it)
// is a liquid listed fund. If the index's recent daily moves disagree with RSP's by more than this,
// the index feed is treated as bad and breadth is measured with RSP instead.
const EW_CHECK_DAYS = 5;
const EW_CHECK_MAX_PP = 0.75;
const CFTC_TFF = 'https://publicreporting.cftc.gov/resource/gpe5-46if.json';
// CFTC contract code → face value per contract (USD)
const UST_FUTURES = { '042601': 200000, '044601': 100000, '043602': 100000, '043607': 100000, '020601': 100000, '020604': 100000 };
const CFTC_SINCE = '2016-03-01';
const CFTC_TIMEOUT_MS = 9000;
const MOF_CURRENT = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/jgbcme.csv';
const MOF_HISTORY = 'https://www.mof.go.jp/english/policy/jgbs/reference/interest_rate/historical/jgbcme_all.csv';
const MOF_TIMEOUT_MS = 8000;
const JGB_HISTORY_TTL_MS = 12 * 60 * 60 * 1000;
const BROWSER_UA = 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)';
const MULTPL_CAPE = 'https://www.multpl.com/shiller-pe/table/by-month';
const CAPE_TIMEOUT_MS = 9000;
const CAPE_ROWS_TTL_MS = 3 * 60 * 60 * 1000;
const TREASURY_CSV = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/all/';
const TTL_S = 60 * 60;
const RELEASE_TTL_S = 15 * 60;
const { isReleaseDay, cacheControl } = require('./fred-data.js').__test;

const SERIES = {
  sp500:     { id: 'SP500',     label: 'S&P 500', unit: '', cadence: 'daily' },
  nasdaq100: { id: 'NASDAQ100', label: 'Nasdaq 100', unit: '', cadence: 'daily' },
  us10y:    { id: 'DGS10',    label: 'US 10Y', unit: '%', cadence: 'daily' },
  us2y:     { id: 'DGS2',     label: 'US 2Y', unit: '%', cadence: 'daily' },
  vix:      { id: 'VIXCLS',   label: 'VIX', unit: '', cadence: 'daily' },
  ovx:      { id: 'OVXCLS',   label: 'OVX', unit: '', cadence: 'daily' },
  hyOas:    { id: 'BAMLH0A0HYM2', label: 'ICE BofA US High Yield OAS', unit: '%', cadence: 'daily' },
  move:     { id: '^MOVE',    label: 'MOVE', unit: '', cadence: 'daily', loader: 'yahoo' },
  cape:     { id: 'CAPE',     label: 'Shiller PE (CAPE)', unit: '', cadence: 'monthly', loader: 'cape' },
  buffett:  { id: 'NCBEILQ027S/GDP', label: 'Buffett Indicator (market cap ÷ GDP)', unit: '%', cadence: 'quarterly', loader: 'buffett' },
  spxew:    { id: '^SPXEW',   label: 'S&P 500 Equal Weight', unit: '', cadence: 'daily', loader: 'spxew' },
  sofrSpread: { id: 'SOFR-IORB', label: 'SOFR − IORB', unit: 'bp', cadence: 'daily', loader: 'sofrSpread' },
  levShort: { id: 'CFTC-TFF-UST', label: 'Leveraged funds net short, UST futures', unit: '$bn', cadence: 'weekly', loader: 'cftc' },
  dollar:   { id: 'DTWEXBGS', label: 'Dollar (Broad)', unit: '', cadence: 'daily' },
  cpi:      { id: 'CPIAUCSL', label: 'CPI YoY', unit: '%', cadence: 'monthly', transformation: 'pc1' },
  unrate:   { id: 'UNRATE',   label: 'Unemployment', unit: '%', cadence: 'monthly' },
  fedUpper: { id: 'DFEDTARU', label: 'Fed upper', unit: '%', cadence: 'daily' },
  usjp2y:   { id: 'US2Y-JGB2Y',   label: 'US 2Y − JGB 2Y', unit: 'pp', cadence: 'daily', loader: 'usjp', us: 'us2y', jp: 'y2' },
  usjp10y:  { id: 'US10Y-JGB10Y', label: 'US 10Y − JGB 10Y', unit: 'pp', cadence: 'daily', loader: 'usjp', us: 'us10y', jp: 'y10' }
};

let jgbHistCache = { rows: null, expiresAt: 0 };
let capeCache = { rows: null, expiresAt: 0 };

let memCache = { data: null, expiresAt: 0, lastGood: null };

function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgoIso(n, from = new Date()) { return isoDay(new Date(from.getTime() - n * 86400000)); }

async function fetchText(url, timeoutMs = ATTEMPT_TIMEOUT_MS, ua = 'global-intelligence-dashboard (netlify function)', extraHeaders = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': ua, Accept: '*/*', ...extraHeaders }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// FRED graph CSV → [{date, value}] oldest-first. Skips "." (FRED's missing marker) and blanks.
function parseCsv(text) {
  const out = [];
  String(text).trim().split(/\r?\n/).slice(1).forEach((line) => {
    const [date, raw] = line.split(',');
    if (!/^\d{4}-\d{2}-\d{2}$/.test((date || '').trim())) return;
    const v = parseFloat(String(raw || '').replace(/"/g, ''));
    if (isFinite(v)) out.push({ date: date.trim(), value: v });
  });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

function parseApiJson(text) {
  const j = JSON.parse(text);
  if (j.error_message) throw new Error(j.error_message);
  return (j.observations || [])
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }))
    .filter((o) => /^\d{4}-\d{2}-\d{2}$/.test(o.date) && isFinite(o.value))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Keep the last observation of each ISO week (daily series → ~52 points a year).
function weekly(obs) {
  const byWeek = new Map();
  obs.forEach((o) => {
    const d = new Date(o.date + 'T00:00:00Z');
    const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000);
    byWeek.set(isoDay(monday), o);
  });
  return [...byWeek.values()];
}

function summarize(key, obs) {
  const cfg = SERIES[key];
  if (!obs.length) throw new Error('no observations');
  const last = obs[obs.length - 1];
  const prev = obs.length > 1 ? obs[obs.length - 2] : null;
  const yearAgo = daysAgoIso(372, new Date(last.date + 'T00:00:00Z'));
  const window = obs.filter((o) => o.date >= yearAgo);
  const thinned = cfg.cadence === 'daily' ? weekly(window) : window;
  // make sure the very latest point is the last one plotted
  if (thinned.length && thinned[thinned.length - 1].date !== last.date) thinned.push(last);
  const round = (v) => Math.round(v * 1000) / 1000;
  return {
    label: cfg.label,
    unit: cfg.unit,
    latest: round(last.value),
    date: last.date,
    prev: prev ? round(prev.value) : null,
    change: prev ? round(last.value - prev.value) : null,
    hist: thinned.map((o) => [o.date, round(o.value)]),
    // VIX card's "fear past its peak" check needs the daily close ~1 month back (hist is weekly)
    ...(key === 'vix' ? { monthAgo: monthAgoValue(obs, last.date, round) } : {})
  };
}

function monthAgoValue(obs, date, round) {
  const cut = daysAgoIso(30, new Date(date + 'T00:00:00Z'));
  let out = null;
  for (const o of obs) { if (o.date <= cut) out = o.value; else break; }
  return out == null ? null : round(out);
}

// Raw FRED observations (oldest first) for one series id: API with key first, then the public CSV.
async function fetchFredObs(cfg, apiKey) {
  // monthly YoY needs 2 years of levels behind it; FRED's pc1 transform does that for us.
  const start = daysAgoIso(cfg.cadence === 'monthly' ? 800 : 420);
  const errors = [];
  if (apiKey) {
    try {
      const url = `${FRED_API}?series_id=${cfg.id}&api_key=${encodeURIComponent(apiKey)}&file_type=json&observation_start=${start}`
        + (cfg.transformation ? `&units=${cfg.transformation}` : '');
      const obs = parseApiJson(await fetchText(url));
      if (obs.length) return { obs, source: 'fred-api' };
      errors.push('fred-api: no observations');
    } catch (e) { errors.push('fred-api: ' + e.message); }
  }
  try {
    const url = `${FRED_CSV}?id=${cfg.id}&cosd=${start}` + (cfg.transformation ? `&transformation=${cfg.transformation}` : '');
    const obs = parseCsv(await fetchText(url));
    if (obs.length) return { obs, source: 'fred-csv' };
    errors.push('fred-csv: no observations');
  } catch (e) { errors.push('fred-csv: ' + e.message); }
  throw new Error(errors.join(' | '));
}

async function loadSeries(key, apiKey, raw) {
  const { obs, source } = await fetchFredObs(SERIES[key], apiKey);
  if (raw) raw[key] = obs;
  return { ...summarize(key, obs), source };
}

// MOF JGB CSV (English) → [{ date, y2, y10 }] oldest-first. Layout: a title line, then
// "Date,1Y,2Y,…,10Y,…" and rows like "2026/11/12,1.653,1.857,…"; "-" = no yield that day. Rows
// before `since` (ISO date) are skipped so the 50-year history file stays cheap to keep.
// `tail: true` = a byte-range slice from the end of the file: no header (MOF's fixed column order
// Date,1Y,2Y,…,10Y is assumed) and the first line may be cut mid-row, so it is dropped.
function parseMofCsv(text, since = '', { tail = false } = {}) {
  const lines = String(text).split(/\r?\n/);
  const h = lines.findIndex((l) => /^"?Date"?,/i.test(l.trim()));
  let i2 = 2, i10 = 10, body;
  if (h >= 0) {
    const head = lines[h].split(',').map((c) => c.replace(/"/g, '').trim().toUpperCase());
    i2 = head.indexOf('2Y'); i10 = head.indexOf('10Y');
    if (i2 < 0 || i10 < 0) throw new Error('mof: no 2Y / 10Y columns');
    body = lines.slice(h + 1);
  } else if (tail) {
    body = lines.slice(1);
  } else throw new Error('mof: no Date header');
  const out = [];
  for (const line of body) {
    const c = line.split(',');
    const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec((c[0] || '').replace(/"/g, '').trim());
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (date < since) continue;
    const y2 = parseFloat(c[i2]), y10 = parseFloat(c[i10]);
    const ok = (v) => isFinite(v) && v > -2 && v < 20;
    if (ok(y2) || ok(y10)) out.push({ date, y2: ok(y2) ? y2 : null, y10: ok(y10) ? y10 : null });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// Merge history + this month's file by date (the newer file wins on overlap).
function mergeJgb(...lists) {
  const byDate = new Map();
  lists.forEach((l) => (l || []).forEach((r) => byDate.set(r.date, r)));
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// The history file is ~1 MB since 1974 and only the last ~14 months are needed, so ask for the tail
// only (HTTP Range). On Cloudflare the whole file was too slow / heavy and the spreads came out with
// just this month's points (no 1-month change, so no colour zone). A server that ignores Range just
// sends the whole file, which still parses. The rows are also kept in the persistent last-good store
// so a failed fetch on a cold instance doesn't shorten the chart either.
const MOF_TAIL_BYTES = 64 * 1024;   // ~700 rows ≈ 2.7 years
const JGB_KV_KEY = 'markets:jgbHistory';

async function fetchJgbHistory(since) {
  const t = await fetchText(MOF_HISTORY, MOF_TIMEOUT_MS, BROWSER_UA, { Range: `bytes=-${MOF_TAIL_BYTES}` });
  const rows = parseMofCsv(t, since, { tail: true });
  if (!rows.length) throw new Error('mof history: no rows');
  return rows;
}

async function loadJgb(now = Date.now(), event = null) {
  const since = daysAgoIso(430, new Date(now));
  const fresh = jgbHistCache.rows && now < jgbHistCache.expiresAt;
  const history = fresh ? Promise.resolve(jgbHistCache.rows) : fetchJgbHistory(since).then((rows) => {
    jgbHistCache = { rows, expiresAt: now + JGB_HISTORY_TTL_MS };
    kvPutGood(event, JGB_KV_KEY, rows).catch(() => {});
    return rows;
  });
  const [cur, hist] = await Promise.allSettled([fetchText(MOF_CURRENT, MOF_TIMEOUT_MS, BROWSER_UA).then((t) => parseMofCsv(t)), history]);
  let histRows = hist.status === 'fulfilled' ? hist.value : jgbHistCache.rows;
  let historyError = null;
  if (!histRows || !histRows.length) {
    const stored = await kvGetGood(event, JGB_KV_KEY, 45 * 86400000);
    if (Array.isArray(stored) && stored.length) histRows = stored;
    else historyError = hist.status === 'rejected' ? hist.reason.message : 'no history rows';
  }
  const rows = mergeJgb(histRows || [], cur.status === 'fulfilled' ? cur.value : []);
  if (!rows.length) {
    throw new Error('mof: ' + [cur, hist].map((r) => (r.status === 'rejected' ? r.reason.message : 'empty')).join(' | '));
  }
  return { rows, currentError: cur.status === 'rejected' ? cur.reason.message : null, historyError };
}

// US daily obs (oldest-first) with the overlaid latest point of the summarised series (Treasury /
// Cboe), so the spread uses the same "today" the US yield tile shows.
function withLatest(obs, s) {
  const list = (obs || []).slice();
  if (s && isFinite(s.latest) && s.date) {
    while (list.length && list[list.length - 1].date >= s.date) list.pop();
    list.push({ date: s.date, value: s.latest });
  }
  return list;
}

// US − JGB spread per US date, JGB carried forward at most 7 days. → [{date, value, us, jp, jpDate}]
function joinUsJp(usObs, jgbRows, field) {
  const jp = jgbRows.filter((r) => r[field] != null);
  const out = [];
  let j = -1;
  for (const u of usObs) {
    while (j + 1 < jp.length && jp[j + 1].date <= u.date) j++;
    if (j < 0) continue;
    if (Date.parse(u.date) - Date.parse(jp[j].date) > 7 * 86400000) continue;
    out.push({ date: u.date, value: Math.round((u.value - jp[j][field]) * 1000) / 1000, us: u.value, jp: jp[j][field], jpDate: jp[j].date });
  }
  return out;
}

// Change of a daily series over the last `days` calendar days (latest vs the value on or before then).
function changeOver(obs, days) {
  const last = obs[obs.length - 1];
  if (!last) return null;
  const cutoff = daysAgoIso(days, new Date(last.date + 'T00:00:00Z'));
  const base = obs.filter((o) => o.date <= cutoff).pop();
  return base ? Math.round((last.value - base.value) * 1000) / 1000 : null;
}

function usJpSummary(key, usObs, jgbRows) {
  const cfg = SERIES[key];
  const joined = joinUsJp(usObs, jgbRows, cfg.jp);
  if (!joined.length) throw new Error(`${key}: no overlapping US / JGB dates`);
  const last = joined[joined.length - 1];
  return {
    ...summarize(key, joined),
    us: last.us,
    jp: last.jp,
    jpDate: last.jpDate,
    chg1w: changeOver(joined, 7),
    chg1m: changeOver(joined, 30),
    source: 'mof+us'
  };
}

// SOFR − IORB in basis points, one point per SOFR day. IORB only changes on Fed decisions, so the
// latest IORB on or before each SOFR date is used (a missing IORB day never drops a SOFR print).
function joinSofrIorb(sofr, iorb) {
  const out = [];
  let j = -1;
  sofr.forEach((s) => {
    while (j + 1 < iorb.length && iorb[j + 1].date <= s.date) j++;
    if (j >= 0) out.push({ date: s.date, value: Math.round((s.value - iorb[j].value) * 1000) / 10, sofr: s.value, iorb: iorb[j].value });
  });
  return out;
}

async function loadSofrSpread(apiKey) {
  const [sofr, iorb] = await Promise.all([
    fetchFredObs({ id: 'SOFR', cadence: 'daily' }, apiKey),
    fetchFredObs({ id: 'IORB', cadence: 'daily' }, apiKey)
  ]);
  const joined = joinSofrIorb(sofr.obs, iorb.obs);
  if (!joined.length) throw new Error('sofr/iorb: no overlapping dates');
  const last = joined[joined.length - 1];
  return { ...summarize('sofrSpread', joined), sofr: last.sofr, iorb: last.iorb, source: sofr.source };
}

// Yahoo chart JSON → [{date, value}] of daily closes. Bar timestamps are shifted by the exchange's
// UTC offset first, so each close lands on the US trading day it belongs to. A live regularMarketPrice
// newer than the last bar is appended as today's point.
function parseYahooSeries(text) {
  const res = (((JSON.parse(text) || {}).chart || {}).result || [])[0];
  if (!res) throw new Error('yahoo: no result');
  const m = res.meta || {};
  const off = isFinite(m.gmtoffset) ? m.gmtoffset : 0;
  const day = (t) => new Date((t + off) * 1000).toISOString().slice(0, 10);
  const closes = ((res.indicators && res.indicators.quote && res.indicators.quote[0]) || {}).close || [];
  const byDay = new Map();
  (res.timestamp || []).forEach((t, i) => {
    const v = closes[i];
    if (v != null && isFinite(v) && v > 0) byDay.set(day(t), v);
  });
  const price = parseFloat(m.regularMarketPrice);
  if (isFinite(price) && price > 0 && isFinite(m.regularMarketTime)) {
    const d = day(m.regularMarketTime);
    const lastDay = [...byDay.keys()].sort().pop();
    if (!lastDay || d >= lastDay) byDay.set(d, price);
  }
  return [...byDay.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

async function loadYahoo(key, url, raw) {
  const errors = [];
  for (const u of [url, url.replace('//query1.', '//query2.')]) {
    try {
      const obs = parseYahooSeries(await fetchText(u));
      if (obs.length) {
        if (raw) raw[key] = obs;
        return { ...summarize(key, obs), source: 'yahoo' };
      }
      errors.push('yahoo: no observations');
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(key + ': ' + errors.join(' | '));
}

function loadMove() { return loadYahoo('move', YAHOO_MOVE); }

async function fetchYahooObs(url) {
  const errors = [];
  for (const u of [url, url.replace('//query1.', '//query2.')]) {
    try {
      const obs = parseYahooSeries(await fetchText(u));
      if (obs.length) return obs;
      errors.push('yahoo: no observations');
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
}

// multpl.com table → [{date, value}] oldest first. Rows look like
//   <tr class="odd"><td>Nov 20, 2026</td><td>\n \n36.44\n</td></tr>
// (an estimate row can carry a marker like "&#x2002;" or "†" before the number).
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
function parseMultplTable(html) {
  const byDate = new Map();
  const re = /<td[^>]*>\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(String(html)))) {
    const mo = MONTHS[m[1]];
    const num = m[4].replace(/<[^>]*>/g, ' ').replace(/&#?[a-z0-9]+;/gi, ' ').match(/-?\d+(?:\.\d+)?/);
    const v = num ? parseFloat(num[0]) : NaN;
    if (!mo || !isFinite(v) || v <= 0 || v > 200) continue;
    const date = `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
    byDate.set(date, v);
  }
  return [...byDate.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}

// CAPE rows → card payload: latest (today's estimate when multpl has one), change vs the previous
// row (= last month start), long-run stats from the month-start rows, 10-year monthly history.
function capeSummary(rows) {
  if (!rows || rows.length < 24) throw new Error('cape: too few rows');
  const r2 = (v) => Math.round(v * 100) / 100;
  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  const monthly = rows.filter((o) => o.date.endsWith('-01'));
  const base = monthly.length >= 24 ? monthly : rows;
  const vals = base.map((o) => o.value).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const peak = base.reduce((a, b) => (b.value > a.value ? b : a));
  const below = vals.filter((v) => v < last.value).length;
  const tenYrsAgo = `${Number(last.date.slice(0, 4)) - 10}${last.date.slice(4)}`;
  const yearAgo = `${Number(last.date.slice(0, 4)) - 1}${last.date.slice(4, 7)}-01`;
  const y1 = base.filter((o) => o.date <= yearAgo).pop();
  const hist = base.filter((o) => o.date >= tenYrsAgo);
  if (hist.length && hist[hist.length - 1].date !== last.date) hist.push(last);
  return {
    label: SERIES.cape.label,
    unit: '',
    latest: r2(last.value),
    date: last.date,
    prev: r2(prev.value),
    prevDate: prev.date,
    change: r2(last.value - prev.value),
    mean: r2(mean),
    median: r2(median),
    peak: r2(peak.value),
    peakDate: peak.date,
    pctile: Math.round(below / vals.length * 1000) / 10,   // % of months since 1871 below today
    timesMean: r2(last.value / mean),
    yearAgo: y1 ? r2(y1.value) : null,
    since: base[0].date,
    months: base.length,
    hist: hist.map((o) => [o.date, r2(o.value)]),
    source: 'multpl'
  };
}

async function loadCape(now = Date.now()) {
  if (!capeCache.rows || now >= capeCache.expiresAt) {
    const rows = parseMultplTable(await fetchText(MULTPL_CAPE, CAPE_TIMEOUT_MS, BROWSER_UA, { Accept: 'text/html' }));
    if (rows.length < 24) throw new Error('cape: multpl table had ' + rows.length + ' rows');
    capeCache = { rows, expiresAt: now + CAPE_ROWS_TTL_MS };
  }
  return capeSummary(capeCache.rows);
}

// Whole FRED history of one series id (API with key first, then the public CSV), oldest first.
async function fetchFredAll(id, apiKey) {
  const errors = [];
  if (apiKey) {
    try {
      const obs = parseApiJson(await fetchText(`${FRED_API}?series_id=${id}&api_key=${encodeURIComponent(apiKey)}&file_type=json`));
      if (obs.length) return obs;
      errors.push('fred-api: no observations');
    } catch (e) { errors.push('fred-api: ' + e.message); }
  }
  try {
    const obs = parseCsv(await fetchText(`${FRED_CSV}?id=${id}`));
    if (obs.length) return obs;
    errors.push('fred-csv: no observations');
  } catch (e) { errors.push('fred-csv: ' + e.message); }
  throw new Error(id + ': ' + errors.join(' | '));
}

async function loadBuffett(apiKey, raw) {
  const [eq, gdp] = await Promise.all([fetchFredAll('NCBEILQ027S', apiKey), fetchFredAll('GDP', apiKey)]);
  raw.buffettEq = eq;
  raw.buffettGdp = gdp;
  return buffettSummary(eq, gdp, null);
}

// Last day of the quarter that starts on `iso` (FRED's quarterly date).
function quarterEnd(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0)));
}

// eq ($ millions, quarterly) + gdp ($ billions, quarterly) [+ S&P 500 daily closes] → card payload.
function buffettSummary(eqObs, gdpObs, spxObs) {
  const r1 = (v) => Math.round(v * 10) / 10;
  const gdp = new Map((gdpObs || []).filter((o) => o.value > 0).map((o) => [o.date, o.value]));
  const q = (eqObs || []).filter((o) => o.value > 0 && gdp.has(o.date))
    .map((o) => ({ date: o.date, end: quarterEnd(o.date), value: o.value / 1000 / gdp.get(o.date) * 100 }));
  if (q.length < 8) throw new Error('buffett: too few quarters');
  const lastQ = q[q.length - 1];
  const eqLast = eqObs.filter((o) => o.date === lastQ.date)[0].value / 1000;   // $ bn
  const gdpDates = [...gdp.keys()].sort();
  const gdpDate = gdpDates[gdpDates.length - 1];
  const gdpNow = gdp.get(gdpDate);
  const out = {
    label: SERIES.buffett.label,
    unit: '%',
    quarter: lastQ.date,
    quarterEnd: lastQ.end,
    quarterValue: r1(lastQ.value),
    prevQuarterValue: r1(q[q.length - 2].value),
    gdp: Math.round(gdpNow),
    gdpDate,
    marketCap: Math.round(eqLast),
    latest: r1(lastQ.value),
    date: lastQ.end,
    estimated: false
  };
  // move the last quarter's equity value with the S&P 500 up to today (needs a close on/before the quarter end)
  const spx = (spxObs || []).filter((o) => o.value > 0);
  const base = spx.filter((o) => o.date <= lastQ.end).pop();
  const now = spx[spx.length - 1];
  if (base && now && now.date > lastQ.end && Date.parse(lastQ.end) - Date.parse(base.date) <= 7 * 86400000) {
    out.marketCap = Math.round(eqLast * now.value / base.value);
    out.latest = r1(out.marketCap / gdpNow * 100);
    out.date = now.date;
    out.estimated = true;
    out.spxMove = Math.round((now.value / base.value - 1) * 10000) / 100;
  }
  const vals = q.map((o) => o.value).sort((a, b) => a - b);
  const mid = vals.length >> 1;
  const peak = q.reduce((a, b) => (b.value > a.value ? b : a));
  const tenYrsAgo = `${Number(out.date.slice(0, 4)) - 10}${out.date.slice(4)}`;
  const hist = q.filter((o) => o.end >= tenYrsAgo).map((o) => [o.end, r1(o.value)]);
  if (out.estimated) hist.push([out.date, out.latest]);
  return Object.assign(out, {
    prev: out.estimated ? r1(lastQ.value) : r1(q[q.length - 2].value),
    change: r1(out.latest - (out.estimated ? lastQ.value : q[q.length - 2].value)),
    mean: r1(vals.reduce((a, b) => a + b, 0) / vals.length),
    median: r1(vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2),
    peak: r1(Math.max(peak.value, out.latest)),
    peakDate: out.latest > peak.value ? out.date : peak.end,
    pctile: Math.round(vals.filter((v) => v < out.latest).length / vals.length * 1000) / 10,
    since: q[0].end,
    quarters: q.length,
    hist,
    source: 'fred'
  });
}

// Daily % moves of two series on their shared dates, last `n` of them → largest gap in pp (null = too few).
function maxDailyGap(aObs, bObs, n = EW_CHECK_DAYS) {
  const b = new Map((bObs || []).map((o) => [o.date, o.value]));
  const rows = (aObs || []).filter((o) => b.has(o.date)).map((o) => [o.value, b.get(o.date)]);
  if (rows.length < 3) return null;
  let gap = 0;
  for (let i = Math.max(1, rows.length - n); i < rows.length; i++) {
    const da = (rows[i][0] / rows[i - 1][0] - 1) * 100, db = (rows[i][1] / rows[i - 1][1] - 1) * 100;
    gap = Math.max(gap, Math.abs(da - db));
  }
  return Math.round(gap * 100) / 100;
}

// SPXEW tile: index level from ^SPXEW, breadth measured against ^GSPC from the same Yahoo feed (same
// trading days and timestamps, so both end on the same day). RSP is the cross-check / fallback.
async function loadSpxew(raw) {
  const [ew, gspc, rsp] = await Promise.allSettled([fetchYahooObs(YAHOO_SPXEW), fetchYahooObs(YAHOO_GSPC), fetchYahooObs(YAHOO_RSP)]);
  const ewObs = ew.status === 'fulfilled' ? ew.value : null;
  const rspObs = rsp.status === 'fulfilled' ? rsp.value : null;
  const gap = ewObs && rspObs ? maxDailyGap(ewObs, rspObs) : null;
  const ewBad = !ewObs || (gap != null && gap > EW_CHECK_MAX_PP);
  const useObs = ewBad ? rspObs : ewObs;
  if (!useObs) throw new Error('spxew: ' + [ew, rsp].map((r) => (r.status === 'rejected' ? r.reason.message : 'empty')).join(' | '));
  raw.spxew = useObs;
  raw.spxewBench = gspc.status === 'fulfilled' ? gspc.value : null;
  const out = { ...summarize('spxew', useObs), source: ewBad ? 'yahoo-rsp' : 'yahoo', breadthBy: ewBad ? 'RSP' : 'SPXEW' };
  if (ewBad) { out.label = 'RSP (S&P 500 Equal Weight ETF)'; out.ewIssue = ewObs ? `^SPXEW daily moves off RSP by ${gap} pp` : '^SPXEW unavailable: ' + ew.reason.message; }
  if (gap != null) out.rspGap = gap;
  if (gspc.status === 'rejected') out.benchError = gspc.reason.message;
  return out;
}

// % change of a joined breadth row field over the last `days` calendar days.
function pctOver(rows, field, days) {
  const last = rows[rows.length - 1];
  if (!last) return null;
  const cutoff = daysAgoIso(days, new Date(last.date + 'T00:00:00Z'));
  const base = rows.filter((r) => r.date <= cutoff).pop();
  if (!base || !(base[field] > 0)) return null;
  return Math.round((last[field] / base[field] - 1) * 10000) / 100;
}

// SPXEW vs S&P 500 on the same trading days → % changes, relative performance and a ratio history.
function breadthSummary(ewObs, spxObs) {
  const spx = new Map((spxObs || []).map((o) => [o.date, o.value]));
  const rows = (ewObs || []).filter((o) => spx.has(o.date) && o.value > 0 && spx.get(o.date) > 0)
    .map((o) => ({ date: o.date, ew: o.value, spx: spx.get(o.date) }));
  if (rows.length < 2) throw new Error('spxew: no overlapping dates with the S&P 500');
  const last = rows[rows.length - 1];
  const rel = (a, b) => (a == null || b == null ? null : Math.round((a - b) * 100) / 100);
  const ew1m = pctOver(rows, 'ew', 30), spx1m = pctOver(rows, 'spx', 30);
  const ew3m = pctOver(rows, 'ew', 91), spx3m = pctOver(rows, 'spx', 91);
  const yearAgo = daysAgoIso(365, new Date(last.date + 'T00:00:00Z'));
  const win = weekly(rows.filter((r) => r.date >= yearAgo));
  if (win.length && win[win.length - 1].date !== last.date) win.push(last);
  const base = win.length ? win[0].ew / win[0].spx : null;
  return {
    breadthDate: last.date,
    spx: last.spx,
    ew1m, spx1m, rel1m: rel(ew1m, spx1m),
    ew3m, spx3m, rel3m: rel(ew3m, spx3m),
    relHist: base ? win.map((r) => [r.date, Math.round(r.ew / r.spx / base * 10000) / 100]) : []
  };
}

// CFTC TFF rows → weekly [{date, value}] of leveraged funds' net short in $bn (positive = short).
function parseCftcLevShort(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('cftc: ' + ((rows && rows.message) || 'unexpected response'));
  const byDate = new Map();
  rows.forEach((r) => {
    const face = UST_FUTURES[String(r.cftc_contract_market_code || '').trim()];
    const date = String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
    const long = parseFloat(r.lev_money_positions_long), short = parseFloat(r.lev_money_positions_short);
    if (!face || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(long) || !isFinite(short)) return;
    const w = byDate.get(date) || { n: new Set(), usd: 0 };
    if (w.n.has(r.cftc_contract_market_code)) return;
    w.n.add(r.cftc_contract_market_code);
    w.usd += (short - long) * face;
    byDate.set(date, w);
  });
  const need = Object.keys(UST_FUTURES).length;
  return [...byDate.entries()].filter(([, w]) => w.n.size === need)
    .map(([date, w]) => ({ date, value: Math.round(w.usd / 1e8) / 10 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function loadLevShort() {
  const codes = Object.keys(UST_FUTURES).map((c) => `'${c}'`).join(',');
  // encodeURIComponent (spaces as %20, not URLSearchParams' "+") keeps the SoQL unambiguous
  const qs = Object.entries({
    $select: 'report_date_as_yyyy_mm_dd,cftc_contract_market_code,lev_money_positions_long,lev_money_positions_short',
    $where: `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${CFTC_SINCE}T00:00:00.000'`,
    $order: 'report_date_as_yyyy_mm_dd',
    $limit: '20000'
  }).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const obs = parseCftcLevShort(await fetchText(`${CFTC_TFF}?${qs}`, CFTC_TIMEOUT_MS));
  if (!obs.length) throw new Error('cftc: no complete weeks');
  const rec = obs.reduce((a, b) => (b.value >= a.value ? b : a));
  return { ...summarize('levShort', obs), record: rec.value, recordDate: rec.date, since: obs[0].date, source: 'cftc-tff' };
}

// Cboe delayed quote → { value, change, date, time }. last_trade_time is US Eastern wall-clock time,
// so its date part is the US trading day the price belongs to (what FRED would file it under).
function parseCboeQuote(text) {
  const d = (JSON.parse(text) || {}).data || {};
  const value = parseFloat(d.current_price);
  const change = parseFloat(d.price_change);
  const time = String(d.last_trade_time || '');
  const date = time.slice(0, 10);
  if (!isFinite(value) || value <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad cboe quote');
  return { value, change: isFinite(change) ? change : null, date, time };
}

// Cboe's TNX is quoted as 10× the yield (49.49 = 4.949%); scale it back to percent.
function tnxToPercent(q) {
  if (q.value <= 20) return q;
  return { ...q, value: q.value / 10, change: q.change != null ? q.change / 10 : null };
}

// Treasury daily par yield curve CSV (newest row first, dates MM/DD/YYYY) → latest { date, us2y, us10y }.
function parseTreasuryCurve(text) {
  const lines = String(text).trim().split(/\r?\n/);
  const head = (lines.shift() || '').split(',').map((h) => h.replace(/"/g, '').trim());
  const i2 = head.indexOf('2 Yr'), i10 = head.indexOf('10 Yr');
  if (i2 < 0 || i10 < 0) throw new Error('treasury: no 2 Yr / 10 Yr columns');
  const rows = lines.map((line) => {
    const c = line.split(',');
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((c[0] || '').replace(/"/g, '').trim());
    return m && { date: `${m[3]}-${m[1]}-${m[2]}`, us2y: parseFloat(c[i2]), us10y: parseFloat(c[i10]) };
  }).filter((r) => r && isFinite(r.us2y) && isFinite(r.us10y)).sort((a, b) => b.date.localeCompare(a.date));
  if (!rows.length) throw new Error('treasury: no rows');
  return rows[0];
}

// Lay a newer live quote over the FRED series: replace the point for the same day or append a new one.
function mergeLive(series, live, source = 'cboe') {
  if (!series || !live || live.date < series.date) return series;
  const round = (v) => Math.round(v * 1000) / 1000;
  const hist = series.hist.filter((p) => p[0] < live.date).concat([[live.date, round(live.value)]]);
  let prev = live.change != null ? round(live.value - live.change)
    : live.date === series.date ? series.prev : series.latest;
  return {
    ...series,
    latest: round(live.value),
    date: live.date,
    time: live.time,
    prev,
    change: prev != null ? round(live.value - prev) : null,
    hist,
    source: live.source || source
  };
}

function dxyFromRates(r) {
  let v = 50.14348112;
  for (const [ccy, w] of Object.entries(DXY_WEIGHTS)) {
    const x = parseFloat(r && r[ccy]);
    if (!isFinite(x) || x <= 0) return NaN;
    v *= Math.pow(x, w);
  }
  return v;
}

// Frankfurter time series ({ rates: { date: { EUR, JPY, ... } } }) → [{date, value}] of DXY.
function parseDxySeries(text) {
  const rates = (JSON.parse(text) || {}).rates || {};
  return Object.keys(rates).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
    .map((date) => ({ date, value: dxyFromRates(rates[date]) }))
    .filter((o) => isFinite(o.value));
}

async function loadDxy() {
  const url = `${FRANKFURTER}${daysAgoIso(420)}..?base=USD&symbols=${Object.keys(DXY_WEIGHTS).join(',')}`;
  return { ...summarize('dollar', parseDxySeries(await fetchText(url))), label: 'DXY', source: 'ecb-dxy' };
}

// Yahoo chart JSON → a quote shaped like parseCboeQuote's: last price, change vs the previous
// daily close, and time as US Eastern wall-clock (exchange gmtoffset applied).
function parseYahooQuote(text) {
  const obs = parseYahooSeries(text);
  const m = ((((JSON.parse(text) || {}).chart || {}).result || [])[0] || {}).meta || {};
  const last = obs[obs.length - 1], prev = obs[obs.length - 2];
  if (!last) throw new Error('yahoo: no quote');
  const off = isFinite(m.gmtoffset) ? m.gmtoffset : 0;
  const time = isFinite(m.regularMarketTime) ? new Date((m.regularMarketTime + off) * 1000).toISOString().slice(0, 19) : '';
  return { value: last.value, change: prev ? last.value - prev.value : null,
    date: last.date, time: time.slice(0, 10) === last.date ? time : '', source: 'yahoo' };
}

// Cboe's delayed quote and Yahoo's chart are read side by side and the newer one wins, so a blocked
// or stale Cboe feed no longer leaves the card on FRED's close (which lags a trading day).
async function loadLiveQuote(cboeUrl, yahooSymbol) {
  const yUrl = YAHOO_CHART + encodeURIComponent(yahooSymbol) + '?interval=1d&range=5d';
  const [c, y] = await Promise.allSettled([
    fetchText(cboeUrl).then(parseCboeQuote),
    fetchText(yUrl).then(parseYahooQuote)
      .catch(() => fetchText(yUrl.replace('//query1.', '//query2.')).then(parseYahooQuote))
  ]);
  const ok = [c, y].filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!ok.length) throw new Error('cboe: ' + c.reason.message + ' | yahoo: ' + y.reason.message);
  return ok.reduce((a, b) => ((b.date + b.time) > (a.date + a.time) ? b : a));
}

function loadVixLive() { return loadLiveQuote(CBOE_VIX, '^VIX'); }

async function loadTnxLive() {
  return tnxToPercent(await loadLiveQuote(CBOE_TNX, '^TNX'));
}

// This month's curve; in the first days of a month it can be empty, so fall back to last month's.
async function loadTreasuryCurve(now = new Date()) {
  const month = (d) => d.toISOString().slice(0, 7).replace('-', '');
  const url = (m) => `${TREASURY_CSV}${m}?type=daily_treasury_yield_curve&field_tdr_date_value_month=${m}&page&_format=csv`;
  try {
    return parseTreasuryCurve(await fetchText(url(month(now))));
  } catch (e) {
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return parseTreasuryCurve(await fetchText(url(month(last))));
  }
}

async function buildPayload(apiKey, event = null) {
  const keys = Object.keys(SERIES).filter((k) => SERIES[k].loader !== 'usjp');
  const raw = {};
  const [results, vixLive, tnxLive, curve, spxLive, ndxLive, jgb, ovxLive] = await Promise.all([
    Promise.allSettled(keys.map((k) => (k === 'dollar'
      ? loadDxy().catch((e) => loadSeries(k, apiKey).then((s) => ({ ...s, dxyError: e.message })))
      : SERIES[k].loader === 'yahoo' ? loadMove()
      : SERIES[k].loader === 'spxew' ? loadSpxew(raw)
      : SERIES[k].loader === 'cape' ? loadCape()
      : SERIES[k].loader === 'buffett' ? loadBuffett(apiKey, raw)
      : SERIES[k].loader === 'sofrSpread' ? loadSofrSpread(apiKey)
      : SERIES[k].loader === 'cftc' ? loadLevShort()
      : loadSeries(k, apiKey, raw)))),
    loadVixLive().catch((e) => ({ error: e.message })),
    loadTnxLive().catch((e) => ({ error: e.message })),
    loadTreasuryCurve().catch((e) => ({ error: e.message })),
    loadLiveQuote(CBOE_SPX, '^GSPC').catch((e) => ({ error: e.message })),
    loadLiveQuote(CBOE_NDX, '^NDX').catch((e) => ({ error: e.message })),
    loadJgb(Date.now(), event).catch((e) => ({ error: e.message })),
    loadLiveQuote(CBOE_OVX, '^OVX').catch((e) => ({ error: e.message }))
  ]);
  const series = {}, errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') series[keys[i]] = r.value;
    else errors[keys[i]] = r.reason && r.reason.message;
  });
  // FRED stays the backbone (history); a failed Cboe call just leaves the FRED close in place.
  if (vixLive.error) errors.vixLive = vixLive.error;
  else if (series.vix) series.vix = mergeLive(series.vix, vixLive);
  // OVX (Cboe crude-oil volatility, the "VIX of oil"): FRED OVXCLS history + Cboe's delayed _OVX quote.
  if (ovxLive.error) errors.ovxLive = ovxLive.error;
  else if (series.ovx) series.ovx = mergeLive(series.ovx, ovxLive);
  if (spxLive.error) errors.spxLive = spxLive.error;
  else if (series.sp500) series.sp500 = mergeLive(series.sp500, spxLive);
  if (ndxLive.error) errors.ndxLive = ndxLive.error;
  else if (series.nasdaq100) series.nasdaq100 = mergeLive(series.nasdaq100, ndxLive);
  // Yields: Treasury's same-day close first, then the Cboe 10-year quote on top when it's as new or newer.
  if (curve.error) errors.treasury = curve.error;
  else {
    if (series.us2y) series.us2y = mergeLive(series.us2y, { value: curve.us2y, change: null, date: curve.date }, 'treasury');
    if (series.us10y) series.us10y = mergeLive(series.us10y, { value: curve.us10y, change: null, date: curve.date }, 'treasury');
  }
  if (tnxLive.error) errors.tnxLive = tnxLive.error;
  else if (series.us10y) series.us10y = mergeLive(series.us10y, tnxLive);
  // Breadth: against Yahoo's ^GSPC (same feed and days as ^SPXEW); FRED + Cboe S&P 500 if that failed.
  if (series.spxew) {
    try {
      let bench = raw.spxewBench;
      if (!bench || !bench.length) {
        if (!raw.sp500 || !series.sp500) throw new Error('sp500 unavailable');
        bench = withLatest(raw.sp500, series.sp500);
      }
      const b = breadthSummary(raw.spxew, bench);
      // keep the headline on the same day as the comparison under it
      if (b.breadthDate < series.spxew.date) {
        const upTo = raw.spxew.filter((o) => o.date <= b.breadthDate);
        if (upTo.length) series.spxew = { ...series.spxew, ...summarize('spxew', upTo), label: series.spxew.label };
      }
      Object.assign(series.spxew, b);
    } catch (e) { errors.spxewBreadth = e.message; }
  }
  // Buffett Indicator: carry the last Z.1 quarter forward with the S&P 500 (FRED closes + Cboe live).
  if (series.buffett && raw.sp500 && series.sp500) {
    try { series.buffett = buffettSummary(raw.buffettEq, raw.buffettGdp, withLatest(raw.sp500, series.sp500)); }
    catch (e) { errors.buffettLive = e.message; }
  }
  // US − Japan spreads, after the overlays so they end on the same day as the US yield tiles.
  for (const k of Object.keys(SERIES).filter((x) => SERIES[x].loader === 'usjp')) {
    const usKey = SERIES[k].us;
    try {
      if (jgb.error) throw new Error(jgb.error);
      if (!raw[usKey] || !series[usKey]) throw new Error(`${usKey} unavailable`);
      series[k] = usJpSummary(k, withLatest(raw[usKey], series[usKey]), jgb.rows);
    } catch (e) { errors[k] = e.message; }
  }
  if (!jgb.error && jgb.currentError) errors.jgbCurrent = jgb.currentError;
  if (!jgb.error && jgb.historyError) errors.jgbHistory = jgb.historyError;
  const out = { series, asOf: new Date().toISOString() };
  if (Object.keys(errors).length) out.errors = errors;
  return { data: out, okCount: Object.keys(series).length };
}

const { RETRY_TTL_S, partialTtl, kvGetGood, kvPutGood, fillFromGood } = require('../lib/last-good.js');
const KV_KEY = 'markets:lastGood';

exports.handler = async function (event) {
  const now = Date.now();
  const { release } = isReleaseDay(new Date(now));
  const ttl = release ? RELEASE_TTL_S : TTL_S;
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': cacheControl(ttl, release)
  };
  if (memCache.data && now < memCache.expiresAt) {
    // advertise only the time this copy has left, so the CDN/browser don't stack another full TTL
    const remaining = Math.round((memCache.expiresAt - now) / 1000);
    return {
      statusCode: 200,
      headers: { ...headers, 'Cache-Control': cacheControl(remaining, release) },
      body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining })
    };
  }
  try {
    const { data } = await buildPayload((process.env.FRED_API_KEY || '').trim(), event);
    // A tile whose series failed this time (live overlays like vixLive don't count: the FRED close
    // still shows) is filled from the last good copy, and the answer is cached only briefly.
    const missing = Object.keys(data.errors || {}).filter((k) => k in SERIES && !data.series[k]);
    let ttlNow = ttl;
    if (missing.length) {
      const good = memCache.lastGood || await kvGetGood(event, KV_KEY, 14 * 86400000);
      const filled = fillFromGood(data.series, good && good.series, data.errors);
      if (filled.length) data.staleSeries = filled;
      if (data.errors && !Object.keys(data.errors).length) delete data.errors;
      ttlNow = partialTtl(ttl, missing.length, missing.length - filled.length);
    }
    // JGB history missing → the spreads only cover this month (no 1-month change / colour zone):
    // show the last good spreads if they had a full year, and try again soon.
    if (data.errors && data.errors.jgbHistory) {
      const good = memCache.lastGood || await kvGetGood(event, KV_KEY, 14 * 86400000);
      for (const k of Object.keys(SERIES).filter((x) => SERIES[x].loader === 'usjp')) {
        const g = good && good.series && good.series[k], cur = data.series[k];
        if (g && g.hist && (!cur || !cur.hist || g.hist.length > cur.hist.length)) {
          data.series[k] = g;
          data.staleSeries = (data.staleSeries || []).concat([k]);
        }
      }
      ttlNow = Math.min(ttlNow, RETRY_TTL_S);
    }
    if (!Object.keys(data.series).length) throw new Error('every series failed: ' + JSON.stringify(data.errors || {}));
    data.ttl = ttlNow;
    memCache = { data, expiresAt: now + ttlNow * 1000, lastGood: data };
    await kvPutGood(event, KV_KEY, data);
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': cacheControl(ttlNow, release) }, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || await kvGetGood(event, KV_KEY, 14 * 86400000);
    if (good) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': cacheControl(RETRY_TTL_S, release) }, body: JSON.stringify({ ...good, stale: true, staleReason: e.message }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = { buffettSummary, quarterEnd, parseMultplTable, capeSummary, MULTPL_CAPE, breadthSummary, pctOver, maxDailyGap, parseMofCsv, mergeJgb, withLatest, joinUsJp, changeOver, usJpSummary, parseCsv, parseApiJson, weekly, summarize, parseCboeQuote, parseYahooQuote, loadLiveQuote, tnxToPercent, parseTreasuryCurve, mergeLive, dxyFromRates, parseDxySeries, joinSofrIorb, parseYahooSeries, parseCftcLevShort, SERIES, _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; jgbHistCache = { rows: null, expiresAt: 0 }; capeCache = { rows: null, expiresAt: 0 }; } };
