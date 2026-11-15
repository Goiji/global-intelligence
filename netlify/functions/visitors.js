// Netlify Function: a small visitor counter for the page footer ("👥 ผู้มาเยือน N").
//
//   GET  /.netlify/functions/visitors   → 200 { total, today, date }       (read only)
//   POST /.netlify/functions/visitors   → 200 { total, today, date }       (count one visit, then read)
//   → 503 { error: 'storage-unavailable' } when the store cannot be reached
//
// The page sends POST once per browser per day (Bangkok date, remembered in localStorage) and GET
// on every other load, so `total` is roughly "browser-days" and `today` is unique browsers today.
// Nothing about the visitor is stored: no IP, no cookie, no id — just two numbers per day.
//
// Storage is Netlify Blobs (built into every Netlify site, no signup or third-party service):
// one JSON blob { total, days: { 'YYYY-MM-DD': n } } in the "visitors" store, pruned to the last
// 60 days. Blobs has no atomic increment, so two visits in the same instant can occasionally count
// as one — fine for a footer counter. Outside Netlify (tests, tools/dev-server.js) it falls back to
// an in-memory store so the page still works.

const STORE = 'visitors';
const KEY = 'counts';
const KEEP_DAYS = 60;

let storeFactory = null; // tests inject a fake store
let memStore = null;

function memoryStore() {
  if (!memStore) {
    const data = new Map();
    memStore = {
      get: async (k) => (data.has(k) ? JSON.parse(data.get(k)) : null),
      setJSON: async (k, v) => { data.set(k, JSON.stringify(v)); },
    };
  }
  return memStore;
}

function openStore(event) {
  if (storeFactory) return storeFactory(event);
  const onNetlify = (event && event.blobs) || process.env.NETLIFY_BLOBS_CONTEXT;
  if (!onNetlify) return memoryStore();
  const blobs = require('@netlify/blobs');
  if (event && event.blobs) blobs.connectLambda(event);
  return blobs.getStore(STORE);
}

function bangkokDate(now) {
  return new Date((now || Date.now()) + 7 * 3600000).toISOString().slice(0, 10);
}

function normalize(v) {
  const days = {};
  if (v && v.days && typeof v.days === 'object') {
    for (const [d, n] of Object.entries(v.days)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(n) && n > 0) days[d] = Math.floor(n);
    }
  }
  const total = v && Number.isFinite(v.total) && v.total > 0 ? Math.floor(v.total) : 0;
  return { total, days };
}

function addVisit(v, date) {
  const out = normalize(v);
  out.total += 1;
  out.days[date] = (out.days[date] || 0) + 1;
  const keep = Object.keys(out.days).sort().slice(-KEEP_DAYS);
  out.days = Object.fromEntries(keep.map((d) => [d, out.days[d]]));
  return out;
}

function json(status, body) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async function (event) {
  const method = (event && event.httpMethod) || 'GET';
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'method-not-allowed' });
  const date = bangkokDate();
  try {
    const store = openStore(event);
    let v = normalize(await store.get(KEY, { type: 'json' }));
    if (method === 'POST') {
      v = addVisit(v, date);
      await store.setJSON(KEY, v);
    }
    return json(200, { total: v.total, today: v.days[date] || 0, date });
  } catch (e) {
    return json(503, { error: 'storage-unavailable' });
  }
};

module.exports.__test = {
  bangkokDate, normalize, addVisit,
  setStoreFactory: (f) => { storeFactory = f; },
  resetMemory: () => { memStore = null; },
};
