// Shared "never blank a card" helpers for the data functions.
//
// Two failure modes made cards show "–" for some visitors while others saw numbers:
//   1) one upstream (e.g. FRED) fails for one request, and the PARTIAL answer gets cached for the
//      full TTL (memory + CDN), so everyone in that window sees the gap;
//   2) a cold start (new instance, other region, the other host) has no in-memory last-good copy.
// Fixes: fill missing fields from the last good copy, cache a partial answer only briefly, and keep
// the last good copy in a persistent store (Cloudflare KV / Netlify Blobs) so it survives cold starts.
//
// KV free tier allows ~1000 writes/day (and ~100k reads), so writes are throttled per key ACROSS
// instances: Cloudflare runs many short-lived isolates in many regions at once, and a timer kept only
// in one isolate's memory let every fresh isolate write every key again (the cause of the
// "KV operations are nearing the daily cap" email). Now a write only happens when the copy already
// in the store is older than KV_WRITE_EVERY_MS — ≤ 8 writes per key per day, whatever the traffic.

const RETRY_TTL_S = 120;        // a field is still blank → retry the upstream soon
const FILLED_TTL_S = 15 * 60;   // every gap was filled from the last good copy → retry, but gently

// TTL for an answer: normal when complete, shorter when something failed this time.
function partialTtl(ttlS, missingCount, stillMissingCount) {
  if (stillMissingCount > 0) return Math.min(ttlS, RETRY_TTL_S);
  if (missingCount > 0) return Math.min(ttlS, FILLED_TTL_S);
  return ttlS;
}
const KV_WRITE_EVERY_MS = 3 * 3600 * 1000;
const STORE_BACKOFF_MS = 10 * 60 * 1000; // the store failed (e.g. daily KV quota used up) → leave it alone a while
const knownAt = new Map(); // key → `at` of the copy in the store, as last seen by this isolate
let storeDownUntil = 0;
let blobsOverride = null; // tests inject a fake @netlify/blobs (npm test runs without node_modules)

// Where the last good copy lives: Cloudflare KV (binding STORE) on Cloudflare Pages, Netlify Blobs
// (store "last-good", built into every Netlify site) on Netlify, nothing elsewhere (tests, dev server).
function storeOf(event) {
  const kv = event && event.cloudflare && event.cloudflare.kv;
  if (kv) return { get: (k) => kv.get(k, 'json'), put: (k, v) => kv.put(k, JSON.stringify(v)) };
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (!((event && event.blobs) || env.NETLIFY_BLOBS_CONTEXT)) return null;
  try {
    // inside try: Cloudflare's bundle never has this package (same pattern as visitors.js)
    const blobs = blobsOverride || require('@netlify/blobs');
    if (event && event.blobs) blobs.connectLambda(event);
    const st = blobs.getStore('last-good');
    return { get: (k) => st.get(k, { type: 'json' }), put: (k, v) => st.setJSON(k, v) };
  } catch (e) { return null; }
}

// → the stored data, or null (no store, nothing stored, too old, or a read error)
async function kvGetGood(event, key, maxAgeMs) {
  const store = Date.now() < storeDownUntil ? null : storeOf(event);
  if (!store) return null;
  try {
    const v = await store.get(key);
    knownAt.set(key, Number(v && v.at) || 0);
    if (!v || !v.data) return null;
    if (maxAgeMs && Date.now() - Number(v.at || 0) > maxAgeMs) return null;
    return v.data;
  } catch (e) { storeDownUntil = Date.now() + STORE_BACKOFF_MS; return null; }
}

async function kvPutGood(event, key, data, { force = false } = {}) {
  const now = Date.now();
  const store = now < storeDownUntil ? null : storeOf(event);
  if (!store || !data) return;
  if (!force) {
    let at = knownAt.get(key);
    if (at === undefined) {
      // first time this isolate wants to write this key: one read tells how old the shared copy is
      knownAt.set(key, now); // concurrent requests in this isolate wait for the answer instead of writing too
      try { const v = await store.get(key); at = Number(v && v.at) || 0; }
      catch (e) { storeDownUntil = now + STORE_BACKOFF_MS; return; }
      knownAt.set(key, at);
    }
    if (now - at < KV_WRITE_EVERY_MS) return;
  }
  knownAt.set(key, now);
  try { await store.put(key, { at: now, data }); } catch (e) { storeDownUntil = now + STORE_BACKOFF_MS; /* memory only */ }
}

// For every key in `errors` that `good` has a value for: copy it into `target` and drop the error.
// Returns the keys that were filled (callers expose them as staleFields).
function fillFromGood(target, good, errors) {
  const filled = [];
  if (!target || !good || !errors) return filled;
  for (const k of Object.keys(errors)) {
    if (good[k] != null && target[k] == null) { target[k] = good[k]; filled.push(k); delete errors[k]; }
  }
  return filled;
}

module.exports = { RETRY_TTL_S, FILLED_TTL_S, KV_WRITE_EVERY_MS, partialTtl, kvGetGood, kvPutGood, fillFromGood, _resetThrottle: () => { knownAt.clear(); storeDownUntil = 0; }, _setBlobs: (m) => { blobsOverride = m; } };
