// Cloudflare adapter: only public answers with s-maxage are kept in the edge cache. Run with: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('edgeTtl honours s-maxage and never caches errors or private answers', async () => {
  const { __test } = await import(pathToFileURL(path.join(__dirname, '..', 'functions', '[[path]].js')).href);
  const t = (cc, statusCode) => __test.edgeTtl({ statusCode, headers: { 'Cache-Control': cc } });
  assert.equal(t('public, max-age=600, s-maxage=600, stale-while-revalidate=3600'), 600);
  assert.equal(t('public, max-age=60'), 0, 'browser-only max-age is not an edge TTL');
  assert.equal(t('no-store'), 0);
  assert.equal(t('private, s-maxage=60'), 0);
  assert.equal(t('public, s-maxage=300', 502), 0);
  assert.equal(t('public, s-maxage=999999'), 86400, 'capped at a day');
});
