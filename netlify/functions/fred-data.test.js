// Unit tests for fred-data.js — run with:  npm test   (or: node --test netlify/functions/)
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
const { __test } = require('./fred-data.js');

const {
  parseFredCsv, parseFredApiJson, parseBlsJson, splitCsvLine,
  yearAgoIso, monthBeforeIso, isReleaseDay, inRange,
  yoyFromLevels, payrollsFromLevels,
  TARGETS, FOMC_STATEMENT_DATES
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
  assert.equal(TARGETS.cpi.bls, 'CUUR0000SA0');
  assert.equal(TARGETS.coreCpi.bls, 'CUUR0000SA0L1E');
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
