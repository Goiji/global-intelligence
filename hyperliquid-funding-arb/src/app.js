/* ============================================================================
 * HL Funding Arb Bot — Hyperliquid Funding-Rate Arbitrage bookmarklet app.
 *
 * กลยุทธ์: ซื้อสปอต + ชอร์ตเพอร์ป (ขนาดเท่ากัน) ใน Hyperliquid เพื่อเก็บ funding
 * (funding เป็นบวก → ขาลองจ่ายให้ขาชอร์ต) แบบเดลต้าเข้าใกล้ศูนย์
 *  + ตารางเปรียบเทียบ funding กับ Binance / Bybit (cross-exchange spread)
 *
 * โหมด:
 *  - จำลอง (paper/dry-run) ค่าเริ่มต้น — ไม่ต้องใส่ key, ปลอดภัย ลองเล่นได้
 *  - ของจริง (live) — ต้องสร้าง "API wallet" จากหน้าเว็บ Hyperliquid แล้วนำ key มาใส่
 *    (API wallet สั่งเทรดได้แต่ถอนเงินไม่ได้)
 *
 * สั่งซื้อขายจริง = ลู่คำสั่งแบบ IOC limit ตาม spec ทางการของ Hyperliquid
 * (เซ็นด้วย crypto-core.js ซึ่งผ่านการตรวจสอบเทียบ vector ทางการของ SDK แล้ว)
 * ==========================================================================*/
function HLFARB_APP() {
  'use strict';
  if (window.__HLFARB_OK) return;
  window.__HLFARB_OK = true;
  const C = window.HLCrypto;
  const IS_POPUP = window.__HLFARB_MODE === 'window';

  /* ================= helpers ================= */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n, d) => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d });
  const fmtUsd = (n, d) => (n == null || isNaN(n)) ? '—' : (n < 0 ? '-' : '') + '$' + fmt(Math.abs(n), d);
  const fmtPct = (n, d) => (n == null || isNaN(n)) ? '—' : (n > 0 ? '+' : '') + fmt(n, d == null ? 2 : d) + '%';
  const fmtPx = (n) => (n == null || isNaN(n)) ? '—' : (n >= 1000 ? fmt(n, 1) : n >= 1 ? fmt(n, Math.min(4, 3)) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));
  const fmtQty = (n) => (n == null) ? '—' : (Math.abs(n) >= 1000 ? fmt(n, 1) : String(+n.toFixed(6)));
  const shortAddr = (a) => a ? a.slice(0, 6) + '…' + a.slice(-4) : '';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const nowH = () => (Date.now() / 3600000);

  /* ================= state ================= */
  const LS_KEY = 'hlfarb.v1';
  const DEF_CFG = {
    net: 'mainnet',            // mainnet | testnet
    dryRun: true,              // โหมดจำลอง (paper trading)
    key: '', rememberKey: false,
    notional: 100,             // USD ต่อขา
    lev: 3,                    // ลีเวอเรจขาเพอร์ป
    slip: 0.3,                 // สลิปเปจ %
    takerFee: 0.045,           // ค่าธรรมเนียม taker % ต่อขา
    refreshSec: 30,
    auto: false,               // โหมดอัตโนมัติ
    autoOpenApr: 15, autoCloseApr: 0.5, maxPos: 3, minHoldH: 6,
    liqWarn: 15,               // แจ้งเตือนเมื่อราคาห่าง liq น้อยกว่า % นี้
    showBn: true, showBy: true,
    scanMinApr: 0, scanHedgeOnly: false, search: ''
  };
  const ST = {
    cfg: Object.assign({}, DEF_CFG),
    records: [], lastClose: {},      // lastClose[coin] = timestamp ที่ปิดล่าสุด (cooldown)
    perps: [], spots: [], hedgeable: [],
    bn: null, by: null,              // binance/bybit funding maps
    addr: null, keyBytes: null,
    acct: null, spotState: null,
    fundingHist: [], fundingAt: 0,
    errors: {},
    log: [], toasts: [],
    busy: false, nextTickAt: 0, lastOk: 0, activeTab: 'scan',
    netWarnAt: 0
  };
  const EP = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' };
  const base = () => EP[ST.cfg.net] || EP.mainnet;
  const isMain = () => ST.cfg.net === 'mainnet';

  function persist() {
    try {
      const data = {
        cfg: Object.assign({}, ST.cfg, { key: ST.cfg.rememberKey ? ST.cfg.key : '' }),
        records: ST.records.slice(-80), // เก็บประวัติที่ปิดแล้วด้วย (ทุกอย่างล่าสุด 80 รายการ)
        lastClose: ST.lastClose
      };
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) { /* localStorage อาจใช้ไม่ได้ในบางบริบท — ทำงานต่อแบบในหน่วยความจำ */ }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d && d.cfg) Object.assign(ST.cfg, d.cfg);
      if (d && Array.isArray(d.records)) ST.records = d.records;
      if (d && d.lastClose) ST.lastClose = d.lastClose;
    } catch (e) { }
  }

  function logLine(msg, kind) {
    const t = new Date().toLocaleTimeString('th-TH', { hour12: false });
    ST.log.push({ t, msg, kind: kind || 'info' });
    if (ST.log.length > 300) ST.log.shift();
    renderLog();
  }
  function toast(msg, kind, ms) {
    ST.toasts.push({ id: uid(), msg, kind: kind || 'info' });
    renderToasts();
    setTimeout(() => { ST.toasts = ST.toasts.filter(t => t.msg !== msg || t.kind !== kind); renderToasts(); }, ms || 5200);
  }

  /* ================= API ================= */
  async function postJson(url, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 15000);
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      let j = null;
      try { j = await r.json(); } catch (e) { }
      if (!r.ok) throw new Error((j && (j.msg || j.error)) || 'HTTP ' + r.status);
      return j;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('หมดเวลาเชื่อมต่อ (timeout)');
      if (e instanceof TypeError) {
        const err = new Error('เชื่อมต่อไม่ได้ — อาจถูก CORS/CSP ของหน้าเว็บนี้บล็อก ลองเปิดหน้า example.com แล้วคลิกบุ๊คมาร์คใหม่');
        err.isNet = true; throw err;
      }
      throw e;
    } finally { clearTimeout(timer); }
  }
  const info = (body) => postJson(base() + '/info', body);

  let lastNonce = 0;
  async function exchange(action) {
    if (!ST.keyBytes) throw new Error('ยังไม่ได้เชื่อมต่อ API wallet (ดูแท็บตั้งค่า)');
    const nonce = Math.max(Date.now(), lastNonce + 1);
    lastNonce = nonce;
    const sig = C.signL1Action(ST.keyBytes, action, null, nonce, null, isMain());
    return postJson(base() + '/exchange', { action, nonce, signature: sig, vaultAddress: null, expiresAfter: null });
  }

  /* ================= market data ================= */
  async function loadPerps() {
    const j = await info({ type: 'metaAndAssetCtxs' });
    const meta = j[0], ctxs = j[1];
    ST.perps = meta.universe.map((u, i) => {
      const c = ctxs[i] || {};
      const f = parseFloat(c.funding) || 0;
      return {
        name: u.name, idx: i, szd: u.szDecimals, maxLev: u.maxLeverage || 3, onlyIso: !!u.onlyIsolated,
        funding: f, mark: parseFloat(c.markPx), mid: c.midPx != null ? parseFloat(c.midPx) : null,
        oracle: parseFloat(c.oraclePx), oi: parseFloat(c.openInterest) || 0, vol: parseFloat(c.dayNtlVlm) || 0,
        apr: f * 24 * 365 * 100
      };
    });
    ST.errors.hl = null;
  }
  async function loadSpots() {
    const sm = await info({ type: 'spotMeta' });
    let cs = null;
    try { cs = await info({ type: 'spotMetaAndAssetCtxs' }); } catch (e) { cs = null; }
    const tokens = {}; (sm.tokens || []).forEach((t) => tokens[t.index] = t);
    ST.spots = (sm.universe || []).map((p, i) => {
      const bT = tokens[p.tokens[0]], qT = tokens[p.tokens[1]];
      const ctx = (cs && cs.assetCtxs && cs.assetCtxs[i]) || {};
      return {
        name: p.name, idx: p.index, assetId: 10000 + p.index,
        base: bT, quote: qT, baseSzd: bT ? bT.szDecimals : 2,
        mark: ctx.markPx != null ? parseFloat(ctx.markPx) : (ctx.midPx != null ? parseFloat(ctx.midPx) : null),
        vol: parseFloat(ctx.dayNtlVlm) || 0
      };
    });
  }
  function matchHedgeable() {
    ST.hedgeable = [];
    const byName = {}; ST.perps.forEach((p) => byName[p.name] = p);
    for (const s of ST.spots) {
      if (!s.base || !s.quote) continue;
      if (!/^(USDC|USDT|USDCe|USDt|USDE|USDT0)$/.test(s.quote.name)) continue;
      const p = byName[s.base.name];
      if (!p || !s.mark) continue;
      if (s.base.name === 'USDC') continue;
      ST.hedgeable.push({ coin: s.base.name, perp: p, spot: s });
    }
  }
  async function loadBinance() {
    if (!ST.cfg.showBn) { ST.bn = null; return; }
    try {
      const j = await fetch('https://fapi.binance.com/fapi/v1/premiumIndex').then((r) => r.json());
      if (!Array.isArray(j)) throw new Error('bad');
      const m = {};
      j.forEach((x) => { if (x && x.symbol) m[x.symbol] = { rate: parseFloat(x.lastFundingRate) || 0, mark: parseFloat(x.markPrice) || 0 }; });
      ST.bn = m; ST.errors.bn = null;
    } catch (e) { ST.bn = null; ST.errors.bn = 'Binance ไม่พร้อมใช้งาน (ถูกบล็อก/เน็ตล่วงหน้า)'; }
  }
  async function loadBybit() {
    if (!ST.cfg.showBy) { ST.by = null; return; }
    try {
      const j = await fetch('https://api.bybit.com/v5/market/tickers?category=linear').then((r) => r.json());
      const list = j && j.result && j.result.list;
      if (!Array.isArray(list)) throw new Error('bad');
      const m = {};
      list.forEach((x) => { if (x && x.symbol) m[x.symbol] = { rate: parseFloat(x.fundingRate) || 0, mark: parseFloat(x.lastPrice) || 0 }; });
      ST.by = m; ST.errors.by = null;
    } catch (e) { ST.by = null; ST.errors.by = 'Bybit ไม่พร้อมใช้งาน'; }
  }
  function venueApr(map, coin) {
    if (!map) return null;
    const cands = [coin + 'USDT', '1000' + coin + 'USDT', coin + '1000USDT'];
    if (coin[0] === 'k' && coin.length > 1) cands.push(coin.slice(1) + 'USDT', '1000' + coin.slice(1) + 'USDT', coin.slice(1) + '1000USDT');
    for (const s of cands) if (map[s] && map[s].rate) return map[s].rate * 3 * 365 * 100; // funding 8 ชม. → ต่อปี
    return null;
  }

  /* ================= account ================= */
  function setKey(hexKey) {
    const h = String(hexKey || '').trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('รูปแบบ key ไม่ถูกต้อง (ต้องเป็นเลขฐานสิบหก 64 ตัว)');
    const kb = C.unhex(h);
    const d = C.bytesToBigInt(kb);
    if (d <= 0n || d >= C.N) throw new Error('private key ไม่ถูกต้อง');
    ST.keyBytes = kb;
    ST.addr = C.addressOf(kb);
  }
  async function loadAccount() {
    if (!ST.addr) { ST.acct = null; ST.spotState = null; return; }
    ST.acct = await info({ type: 'clearinghouseState', user: ST.addr });
    ST.spotState = await info({ type: 'spotClearinghouseState', user: ST.addr });
    if (!ST.fundingAt || Date.now() - ST.fundingAt > 5 * 60 * 1000) {
      try {
        ST.fundingHist = await info({ type: 'userFunding', user: ST.addr, startTime: Date.now() - 30 * 86400 * 1000 });
        ST.fundingAt = Date.now();
      } catch (e) { ST.fundingHist = []; }
    }
  }
  function spotBal(tokenName, tokenId) {
    if (!ST.spotState || !ST.spotState.balances) return null;
    const b = ST.spotState.balances.find((x) => x.coin === tokenName || x.coin === tokenId || x.token === tokenName || x.token === tokenId);
    return b ? { total: parseFloat(b.total) || 0, hold: parseFloat(b.hold) || 0 } : null;
  }
  function usdcBal() {
    const b = spotBal('USDC', '@1') || spotBal('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    return b ? b.total : 0;
  }
  function perpPos(coin) {
    if (!ST.acct || !ST.acct.assetPositions) return null;
    for (const ap of ST.acct.assetPositions) if (ap.position && ap.position.coin === coin) return ap.position;
    return null;
  }
  function realizedFunding(coin, since) {
    let s = 0;
    for (const f of (ST.fundingHist || [])) {
      const d = f.delta || {};
      if (d.coin === coin && f.time >= since) s += parseFloat(d.usdc) || 0;
    }
    return s;
  }

  /* ================= books & orders ================= */
  async function book(coinName) {
    const b = await info({ type: 'l2Book', coin: coinName });
    const lv = (b && b.levels) || [[], []];
    return { bids: lv[0] || [], asks: lv[1] || [] };
  }
  // เดินหนังสือเพื่อหา vwap และปริมาณสูงสุดที่จ่ายได้ในกรอบราคา limitPx
  function walkBook(levels, isBuySide, limitPx) {
    let qty = 0, cost = 0;
    for (const l of levels) {
      const px = parseFloat(l.px), sz = parseFloat(l.sz);
      const ok = isBuySide ? px <= limitPx : px >= limitPx;
      if (!ok) break;
      qty += sz; cost += px * sz;
    }
    return { qty, vwap: qty > 0 ? cost / qty : null };
  }
  function orderWire(assetId, isBuy, px, sz, reduceOnly) {
    return { a: assetId, b: !!isBuy, p: C.floatToWire(px), s: C.floatToWire(sz), r: !!reduceOnly, t: { limit: { tif: 'Ioc' } } };
  }
  function parseOrderRes(res) {
    if (!res || res.status !== 'ok') {
      const msg = res && res.response && (res.response.data || res.response) || res;
      return { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg).slice(0, 200) };
    }
    const st = res.response && res.response.data && res.response.data.statuses && res.response.data.statuses[0];
    if (!st) return { ok: false, error: 'ไม่ได้รับสถานะคำสั่ง' };
    if (typeof st === 'string') return { ok: false, error: st === 'marginNormalized' ? 'มาร์จิ้นถูกปรับ (marginNormalized) — ลองใหม่' : 'สถานะ: ' + st };
    if (st.filled) return { ok: true, avgPx: parseFloat(st.filled.avgPx), totalSz: parseFloat(st.filled.totalSz), oid: st.filled.oid };
    if (st.error) return { ok: false, error: st.error };
    if (st.resting) return { ok: false, error: 'คำสั่งค้างอยู่ (ไม่ควรเกิดกับ IOC)' };
    return { ok: false, error: 'สถานะไม่ทราบ: ' + JSON.stringify(st).slice(0, 120) };
  }
  async function sendOrder(w) {
    const res = await exchange({ type: 'order', orders: [w], grouping: 'na' });
    return parseOrderRes(res);
  }
  async function setLeverage(perp, lev) {
    const action = { type: 'updateLeverage', asset: perp.idx, isCross: !perp.onlyIso, leverage: lev };
    const res = await exchange(action);
    return res && res.status === 'ok';
  }

  /* ================= hedge economics ================= */
  function econ(h) {
    const lev = Math.max(1, Math.min(ST.cfg.lev, h.perp.maxLev || 3));
    const apr = h.perp.apr;                        // APR หน้าปก (บน notional ของขาเพอร์ป)
    const capitalFactor = 1 + 1 / lev;             // เงินล็อกจริง = สปอตเต็ม + มาร์จิ้นเพอร์ป
    const netApr = apr / capitalFactor;
    const feeRoundTrip = ST.cfg.takerFee * 4;      // เปิด 2 ขา + ปิด 2 ขา
    const perHourPer100 = h.perp.funding * 100;    // $ ต่อชั่วโมง ต่อ notional $100
    const breakEvenH = h.perp.funding > 0 ? feeRoundTrip / 100 / h.perp.funding : Infinity;
    return { lev, apr, netApr, capitalFactor, feeRoundTrip, perHourPer100, breakEvenH };
  }

  /* ================= hedge engine ================= */
  function openRecords(coin) { return ST.records.filter((r) => (r.coin === coin) && (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net); }

  async function openHedge(coin, notionalUsd, opts) {
    opts = opts || {};
    const h = ST.hedgeable.find((x) => x.coin === coin);
    if (!h) throw new Error('ไม่พบคู่ spot-perp ของ ' + coin);
    if (openRecords(coin).length) { toast('มีโพซิชัน ' + coin + ' อยู่แล้ว', 'warn'); return null; }
    notionalUsd = Number(notionalUsd) || ST.cfg.notional;
    if (notionalUsd < 11) throw new Error('ขนาดต้องมากกว่า ~$11 (คำสั่งขั้นต่ำของ Hyperliquid)');
    const dry = ST.cfg.dryRun || !ST.keyBytes;
    if (!ST.cfg.dryRun && !ST.keyBytes) throw new Error('โหมดของจริงต้องใส่ API wallet key ก่อน (แท็บตั้งค่า)');
    const e = econ(h);

    // หนังสือราคาล่าสุด
    const [sb, pb] = await Promise.all([book(h.spot.name), book(h.perp.name)]);
    if (!sb.asks.length || !pb.bids.length) throw new Error('หนังสือราคา ' + coin + ' ว่าง/ไม่พร้อมใช้งาน');
    const slip = ST.cfg.slip / 100;
    const spotLimit = sb.asks[0].px != null ? parseFloat(sb.asks[0].px) * (1 + slip) : null;
    const perpLimit = parseFloat(pb.bids[0].px) * (1 - slip);
    const dSpot = walkBook(sb.asks, true, spotLimit);
    const dPerp = walkBook(pb.bids, false, perpLimit);
    if (!dSpot.qty || !dPerp.qty) throw new Error('สภาพคล่องในกรอบสลิปเปจไม่พอ');
    const szd = Math.min(h.spot.baseSzd, h.perp.szd);
    let qty = Math.min(notionalUsd / dSpot.vwap, notionalUsd / dPerp.vwap, dSpot.qty, dPerp.qty);
    qty = C.roundSz(qty, szd);
    if (qty <= 0 || qty * dSpot.vwap < 10 || qty * dPerp.vwap < 10) throw new Error('ขนาดเล็กเกินไปหลังปัดตามเวลาการซื้อขาย (ลองเพิ่ม notional)');

    const spotPx = C.roundPx(spotLimit, h.spot.baseSzd, true);
    const perpPx = C.roundPx(perpLimit, h.perp.szd, false);
    const rec = {
      id: uid(), net: ST.cfg.net, coin, mode: dry ? 'dry' : 'live', status: 'open', openTime: Date.now(),
      qty, szd, lev: e.lev,
      entrySpot: dry ? dSpot.vwap : null, entryPerp: dry ? dPerp.vwap : null,
      estSpreadCost: (dSpot.vwap - dPerp.vwap) / ((dSpot.vwap + dPerp.vwap) / 2),
      feesPaid: 0, fundingEst: 0, lastFundTick: nowH(),
      spotPair: h.spot.name, spotAssetId: h.spot.assetId, perpIdx: h.perp.idx,
      auto: !!opts.auto
    };
    const feeRate = ST.cfg.takerFee / 100;
    rec.feesPaid = qty * dSpot.vwap * feeRate + qty * dPerp.vwap * feeRate;

    logLine((dry ? '[จำลอง] ' : '[สั่งจริง] ') + 'เปิดฮีดจ์ ' + coin + ' จำนวน ' + fmtQty(qty) + ' (~$' + fmt(qty * dSpot.vwap, 0) + '/ขา)' + (opts.auto ? ' (อัตโนมัติ)' : ''));

    if (dry) {
      ST.records.push(rec); persist();
      toast('✅ [จำลอง] เปิดฮีดจ์ ' + coin + ' · ' + fmtQty(qty) + ' ' + coin, 'ok');
      renderAll(); return rec;
    }

    // ---- ของจริง: สปอตก่อน (ไม่มีมาร์จิ้น) แล้วค่อยเพอร์ป ----
    // ตรวจยอด USDC
    const need = qty * spotPx * 1.005;
    if (usdcBal() < need) throw new Error('USDC ไม่พอสำหรับขาสปอต (ต้องการ ~$' + fmt(need, 0) + ')');
    const spotRes = await sendOrder(orderWire(rec.spotAssetId, true, spotPx, qty, false));
    if (!spotRes.ok) throw new Error('สั่งซื้อสปอตไม่สำเร็จ: ' + spotRes.error);
    rec.entrySpot = spotRes.avgPx; rec.filledSpot = spotRes.totalSz;
    let perpOk = false, perpErr = '';
    for (let i = 0; i < 3 && !perpOk; i++) {
      if (i > 0) await sleep(500);
      try {
        if (i === 0 && !perpPos(coin)) { try { await setLeverage(h.perp, e.lev); } catch (er) { logLine('ตั้งลีเวอเรจ ' + e.lev + 'x ไม่สำเร็จ: ' + er.message, 'warn'); } }
        const pr = await sendOrder(orderWire(rec.perpIdx, false, perpPx, qty, false));
        if (pr.ok) { rec.entryPerp = pr.avgPx; rec.filledPerp = pr.totalSz; perpOk = true; }
        else { perpErr = pr.error; logLine('ลองสั่งขาเพอร์ปครั้งที่ ' + (i + 1) + ' ไม่สำเร็จ: ' + perpErr, 'warn'); }
      } catch (er) { perpErr = er.message; }
    }
    if (!perpOk) {
      rec.status = 'broken'; rec.missing = 'perp';
      ST.records.push(rec); persist();
      toast('⚠️ ซื้อสปอต ' + coin + ' สำเร็จ แต่ชอร์ตเพอร์ปไม่สำเร็จ: ' + perpErr + ' — ใช้ปุ่ม "ซ่อม" ที่ตารางโพซิชัน', 'err', 12000);
      renderAll(); return rec;
    }
    ST.records.push(rec); persist();
    toast('✅ เปิดฮีดจ์ ' + coin + ' สำเร็จ · ' + fmtQty(qty) + ' ' + coin + ' (สปอต @' + fmtPx(rec.entrySpot) + ' / เพอร์ป @' + fmtPx(rec.entryPerp) + ')', 'ok', 8000);
    renderAll(); return rec;
  }

  async function repairHedge(rec) {
    const h = ST.hedgeable.find((x) => x.coin === rec.coin);
    if (!h) throw new Error('ไม่พบคู่ ' + rec.coin);
    if (rec.missing === 'perp') {
      const pb = await book(h.perp.name);
      if (!pb.bids.length) throw new Error('หนังสือราคาว่าง');
      const px = C.roundPx(parseFloat(pb.bids[0].px) * (1 - ST.cfg.slip / 100), h.perp.szd, false);
      if (!perpPos(rec.coin)) { try { await setLeverage(h.perp, rec.lev); } catch (e) { } }
      const r = await sendOrder(orderWire(rec.perpIdx, false, px, rec.qty, false));
      if (!r.ok) throw new Error('วางขาเพอร์ปไม่สำเร็จ: ' + r.error);
      rec.entryPerp = rec.entryPerp || r.avgPx; rec.filledPerp = r.totalSz;
      rec.status = 'open'; delete rec.missing; persist();
      toast('✅ ซ่อมสำเร็จ — ชอร์ตเพอร์ป ' + rec.coin + ' แล้ว', 'ok');
    } else if (rec.missing === 'spot') {
      const sb = await book(h.spot.name);
      if (!sb.asks.length) throw new Error('หนังสือราคาว่าง');
      const px = C.roundPx(parseFloat(sb.asks[0].px) * (1 + ST.cfg.slip / 100), h.spot.baseSzd, true);
      const r = await sendOrder(orderWire(rec.spotAssetId, true, px, rec.qty, false));
      if (!r.ok) throw new Error('วางขาสปอตไม่สำเร็จ: ' + r.error);
      rec.entrySpot = rec.entrySpot || r.avgPx; rec.status = 'open'; delete rec.missing; persist();
      toast('✅ ซ่อมสำเร็จ — ซื้อสปอต ' + rec.coin + ' แล้ว', 'ok');
    }
    renderAll();
  }
  async function unwindLeg(rec, which) { // ขายขาที่ถืออยู่กลับ (ใช้กับ broken positions)
    const h = ST.hedgeable.find((x) => x.coin === rec.coin);
    if (which === 'spot') {
      const sb = await book(h.spot.name);
      const px = C.roundPx(parseFloat(sb.bids[0].px) * (1 - ST.cfg.slip / 100), h.spot.baseSzd, true);
      const r = await sendOrder(orderWire(rec.spotAssetId, false, px, rec.qty, false));
      if (!r.ok) throw new Error('ขายสปอตไม่สำเร็จ: ' + r.error);
    } else {
      const pb = await book(h.perp.name);
      const px = C.roundPx(parseFloat(pb.asks[0].px) * (1 + ST.cfg.slip / 100), h.perp.szd, false);
      const r = await sendOrder(orderWire(rec.perpIdx, true, px, rec.qty, true));
      if (!r.ok) throw new Error('ปิดเพอร์ปไม่สำเร็จ: ' + r.error);
    }
  }

  async function closeHedge(rec, opts) {
    opts = opts || {};
    const h = ST.hedgeable.find((x) => x.coin === rec.coin);
    const dry = rec.mode === 'dry';
    logLine((dry ? '[จำลอง] ' : '[สั่งจริง] ') + 'ปิดฮีดจ์ ' + rec.coin + (opts.auto ? ' (อัตโนมัติ)' : ''));
    if (dry || !h) {
      const p = h ? h.perp : null, s = h ? h.spot : null;
      const perpMark = p ? p.mark : rec.entryPerp, spotMark = s ? s.mark : rec.entrySpot;
      const pnl = posPnl(rec, spotMark, perpMark);
      rec.status = 'closed'; rec.close = { time: Date.now(), pnl };
      ST.lastClose[rec.coin] = Date.now();
      persist();
      toast((opts.auto ? '🤖 ' : '') + 'ปิดโพซิชัน ' + rec.coin + ' แล้ว (PnL รวมประมาณ ' + fmtUsd(pnl.total) + ')', 'ok');
      renderAll(); return;
    }
    // ของจริง: ขายสปอตตามยอดคงเหลือ + ปิดเพอร์ป reduce-only ตาม szi จริง
    let spotLeft = (spotBal(h.spot.base.name, h.spot.base.tokenId) || { total: rec.qty }).total;
    let perpLeft = Math.abs(parseFloat((perpPos(rec.coin) || { szi: String(rec.qty) }).szi));
    for (let i = 0; i < 3 && (spotLeft > 1e-9 || perpLeft > 1e-9); i++) {
      if (i > 0) await sleep(600);
      if (spotLeft > 1e-9) {
        const sb = await book(h.spot.name);
        if (sb.bids.length) {
          const q = C.roundSz(Math.min(spotLeft, walkBook(sb.bids, false, parseFloat(sb.bids[0].px) * (1 - ST.cfg.slip / 100)).qty), rec.szd);
          if (q > 0) {
            const px = C.roundPx(parseFloat(sb.bids[0].px) * (1 - ST.cfg.slip / 100), h.spot.baseSzd, true);
            const r = await sendOrder(orderWire(rec.spotAssetId, false, px, q, false));
            if (r.ok) spotLeft = Math.max(0, spotLeft - r.totalSz);
            else logLine('ขายสปอตไม่สำเร็จ: ' + r.error, 'warn');
          }
        }
      }
      if (perpLeft > 1e-9) {
        const pb = await book(h.perp.name);
        if (pb.asks.length) {
          const q = C.roundSz(Math.min(perpLeft, walkBook(pb.asks, true, parseFloat(pb.asks[0].px) * (1 + ST.cfg.slip / 100)).qty), rec.szd);
          if (q > 0) {
            const px = C.roundPx(parseFloat(pb.asks[0].px) * (1 + ST.cfg.slip / 100), h.perp.szd, false);
            const r = await sendOrder(orderWire(rec.perpIdx, true, px, q, true));
            if (r.ok) perpLeft = Math.max(0, perpLeft - r.totalSz);
            else logLine('ปิดเพอร์ปไม่สำเร็จ: ' + r.error, 'warn');
          }
        }
      }
    }
    if (spotLeft > 1e-9 || perpLeft > 1e-9) {
      rec.status = 'broken';
      rec.missing = spotLeft > 1e-9 ? 'spot-unwind' : 'perp-unwind';
      toast('⚠️ ปิด ' + rec.coin + ' ไม่ครบทั้งสองขา — มีของเหลือ ใช้ปุ่มซ่อม/ปิดใหม่อีกครั้ง', 'err', 10000);
      persist(); renderAll(); return;
    }
    const p = perpPos(rec.coin);
    rec.status = 'closed';
    rec.close = { time: Date.now(), pnl: posPnl(rec, h.spot.mark, h.perp.mark).total };
    ST.lastClose[rec.coin] = Date.now();
    persist();
    toast((opts.auto ? '🤖 ' : '') + 'ปิดโพซิชัน ' + rec.coin + ' สำเร็จ', 'ok');
    renderAll();
  }

  // PnL ของโพซิชันที่เปิดอยู่
  function posPnl(rec, spotMark, perpMark) {
    const es = rec.entrySpot || spotMark, ep = rec.entryPerp || perpMark;
    const spotPnl = (spotMark - es) * rec.qty;
    const perpPnl = (ep - perpMark) * rec.qty; // short
    let funding = 0, fundingSrc = 'ประมาณ';
    if (rec.mode === 'live' && ST.addr) { funding = realizedFunding(rec.coin, rec.openTime); fundingSrc = 'จาก exchange'; }
    else funding = rec.fundingEst || 0;
    const feeRate = ST.cfg.takerFee / 100;
    const exitFee = rec.qty * (spotMark || 0) * feeRate + rec.qty * (perpMark || 0) * feeRate;
    const total = spotPnl + perpPnl + funding - (rec.feesPaid || 0) - exitFee;
    return { spotPnl, perpPnl, funding, fundingSrc, exitFee, total };
  }
  function tickFunding() { // สะสม funding โดยประมาณสำหรับโพซิชันจำลอง
    for (const r of ST.records) {
      if (r.status !== 'open' || r.mode !== 'dry') continue;
      const h = ST.hedgeable.find((x) => x.coin === r.coin);
      if (!h || !h.perp.mark) continue;
      const t = nowH();
      const dh = Math.max(0, t - (r.lastFundTick || t));
      r.fundingEst = (r.fundingEst || 0) + h.perp.funding * h.perp.mark * r.qty * dh;
      r.lastFundTick = t;
    }
  }

  /* ================= auto rules ================= */
  function autoRules() {
    if (!ST.cfg.auto) return;
    const opens = ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net);
    // ปิดอัตโนมัติ
    for (const r of opens) {
      if (r.status === 'broken') continue;
      const h = ST.hedgeable.find((x) => x.coin === r.coin);
      if (!h) continue;
      const held = (Date.now() - r.openTime) / 3600000;
      if (held >= ST.cfg.minHoldH && h.perp.apr <= ST.cfg.autoCloseApr) {
        logLine('🤖 อัตโนมัติ: ปิด ' + r.coin + ' (APR ' + fmtPct(h.perp.apr, 1) + ' ≤ ' + ST.cfg.autoCloseApr + '%)', 'auto');
        closeHedge(r, { auto: true }).catch((e) => logLine('ปิดอัตโนมัติล้มเหลว: ' + e.message, 'err'));
      }
    }
    // เปิดอัตโนมัติ
    const openCount = ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net).length;
    if (openCount >= ST.cfg.maxPos) return;
    const cands = ST.hedgeable
      .filter((h) => h.perp.apr >= ST.cfg.autoOpenApr)
      .filter((h) => !openRecords(h.coin).length)
      .filter((h) => !ST.lastClose[h.coin] || Date.now() - ST.lastClose[h.coin] > ST.cfg.minHoldH * 3600000)
      .sort((a, b) => econ(b).netApr - econ(a).netApr);
    for (const h of cands) {
      if (ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net).length >= ST.cfg.maxPos) break;
      if (!ST.cfg.dryRun && !ST.keyBytes) { logLine('อัตโนมัติ: หยุด — โหมดของจริงแต่ยังไม่ใส่ key', 'warn'); return; }
      logLine('🤖 อัตโนมัติ: เปิด ' + h.coin + ' (APR ' + fmtPct(h.perp.apr, 1) + ')', 'auto');
      openHedge(h.coin, ST.cfg.notional, { auto: true }).catch((e) => logLine('เปิดอัตโนมัติล้มเหลว ' + h.coin + ': ' + e.message, 'err'));
    }
  }
  function liqCheck() {
    if (!ST.acct || !ST.acct.assetPositions) return;
    for (const ap of ST.acct.assetPositions) {
      const p = ap.position; if (!p || !p.liquidationPx || !p.szi) continue;
      const perp = ST.perps.find((x) => x.name === p.coin);
      if (!perp || !perp.mark) continue;
      const dist = Math.abs(perp.mark - parseFloat(p.liquidationPx)) / perp.mark * 100;
      const isOurs = ST.records.some((r) => r.coin === p.coin && (r.status === 'open' || r.status === 'broken'));
      if (isOurs && dist < ST.cfg.liqWarn) {
        const key = 'liq_' + p.coin;
        if (!ST[key] || Date.now() - ST[key] > 10 * 60 * 1000) {
          ST[key] = Date.now();
          toast('🚨 ขาเพอร์ปชอร์ต ' + p.coin + ' ห่างจากราคาชำระบาญ ' + fmt(dist, 1) + '% — พิจารณาปิด/ลดขนาด', 'err', 15000);
        }
      }
    }
  }

  /* ================= tick ================= */
  async function tick() {
    if (ST.busy) return;
    ST.busy = true;
    try {
      const jobs = [loadPerps(), loadSpots()];
      jobs.push(loadBinance(), loadBybit());
      if (ST.addr) jobs.push(loadAccount().catch((e) => { ST.errors.acct = e.message; }));
      await Promise.all(jobs);
      matchHedgeable();
      tickFunding();
      ST.lastOk = Date.now();
      ST.errors.hl = null;
      autoRules();
      liqCheck();
    } catch (e) {
      ST.errors.hl = e.message;
      logLine('รีเฟรชล้มเหลว: ' + e.message, 'err');
      if (e.isNet && Date.now() - ST.netWarnAt > 60000) { ST.netWarnAt = Date.now(); toast('⚠️ ' + e.message, 'err', 9000); }
    } finally {
      ST.busy = false;
      ST.nextTickAt = Date.now() + Math.max(10, ST.cfg.refreshSec) * 1000;
      renderAll();
    }
  }

  /* ================= UI ================= */
  let UI = {};
  const CSS = `
    :host, * { box-sizing: border-box; }
    .app { position:fixed; inset:0; display:flex; flex-direction:column; background:#0b0e14; color:#dbe2ef;
      font-family:'Segoe UI',system-ui,-apple-system,'Noto Sans Thai',sans-serif; font-size:13.5px; }
    .app.overlay { inset: 12px 12px auto 12px; height: calc(100vh - 24px); max-height:860px; border-radius:14px;
      border:1px solid #1e2635; box-shadow:0 18px 60px rgba(0,0,0,.6); overflow:hidden; }
    .app.overlay.min { height:44px; }
    .app.overlay.min main, .app.overlay.min nav, .app.overlay.min footer { display:none; }
    .top { display:flex; align-items:center; gap:10px; padding:9px 14px; background:#101623; border-bottom:1px solid #1c2433; cursor:default; }
    .brand { font-weight:700; color:#97fce4; letter-spacing:.3px; font-size:14px; }
    .brand small { color:#5b6b85; font-weight:400; }
    .badge { font-size:11px; padding:3px 9px; border-radius:20px; background:#1a2333; color:#8fa3c0; border:1px solid #243048; white-space:nowrap; }
    .badge.mainnet { color:#97fce4; border-color:#1d4b45; }
    .badge.testnet { color:#f7c948; border-color:#5c4a1d; }
    .badge.live { color:#ff6b6b; border-color:#5c2a2a; }
    .badge.ok { color:#77e0a0; }
    .spacer { flex:1; }
    .refresh { color:#5b6b85; font-size:12px; }
    button { background:#1a2333; color:#cfe0f5; border:1px solid #28374f; border-radius:8px; padding:6px 12px;
      font-size:12.5px; cursor:pointer; font-family:inherit; }
    button:hover { background:#223049; }
    button.primary { background:#0e4f43; border-color:#1d6f60; color:#97fce4; font-weight:600; }
    button.primary:hover { background:#116255; }
    button.danger { background:#4a1f1f; border-color:#6e2c2c; color:#ff9d9d; }
    button.small { padding:3px 9px; font-size:11.5px; border-radius:6px; }
    input, select { background:#0e1420; border:1px solid #26334a; color:#dbe2ef; border-radius:8px; padding:6px 9px;
      font-size:12.5px; font-family:inherit; }
    input:focus, select:focus { outline:none; border-color:#2f6f63; }
    input[type=checkbox] { accent-color:#2f9e8a; }
    nav.tabs { display:flex; gap:4px; padding:8px 12px 0; background:#101623; border-bottom:1px solid #1c2433; }
    .tab { background:transparent; border:none; border-bottom:2px solid transparent; border-radius:8px 8px 0 0;
      color:#7e91ad; padding:8px 14px; font-size:13px; }
    .tab.active { color:#97fce4; border-bottom-color:#2f9e8a; background:#0b0e14; }
    .tab b { background:#173229; color:#97fce4; border-radius:10px; padding:1px 7px; font-size:10.5px; margin-left:5px; }
    main { flex:1; overflow:auto; padding:14px 16px; }
    .toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px; color:#8fa3c0; font-size:12.5px; }
    table { width:100%; border-collapse:collapse; font-size:12.5px; }
    th { text-align:right; color:#7e91ad; font-weight:600; padding:7px 9px; border-bottom:1px solid #1e2635; white-space:nowrap; cursor:pointer; position:sticky; top:0; background:#0b0e14; z-index:2; }
    th:first-child, td:first-child { text-align:left; }
    td { text-align:right; padding:6px 9px; border-bottom:1px solid #151c29; white-space:nowrap; }
    tr:hover td { background:#0f1522; }
    td.num { font-family:ui-monospace,Consolas,monospace; font-variant-numeric:tabular-nums; }
    .pos { color:#3ddc97; } .neg { color:#ff6b6b; }
    .muted { color:#5b6b85; }
    .tag { display:inline-block; font-size:10.5px; padding:1px 7px; border-radius:10px; background:#16202f; color:#8fa3c0; border:1px solid #223048; }
    .tag.g { background:#11322a; color:#57e0b0; border-color:#1d4b45; }
    .tag.y { background:#3a3113; color:#f7d948; border-color:#574a1d; }
    .tag.r { background:#3a1616; color:#ff8f8f; border-color:#5c2626; }
    h3.sec { margin:18px 0 8px; font-size:13.5px; color:#c6d4e8; }
    .note { color:#7e91ad; font-size:11.5px; line-height:1.55; margin:8px 0; }
    .warnbox { background:#2b1f0e; border:1px solid #57431d; color:#f7d948; padding:10px 12px; border-radius:10px; margin:8px 0; font-size:12px; line-height:1.5; }
    .errbox { background:#2b0e0e; border:1px solid #571d1d; color:#ff9d9d; padding:10px 12px; border-radius:10px; margin:8px 0; font-size:12px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(330px,1fr)); gap:12px; }
    .card { background:#0e1420; border:1px solid #1c2637; border-radius:12px; padding:12px 14px; }
    .card h4 { margin:0 0 8px; font-size:12.5px; color:#97fce4; }
    .frow { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:7px 0; }
    .frow label { color:#8fa3c0; font-size:12px; }
    .frow .val input, .frow .val select { width:130px; text-align:right; }
    .frow .val input[type=text].wide { width:260px; text-align:left; }
    .footer-log { display:flex; align-items:center; gap:10px; padding:6px 14px; background:#0d1219; border-top:1px solid #1c2433; color:#5b6b85; font-size:11.5px; min-height:34px; }
    .footer-log .lines { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:ltr; }
    .log-panel { position:absolute; bottom:34px; left:0; right:0; max-height:220px; overflow:auto; background:#0a0e15;
      border-top:1px solid #1c2433; padding:8px 14px; font-family:ui-monospace,Consolas,monospace; font-size:11px; color:#8fa3c0; display:none; }
    .log-panel.open { display:block; }
    .log-panel .err { color:#ff8f8f; } .log-panel .warn { color:#f7d948; } .log-panel .ok { color:#57e0b0; } .log-panel .auto { color:#7dc4ff; }
    .toasts { position:fixed; top:14px; right:14px; display:flex; flex-direction:column; gap:8px; z-index:99999; max-width:420px; }
    .toast { padding:10px 14px; border-radius:10px; font-size:12.5px; line-height:1.45; color:#dbe2ef;
      background:#141b29; border:1px solid #28374f; box-shadow:0 8px 30px rgba(0,0,0,.5); animation:tin .18s ease-out; }
    .toast.ok { border-color:#1d6f60; } .toast.err { border-color:#6e2c2c; background:#241214; }
    .toast.warn { border-color:#574a1d; background:#241f0e; }
    @keyframes tin { from { transform:translateX(20px); opacity:0; } to { transform:none; opacity:1; } }
    .help p { line-height:1.7; color:#a9bad2; font-size:12.8px; }
    .help h4 { color:#97fce4; margin:16px 0 6px; }
    .help code { background:#141b29; padding:1px 6px; border-radius:6px; font-size:11.5px; }
    .help li { line-height:1.65; color:#a9bad2; font-size:12.8px; margin-bottom:4px; }
    .empty { color:#5b6b85; text-align:center; padding:26px 0; font-size:12.5px; }
    .sticky-total td { background:#0f1624; font-weight:600; border-top:2px solid #223048; }
    @media (max-width:760px){ .app.overlay { inset:0; border-radius:0; } th,td{padding:5px 5px;} }
  `;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'hlfarb-host-' + (IS_POPUP ? 'w' : 'o');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    const app = document.createElement('div');
    app.className = 'app' + (IS_POPUP ? '' : ' overlay');
    app.innerHTML = `
      <header class="top">
        <div class="brand">⚡ HL Funding Arb <small>บอทเก็บดอกเบี้ยทุน Hyperliquid</small></div>
        <span class="badge net" data-b-net></span>
        <span class="badge" data-b-mode></span>
        <span class="badge" data-b-acct></span>
        <div class="spacer"></div>
        <span class="refresh" data-refresh></span>
        <button class="small" data-act="refresh" title="รีเฟรชตอนนี้">รีเฟรช</button>
        ${IS_POPUP ? '' : '<button class="small" data-act="min" title="ย่อ">—</button><button class="small" data-act="close" title="ปิด">✕</button>'}
      </header>
      <nav class="tabs">
        <button class="tab active" data-tab="scan">📊 สแกน Funding</button>
        <button class="tab" data-tab="hedge">⚖️ ฮีดจ์ Spot–Perp <b data-badge-hedge></b></button>
        <button class="tab" data-tab="settings">⚙️ ตั้งค่า</button>
        <button class="tab" data-tab="help">📖 คู่มือ & ความเสี่ยง</button>
      </nav>
      <main></main>
      <div class="log-panel" data-logpanel></div>
      <footer class="footer-log">
        <div class="lines" data-logline></div>
        <button class="small" data-act="log">บันทึก ▾</button>
      </footer>`;
    const style = document.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    const toasts = document.createElement('div');
    toasts.className = 'toasts';
    root.appendChild(toasts);
    root.appendChild(app);
    (document.body || document.documentElement).appendChild(host);
    UI = { host, root, app, main: $('main', app), toasts, logPanel: $('[data-logpanel]', app), logLine: $('[data-logline]', app) };

    // drag (overlay)
    if (!IS_POPUP) {
      const hdr = $('.top', app);
      let sx = 0, sy = 0, sl = 0, st = 0, drag = false;
      hdr.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        drag = true; sx = e.clientX; sy = e.clientY;
        const r = app.getBoundingClientRect(); sl = r.left; st = r.top;
        hdr.setPointerCapture(e.pointerId);
      });
      hdr.addEventListener('pointermove', (e) => {
        if (!drag) return;
        app.style.inset = 'auto';
        app.style.left = Math.max(0, sl + e.clientX - sx) + 'px';
        app.style.top = Math.max(0, st + e.clientY - sy) + 'px';
        app.style.right = '12px';
        app.style.height = Math.min(window.innerHeight - 24, 860) + 'px';
      });
      hdr.addEventListener('pointerup', () => { drag = false; });
    }

    // events
    $$('.tab', app).forEach((b) => b.addEventListener('click', () => { ST.activeTab = b.dataset.tab; renderTabs(); renderAll(); }));
    app.addEventListener('click', onAction);
    UI.main.addEventListener('change', onCfgChange);
    UI.main.addEventListener('input', (e) => {
      const el = e.target;
      if (el.dataset.kind === 'search') { ST.cfg.search = el.value.toLowerCase(); renderScan(); }
    });
    return host;
  }

  function onAction(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (btn.closest('.tabs') || btn.closest('nav')) return;
    try {
      if (act === 'refresh') { tick(); }
      else if (act === 'min') { UI.app.classList.toggle('min'); }
      else if (act === 'close') { shutdown(); }
      else if (act === 'log') { UI.logPanel.classList.toggle('open'); renderLog(); }
      else if (act === 'open') { const c = btn.dataset.coin; guard(async () => { await openHedge(c, Number(btn.dataset.notional) || ST.cfg.notional); }); }
      else if (act === 'close-pos') { const id = btn.dataset.id; const rec = ST.records.find((r) => r.id === id); if (rec) guard(() => closeHedge(rec)); }
      else if (act === 'close-all') { guard(async () => { const os = ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net); for (const r of os) { await closeHedge(r).catch((er) => logLine('ปิด ' + r.coin + ' ล้มเหลว: ' + er.message, 'err')); await sleep(400); } }); }
      else if (act === 'repair') { const id = btn.dataset.id; const rec = ST.records.find((r) => r.id === id); if (rec) guard(() => repairHedge(rec)); }
      else if (act === 'unwind-spot') { const id = btn.dataset.id; const rec = ST.records.find((r) => r.id === id); if (rec) guard(() => unwindLeg(rec, 'spot')); }
      else if (act === 'unwind-perp') { const id = btn.dataset.id; const rec = ST.records.find((r) => r.id === id); if (rec) guard(() => unwindLeg(rec, 'perp')); }
      else if (act === 'rm-closed') { ST.records = ST.records.filter((r) => r.status === 'open' || r.status === 'broken'); persist(); renderAll(); }
      else if (act === 'setkey') { applyKeyFromInput(); }
      else if (act === 'clearkey') { ST.cfg.key = ''; ST.keyBytes = null; ST.addr = null; ST.acct = null; ST.spotState = null; ST.fundingHist = []; persist(); logLine('ลบ API key และตัดการเชื่อมต่อแล้ว', 'ok'); renderAll(); }
      else if (act === 'reset') { if (confirm('ลบค่าตั้งค่าและประวัติโพซิชันจำลองทั้งหมด?')) { localStorage.removeItem(LS_KEY); location.reload(); } }
      else if (act === 'sort') { const k = btn.dataset.k; if (ST.sortK === k) ST.sortD = -(ST.sortD || -1); else { ST.sortK = k; ST.sortD = -1; } renderScan(); }
      else if (act === 'goto-hedge') { ST.activeTab = 'hedge'; renderTabs(); renderAll(); }
    } catch (er) { toast('เกิดข้อผิดพลาด: ' + er.message, 'err'); }
  }
  function guard(fn) {
    Promise.resolve().then(fn).catch((e) => { toast('❌ ' + e.message, 'err', 9000); logLine('ผิดพลาด: ' + e.message, 'err'); renderAll(); });
  }
  function onCfgChange(e) {
    const el = e.target, k = el.dataset.cfg;
    if (!k || !(k in DEF_CFG)) return;
    if (k === 'key') return; // key ใช้เฉพาะปุ่ม "เชื่อมต่อ" เท่านั้น (ผ่านการตรวจสอบ)
    let v;
    if (el.type === 'checkbox') v = el.checked;
    else if (el.type === 'number') v = parseFloat(el.value);
    else v = el.value;
    if (el.type === 'number' && isNaN(v)) return;
    ST.cfg[k] = v;
    if (k === 'net') { logLine('สลับเครือข่ายเป็น ' + v, 'info'); ST.fundingAt = 0; }
    if (k === 'dryRun' && !v && !ST.keyBytes) toast('โหมดของจริง: ต้องใส่ API wallet key ที่แท็บตั้งค่าก่อนถึงจะสั่งได้', 'warn', 7000);
    if (k === 'auto' && v) toast('🤖 เปิดโหมดอัตโนมัติ — บอทจะเปิด/ปิดฮีดจ์ตามเกณฑ์ที่ตั้ง' + (ST.cfg.dryRun ? ' (แบบจำลอง)' : ' (ของจริง!)'), 'warn', 8000);
    persist();
    renderAll(); tick();
  }
  function applyKeyFromInput() {
    const inp = UI.main.querySelector('[data-cfg=key]');
    if (!inp || !inp.value.trim()) { toast('วาง API wallet key ก่อน (ได้จากหน้าเว็บ Hyperliquid → Settings → API wallets)', 'warn'); return; }
    try {
      setKey(inp.value);
      ST.cfg.key = ST.cfg.rememberKey ? inp.value.trim() : '';
      ST.fundingAt = 0;
      persist();
      logLine('เชื่อมต่อ API wallet สำเร็จ: ' + ST.addr, 'ok');
      toast('✅ เชื่อมต่อ API wallet แล้ว — ที่อยู่ ' + shortAddr(ST.addr), 'ok');
      renderAll(); tick();
    } catch (e) { toast('❌ ' + e.message, 'err', 8000); }
  }

  function renderTabs() {
    $$('.tab', UI.app).forEach((b) => b.classList.toggle('active', b.dataset.tab === ST.activeTab));
  }
  function renderHeader() {
    const netB = $('[data-b-net]', UI.app), modeB = $('[data-b-mode]', UI.app), acctB = $('[data-b-acct]', UI.app);
    netB.textContent = ST.cfg.net === 'mainnet' ? 'MAINNET' : 'TESTNET';
    netB.className = 'badge ' + ST.cfg.net;
    modeB.textContent = ST.cfg.dryRun ? 'โหมดจำลอง (paper)' : 'ของจริง';
    modeB.className = 'badge ' + (ST.cfg.dryRun ? '' : 'live');
    if (ST.addr) {
      const av = ST.acct && ST.acct.marginSummary ? ST.acct.marginSummary.accountValue : null;
      const wd = ST.acct ? ST.acct.withdrawable : null;
      acctB.textContent = shortAddr(ST.addr) + (av != null ? ' · ~$' + fmt(av, 0) + ' (ถอนได้ $' + fmt(wd || 0, 0) + ')' : '');
      acctB.className = 'badge ok';
    } else { acctB.textContent = 'ยังไม่เชื่อมต่อ API wallet'; acctB.className = 'badge'; }
    const left = Math.max(0, Math.ceil((ST.nextTickAt - Date.now()) / 1000));
    $('[data-refresh]', UI.app).textContent = ST.busy ? 'กำลังโหลด…' : 'อัปเดตถัดไป ' + left + ' วิ · ' + (ST.lastOk ? 'ล่าสุด ' + new Date(ST.lastOk).toLocaleTimeString('th-TH', { hour12: false }) : '—');
  }
  function renderLog() {
    if (!UI.logLine) return;
    const last = ST.log.slice(-1)[0];
    UI.logLine.innerHTML = last ? esc(last.t) + ' · ' + esc(last.msg) : 'พร้อมใช้งาน';
    if (UI.logPanel && UI.logPanel.classList.contains('open')) {
      UI.logPanel.innerHTML = ST.log.slice(-150).map((l) =>
        '<div class="' + esc(l.kind) + '">' + esc(l.t) + ' ' + esc(l.msg) + '</div>').join('') || '<div class="muted">— ยังไม่มีบันทึก —</div>';
    }
  }
  function renderToasts() {
    if (!UI.toasts) return;
    UI.toasts.innerHTML = ST.toasts.map((t) => '<div class="toast ' + esc(t.kind) + '">' + esc(t.msg) + '</div>').join('');
  }

  /* ---------- scan tab ---------- */
  function renderScan() {
    const el = UI.main.querySelector('[data-panel=scan]');
    if (!el) return;
    const errs = [];
    if (ST.errors.hl) errs.push(ST.errors.hl);
    if (ST.errors.bn) errs.push(ST.errors.bn);
    if (ST.errors.by) errs.push(ST.errors.by);
    let rows = ST.perps.slice();
    const q = (ST.cfg.search || '').trim().toLowerCase();
    if (q) rows = rows.filter((p) => p.name.toLowerCase().includes(q));
    if (ST.cfg.scanMinApr > 0) rows = rows.filter((p) => Math.abs(p.apr) >= ST.cfg.scanMinApr);
    if (ST.cfg.scanHedgeOnly) {
      const hs = new Set(ST.hedgeable.map((h) => h.coin));
      rows = rows.filter((p) => hs.has(p.name));
    }
    const hedgeCoins = new Set(ST.hedgeable.map((h) => h.coin));
    const k = ST.sortK || 'apr', d = ST.sortD || -1;
    rows.sort((a, b) => ((a[k] != null ? a[k] : -1e18) - (b[k] != null ? b[k] : -1e18)) * d);
    const bnOn = !!ST.bn, byOn = !!ST.by;
    let html = `
      <div class="toolbar">
        <input type="text" data-kind="search" placeholder="🔍 ค้นหาเหรียญ เช่น HYPE" value="${esc(ST.cfg.search || '')}" style="width:180px">
        <label>|APR| ≥ <input type="number" data-cfg="scanMinApr" value="${+ST.cfg.scanMinApr || 0}" min="0" step="1" style="width:64px"> %</label>
        <label><input type="checkbox" data-cfg="scanHedgeOnly" ${ST.cfg.scanHedgeOnly ? 'checked' : ''}> เฉพาะคู่ที่ฮีดจ์ได้ใน HL</label>
        <span class="muted">funding HL จ่ายทุก 1 ชม. · APR = อัตรา×24×365</span>
      </div>`;
    if (errs.length) html += '<div class="warnbox">⚠️ ' + errs.map(esc).join(' · ') + '</div>';
    html += `<table><thead><tr>
      <th data-act="sort" data-k="name">เหรียญ</th>
      <th data-act="sort" data-k="mark">ราคา</th>
      <th data-act="sort" data-k="funding">Funding/ชม.</th>
      <th data-act="sort" data-k="apr">APR ปี (HL)</th>
      ${bnOn ? '<th data-act="sort" data-k="bnApr">APR Binance</th>' : ''}
      ${byOn ? '<th data-act="sort" data-k="byApr">APR Bybit</th>' : ''}
      <th>สเปรดดีสุด</th><th data-act="sort" data-k="vol">วอลุ่ม 24 ชม.</th><th>ฮีดจ์ใน HL</th></tr></thead><tbody>`;
    if (!rows.length) html += '<tr><td colspan="9"><div class="empty">ไม่มีข้อมูล — รอโหลดหรือปรับตัวกรอง</div></td></tr>';
    for (const p of rows) {
      const bnApr = venueApr(ST.bn, p.name), byApr = venueApr(ST.by, p.name);
      p.bnApr = bnApr; p.byApr = byApr;
      let best = null;
      if (bnApr != null) { const s = p.apr - bnApr; if (!best || Math.abs(s) > Math.abs(best.s)) best = { s, v: 'Binance' }; }
      if (byApr != null) { const s = p.apr - byApr; if (!best || Math.abs(s) > Math.abs(best.s)) best = { s, v: 'Bybit' }; }
      const canHedge = hedgeCoins.has(p.name);
      html += `<tr>
        <td><b>${esc(p.name)}</b></td>
        <td class="num">${fmtPx(p.mark)}</td>
        <td class="num ${p.funding >= 0 ? 'pos' : 'neg'}">${fmtPct(p.funding * 100, 4)}</td>
        <td class="num ${p.apr >= 0 ? 'pos' : 'neg'}"><b>${fmtPct(p.apr, 1)}</b></td>
        ${bnOn ? `<td class="num ${bnApr >= 0 ? 'pos' : 'neg'}">${bnApr == null ? '<span class=muted>—</span>' : fmtPct(bnApr, 1)}</td>` : ''}
        ${byOn ? `<td class="num ${byApr >= 0 ? 'pos' : 'neg'}">${byApr == null ? '<span class=muted>—</span>' : fmtPct(byApr, 1)}</td>` : ''}
        <td class="num ${best && best.s >= 0 ? 'pos' : 'neg'}" title="${best ? ('ชอร์ต ' + (best.s >= 0 ? 'HL' : best.v) + ' + ลอง ' + (best.s >= 0 ? best.v : 'HL')) : ''}">${best ? fmtPct(best.s, 1) : '<span class=muted>—</span>'}</td>
        <td class="num muted">$${fmt(p.vol / 1e6, 1)}M</td>
        <td>${canHedge ? (p.apr > 0 ? '<span class="tag g" data-act="goto-hedge" style="cursor:pointer">⚖️ ได้ · เก็บ funding</span>' : '<span class="tag y" title="funding ติดลบ: ชอร์ตเพอร์ปต้องจ่าย — ฮีดจ์ใน HL ไม่คุ้ม">⚖️ ได้ · จ่าย funding</span>') : '<span class="tag">—</span>'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    html += '<div class="note">💡 สเปรดดีสุด = APR(HL) − APR(คู่แข่ง) · ค่าบวก ⇒ ชอร์ตฝั่ง HL + ลองฝั่งคู่แข่งเก็บส่วนต่าง (ต้องมีบัญชีทั้งสองแลกเอง — บอทนี้สั่งได้เฉพาะใน Hyperliquid) · คู่ที่ "ได้ · เก็บ funding" คือมีทั้งสปอต+เพอร์ปใน HL เปิดฮีดจ์อัตโนมัติได้ในแท็บถัดไป</div>';
    el.innerHTML = html;
  }

  /* ---------- hedge tab ---------- */
  function renderHedge() {
    const el = UI.main.querySelector('[data-panel=hedge]');
    if (!el) return;
    let html = '';
    if (!ST.cfg.dryRun) html += '<div class="errbox">🔴 <b>โหมดของจริง</b> — คำสั่งซื้อขายจะถูกส่งจริงด้วย API wallet ของคุณ ตรวจสอบขนาด/เกณฑ์ให้ดี และเริ่มจากจำนวนเล็ก ๆ หรือทดลองบน Testnet ก่อน</div>';
    html += `
      <div class="toolbar">
        <label>ขนาดต่อขา <input type="number" data-cfg="notional" value="${+ST.cfg.notional || 100}" min="11" step="10" style="width:76px"> USD</label>
        <label>ลีเวอเรจเพอร์ป <input type="number" data-cfg="lev" value="${+ST.cfg.lev || 3}" min="1" max="10" style="width:56px"> x</label>
        <label>สลิปเปจ <input type="number" data-cfg="slip" value="${+ST.cfg.slip || 0.3}" min="0.05" max="3" step="0.05" style="width:60px"> %</label>
        <label>ค่าธรรมเนียม taker <input type="number" data-cfg="takerFee" value="${+ST.cfg.takerFee || 0.045}" min="0" max="0.5" step="0.005" style="width:64px"> %</label>
        <span class="muted">ค่าเริ่มต้นค่าธรรมเนียมตามระดับปกติของ HL (แก้ได้ตามระดับ VIP ของคุณ)</span>
      </div>
      <table><thead><tr><th>คู่ (สปอต+เพอร์ป)</th><th>ราคาสปอต / เพอร์ป</th><th>เบสิส%</th><th>Funding/ชม.</th><th>APR หน้าปก</th><th>APR สุทธิ*</th><th>ค่าธรรมเนียมรอบเดียว</th><th>คุ้มทุนใน</th><th></th></tr></thead><tbody>`;
    if (!ST.hedgeable.length) {
      html += `<tr><td colspan="9"><div class="empty">ยังไม่พบคู่ spot–perp ที่เข้ากันได้${ST.errors.hl ? ' (โหลดข้อมูลไม่สำเร็จ: ' + esc(ST.errors.hl) + ')' : ''} — บน Testnet อาจไม่มีคู่ให้ฮีดจ์</div></td></tr>`;
    }
    const sorted = ST.hedgeable.slice().sort((a, b) => econ(b).netApr - econ(a).netApr);
    for (const h of sorted) {
      const e = econ(h);
      const basis = (h.spot.mark - h.perp.mark) / h.perp.mark * 100;
      const opened = openRecords(h.coin).length > 0;
      html += `<tr>
        <td><b>${esc(h.coin)}</b> <span class="tag">${esc(h.spot.name)}</span></td>
        <td class="num">${fmtPx(h.spot.mark)} / ${fmtPx(h.perp.mark)}</td>
        <td class="num ${basis >= 0 ? 'neg' : 'pos'}">${fmtPct(basis, 2)}</td>
        <td class="num ${h.perp.funding >= 0 ? 'pos' : 'neg'}">${fmtPct(h.perp.funding * 100, 4)}</td>
        <td class="num ${e.apr >= 0 ? 'pos' : 'neg'}"><b>${fmtPct(e.apr, 1)}</b></td>
        <td class="num ${e.netApr >= 0 ? 'pos' : 'neg'}"><b>${fmtPct(e.netApr, 1)}</b></td>
        <td class="num">${fmt(e.feeRoundTrip, 3)}%</td>
        <td class="num">${e.breakEvenH === Infinity ? '—' : fmt(e.breakEvenH, 1) + ' ชม.'}</td>
        <td>${opened ? '<span class="tag g">เปิดอยู่</span>' : (e.apr > 0 ? `<button class="small primary" data-act="open" data-coin="${esc(h.coin)}">เปิดฮีดจ์ $${fmt(ST.cfg.notional, 0)}</button>` : '<span class="tag r">funding ติดลบ</span>')}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    html += '<div class="note">* APR สุทธิ = APR หารด้วยเงินล็อกจริง (1 + 1/ลีเวอเรจ) · "คุ้มทุนใน" = ชั่วโมงที่ funding สะสมจะเท่ากับค่าธรรมเนียมเข้า–ออก (ไม่รวมสเปรด/สลิปเปจ) · เบสิส% = ราคาสปอต−เพอร์ป (ติดลบ = เข้าฮีดจ์ได้ถูกกว่า)</div>';

    // positions
    const opens = ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net);
    const closed = ST.records.filter((r) => r.status === 'closed' && r.net === ST.cfg.net);
    html += '<h3 class="sec">📁 โพซิชันที่เปิดอยู่ (' + opens.length + ')</h3>';
    if (opens.length) {
      html += '<table><thead><tr><th>เหรียญ</th><th>โหมด</th><th>ขนาด</th><th>เข้า สปอต/เพอร์ป</th><th>ราคาตลาด</th><th>PnL ขาสปอต</th><th>PnL ขาเพอร์ป</th><th>Funding สะสม</th><th>$/ชม.</th><th>ห่าง liq</th><th>อายุ</th><th></th></tr></thead><tbody>';
      let tPnl = 0, tFund = 0;
      for (const r of opens) {
        const h = ST.hedgeable.find((x) => x.coin === r.coin);
        const spotMark = h ? h.spot.mark : r.entrySpot, perpMark = h ? h.perp.mark : r.entryPerp;
        const pnl = posPnl(r, spotMark, perpMark);
        tPnl += pnl.total; tFund += pnl.funding;
        const pos = perpPos(r.coin);
        const liq = pos && pos.liquidationPx && perpMark ? Math.abs(perpMark - parseFloat(pos.liquidationPx)) / perpMark * 100
          : (r.mode === 'dry' && r.lev ? Math.abs((1 / r.lev) * 95) : null);
        const perHour = h ? h.perp.funding * perpMark * r.qty : null;
        const age = (Date.now() - r.openTime) / 3600000;
        html += `<tr>
          <td><b>${esc(r.coin)}</b>${r.auto ? ' <span class="tag y">auto</span>' : ''}</td>
          <td>${r.mode === 'dry' ? '<span class="tag">จำลอง</span>' : '<span class="tag g">จริง</span>'}</td>
          <td class="num">${fmtQty(r.qty)}</td>
          <td class="num muted">${fmtPx(r.entrySpot || spotMark)} / ${fmtPx(r.entryPerp || perpMark)}</td>
          <td class="num">${fmtPx(spotMark)} / ${fmtPx(perpMark)}</td>
          <td class="num ${pnl.spotPnl >= 0 ? 'pos' : 'neg'}">${fmtUsd(pnl.spotPnl)}</td>
          <td class="num ${pnl.perpPnl >= 0 ? 'pos' : 'neg'}">${fmtUsd(pnl.perpPnl)}</td>
          <td class="num ${pnl.funding >= 0 ? 'pos' : 'neg'}" title="ที่มา: ${esc(pnl.fundingSrc)}">${fmtUsd(pnl.funding)}</td>
          <td class="num ${perHour >= 0 ? 'pos' : 'neg'}">${perHour == null ? '—' : fmtUsd(perHour)}</td>
          <td class="num ${liq != null && liq < ST.cfg.liqWarn ? 'neg' : ''}">${liq == null ? '—' : (r.mode === 'dry' ? '≈' : '') + fmt(liq, 0) + '%'}</td>
          <td class="num muted">${age < 48 ? fmt(age, 1) + ' ชม.' : fmt(age / 24, 1) + ' วัน'}</td>
          <td>${r.status === 'broken'
            ? `<button class="small primary" data-act="repair" data-id="${r.id}" title="วางขาที่ขาด">ซ่อม</button>${r.missing === 'perp' ? `<button class="small danger" data-act="unwind-spot" data-id="${r.id}" title="ขายสปอตคืนทั้งหมด">เลิก เข้าสปอต</button>` : `<button class="small danger" data-act="unwind-perp" data-id="${r.id}">เลิก เข้าเพอร์ป</button>`}`
            : `<button class="small danger" data-act="close-pos" data-id="${r.id}">ปิด</button>`}</td>
        </tr>`;
      }
      html += `<tr class="sticky-total"><td colspan="7">รวม (PnL สุทธิรวมค่าธรรมเนียม+สเปรด)</td><td class="num ${tFund >= 0 ? 'pos' : 'neg'}">${fmtUsd(tFund)}</td><td colspan="3"></td><td class="num ${tPnl >= 0 ? 'pos' : 'neg'}"><b>${fmtUsd(tPnl)}</b></td><td></td></tr>`;
      html += '</tbody></table>';
      html += `<div style="margin:8px 0"><button data-act="close-all" class="danger">🧹 ปิดทั้งหมด (${opens.length} โพซิชัน)</button></div>`;
    } else {
      html += '<div class="empty">ยังไม่มีโพซิชัน — กด "เปิดฮีดจ์" ที่ตารางด้านบน (เริ่มแบบจำลองก่อนก็ได้)</div>';
    }
    if (closed.length) {
      html += '<h3 class="sec">ปิดแล้ว (ล่าสุด 10) <button class="small" data-act="rm-closed">ล้างรายการ</button></h3><table><tbody>';
      for (const r of closed.slice(-10).reverse()) {
        html += `<tr><td>${esc(r.coin)}</td><td class="num muted">${new Date(r.close.time).toLocaleString('th-TH')}</td>
          <td class="num ${(r.close.pnl || 0) >= 0 ? 'pos' : 'neg'}">${fmtUsd(r.close.pnl)}</td><td class="muted">${r.mode === 'dry' ? 'จำลอง' : 'จริง'}${r.auto ? ' · auto' : ''}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    el.innerHTML = html;
  }

  /* ---------- settings tab ---------- */
  function renderSettings() {
    const el = UI.main.querySelector('[data-panel=settings]');
    if (!el) return;
    const cfg = ST.cfg;
    el.innerHTML = `
      <div class="grid">
        <div class="card">
          <h4>🔌 การเชื่อมต่อ</h4>
          <div class="frow"><label>เครือข่าย</label><span class="val"><select data-cfg="net">
            <option value="mainnet" ${cfg.net === 'mainnet' ? 'selected' : ''}>Mainnet (ของจริง)</option>
            <option value="testnet" ${cfg.net === 'testnet' ? 'selected' : ''}>Testnet (ทดลอง)</option></select></span></div>
          <div class="frow"><label>โหมดจำลอง (paper)</label><span class="val"><input type="checkbox" data-cfg="dryRun" ${cfg.dryRun ? 'checked' : ''}></span></div>
          <div class="note">เริ่มแบบจำลองก่อนเสมอ — เมื่อมั่นใจแล้วจึงปิด "โหมดจำลอง" เพื่อส่งคำสั่งจริง</div>
        </div>
        <div class="card">
          <h4>🔑 API Wallet (เฉพาะโหมดของจริง)</h4>
          <div class="frow"><label>Private key ของ API wallet</label>
            <span class="val"><input type="password" data-cfg="key" class="wide" placeholder="วาง key แล้วกด เชื่อมต่อ" style="width:250px" autocomplete="off"></span></div>
          <div class="frow"><label>จำ key ไว้ในเครื่องนี้ (localStorage)</label><span class="val"><input type="checkbox" data-cfg="rememberKey" ${cfg.rememberKey ? 'checked' : ''}></span></div>
          <div class="frow"><label>สถานะ</label><span class="val muted">${ST.addr ? 'เชื่อมต่อแล้ว: ' + esc(ST.addr) : 'ยังไม่เชื่อมต่อ'}</span></div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="primary" data-act="setkey">เชื่อมต่อ</button>
            <button data-act="clearkey">ลบ key / ตัดการเชื่อมต่อ</button>
          </div>
          <div class="note">สร้างได้ที่ app.hyperliquid.xyz → Settings → API wallets → Generate (แนะนำตั้งชื่อว่า arb-bot) — <b>ใช้ key ของ API wallet เท่านั้น</b> ไม่ใช่ private key กระเป๋าหลัก API wallet สั่งเทรดได้แต่<b>ถอนเงินไม่ได้</b> · ควรใช้บนหน้าเว็บปลอดภัยเช่น example.com</div>
        </div>
        <div class="card">
          <h4>💰 ขนาด & ต้นทุน</h4>
          <div class="frow"><label>ขนาดโพซิชันต่อขา (USD)</label><span class="val"><input type="number" data-cfg="notional" value="${+cfg.notional}" min="11"></span></div>
          <div class="frow"><label>ลีเวอเรจขาเพอร์ป</label><span class="val"><input type="number" data-cfg="lev" value="${+cfg.lev}" min="1" max="10"></span></div>
          <div class="frow"><label>สลิปเปจสูงสุด (%)</label><span class="val"><input type="number" data-cfg="slip" value="${+cfg.slip}" min="0.05" max="3" step="0.05"></span></div>
          <div class="frow"><label>ค่าธรรมเนียม taker ต่อขา (%)</label><span class="val"><input type="number" data-cfg="takerFee" value="${+cfg.takerFee}" min="0" max="0.5" step="0.005"></span></div>
        </div>
        <div class="card">
          <h4>🤖 โหมดอัตโนมัติ</h4>
          <div class="frow"><label>เปิดใช้งาน</label><span class="val"><input type="checkbox" data-cfg="auto" ${cfg.auto ? 'checked' : ''}></span></div>
          <div class="frow"><label>เปิดเมื่อ APR ≥ (%)</label><span class="val"><input type="number" data-cfg="autoOpenApr" value="${+cfg.autoOpenApr}"></span></div>
          <div class="frow"><label>ปิดเมื่อ APR ≤ (%)</label><span class="val"><input type="number" data-cfg="autoCloseApr" value="${+cfg.autoCloseApr}"></span></div>
          <div class="frow"><label>จำนวนโพซิชันสูงสุด</label><span class="val"><input type="number" data-cfg="maxPos" value="${+cfg.maxPos}" min="1" max="20"></span></div>
          <div class="frow"><label>ถือขั้นต่ำ (ชั่วโมง)</label><span class="val"><input type="number" data-cfg="minHoldH" value="${+cfg.minHoldH}" min="0"></span></div>
          <div class="note">ทำงานเฉพาะคู่ spot–perp ใน Hyperliquid ที่ funding เป็นบวก (ซื้อสปอต + ชอร์ตเพอร์ป)</div>
        </div>
        <div class="card">
          <h4>📡 ข้อมูล & แจ้งเตือน</h4>
          <div class="frow"><label>รีเฟรชทุก (วินาที)</label><span class="val"><input type="number" data-cfg="refreshSec" value="${+cfg.refreshSec}" min="10" max="600"></span></div>
          <div class="frow"><label>แสดง funding จาก Binance</label><span class="val"><input type="checkbox" data-cfg="showBn" ${cfg.showBn ? 'checked' : ''}></span></div>
          <div class="frow"><label>แสดง funding จาก Bybit</label><span class="val"><input type="checkbox" data-cfg="showBy" ${cfg.showBy ? 'checked' : ''}></span></div>
          <div class="frow"><label>แจ้งเตือนเมื่อห่าง liq ต่ำกว่า (%)</label><span class="val"><input type="number" data-cfg="liqWarn" value="${+cfg.liqWarn}" min="2" max="50"></span></div>
        </div>
        <div class="card">
          <h4>🗑️ ข้อมูล</h4>
          <div class="note">ค่าตั้งค่า/โพซิชันถูกเก็บใน localStorage ของโดเมนที่เปิดบุ๊คมาร์ค (ใช้จากหน้าเว็บเดิมทุกครั้งเพื่อให้ค่าคงเดิม)</div>
          <button class="danger" data-act="reset">ล้างข้อมูลทั้งหมด</button>
        </div>
      </div>`;
  }

  /* ---------- help tab ---------- */
  function renderHelp() {
    const el = UI.main.querySelector('[data-panel=help]');
    if (!el) return;
    el.innerHTML = `
      <div class="help">
        <h4>🧠 บอทนี้ทำอะไร</h4>
        <p><b>Funding Rate Arbitrage</b> บน Hyperliquid: เมื่อ funding ของเหรียญหนึ่งเป็น<b>บวก</b> ขาลอง (long) ต้องจ่าย funding ให้ขาชอร์ตทุก ๆ 1 ชั่วโมง บอทจะเปิดโพซิชัน "<b>ซื้อสปอต + ชอร์ตเพอร์ป</b>" ขนาดเท่ากัน เพื่อให้ราคาเข้าใกล้เป็นกลาง (delta ≈ 0) แล้วเก็บ funding เป็นรายได้ พร้อมแสดงเปรียบเทียบ funding กับ Binance/Bybit เพื่อหีบโอกาส cross-exchange</p>
        <h4>🚀 เริ่มใช้อย่างไร</h4>
        <li>1) เปิดหน้าเว็บธรรมดา เช่น <code>example.com</code> แล้วคลิกบุ๊คมาร์ค — แดชบอร์ดจะเด้งขึ้นมา</li>
        <li>2) ดูแท็บ "สแกน Funding" → คู่ที่มีป้าย ⚖️ ได้ = มีทั้งสปอตและเพอร์ปใน HL</li>
        <li>3) แท็บ "ฮีดจ์" → ตั้งขนาดเงิน → กด "เปิดฮีดจ์" (เริ่มที่โหมดจำลองก่อน)</li>
        <li>4) อยากให้ทำงานเอง → แท็บ "ตั้งค่า" → เปิด "โหมดอัตโนมัติ" ตั้งเกณฑ์ APR</li>
        <h4>🔑 การใช้ของจริง (Live)</h4>
        <li>สร้าง API wallet: เว็บ Hyperliquid → <code>Settings → API wallets → Generate</code> (ตั้งชื่อเช่น arb-bot) แล้วคัดลอก private key ที่ให้มา</li>
        <li>มาใส่ในแท็บตั้งค่าของบอท แล้วปิด "โหมดจำลอง" — API wallet <b>สั่งเทรดได้แต่ถอนเงินไม่ได้</b> จึงปลอดภัยกว่าใช้ key หลัก</li>
        <li>แนะนำทดสอบบน Testnet ก่อน (เลือกได้ในตั้งค่า) — ขอเงินทดลองได้ที่ app.hyperliquid-testnet.xyz</li>
        <h4>⚠️ ความเสี่ยงสำคัญ (อ่านก่อนใช้เงินจริง)</h4>
        <li><b>ราคาชำระบาญ (liquidation):</b> ขาชอร์ตเพอร์ปอาจโดนไล่ล้างถ้าราคาพุ่งแรง แม้จะมีขาสปอถู (คนละบัญชีมาร์จิ้น) — ใช้ลีเวอเรจต่ำ (2–3x) และเปิดรับแจ้งเตือน</li>
        <li><b>Funding กลับทิศ:</b> เมื่อ funding ติดลบ โพซิชันจะ<b>จ่าย</b>แทนที่จะรับ — ตั้ง "ปิดเมื่อ APR ≤" ไว้ด้วย</li>
        <li><b>สเปรด/สลิปเปจ/ค่าธรรมเนียม:</b> เข้า–ออก 4 ไม้ taker ≈ 0.18% — ต้องถือนานพอจึงคุ้ม (ดูคอลัมน์ "คุ้มทุนใน")</li>
        <li><b>เบสิส (basis):</b> ส่วนต่างราคาสปอต–เพอร์ปแกว่งได้ อาจกินกำไร funding</li>
        <li><b>ซอฟต์แวร์:</b> บอททำงานในเบราว์เซอร์ ถ้าปิดหน้าต่าง/เน็ตหลุด มันจะไม่ถือโพซิชันแทนคุณ — โพซิชันที่เปิดค้างอยู่ยังเป็นของคุณบน Hyperliquid ตรวจสอบได้ที่หน้าเว็บ HL เสมอ</li>
        <h4>🧮 ตัวเลขที่ควรรู้</h4>
        <li>funding จ่ายรายชั่วโมง · APR ปี = อัตรา×24×365 · เงินล็อกจริง ≈ ขนาด×(1 + 1/ลีเวอเรจ)</li>
        <li>รายได้ต่อชั่วโมง ≈ ขนาด×อัตรา funding (เช่น $100 × 0.01% = $0.01/ชม.)</li>
        <h4>🔒 ความเป็นส่วนตัว</h4>
        <p>โค้ดทั้งหมดรันในเบราว์เซอร์ของคุณ ไม่มีเซิร์ฟเวอร์กลาง — ส่งคำขอตรงไปที่ api.hyperliquid.xyz (และ Binance/Bybit สำหรับดูราคาเทียบ) เท่านั้น · key ถูกเก็บเฉพาะในเครื่องคุณ (ถ้าเลือกจำ) · ควรรันจากหน้าเว็บที่ไว้ใจได้ (เช่น example.com) ไม่ใช่เว็บแปลก ๆ ที่อาจดักข้อมูล</p>
        <p class="muted">⚠️ ดิสคลายเมอร์: เครื่องมือนี้เป็นซอฟต์แวร์โอเพนซอร์สเพื่อการศึกษา ไม่ใช่คำแนะนำการลงทุน สกุลเงินดิจิทัลมีความเสี่ยงสูง ใช้เงินที่พอจะเสียได้เท่านั้น</p>
      </div>`;
  }

  function renderAll() {
    if (!UI.main) return;
    const panels = {
      scan: '<section data-panel="scan"></section>',
      hedge: '<section data-panel="hedge"></section>',
      settings: '<section data-panel="settings"></section>',
      help: '<section data-panel="help"></section>'
    };
    const want = Object.keys(panels).filter((k) => !!UI.main.querySelector('[data-panel=' + k + ']'));
    if (want.join() !== Object.keys(panels).join()) UI.main.innerHTML = Object.values(panels).join('');
    // แสดงเฉพาะแท็บกิจกรรม
    Object.keys(panels).forEach((k) => {
      const el = UI.main.querySelector('[data-panel=' + k + ']');
      if (el) el.style.display = (k === ST.activeTab) ? '' : 'none';
    });
    renderHeader(); renderLog(); renderToasts();
    if (ST.activeTab === 'scan') renderScan();
    else if (ST.activeTab === 'hedge') renderHedge();
    else if (ST.activeTab === 'settings') renderSettings();
    else if (ST.activeTab === 'help') renderHelp();
    const hb = UI.app.querySelector('[data-badge-hedge]');
    if (hb) { const n = ST.records.filter((r) => (r.status === 'open' || r.status === 'broken') && r.net === ST.cfg.net).length; hb.textContent = n ? String(n) : ''; }
  }

  function shutdown() {
    try { if (UI.host && UI.host.parentNode) UI.host.parentNode.removeChild(UI.host); } catch (e) { }
    window.__HLFARB_OK = false;
    if (IS_POPUP) { try { window.close(); } catch (e) { } }
  }

  /* ================= boot ================= */
  function init() {
    restore();
    if (ST.cfg.key) { try { setKey(ST.cfg.key); } catch (e) { ST.cfg.key = ''; } }
    buildUI();
    renderAll();
    logLine('เริ่มทำงาน — โหมด' + (ST.cfg.dryRun ? 'จำลอง' : 'ของจริง') + ' · ' + ST.cfg.net, 'ok');
    tick();
    setInterval(() => {
      renderHeader();
      if (!ST.busy && Date.now() >= ST.nextTickAt) tick();
    }, 1000);
  }
  init();
}
