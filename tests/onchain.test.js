// Unit tests for onchain.js — run with:  npm test
//
// The only risky logic in that function is guessing which field of the BGeometrics response holds
// the number, so it is pinned down here for each shape the API has been seen answering with.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../netlify/functions/onchain.js');

const { extractValue, METRICS } = __test;

test('extractValue handles a single object with a value field', () => {
  assert.equal(extractValue({ date: '2026-09-11', value: 0.512 }), 0.512);
});

test('extractValue handles arrays and {data:[…]} wrappers (newest entry last)', () => {
  assert.equal(extractValue([{ value: 0.4 }, { value: 0.512 }]), 0.512);
  assert.equal(extractValue({ data: [{ value: 0.4 }, { value: 0.512 }] }), 0.512);
  assert.equal(extractValue({ data: { value: 1.87 } }), 1.87);
});

test('extractValue prefers named fields over the first numeric key', () => {
  // "d" is numeric-looking but is a date placeholder — must not win over `value`.
  assert.equal(extractValue({ d: 20260911, value: 2.41 }), 2.41);
});

test('extractValue skips timestamp-like keys when falling back', () => {
  assert.equal(extractValue({ timestamp: 1757600000, unixTs: 1757600000, mvrv_ratio: 2.1 }), 2.1);
});

test('extractValue returns null for junk instead of NaN', () => {
  assert.equal(extractValue(null), null);
  assert.equal(extractValue({ timestamp: 1, date: '2026-09-11' }), null);
  assert.equal(extractValue('not a number'), null);
  assert.equal(extractValue({ value: 'abc' }), null);
});

test('only whitelisted metric slugs exist (the query string can never pick the upstream path)', () => {
  assert.deepEqual(Object.keys(METRICS).sort(), ['mvrv', 'mvrv-zscore', 'nupl']);
  assert.ok(METRICS.nupl.every((s) => /^[a-z0-9/-]+$/.test(s) && !s.includes('..')));
});
