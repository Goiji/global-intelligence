// Netlify Function: biggest US stock gainers over a chosen period (Capital Markets tab).
//
//   GET /.netlify/functions/us-gainers
//   → { periods: ['1d','1w','1m','3m','ytd'], rows: [{ s, n, p, r: { 1d, 1w, 1m, 3m, ytd } }],
//       asOf, universe, missing?, fetchedAt, ttl }
//     r = % change over the period (null when the stock has not traded that long, e.g. a new listing).
//     The page ranks the rows itself, so one payload serves every period button.
//
// Universe: the ~260 largest / most-watched US-listed stocks below (S&P 500 heavyweights plus the
// big Nasdaq, AI, crypto and popular US-listed foreign names). Edit the list to change it; a ticker
// Yahoo no longer returns is simply left out (reported under `missing`).
// Source: Yahoo Finance spark API (query1, then the query2 mirror), daily closes for one year, 20
// symbols per request (Yahoo's limit). No key. The latest price is Yahoo's `fulldayPrice` (live
// during the session) when the day's bar has no close yet.
// Period start = the last close on or before: 1W = 7 days ago, 1M = 30 days, 3M = 91 days, YTD = the
// last trading day of the previous year. 1D = Yahoo's own day change (vs the previous close).

const SPARK = 'https://query1.finance.yahoo.com/v8/finance/spark';
const BATCH = 20;
const ATTEMPT_TIMEOUT_MS = 6000;
const TTL_S = 15 * 60;
const PERIODS = ['1d', '1w', '1m', '3m', 'ytd'];
const LOOKBACK_DAYS = { '1w': 7, '1m': 30, '3m': 91 };

const DESC = require('../lib/us-stock-desc.js');   // [Thai, English] one-liners for the ⓘ tooltip

const UNIVERSE = [
  ['AAPL', 'Apple'], ['MSFT', 'Microsoft'], ['NVDA', 'Nvidia'], ['AMZN', 'Amazon'], ['GOOGL', 'Alphabet'],
  ['META', 'Meta'], ['TSLA', 'Tesla'], ['AVGO', 'Broadcom'], ['BRK-B', 'Berkshire Hathaway'],
  ['JPM', 'JPMorgan'], ['LLY', 'Eli Lilly'], ['V', 'Visa'], ['MA', 'Mastercard'], ['UNH', 'UnitedHealth'],
  ['XOM', 'Exxon Mobil'], ['COST', 'Costco'], ['WMT', 'Walmart'], ['HD', 'Home Depot'],
  ['PG', 'Procter & Gamble'], ['JNJ', 'Johnson & Johnson'], ['ORCL', 'Oracle'], ['NFLX', 'Netflix'],
  ['ABBV', 'AbbVie'], ['BAC', 'Bank of America'], ['KO', 'Coca-Cola'], ['CRM', 'Salesforce'], ['AMD', 'AMD'],
  ['CVX', 'Chevron'], ['MRK', 'Merck'], ['PEP', 'PepsiCo'], ['TMO', 'Thermo Fisher'], ['CSCO', 'Cisco'],
  ['ADBE', 'Adobe'], ['ACN', 'Accenture'], ['LIN', 'Linde'], ['MCD', "McDonald's"], ['WFC', 'Wells Fargo'],
  ['ABT', 'Abbott'], ['IBM', 'IBM'], ['PM', 'Philip Morris'], ['GE', 'GE Aerospace'], ['NOW', 'ServiceNow'],
  ['INTU', 'Intuit'], ['QCOM', 'Qualcomm'], ['TXN', 'Texas Instruments'], ['CAT', 'Caterpillar'],
  ['DIS', 'Disney'], ['AMGN', 'Amgen'], ['VZ', 'Verizon'], ['ISRG', 'Intuitive Surgical'],
  ['GS', 'Goldman Sachs'], ['MS', 'Morgan Stanley'], ['AXP', 'American Express'], ['SPGI', 'S&P Global'],
  ['RTX', 'RTX'], ['T', 'AT&T'], ['PFE', 'Pfizer'], ['UBER', 'Uber'], ['BKNG', 'Booking'], ['LOW', "Lowe's"],
  ['NEE', 'NextEra Energy'], ['UNP', 'Union Pacific'], ['CMCSA', 'Comcast'], ['HON', 'Honeywell'],
  ['AMAT', 'Applied Materials'], ['PGR', 'Progressive'], ['BLK', 'BlackRock'], ['ETN', 'Eaton'],
  ['SYK', 'Stryker'], ['TJX', 'TJX'], ['C', 'Citigroup'], ['BX', 'Blackstone'], ['SCHW', 'Charles Schwab'],
  ['BSX', 'Boston Scientific'], ['COP', 'ConocoPhillips'], ['VRTX', 'Vertex'], ['ADP', 'ADP'],
  ['PANW', 'Palo Alto Networks'], ['LMT', 'Lockheed Martin'], ['MU', 'Micron'], ['ANET', 'Arista Networks'],
  ['KLAC', 'KLA'], ['LRCX', 'Lam Research'], ['ADI', 'Analog Devices'], ['INTC', 'Intel'], ['DE', 'Deere'],
  ['MDT', 'Medtronic'], ['GILD', 'Gilead'], ['SBUX', 'Starbucks'], ['CB', 'Chubb'], ['PLD', 'Prologis'],
  ['BA', 'Boeing'], ['SO', 'Southern Co'], ['DUK', 'Duke Energy'], ['MO', 'Altria'], ['CRWD', 'CrowdStrike'],
  ['PLTR', 'Palantir'], ['APP', 'AppLovin'], ['SNPS', 'Synopsys'], ['CDNS', 'Cadence'],
  ['MRVL', 'Marvell Technology'], ['DELL', 'Dell'], ['WDC', 'Western Digital'], ['STX', 'Seagate'],
  ['SNDK', 'SanDisk'], ['SMCI', 'Supermicro'], ['VRT', 'Vertiv'], ['CEG', 'Constellation Energy'],
  ['VST', 'Vistra'], ['GEV', 'GE Vernova'], ['ARM', 'Arm'], ['TSM', 'TSMC'], ['ASML', 'ASML'],
  ['NBIS', 'Nebius'], ['CRWV', 'CoreWeave'], ['HOOD', 'Robinhood'], ['COIN', 'Coinbase'],
  ['MSTR', 'Strategy'], ['SHOP', 'Shopify'], ['SNOW', 'Snowflake'], ['DDOG', 'Datadog'],
  ['NET', 'Cloudflare'], ['ZS', 'Zscaler'], ['FTNT', 'Fortinet'], ['WDAY', 'Workday'], ['TEAM', 'Atlassian'],
  ['MDB', 'MongoDB'], ['DASH', 'DoorDash'], ['ABNB', 'Airbnb'], ['SPOT', 'Spotify'], ['RBLX', 'Roblox'],
  ['PYPL', 'PayPal'], ['XYZ', 'Block'], ['AFRM', 'Affirm'], ['SOFI', 'SoFi'], ['RDDT', 'Reddit'],
  ['PINS', 'Pinterest'], ['SNAP', 'Snap'], ['TTD', 'The Trade Desk'], ['NKE', 'Nike'], ['LULU', 'Lululemon'],
  ['CMG', 'Chipotle'], ['MAR', 'Marriott'], ['F', 'Ford'], ['GM', 'General Motors'], ['RIVN', 'Rivian'],
  ['NOC', 'Northrop Grumman'], ['GD', 'General Dynamics'], ['FDX', 'FedEx'], ['UPS', 'UPS'],
  ['ORLY', "O'Reilly"], ['AZO', 'AutoZone'], ['MELI', 'MercadoLibre'], ['PDD', 'PDD'], ['BABA', 'Alibaba'],
  ['JD', 'JD.com'], ['NU', 'Nu Holdings'], ['ON', 'ON Semi'], ['MCHP', 'Microchip'], ['NXPI', 'NXP'],
  ['MPWR', 'Monolithic Power'], ['TER', 'Teradyne'], ['ENPH', 'Enphase'], ['FSLR', 'First Solar'],
  ['OKLO', 'Oklo'], ['SMR', 'NuScale'], ['IONQ', 'IonQ'], ['RGTI', 'Rigetti'], ['QBTS', 'D-Wave'],
  ['ASTS', 'AST SpaceMobile'], ['RKLB', 'Rocket Lab'], ['SPCX', 'SpaceX'], ['CIEN', 'Ciena'],
  ['COHR', 'Coherent'], ['LITE', 'Lumentum'], ['CLS', 'Celestica'], ['ALAB', 'Astera Labs'],
  ['CRDO', 'Credo'], ['NTAP', 'NetApp'], ['HPE', 'HPE'], ['HPQ', 'HP'], ['ANF', 'Abercrombie'],
  ['ELV', 'Elevance'], ['CI', 'Cigna'], ['CVS', 'CVS'], ['HUM', 'Humana'], ['REGN', 'Regeneron'],
  ['MRNA', 'Moderna'], ['NVO', 'Novo Nordisk'], ['HIMS', 'Hims & Hers'], ['OXY', 'Occidental'],
  ['SLB', 'SLB'], ['EOG', 'EOG'], ['FCX', 'Freeport-McMoRan'], ['NEM', 'Newmont'],
  ['AAL', 'American Airlines'], ['DAL', 'Delta'], ['UAL', 'United Airlines'], ['CCL', 'Carnival'],
  ['TTWO', 'Take-Two'], ['CVNA', 'Carvana'], ['TGT', 'Target'], ['DG', 'Dollar General'], ['KR', 'Kroger'],
  ['MNST', 'Monster'], ['CL', 'Colgate'], ['MDLZ', 'Mondelez'], ['KHC', 'Kraft Heinz'],
  ['AMT', 'American Tower'], ['EQIX', 'Equinix'], ['WELL', 'Welltower'], ['O', 'Realty Income'],
  ['USB', 'U.S. Bancorp'], ['PNC', 'PNC'], ['COF', 'Capital One'], ['KKR', 'KKR'], ['APO', 'Apollo'],
  ['ICE', 'ICE'], ['CME', 'CME Group'], ['MCO', "Moody's"], ['ZTS', 'Zoetis'], ['DHR', 'Danaher'],
  ['ADSK', 'Autodesk'], ['ROP', 'Roper'], ['CTAS', 'Cintas'], ['WM', 'Waste Management'], ['EMR', 'Emerson'],
  ['ITW', 'Illinois Tool Works'], ['PH', 'Parker-Hannifin'], ['TT', 'Trane'], ['JCI', 'Johnson Controls'],
  ['CARR', 'Carrier'], ['URI', 'United Rentals'], ['PWR', 'Quanta Services'], ['LHX', 'L3Harris'],
  ['HWM', 'Howmet'], ['TDG', 'TransDigm'], ['AXON', 'Axon'], ['DECK', 'Deckers'], ['ULTA', 'Ulta'],
  ['EBAY', 'eBay'], ['CHWY', 'Chewy'], ['DKNG', 'DraftKings'], ['LYFT', 'Lyft'], ['ZM', 'Zoom'],
  ['DOCU', 'DocuSign'], ['OKTA', 'Okta'], ['TWLO', 'Twilio'], ['PATH', 'UiPath'], ['AI', 'C3.ai'],
  ['TEM', 'Tempus AI'], ['CRCL', 'Circle'], ['BMNR', 'BitMine'], ['MARA', 'MARA'], ['RIOT', 'Riot'],
  ['IREN', 'IREN'], ['CIFR', 'Cipher'], ['WULF', 'TeraWulf'], ['CORZ', 'Core Scientific'],
  ['GLXY', 'Galaxy'], ['HUT', 'Hut 8']
];

let memCache = { data: null, expiresAt: 0, lastGood: null };

function isoDay(d) { return d.toISOString().slice(0, 10); }
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

async function fetchText(url, timeoutMs = ATTEMPT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; global-intelligence-dashboard/1.0)', Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

// One spark entry → [{ date, close }] oldest-first (null closes dropped) + live price / day change.
// Accepts both response shapes Yahoo uses: v8 { SYM: { timestamp, close, ... } } and the older v7
// { spark: { result: [{ symbol, response: [{ timestamp, indicators: { quote: [{ close }] }, meta }] }] } }.
function sparkEntries(json) {
  const j = typeof json === 'string' ? JSON.parse(json) : json;
  const out = {};
  if (j && j.spark && Array.isArray(j.spark.result)) {
    for (const r of j.spark.result) {
      const c = r && r.response && r.response[0];
      if (!c) continue;
      const q = c.indicators && c.indicators.quote && c.indicators.quote[0];
      out[r.symbol] = { timestamp: c.timestamp, close: q && q.close, fulldayPrice: c.meta && c.meta.regularMarketPrice, chartPreviousClose: c.meta && c.meta.chartPreviousClose };
    }
    return out;
  }
  for (const [k, v] of Object.entries(j || {})) if (v && Array.isArray(v.timestamp)) out[k] = v;
  return out;
}

function toBars(e) {
  const ts = e.timestamp || [], cl = e.close || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = cl[i];
    if (c == null || !isFinite(c) || c <= 0) continue;
    bars.push({ date: isoDay(new Date(ts[i] * 1000)), close: Number(c) });
  }
  return bars;
}

// Returns for one stock. `now` = the latest bar's date drives the look-back dates.
function stockReturns(e) {
  const bars = toBars(e);
  if (!bars.length) return null;
  const lastTs = (e.timestamp || []).length ? isoDay(new Date(e.timestamp[e.timestamp.length - 1] * 1000)) : bars[bars.length - 1].date;
  let price = bars[bars.length - 1].close;
  const live = Number(e.fulldayPrice);
  // the newest bar has no close yet (session open / just closed): Yahoo's live price stands in
  if (isFinite(live) && live > 0 && lastTs > bars[bars.length - 1].date) {
    bars.push({ date: lastTs, close: live });
    price = live;
  }
  const last = bars[bars.length - 1];
  const at = (date) => { let hit = null; for (const b of bars) { if (b.date <= date) hit = b; else break; } return hit; };
  const pct = (from) => (from && from.close > 0 ? round((price / from.close - 1) * 100) : null);
  const r = {};
  const dayPct = Number(e.fulldayChangePercent);
  r['1d'] = isFinite(dayPct) && e.fulldayChangePercent != null ? round(dayPct) : (bars.length > 1 ? pct(bars[bars.length - 2]) : null);
  const base = new Date(last.date + 'T00:00:00Z').getTime();
  for (const [k, days] of Object.entries(LOOKBACK_DAYS)) {
    const from = at(isoDay(new Date(base - days * 86400000)));
    // a stock listed after the start date has no bar on/before it → null rather than a fake return
    r[k] = from && from.date < last.date ? pct(from) : null;
  }
  const ytdFrom = at(`${Number(last.date.slice(0, 4)) - 1}-12-31`);
  r.ytd = ytdFrom ? pct(ytdFrom) : null;
  return { p: round(price, price >= 100 ? 2 : 3), date: last.date, r };
}

async function loadBatch(symbols) {
  const q = `?symbols=${encodeURIComponent(symbols.join(','))}&range=1y&interval=1d`;
  try {
    return sparkEntries(await fetchText(SPARK + q));
  } catch (e) {
    return sparkEntries(await fetchText(SPARK.replace('//query1.', '//query2.') + q));
  }
}

function buildRows(entries, universe = UNIVERSE) {
  const rows = [], missing = [];
  let asOf = '';
  for (const [s, n] of universe) {
    const e = entries[s];
    const x = e ? stockReturns(e) : null;
    if (!x || (x.r['1d'] == null && x.r['1w'] == null)) { missing.push(s); continue; }
    if (x.date > asOf) asOf = x.date;
    rows.push({ s, n, p: x.p, r: x.r, date: x.date, ...(DESC[s] ? { d: DESC[s] } : {}) });
  }
  // a ticker that stopped trading (delisted / bought out) keeps its last bar forever: drop it
  const floor = asOf ? isoDay(new Date(new Date(asOf + 'T00:00:00Z').getTime() - 7 * 86400000)) : '';
  const fresh = rows.filter((r) => { if (r.date >= floor) return true; missing.push(r.s); return false; });
  fresh.forEach((r) => { delete r.date; });
  return { rows: fresh, missing, asOf };
}

async function buildPayload() {
  const batches = [];
  for (let i = 0; i < UNIVERSE.length; i += BATCH) batches.push(UNIVERSE.slice(i, i + BATCH).map((u) => u[0]));
  const settled = await Promise.allSettled(batches.map(loadBatch));
  const entries = {}, errors = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') Object.assign(entries, r.value);
    else errors.push(`batch ${i}: ${r.reason && r.reason.message}`);
  });
  const { rows, missing, asOf } = buildRows(entries);
  // fewer than half the universe = something is wrong upstream; don't publish a skewed ranking
  if (rows.length < UNIVERSE.length / 2) throw new Error(`only ${rows.length} stocks loaded (${errors.join(' | ') || 'no data'})`);
  return { periods: PERIODS, rows, asOf, universe: UNIVERSE.length, missing: missing.length ? missing : undefined, errors: errors.length ? errors : undefined };
}

const KV_KEY = 'us-gainers:lastGood';
const { kvGetGood, kvPutGood } = require('../lib/last-good.js');

exports.handler = async function (event) {
  const now = Date.now();
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${TTL_S}, s-maxage=${TTL_S}, stale-while-revalidate=1800`
  };
  if (memCache.data && now < memCache.expiresAt) {
    const remaining = Math.max(30, Math.round((memCache.expiresAt - now) / 1000));
    return { statusCode: 200, headers: { ...headers, 'Cache-Control': `public, max-age=${remaining}, s-maxage=${remaining}, stale-while-revalidate=1800` }, body: JSON.stringify({ ...memCache.data, cached: true, ttl: remaining }) };
  }
  try {
    const p = await buildPayload();
    // a few failed batches: cache only briefly so the next visitor retries them
    const ttl = p.errors ? 120 : TTL_S;
    const data = { ...p, fetchedAt: new Date().toISOString(), ttl };
    memCache = { data, expiresAt: Date.now() + ttl * 1000, lastGood: p.errors ? memCache.lastGood || data : data };
    if (!p.errors) await kvPutGood(event, KV_KEY, data);
    const h = p.errors ? { ...headers, 'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}` } : headers;
    return { statusCode: 200, headers: h, body: JSON.stringify(data) };
  } catch (e) {
    const good = memCache.lastGood || await kvGetGood(event, KV_KEY, 7 * 86400000);
    if (good) {
      return { statusCode: 200, headers: { ...headers, 'Cache-Control': 'public, max-age=300, s-maxage=300' }, body: JSON.stringify({ ...good, stale: true, staleReason: e.message, ttl: 300 }) };
    }
    return { statusCode: 502, headers: { ...headers, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: e.message }) };
  }
};

module.exports.__test = {
  sparkEntries, toBars, stockReturns, buildRows, buildPayload, UNIVERSE, PERIODS,
  _clearCache: () => { memCache = { data: null, expiresAt: 0, lastGood: null }; }
};
