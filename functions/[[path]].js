// Cloudflare Pages adapter: runs the existing Netlify Functions unchanged on Cloudflare.
//
// The page keeps calling /.netlify/functions/<name>; this file turns each request into the
// Netlify-style `event`, calls netlify/functions/<name>.js's handler, and turns its
// { statusCode, headers, body } back into a Response. So one codebase deploys to both hosts.
//
// Needs (Cloudflare dashboard → the Pages project → Settings):
//   - (optional) compatibility flag `nodejs_compat` — not required: nothing here needs Node built-ins
//   - KV namespace bound as `STORE` (visitor counter + shared consensus override)
//   - the same environment variables the Netlify site has (FRED_API_KEY, … see README)
// _routes.json limits this to /.netlify/functions/* and the paths blocked below, so static
// files are served straight from the CDN without invoking a function.

import calendar from '../netlify/functions/calendar.js';
import cmcFearGreed from '../netlify/functions/cmc-fear-greed.js';
import consensusOverride from '../netlify/functions/consensus-override.js';
import consensus from '../netlify/functions/consensus.js';
import dvol from '../netlify/functions/dvol.js';
import econExtra from '../netlify/functions/econ-extra.js';
import fredData from '../netlify/functions/fred-data.js';
import goldTh from '../netlify/functions/gold-th.js';
import markets from '../netlify/functions/markets.js';
import newsFeed from '../netlify/functions/news-feed.js';
import oilPrice from '../netlify/functions/oil-price.js';
import onchain from '../netlify/functions/onchain.js';
import usdjpy from '../netlify/functions/usdjpy.js';
import visitors from '../netlify/functions/visitors.js';
import wti from '../netlify/functions/wti.js';

const HANDLERS = {
  calendar, 'cmc-fear-greed': cmcFearGreed, 'consensus-override': consensusOverride, consensus,
  dvol, 'econ-extra': econExtra, 'fred-data': fredData, 'gold-th': goldTh, markets,
  'news-feed': newsFeed, 'oil-price': oilPrice, onchain, usdjpy, visitors, wti,
};

// Same idea as _redirects on Netlify: the publish dir is the repo root, so keep source/notes private.
const BLOCKED = /^\/(netlify|functions|tools|tests)(\/|$)|^\/(package(-lock)?\.json|netlify\.toml|README\.md|REVIEW-2026-09\.md)$/;

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });

export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/\.netlify\/functions\/([a-z0-9-]+)\/?$/);
  if (!m) return notFound(); // only BLOCKED paths reach here besides functions (see _routes.json)
  const mod = HANDLERS[m[1]];
  if (!mod || typeof mod.handler !== 'function') return notFound();

  // The functions read process.env; on Cloudflare, env vars arrive as bindings instead.
  // (Works with or without the nodejs_compat flag: without it there is no global `process`.)
  if (typeof globalThis.process === 'undefined') globalThis.process = { env: {} };
  if (!globalThis.process.env) globalThis.process.env = {};
  for (const [k, v] of Object.entries(env || {})) if (typeof v === 'string') globalThis.process.env[k] = v;

  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  if (!headers['x-forwarded-for'] && headers['cf-connecting-ip']) headers['x-forwarded-for'] = headers['cf-connecting-ip'];
  const method = request.method.toUpperCase();
  const event = {
    httpMethod: method,
    path: url.pathname,
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: method === 'GET' || method === 'HEAD' ? '' : await request.text(),
    isBase64Encoded: false,
    cloudflare: { kv: (env && env.STORE) || null },
  };

  let res;
  try {
    res = (await mod.handler(event)) || {};
  } catch (e) {
    return new Response(JSON.stringify({ error: 'function-crashed', detail: String(e && e.message) }), {
      status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  const status = res.statusCode || 200;
  const body = status === 204 || status === 304 ? null
    : res.isBase64Encoded ? Uint8Array.from(atob(res.body || ''), (c) => c.charCodeAt(0)) : (res.body ?? '');
  return new Response(body, { status, headers: res.headers || {} });
}
