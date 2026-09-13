/*!
 * HLCrypto — Pure-JS crypto for Hyperliquid order signing.
 * Port of the official hyperliquid-python-sdk signing scheme (hyperliquid/utils/signing.py):
 *   action_hash = keccak256( msgpack(action) + nonce(8B BE) + vaultTag + [expiresTag] )
 *   phantom agent = { source: "a"|"b", connectionId: action_hash }
 *   EIP-712: domain {name:"Exchange", version:"1", chainId:1337, verifyingContract:0x0}, type Agent(string source, bytes32 connectionId)
 *   ECDSA secp256k1 (RFC6979 deterministic k, v = 27|28, NO low-s normalization) — matches eth_account used by the official SDK.
 * Verified against the official SDK test vectors (tests/signing_test.py) — see test/crypto.test.mjs.
 * No dependencies. Works in browsers (BigInt) and Node.
 */
(function (root, factory) {
  const api = factory();
  root.HLCrypto = api;
  root.HLCryptoFactory = factory; // used by the bookmarklet boot to re-inject into the dashboard window
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ---------------- byte helpers ---------------- */
  const te = new TextEncoder();
  const utf8 = (s) => te.encode(s);
  function hex(b) { let s = ''; for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0'); return s; }
  function unhex(h) {
    h = String(h).replace(/^0x/i, '');
    if (h.length % 2) h = '0' + h;
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
    return out;
  }
  function cat() {
    let n = 0; for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
    const o = new Uint8Array(n); let p = 0;
    for (let i = 0; i < arguments.length; i++) { o.set(arguments[i], p); p += arguments[i].length; }
    return o;
  }
  function be(v, len) { // big-endian fixed-length bytes of a BigInt
    const o = new Uint8Array(len); let x = BigInt(v);
    for (let i = len - 1; i >= 0; i--) { o[i] = Number(x & 255n); x >>= 8n; }
    return o;
  }
  function bytesToBigInt(b) { let x = 0n; for (let i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]); return x; }
  // eth_utils to_hex(): minimal hex, no zero-padding (SDK parity)
  const hexMin = (v) => '0x' + BigInt(v).toString(16);

  /* ---------------- keccak256 (Keccak-f[1600], BigInt lanes) ---------------- */
  const RC = (() => { // official Iota constants via the spec LFSR (stepped 7x per round)
    const t = []; let R = 1n;
    for (let r = 0; r < 24; r++) {
      let v = 0n;
      for (let j = 0; j < 7; j++) {
        R = ((R << 1n) ^ ((R >> 7n) * 0x71n)) % 256n;
        if (R & 2n) v ^= 1n << ((1n << BigInt(j)) - 1n);
      }
      t.push(v);
    }
    return t;
  })();
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14]; // r[x + 5y]
  const M64 = (1n << 64n) - 1n;
  const rotl = (x, n) => n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64;
  function f1600(s) {
    const B = new Array(25), C = new Array(5), D = new Array(5);
    for (let round = 0; round < 24; round++) {
      for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) s[x + 5 * y] ^= D[x];
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++)
        B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++)
        s[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y]) & M64 & B[(x + 2) % 5 + 5 * y]);
      s[0] ^= RC[round];
    }
  }
  function keccak256(msg) {
    const rate = 136;
    const pad = new Uint8Array(rate - (msg.length % rate));
    pad[0] = 0x01; pad[pad.length - 1] |= 0x80;
    const buf = cat(msg, pad);
    const s = new Array(25).fill(0n);
    for (let off = 0; off < buf.length; off += rate) {
      for (let i = 0; i < 17; i++) { // 136/8 = 17 lanes
        let lane = 0n;
        for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(buf[off + i * 8 + j]);
        s[i] ^= lane;
      }
      f1600(s);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) { let x = s[i]; for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(x & 255n); x >>= 8n; } }
    return out;
  }

  /* ---------------- sha256 + hmac-sha256 (for RFC6979) ---------------- */
  const K256 = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  function sha256(msg) {
    const l = msg.length;
    const bitLenHi = Math.floor(l / 0x20000000), bitLenLo = (l << 3) >>> 0;
    const rem = l % 64;
    const padLen = rem < 56 ? 56 - rem : 120 - rem;
    const buf = new Uint8Array(l + padLen + 8);
    buf.set(msg); buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(buf.length - 8, bitLenHi); dv.setUint32(buf.length - 4, bitLenLo);
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let off = 0; off < buf.length; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
      h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    const out = new Uint8Array(32); const odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3);
    odv.setUint32(16, h4); odv.setUint32(20, h5); odv.setUint32(24, h6); odv.setUint32(28, h7);
    return out;
  }
  function hmacSha256(key, msg) {
    let k = key.length > 64 ? sha256(key) : key;
    const ki = new Uint8Array(64), ko = new Uint8Array(64);
    ki.set(k); ko.set(k);
    for (let i = 0; i < 64; i++) { ki[i] ^= 0x36; ko[i] ^= 0x5c; }
    return sha256(cat(ko, sha256(cat(ki, msg))));
  }

  /* ---------------- secp256k1 ---------------- */
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
  function mod(a, m) { const r = a % m; return r >= 0n ? r : r + m; }
  function inv(a, m) { // extended euclid
    let lm = 1n, hm = 0n, low = mod(a, m), high = m;
    while (low > 1n) {
      const q = high / low, nm = hm - lm * q, nw = high - low * q;
      hm = lm; lm = nm; high = low; low = nw;
    }
    return mod(lm, m);
  }
  const ptEq = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  function ptAdd(p, q) {
    if (!p) return q; if (!q) return p;
    if (p[0] === q[0]) {
      if (p[1] === q[1]) return ptDbl(p);
      return null; // p + (-p) = infinity
    }
    const l = mod((q[1] - p[1]) * inv(q[0] - p[0], P), P);
    const x = mod(l * l - p[0] - q[0], P);
    return [x, mod(l * (p[0] - x) - p[1], P)];
  }
  function ptDbl(p) {
    if (!p || p[1] === 0n) return null;
    const l = mod(3n * p[0] * p[0] * inv(2n * p[1], P), P);
    const x = mod(l * l - 2n * p[0], P);
    return [x, mod(l * (p[0] - x) - p[1], P)];
  }
  function ptMul(k, p) {
    let r = null, a = p;
    let kk = BigInt(k);
    while (kk > 0n) { if (kk & 1n) r = ptAdd(r, a); a = ptDbl(a); kk >>= 1n; }
    return r;
  }

  /* ---------------- ECDSA sign (RFC6979 deterministic, matches eth_account) ---------------- */
  function* kGen(h32, d) {
    const V = new Uint8Array(32).fill(1), K = new Uint8Array(32).fill(0);
    const x = be(d, 32);
    const hi = bytesToBigInt(h32);
    const b2o = be(hi >= N ? hi - N : hi, 32); // bits2octets
    K.set(hmacSha256(K, cat(V, [0x00], x, b2o)));
    V.set(hmacSha256(K, V));
    K.set(hmacSha256(K, cat(V, [0x01], x, b2o)));
    V.set(hmacSha256(K, V));
    for (;;) {
      V.set(hmacSha256(K, V));
      const k = bytesToBigInt(V); // bits2int (qlen == hlen == 256)
      if (k >= 1n && k < N) yield k;
      K.set(hmacSha256(K, cat(V, [0x00])));
      V.set(hmacSha256(K, V));
    }
  }
  function signSecp256k1(h32, d) {
    const z = bytesToBigInt(h32);
    for (const k of kGen(h32, d)) {
      const R = ptMul(k, [GX, GY]);
      if (!R || R[0] % N === 0n) continue;
      const r = R[0] % N;
      let s = mod(inv(k, N) * mod(z + r * BigInt(d), N), N);
      if (s === 0n) continue;
      let v = 27 + Number((R[1] & 1n) | (R[0] >= N ? 2n : 0n));
      // eth_account (used by the official SDK) normalizes to low-s, flipping v accordingly
      if (s > N / 2n) { s = N - s; v = v === 27 ? 28 : 27; }
      return { r, s, v };
    }
  }
  function toPriv(d) {
    if (typeof d === 'string') return bytesToBigInt(unhex(d));
    if (d && d.length !== undefined) return bytesToBigInt(d);
    return BigInt(d);
  }
  function pubKeyBytes(d) { const Q = ptMul(toPriv(d), [GX, GY]); return cat(be(Q[0], 32), be(Q[1], 32)); }
  function addressOf(d) { return '0x' + hex(keccak256(pubKeyBytes(d)).slice(12)); }

  /* ---------------- msgpack (subset matching python msgpack.packb) ---------------- */
  function msgpack(v) {
    const o = [];
    (function enc(v) {
      if (v === null || v === undefined) { o.push(0xc0); return; }
      const t = typeof v;
      if (t === 'boolean') { o.push(v ? 0xc3 : 0xc2); return; }
      if (t === 'number') {
        if (!Number.isInteger(v)) throw new Error('msgpack: non-integer number: ' + v);
        if (v >= 0) {
          if (v < 128) o.push(v);
          else if (v < 256) o.push(0xcc, v);
          else if (v < 65536) o.push(0xcd, v >> 8, v & 255);
          else if (v <= 0xffffffff) o.push(0xce, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
          else { const b = be(BigInt(v), 8); o.push(0xcf); for (const x of b) o.push(x); }
        } else throw new Error('msgpack: negative int unsupported: ' + v);
        return;
      }
      if (t === 'string') {
        const b = utf8(v);
        if (b.length <= 31) o.push(0xa0 | b.length);
        else if (b.length <= 255) { o.push(0xd9, b.length); }
        else if (b.length <= 65535) { o.push(0xda, b.length >> 8, b.length & 255); }
        else { o.push(0xdb); const bb = be(BigInt(b.length), 4); for (const x of bb) o.push(x); }
        for (const x of b) o.push(x);
        return;
      }
      if (Array.isArray(v)) {
        if (v.length <= 15) o.push(0x90 | v.length);
        else if (v.length <= 65535) o.push(0xdc, v.length >> 8, v.length & 255);
        else { o.push(0xdd); const bb = be(BigInt(v.length), 4); for (const x of bb) o.push(x); }
        for (const x of v) enc(x);
        return;
      }
      if (t === 'object') {
        const keys = Object.keys(v);
        if (keys.length <= 15) o.push(0x80 | keys.length);
        else if (keys.length <= 65535) o.push(0xde, keys.length >> 8, keys.length & 255);
        else { o.push(0xdf); const bb = be(BigInt(keys.length), 4); for (const x of bb) o.push(x); }
        for (const k of keys) { enc(k, o); enc(v[k], o); }
        return;
      }
      throw new Error('msgpack: unsupported type: ' + t);
    })(v);
    return new Uint8Array(o);
  }

  /* ---------------- Hyperliquid L1 action signing ---------------- */
  function actionHash(action, vaultAddress, nonce, expiresAfter) {
    const parts = [msgpack(action), be(BigInt(nonce), 8)];
    if (vaultAddress == null) parts.push(new Uint8Array([0x00]));
    else { parts.push(new Uint8Array([0x01]), unhex(vaultAddress)); }
    if (expiresAfter != null) parts.push(new Uint8Array([0x00]), be(BigInt(expiresAfter), 8));
    return keccak256(cat.apply(null, parts));
  }
  const DOMAIN_SEP = keccak256(cat(
    keccak256(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
    keccak256(utf8('Exchange')),
    keccak256(utf8('1')),
    be(1337n, 32),
    new Uint8Array(32) // verifyingContract 0x0000...0000
  ));
  const AGENT_TYPEHASH = keccak256(utf8('Agent(string source,bytes32 connectionId)'));
  function l1Digest(connectionId, isMainnet) {
    return keccak256(cat(
      new Uint8Array([0x19, 0x01]),
      DOMAIN_SEP,
      keccak256(cat(AGENT_TYPEHASH, keccak256(utf8(isMainnet ? 'a' : 'b')), connectionId))
    ));
  }
  /**
   * Sign an L1 action (e.g. an order) exactly like the official python SDK's sign_l1_action().
   * privKey: hex string (with or without 0x) or 32-byte Uint8Array.
   * Returns {r, s, v} hex strings ready for POST /exchange.
   */
  function signL1Action(privKey, action, vaultAddress, nonce, expiresAfter, isMainnet) {
    const d = toPriv(privKey);
    if (d <= 0n || d >= N) throw new Error('invalid private key');
    const digest = l1Digest(actionHash(action, vaultAddress, nonce, expiresAfter), isMainnet);
    const sig = signSecp256k1(digest, d);
    return { r: hexMin(sig.r), s: hexMin(sig.s), v: sig.v };
  }

  /* ---------------- number wire-formatting (SDK parity) ---------------- */
  /** python sdk float_to_wire: 8-decimal formatting, trailing zeros stripped. "100" not "100.0" */
  function floatToWire(x) {
    if (!isFinite(x)) throw new Error('floatToWire: not finite');
    const s = x.toFixed(8);
    if (Math.abs(parseFloat(s) - x) >= 1e-12) throw new Error('floatToWire rounding: ' + x);
    if (parseFloat(s) === 0) return '0';
    let t = s;
    const dot = t.indexOf('.');
    if (dot >= 0) t = t.replace(/0+$/, '').replace(/\.$/, '');
    return t || '0';
  }
  /** python sdk _slippage_price/rounding.py: 5 significant figures, <= (6|8 - szDecimals) decimals; ints >100k allowed */
  function roundPx(px, szDecimals, isSpot) {
    const maxDec = (isSpot ? 8 : 6) - szDecimals;
    if (px > 100000) return Math.round(px);
    const sig = parseFloat(px.toPrecision(5));
    if (maxDec <= 0) return Math.round(sig);
    const f = Math.pow(10, maxDec);
    return Math.round(sig * f) / f;
  }
  /** floor size to szDecimals (never over-sizes) */
  function roundSz(sz, szDecimals) {
    const f = Math.pow(10, szDecimals);
    return Math.floor(sz * f + 1e-12) / f;
  }

  return {
    utf8, hex, unhex, cat, be, bytesToBigInt,
    keccak256, sha256, hmacSha256,
    msgpack, actionHash, signL1Action, l1Digest,
    signSecp256k1, pubKeyBytes, addressOf,
    floatToWire, roundPx, roundSz,
    N
  };
});
