// Shared "never blank a card" helpers for the data functions.
//
// Two failure modes made cards show "–" for some visitors while others saw numbers:
//   1) one upstream (e.g. FRED) fails for one request, and the PARTIAL answer gets cached for the
//      full TTL (memory + CDN), so everyone in that window sees the gap;
//   2) a cold start (new instance, other region, the other host) has no in-memory last-good copy.
// Fixes: fill missing fields from the last good copy, cache a partial answer only briefly, and keep
// the last good copy in a persistent store (Cloudflare KV / Netlify Blobs) so it survives cold starts.
//
// KV free tier allows ~1000 writes/day, so writes are throttled per key per instance.

const RETRY_TTL_S = 120;        // a field is still blank → retry the upstream soon
const FILLED_TTL_S = 15 * 60;   // every gap was filled from the last good copy → retry, but gently

// TTL for an answer: normal when complete, shorter when something failed this time.
function partialTtl(ttlS, missingCount, stillMissingCount) {
  if (stillMissingCount > 0) return Math.min(ttlS, RETRY_TTL_S);
  if (missingCount > 0) return Math.min(ttlS, FILLED_TTL_S);
  return ttlS;
}
const KV_WRITE_EVERY_MS = 30 * 60 * 1000;
const lastWrite = new Map();
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
  const store = storeOf(event);
  if (!store) return null;
  try {
    const v = await store.get(key);
    if (!v || !v.data) return null;
    if (maxAgeMs && Date.now() - Number(v.at || 0) > maxAgeMs) return null;
    return v.data;
  } catch (e) { return null; }
}

async function kvPutGood(event, key, data, { force = false } = {}) {
  const store = storeOf(event);
  if (!store || !data) return;
  const now = Date.now();
  if (!force && now - (lastWrite.get(key) || 0) < KV_WRITE_EVERY_MS) return;
  lastWrite.set(key, now);
  try { await store.put(key, { at: now, data }); } catch (e) { /* memory only */ }
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

module.exports = { RETRY_TTL_S, FILLED_TTL_S, partialTtl, kvGetGood, kvPutGood, fillFromGood, _resetThrottle: () => lastWrite.clear(), _setBlobs: (m) => { blobsOverride = m; } };
