// Unit tests for netlify/functions/fred-data.js — run with:  npm test
//
// The function deliberately exports its pure helpers via `module.exports.__test`, but until now
// nothing in the repo actually used them, so every regression had to be caught in production.
// These tests cover the parsing + date-math paths that already caused real bugs once:
//   • Oct 2025 CPI missing (".") → year-ago lookup must be by date, not by array index
//   • the BLS payrolls fallback pointed at average HOURLY EARNINGS instead of an employment level
//   • FRED CSV values can be quoted with thousands separators ("159,075")
// No network access is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test, handler } = require('../netlify/functions/fred-data.js');

const {
  parseFredCsv, parseFredApiJson, parseBlsJson, splitCsvLine,
  yearAgoIso, monthBeforeIso, isReleaseDay, inRange, awaitingFields, cacheControl, secondsUntilWatch,
  yoyFromLevels, payrollsFromLevels,
  TARGETS, FOMC_STATEMENT_DATES, _expireCache
} = __test;

// ── CSV / JSON parsing ────────────────────────────────────────────────────────────────────────
test('splitCsvLine keeps quoted fields with thousands separators intact', () => {
  assert.deepEqual(splitCsvLine('2026-08-01,"159,075"'), ['2026-08-01', '159,075']);
  assert.deepEqual(splitCsvLine('"a,b",c'), ['a,b', 'c']);
  assert.deepEqual(splitCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
});

test('parseFredCsv drops FRED missing markers and sorts newest-first', () => {
  const csv = [
    'observation_date,CPIAUCSL',
    '2026-06-01,320.1',
    '2026-07-01,.',        // FRED's literal "missing"
    '2025-10-01,',         // empty
    '2026-08-01,"326,000"',
    'not-a-date,999'
  ].join('\n');
  const obs = parseFredCsv(csv);
  assert.deepEqual(obs, [
    { date: '2026-08-01', value: 326000 },
    { date: '2026-06-01', value: 320.1 }
  ]);
});

test('parseFredApiJson handles errors and unusable observations', () => {
  assert.throws(() => parseFredApiJson(JSON.stringify({ error_message: 'Bad Request' })), /FRED error/);
  const obs = parseFredApiJson(JSON.stringify({
    observations: [
      { date: '2026-08-01', value: '3.35' },
      { date: '2026-07-01', value: '.' },
      { date: '2026-06-01', value: '3.20' }
    ]
  }));
  assert.deepEqual(obs, [
    { date: '2026-08-01', value: 3.35 },
    { date: '2026-06-01', value: 3.2 }
  ]);
  assert.throws(() => parseFredApiJson(JSON.stringify({ observations: [] })), /no usable observations/);
});

test('parseBlsJson maps M01..M12 and skips annual (M13) / "-" values', () => {
  const payload = JSON.stringify({
    status: 'REQUEST_SUCCEEDED',
    Results: {
      series: [{
        seriesID: 'LNS14000000',
        data: [
          { year: '2026', period: 'M08', value: '4.1' },
          { year: '2026', period: 'M13', value: '4.0' },  // annual average — must be ignored
          { year: '2026', period: 'M07', value: '-' },    // not published
          { year: '2026', period: 'M06', value: '4.2' }
        ]
      }]
    }
  });
  assert.deepEqual(parseBlsJson(payload, 'LNS14000000'), [
    { date: '2026-08-01', value: 4.1 },
    { date: '2026-06-01', value: 4.2 }
  ]);
  assert.throws(() => parseBlsJson(JSON.stringify({ status: 'REQUEST_NOT_PROCESSED' }), 'X'), /BLS status/);
  assert.throws(() => parseBlsJson(JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [] } }), 'X'), /missing from response/);
});

// ── date helpers ──────────────────────────────────────────────────────────────────────────────
test('date helpers are month/year correct at boundaries', () => {
  assert.equal(yearAgoIso('2026-08-01'), '2025-08-01');
  assert.equal(monthBeforeIso('2026-03-01'), '2026-02-01');
  assert.equal(monthBeforeIso('2026-01-01'), '2025-12-01'); // year rollover
});

// ── CPI YoY by date (the Oct-2025 missing-print regression) ───────────────────────────────────
test('yoyFromLevels matches the year-ago row by DATE, not by array index', () => {
  // Oct 2025 is missing entirely, exactly like the real 2025 lapse-in-appropriations gap.
  const obs = [
    { date: '2026-08-01', value: 330.0 },
    { date: '2026-07-01', value: 329.0 },
    { date: '2025-09-01', value: 315.0 },
    { date: '2025-08-01', value: 319.0 } // the correct comparison row
  ];
  const { result } = yoyFromLevels(obs, 'fred-csv');
  assert.equal(result.date, '2026-08-01');
  assert.equal(result.yearAgoDate, '2025-08-01');
  assert.equal(result.yearAgoLevel, 319.0);
  assert.equal(Number(result.value.toFixed(2)), 3.45); // (330-319)/319
  assert.equal(result.method, 'computed-from-levels-by-date');
});

test('yoyFromLevels reports a missing year-ago row instead of guessing', () => {
  const obs = [{ date: '2026-08-01', value: 330.0 }, { date: '2026-07-01', value: 329.0 }];
  const out = yoyFromLevels(obs, 'fred-csv');
  assert.equal(out.result, undefined);
  assert.match(out.error, /no year-ago level for 2025-08-01/);
});

// ── payrolls ──────────────────────────────────────────────────────────────────────────────────
test('payrollsFromLevels diffs PAYEMS levels in thousands → jobs', () => {
  const obs = [
    { date: '2026-08-01', value: 159075 },
    { date: '2026-07-01', value: 159030 },
    { date: '2026-06-01', value: 158990 }
  ];
  const out = payrollsFromLevels(obs, 'fred-csv');
  assert.equal(out.value, 45000); // 45k jobs added
  assert.equal(out.prevDate, '2026-07-01');
  assert.equal(out.level, 159075000);
});

test('payrollsFromLevels refuses a series that is not an employment level', () => {
  // Regression guard: the BLS fallback used to point at CES0500000003, i.e. average hourly
  // earnings (~$37). Values like that must be rejected, not turned into a nonsense "jobs" number.
  const avgHourlyEarnings = [{ date: '2026-08-01', value: 37.1 }, { date: '2026-07-01', value: 37.0 }];
  assert.throws(() => payrollsFromLevels(avgHourlyEarnings, 'bls'), /no usable PAYEMS level/);
});

test('payrollsFromLevels needs the immediately preceding month', () => {
  const obs = [{ date: '2026-08-01', value: 159075 }, { date: '2026-05-01', value: 158900 }];
  assert.throws(() => payrollsFromLevels(obs, 'fred-csv'), /no previous month \(2026-07-01\)/);
});

test('payrollsFromLevels rejects implausible swings', () => {
  const obs = [{ date: '2026-08-01', value: 250000 }, { date: '2026-07-01', value: 159000 }];
  assert.throws(() => payrollsFromLevels(obs, 'fred-csv'), /implausible payroll change/);
});

test('the BLS fallback series ids are the ones that actually exist upstream', () => {
  // CES0000000001 = All Employees, Total Nonfarm (the headline NFP series; FRED PAYEMS)
  assert.equal(TARGETS.payrolls.bls, 'CES0000000001');
  assert.equal(TARGETS.payrolls.fred, 'PAYEMS');
  assert.equal(TARGETS.unrate.bls, 'LNS14000000');
  assert.equal(TARGETS.cpi.bls, 'CUSR0000SA0');       // seasonally adjusted = FRED CPIAUCSL
  assert.equal(TARGETS.coreCpi.bls, 'CUSR0000SA0L1E'); // seasonally adjusted = FRED CPILFESL
  // Daily series have no BLS equivalent — asking BLS for them would just waste the 25/day quota.
  assert.equal(TARGETS.effr.bls, undefined);
});

// ── release-day caching heuristic ─────────────────────────────────────────────────────────────
test('isReleaseDay flags CPI window, first Friday, and FOMC days', () => {
  assert.equal(isReleaseDay(new Date('2026-09-12T12:00:00Z')).cpiWindow, true);   // 12th = CPI window
  assert.equal(isReleaseDay(new Date('2026-09-21T12:00:00Z')).release, false);    // quiet Monday
  assert.equal(isReleaseDay(new Date('2026-09-04T12:00:00Z')).firstFriday, true); // Fri Sep 4, day 4
  assert.equal(isReleaseDay(new Date('2026-09-16T12:00:00Z')).fomc, true);        // FOMC statement
});

test('FOMC calendar covers 2026 and 2027 and is sorted/deduped', () => {
  const dates = [...FOMC_STATEMENT_DATES].sort();
  assert.deepEqual(FOMC_STATEMENT_DATES, dates);
  assert.equal(new Set(FOMC_STATEMENT_DATES).size, FOMC_STATEMENT_DATES.length);
  assert.ok(FOMC_STATEMENT_DATES.includes('2026-09-16'));
  // Without these the 15-minute TTL shortcut silently died on 2027-01-01.
  assert.ok(FOMC_STATEMENT_DATES.includes('2027-01-27'));
  assert.ok(FOMC_STATEMENT_DATES.includes('2027-12-08'));
  assert.ok(FOMC_STATEMENT_DATES.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
});

test('inRange is inclusive and rejects non-numbers', () => {
  assert.equal(inRange(3.5, [3, 4]), true);
  assert.equal(inRange(3, [3, 4]), true);
  assert.equal(inRange(4.5, [3, 4]), false);
  assert.equal(inRange(NaN, [3, 4]), false);
  assert.equal(inRange('3.5', [3, 4]), false);
});

// ── release morning: fields still on last month's print ───────────────────────────────────────
test('awaitingFields flags CPI still on the old month after 8:30 ET on a CPI-window day', () => {
  const data = { cpi: { date: '2026-08-01' }, coreCpi: { date: '2026-09-01' }, nfp: { date: '2026-08-01' } };
  // 14 Oct 2026, 13:00 UTC: September CPI is due — cpi still says August, coreCpi already updated
  assert.deepEqual(awaitingFields(data, new Date('2026-10-14T13:00:00Z')), ['cpi']);
  // before the release time, and after the window closes, nothing is pending
  assert.deepEqual(awaitingFields(data, new Date('2026-10-14T11:00:00Z')), []);
  assert.deepEqual(awaitingFields(data, new Date('2026-10-14T17:00:00Z')), []);
  // quiet day outside the CPI window
  assert.deepEqual(awaitingFields(data, new Date('2026-10-21T13:00:00Z')), []);
  // jobs Friday (2 Oct 2026): nfp on August is pending, CPI isn't checked
  assert.deepEqual(awaitingFields(data, new Date('2026-10-02T13:00:00Z')), ['nfp']);
});

test('cacheControl never stacks a long stale window on release days', () => {
  assert.equal(cacheControl(600, true), 'public, max-age=600, s-maxage=600, stale-while-revalidate=60');
  assert.match(cacheControl(10800, false), /stale-while-revalidate=21600$/);
  assert.match(cacheControl(3, true), /max-age=30,/); // floor so the CDN still absorbs bursts
});

test('release morning: FRED still on August, BLS already has September → page gets September', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T12:45:00Z') });
  const months = [];
  for (let d = new Date(Date.UTC(2024, 6, 1)); d <= new Date(Date.UTC(2026, 8, 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 10));
  }
  const level = (i) => 315 + i * 0.8; // ~3% a year
  const fredMonths = months.slice(0, -1); // FRED hasn't posted 2026-09 yet
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(url);
    const ok = (text) => ({ ok: true, status: 200, text: async () => text });
    if (url.includes('fredgraph.csv?id=CPIAUCSL')) {
      const pc1 = url.includes('transformation=pc1');
      return ok('observation_date,CPIAUCSL\n' + fredMonths.map((m, i) => `${m},${pc1 ? '3.0' : level(i)}`).join('\n'));
    }
    if (url.includes('CUSR0000SA0') && !url.includes('L1E')) {
      const data = months.map((m, i) => ({ year: m.slice(0, 4), period: 'M' + m.slice(5, 7), value: String(level(i)) }));
      return ok(JSON.stringify({ status: 'REQUEST_SUCCEEDED', Results: { series: [{ seriesID: 'CUSR0000SA0', data }] } }));
    }
    return { ok: false, status: 503, text: async () => '' };
  };
  t.after(() => { global.fetch = realFetch; });

  _expireCache();
  const res = await handler();
  const body = JSON.parse(res.body);
  assert.equal(body.cpi.date, '2026-09-01');
  assert.equal(body.cpi.source, 'bls');
  assert.deepEqual(body.updatedFromBls, ['cpi']);
  assert.equal(body.awaiting, undefined);
  assert.ok(calls.some((u) => u.includes('CUSR0000SA0')));
});

test('secondsUntilWatch stops a pre-release cache from outliving 12:25 UTC', () => {
  assert.equal(secondsUntilWatch(new Date('2026-10-14T12:20:00Z')), 300);  // CPI day, 5 min before
  assert.equal(secondsUntilWatch(new Date('2026-10-14T12:30:00Z')), null); // already watching
  assert.equal(secondsUntilWatch(new Date('2026-10-21T12:20:00Z')), null); // quiet day
});

test('jobs day covers the reports BLS moves off the first Friday', () => {
  assert.equal(isReleaseDay(new Date('2026-01-09T13:00:00Z')).jobsDay, true);  // 2nd Friday (Jan 9, 2026)
  assert.equal(isReleaseDay(new Date('2026-05-08T13:00:00Z')).jobsDay, true);  // 2nd Friday (May 8, 2026)
  assert.equal(isReleaseDay(new Date('2026-07-02T13:00:00Z')).jobsDay, true);  // Thursday before Jul 3 holiday
  assert.equal(isReleaseDay(new Date('2026-10-23T13:00:00Z')).jobsDay, false); // late-month Friday
  assert.deepEqual(awaitingFields({ nfp: { date: '2026-03-01' }, unrate: { date: '2026-04-01' } },
    new Date('2026-05-08T13:00:00Z')), ['nfp']);
});

test('the day after an FOMC statement still counts as a release day', () => {
  assert.equal(isReleaseDay(new Date('2026-10-29T12:00:00Z')).fomc, true);  // statement Oct 28
  assert.equal(isReleaseDay(new Date('2026-10-30T12:00:00Z')).fomc, false);
});
