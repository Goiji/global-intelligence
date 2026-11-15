// BTC open interest: CoinGecko (CEX + whatever DEXs it tracks) combined with Hyperliquid's own API,
// without counting Hyperliquid twice.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { SCRIPTS, makeSandbox } = require('./dom-stub.js');

async function load() {
  const sandbox = makeSandbox();
  SCRIPTS.forEach((src) => vm.runInNewContext(src, sandbox, { filename: 'index.html' }));
  await new Promise((resolve) => setImmediate(resolve));
  const api = (sandbox.window && sandbox.window.__oiTest) || sandbox.__oiTest;
  assert.ok(api, '__oiTest helpers missing');
  return api;
}

const hl = (oi, px) => [{ universe: [{ name: 'ETH' }, { name: 'BTC' }] }, [{ openInterest: '9', markPx: '1' }, { openInterest: String(oi), markPx: String(px) }]];
const cg = (extra = []) => [
  { market: 'Binance (Futures)', index_id: 'BTC', open_interest: 10e9, expired_at: null },
  { market: 'OKX (Futures)', index_id: 'BTC', open_interest: 5e9, expired_at: null },
  { market: 'Binance (Futures)', index_id: 'ETH', open_interest: 99e9, expired_at: null },
  { market: 'CME', index_id: 'BTC', open_interest: 7e9, expired_at: '2026-12-26' },
  ...extra,
];

test('Hyperliquid BTC OI is coins × mark price, null on junk', async () => {
  const { hyperliquidBtcOiUsd } = await load();
  assert.equal(hyperliquidBtcOiUsd(hl(20000, 100000)), 2e9);
  assert.equal(hyperliquidBtcOiUsd({ error: 'x' }), null);
  assert.equal(hyperliquidBtcOiUsd([{ universe: [{ name: 'ETH' }] }, [{ openInterest: '1', markPx: '1' }]]), null);
});

test('Hyperliquid is added to the CoinGecko total when CoinGecko lacks it', async () => {
  const { combineBtcOpenInterest } = await load();
  const r = combineBtcOpenInterest(cg(), 2e9);
  assert.equal(r.totalUsd, 17e9);
  assert.equal(r.byExchange.Hyperliquid, 2e9);
});

test('Hyperliquid is not double counted when CoinGecko already lists it', async () => {
  const { combineBtcOpenInterest } = await load();
  const r = combineBtcOpenInterest(cg([{ market: 'Hyperliquid (Futures)', index_id: 'BTC', open_interest: 1.9e9, expired_at: null }]), 2e9);
  assert.equal(r.totalUsd, 16.9e9);
  assert.equal(r.byExchange.Hyperliquid, undefined);
});

test('either source alone still yields a total', async () => {
  const { combineBtcOpenInterest } = await load();
  assert.equal(combineBtcOpenInterest(null, 2e9).totalUsd, 2e9);
  assert.equal(combineBtcOpenInterest(cg(), null).totalUsd, 15e9);
});
