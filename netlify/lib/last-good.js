// Shared "never blank a card" helpers for the data functions.
//
// Two failure modes made cards show "–" for some visitors while others saw numbers:
//   1) one upstream (e.g. FRED) fails for one request, and the PARTIAL answer gets cached for the
//      full TTL (memory + CDN), so everyone in that window sees the gap;
//   2) a cold start (new instance, other region, the other host) has no in-memory last-good copy.
// Fixes: fill missing fields from the last good copy, cache a partial answer only briefly, and keep
// the last good copy in Cloudflare KV (binding STORE) so it survives cold starts. On Netlify there is
// no KV here, so it is memory only there.
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

function kvOf(event) {
  return (event && event.cloudflare && event.cloudflare.kv) || null;
}

// → the stored data, or null (no KV, nothing stored, too old, or a read error)
async function kvGetGood(event, key, maxAgeMs) {
  const kv = kvOf(event);
  if (!kv) return null;
  try {
    const v = await kv.get(key, 'json');
    if (!v || !v.data) return null;
    if (maxAgeMs && Date.now() - Number(v.at || 0) > maxAgeMs) return null;
    return v.data;
  } catch (e) { return null; }
}

async function kvPutGood(event, key, data, { force = false } = {}) {
  const kv = kvOf(event);
  if (!kv || !data) return;
  const now = Date.now();
  if (!force && now - (lastWrite.get(key) || 0) < KV_WRITE_EVERY_MS) return;
  lastWrite.set(key, now);
  try { await kv.put(key, JSON.stringify({ at: now, data })); } catch (e) { /* memory only */ }
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

module.exports = { RETRY_TTL_S, FILLED_TTL_S, partialTtl, kvGetGood, kvPutGood, fillFromGood, _resetThrottle: () => lastWrite.clear() };
