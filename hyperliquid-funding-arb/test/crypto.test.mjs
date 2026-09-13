/**
 * Tests for crypto-core.js against OFFICIAL hyperliquid-python-sdk test vectors
 * (tests/signing_test.py, hyperliquid-dex/hyperliquid-python-sdk @ master).
 * Also cross-checks keccak/sha256/hmac/secp256k1 against noble, js-sha3, node crypto and ethers.
 *
 * Run:  node test/crypto.test.mjs
 */
import { createRequire } from 'node:module';
import { webcrypto as nodeCrypto } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HLC = require(path.join(__dirname, '..', 'src', 'crypto-core.js'));

// reference implementations (dev/test only)
const { keccak_256 } = require('/tmp/x/node_modules/@noble/hashes/sha3.js');
const { sha256: nobleSha256 } = require('/tmp/x/node_modules/@noble/hashes/sha2.js');
const { verifyTypedData, computeAddress } = require('/tmp/x/node_modules/ethers/lib.commonjs/index.js');

const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
let pass = 0, fail = 0;
function eq(name, got, want) {
  const g = typeof got === 'string' ? got.toLowerCase() : got;
  const w = typeof want === 'string' ? want.toLowerCase() : want;
  if (g === w) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + '\n      got:  ' + got + '\n      want: ' + want); }
}

console.log('== keccak256 ==');
eq('keccak256("")', HLC.hex(HLC.keccak256(new Uint8Array(0))), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
eq('keccak256("abc")', HLC.hex(HLC.keccak256(HLC.utf8('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
{
  let allOk = true;
  for (let i = 0; i < 200; i++) {
    const len = Math.floor(Math.random() * 400);
    const buf = new Uint8Array(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256);
    const a = HLC.hex(HLC.keccak256(buf));
    const b = HLC.hex(keccak_256(buf));
    if (a !== b) { allOk = false; console.log('    mismatch at len=' + len); break; }
  }
  eq('keccak256 vs @noble/hashes (200 random inputs)', allOk, true);
}

console.log('== sha256 / hmac (vs node webcrypto) ==');
{
  let allOk = true;
  for (let i = 0; i < 20; i++) {
    const len = Math.floor(Math.random() * 300);
    const buf = new Uint8Array(len);
    for (let j = 0; j < len; j++) buf[j] = Math.floor(Math.random() * 256);
    const mine = HLC.sha256(buf);
    const ref = new Uint8Array(await nodeCrypto.subtle.digest('SHA-256', buf));
    if (HLC.hex(mine) !== HLC.hex(ref)) { allOk = false; break; }
  }
  eq('sha256 (20 random inputs)', allOk, true);
}
{
  const key = new Uint8Array(33).map(() => 7), msg = new Uint8Array(50).map(() => 3);
  const k = await nodeCrypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const ref = new Uint8Array(await nodeCrypto.subtle.sign('HMAC', k, msg));
  eq('hmac-sha256 (33-byte key)', HLC.hex(HLC.hmacSha256(key, msg)), HLC.hex(ref));
}

console.log('== float_to_wire ==');
eq('1670.1', HLC.floatToWire(1670.1), '1670.1');
eq('100', HLC.floatToWire(100), '100');
eq('0.0147', HLC.floatToWire(0.0147), '0.0147');
eq('0.07', HLC.floatToWire(0.07), '0.07');
eq('123456', HLC.floatToWire(123456.0), '123456');
eq('-0 -> 0', HLC.floatToWire(-0.0), '0');
eq('1.5', HLC.floatToWire(1.5), '1.5');
eq('1234.000001', HLC.floatToWire(1234.000001), '1234.000001');

console.log('== roundPx / roundSz ==');
eq('px 1.2345678 perp szDec=2 -> 1.2346', HLC.floatToWire(HLC.roundPx(1.2345678, 2, false)), '1.2346');
eq('px 1234.56 perp szDec=2 -> 1234.6', HLC.floatToWire(HLC.roundPx(1234.56, 2, false)), '1234.6');
eq('px 0.0012345 perp szDec=2 -> 0.0012', HLC.floatToWire(HLC.roundPx(0.0012345, 2, false)), '0.0012');
eq('px 0.0012345 spot szDec=0 -> 0.0012345', HLC.floatToWire(HLC.roundPx(0.0012345, 0, true)), '0.0012345');
eq('px 1234567 -> int', HLC.floatToWire(HLC.roundPx(1234567.8, 2, false)), '1234568');
eq('sz 12.345 szDec=2 -> 12.34', HLC.floatToWire(HLC.roundSz(12.345, 2)), '12.34');

console.log('== official SDK vector: phantom agent connectionId ==');
{
  const wire = { a: 4, b: true, p: '1670.1', s: '0.0147', r: false, t: { limit: { tif: 'Ioc' } } };
  const action = { type: 'order', orders: [wire], grouping: 'na' };
  const h = HLC.actionHash(action, null, 1677777606040, null);
  eq('connectionId', '0x' + HLC.hex(h), '0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908');
}

console.log('== official SDK vector: sign_l1_action ==');
function v(name, action, opts, wantR, wantS, wantV) {
  const sig = HLC.signL1Action(KEY, action, opts.vault || null, opts.nonce, null, opts.mainnet);
  eq(name + ' r', sig.r, wantR);
  eq(name + ' s', sig.s, wantS);
  eq(name + ' v', sig.v, wantV);
}
{
  v('dummy mainnet', { type: 'dummy', num: 100000000000 }, { nonce: 0, mainnet: true },
    '0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298',
    '0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8', 27);
  v('dummy testnet', { type: 'dummy', num: 100000000000 }, { nonce: 0, mainnet: false },
    '0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510',
    '0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613', 28);

  const orderAction = {
    type: 'order',
    orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }],
    grouping: 'na'
  };
  v('order mainnet', orderAction, { nonce: 0, mainnet: true },
    '0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e',
    '0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e', 28);
  v('order testnet', orderAction, { nonce: 0, mainnet: false },
    '0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54',
    '0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5', 27);

  const cloidAction = {
    type: 'order',
    orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } }, c: '0x00000000000000000000000000000001' }],
    grouping: 'na'
  };
  v('order+cloid mainnet', cloidAction, { nonce: 0, mainnet: true },
    '0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3',
    '0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da', 27);
  v('order+cloid testnet', cloidAction, { nonce: 0, mainnet: false },
    '0xeba0664bed2676fc4e5a743bf89e5c7501aa6d870bdb9446e122c9466c5cd16d',
    '0x7f3e74825c9114bc59086f1eebea2928c190fdfbfde144827cb02b85bbe90988', 28);

  v('vault mainnet', { type: 'dummy', num: 100000000000 },
    { nonce: 0, mainnet: true, vault: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' },
    '0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239',
    '0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c', 28);
  v('vault testnet', { type: 'dummy', num: 100000000000 },
    { nonce: 0, mainnet: false, vault: '0x1719884eb866cb12b2287399b15f7db5e7d775ea' },
    '0xe281d2fb5c6e25ca01601f878e4d69c965bb598b88fac58e475dd1f5e56c362b',
    '0x7ddad27e9a238d045c035bc606349d075d5c5cd00a6cd1da23ab5c39d4ef0f60', 27);

  const tpslAction = {
    type: 'order',
    orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { trigger: { isMarket: true, triggerPx: '103', tpsl: 'sl' } } }],
    grouping: 'na'
  };
  v('tpsl mainnet', tpslAction, { nonce: 0, mainnet: true },
    '0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9',
    '0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405', 27);
  v('tpsl testnet', tpslAction, { nonce: 0, mainnet: false },
    '0x971c554d917c44e0e1b6cc45d8f9404f32172a9d3b3566262347d0302896a2e4',
    '0x206257b104788f80450f8e786c329daa589aa0b32ba96948201ae556d5637eac', 28);

  // NOTE: the SDK repo's test file asserts v==28 here, but that vector is stale — running the
  // current official SDK (eth_account 0.14.0) yields v==27, identical to this implementation.
  v('createSubAccount mainnet', { type: 'createSubAccount', name: 'example' }, { nonce: 0, mainnet: true },
    '0x51096fe3239421d16b671e192f574ae24ae14329099b6db28e479b86cdd6caa7',
    '0xb71f7d293af92d3772572afb8b102d167a7cef7473388286bc01f52a5c5b423', 27);
  v('createSubAccount testnet', { type: 'createSubAccount', name: 'example' }, { nonce: 0, mainnet: false },
    '0xa699e3ed5c2b89628c746d3298b5dc1cca604694c2c855da8bb8250ec8014a5b',
    '0x53f1b8153a301c72ecc655b1c315d64e1dcea3ee58921fd7507e35818fcc1584', 28);

  v('subAccountTransfer mainnet',
    { type: 'subAccountTransfer', subAccountUser: '0x1d9470d4b963f552e6f671a81619d395877bf409', isDeposit: true, usd: 10 },
    { nonce: 0, mainnet: true },
    '0x43592d7c6c7d816ece2e206f174be61249d651944932b13343f4d13f306ae602',
    '0x71a926cb5c9a7c01c3359ec4c4c34c16ff8107d610994d4de0e6430e5cc0f4c9', 28);
  v('subAccountTransfer testnet',
    { type: 'subAccountTransfer', subAccountUser: '0x1d9470d4b963f552e6f671a81619d395877bf409', isDeposit: true, usd: 10 },
    { nonce: 0, mainnet: false },
    '0xe26574013395ad55ee2f4e0575310f003c5bb3351b5425482e2969fa51543927',
    '0xefb08999196366871f919fd0e138b3a7f30ee33e678df7cfaf203e25f0a4278', 28);

  v('scheduleCancel mainnet', { type: 'scheduleCancel' }, { nonce: 0, mainnet: true },
    '0x6cdfb286702f5917e76cd9b3b8bf678fcc49aec194c02a73e6d4f16891195df9',
    '0x6557ac307fa05d25b8d61f21fb8a938e703b3d9bf575f6717ba21ec61261b2a0', 27);
  v('scheduleCancel testnet', { type: 'scheduleCancel' }, { nonce: 0, mainnet: false },
    '0xc75bb195c3f6a4e06b7d395acc20bbb224f6d23ccff7c6a26d327304e6efaeed',
    '0x342f8ede109a29f2c0723bd5efb9e9100e3bbb493f8fb5164ee3d385908233df', 28);
  v('scheduleCancel(time) mainnet', { type: 'scheduleCancel', time: 123456789 }, { nonce: 0, mainnet: true },
    '0x609cb20c737945d070716dcc696ba030e9976fcf5edad87afa7d877493109d55',
    '0x16c685d63b5c7a04512d73f183b3d7a00da5406ff1f8aad33f8ae2163bab758b', 28);
  v('scheduleCancel(time) testnet', { type: 'scheduleCancel', time: 123456789 }, { nonce: 0, mainnet: false },
    '0x4e4f2dbd4107c69783e251b7e1057d9f2b9d11cee213441ccfa2be63516dc5bc',
    '0x706c656b23428c8ba356d68db207e11139ede1670481a9e01ae2dfcdb0e1a678', 27);
}

console.log('== address derivation & ethers cross-check ==');
{
  const addr = HLC.addressOf(HLC.unhex(KEY));
  eq('addressOf == ethers.computeAddress', addr, computeAddress(KEY));
  // verify my EIP-712 signature with ethers: it must recover to the signer address
  const action = { type: 'order', orders: [{ a: 1, b: true, p: '100', s: '100', r: false, t: { limit: { tif: 'Gtc' } } }], grouping: 'na' };
  const nonce = 1677777606040;
  const connId = HLC.actionHash(action, null, nonce, null);
  const sig = HLC.signL1Action(KEY, action, null, nonce, null, true);
  const domain = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: '0x0000000000000000000000000000000000000000' };
  const types = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
  const value = { source: 'a', connectionId: '0x' + HLC.hex(connId) };
  const recovered = verifyTypedData(domain, types, value, sig.r + sig.s.slice(2) + sig.v.toString(16).padStart(2, '0'));
  eq('ethers.verifyTypedData recovers signer', recovered, addr);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
