(function(){
  // ---------- On-chain section of the BTC tab: market cost basis & MVRV, long/short-term holders,
  // power law, Strategy (MSTR). Loaded on the first visit to the BTC tab. ----------
  const tr = window.tr || ((th) => th);
  const el = id => document.getElementById(id);
  const DAY = 86400000, GENESIS = Date.UTC(2009, 0, 3), START = Date.UTC(2011, 5, 1);
  // one fixed colour per entity (checked for colour-blind separation on the dark panel)
  const C = { price: '#d8d2c4', rp: '#c08a1e', lth: '#3f8fe0', sth: '#e0505f', up: '#2fae7a', dn: '#e0505f', grid: '#1c2331', axis: '#8d95a6' };
  const SRC = 'https://charts.bgeometrics.com/files/';
  const FILES = { price: 'realized_price_btc_price', rp: 'realized_price', lrp: 'lth_realized_price', srp: 'sth_realized_price', ls: 'lth_supply', ss: 'sth_supply' };
  const CG = 'https://api.coingecko.com/api/v3/';

  // ---------- formatting ----------
  const loc = () => (window.GI_LOCALE || 'th-TH') + '-u-ca-gregory';
  const usd = v => v == null || !isFinite(v) ? '–' : '$' + (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(2));
  const usdShort = v => { if(v == null || !isFinite(v)) return '–'; const a = Math.abs(v), s = v < 0 ? '−' : '';
    if(a >= 1e12) return s + '$' + (a / 1e12).toFixed(2) + 'T'; if(a >= 1e9) return s + '$' + (a / 1e9).toFixed(a >= 1e11 ? 0 : 1) + 'B';
    if(a >= 1e6) return s + '$' + Math.round(a / 1e6) + 'M'; if(a >= 1e3) return s + '$' + (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K'; return s + '$' + a.toFixed(a < 10 ? 2 : 0); };
  const btcN = v => v == null || !isFinite(v) ? '–' : (v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('en-US');
  const btcSigned = v => v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.round(Math.abs(v)).toLocaleString('en-US');
  const btcShort = v => { if(v == null || !isFinite(v)) return '–'; const a = Math.abs(v), s = v < 0 ? '−' : '';
    return a >= 1e6 ? s + (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? s + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K' : s + Math.round(a); };
  const pct = (x, d) => x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x * 100).toFixed(d == null ? 1 : d) + '%';
  const share = x => Math.round(x * 100) + '%';
  const cls = x => x > 0 ? 'oc-up' : x < 0 ? 'oc-dn' : '';
  const dLong = t => new Date(t).toLocaleDateString(loc(), { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const dShort = t => new Date(t).toLocaleDateString(loc(), { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- data ----------
  // BGeometrics files [[tsMs, value], ...] → aligned daily arrays from START (same rules as
  // netlify/functions/btc-holders.js, used when that function is unreachable)
  function ocBuild(raw){
    const roundPx = v => v < 100 ? Math.round(v * 100) / 100 : Math.round(v);
    const maps = {}; let last = 0;
    Object.keys(FILES).forEach(k => {
      const m = new Map();
      (raw[k] || []).forEach(row => {
        const t = Number(row && row[0]), v = Number(row && row[1]);
        if(!isFinite(t) || row[1] == null || !isFinite(v) || v <= 0) return;
        const d = Math.floor((t - START) / DAY); if(d < 0) return;
        m.set(d, k === 'ls' || k === 'ss' ? Math.round(v) : roundPx(v));
        if(k === 'price' && d > last) last = d;
      });
      maps[k] = m;
    });
    const days = last + 1;
    if(days < 3000 || maps.rp.size < 2000 || maps.ls.size < 1000) throw new Error('too little history');
    const out = { start: new Date(START).toISOString().slice(0, 10), days };
    Object.keys(FILES).forEach(k => { const a = new Array(days).fill(null); maps[k].forEach((v, d) => { if(d < days) a[d] = v; }); out[k] = a; });
    return out;
  }
  // CoinGecko answers → compact Strategy payload (same rules as netlify/functions/btc-treasury.js)
  function ocShapeTreasury(entity, history, list){
    const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
    const h = ((entity && entity.holdings) || []).filter(x => x && x.coin_id === 'bitcoin')[0];
    if(!h || !(num(h.amount) > 0)) throw new Error('no bitcoin holdings');
    const tx = ((history && history.transactions) || []).filter(t => t && t.coin_id === 'bitcoin' && num(t.date) && num(t.holding_net_change) != null)
      .map(t => ({ date: new Date(Number(t.date)).toISOString().slice(0, 10), type: t.type === 'sell' ? 'sell' : 'buy', btc: Math.abs(num(t.holding_net_change)),
        usd: num(t.transaction_value_usd), balance: num(t.holding_balance), url: /^https:\/\//.test(String(t.source_url || '')) ? String(t.source_url) : null }))
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const top = ((list && list.companies) || []).slice(0, 8).map(c => ({ name: String(c.name || ''), symbol: String(c.symbol || ''), country: String(c.country || ''),
      btc: num(c.total_holdings), avgCost: num(c.total_entry_value_usd) > 0 && num(c.total_holdings) > 0 ? c.total_entry_value_usd / c.total_holdings : null }));
    return { strategy: { holdings: num(h.amount), cost: num(h.total_entry_value_usd), avgCost: num(h.average_entry_value_usd), value: num(h.current_value_usd),
      pnl: num(h.unrealized_pnl), mnav: num(entity.m_nav), pctSupply: num(h.percentage_of_total_supply) }, tx, top, totalCompanies: num(list && list.total_holdings) };
  }
  async function getJ(url, ms){
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), ms || 15000);
    try{ const r = await fetch(url, { signal: ctrl.signal }); if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  }
  async function loadHolders(){
    try{
      const d = await getJ('/.netlify/functions/btc-holders', 15000);
      if(d && d.days > 3000 && Object.keys(FILES).every(k => Array.isArray(d[k]) && d[k].length === d.days)) return d;
      throw new Error('bad payload');
    }catch(e){
      const keys = Object.keys(FILES), res = await Promise.all(keys.map(k => getJ(SRC + FILES[k] + '.json', 25000))), raw = {};
      keys.forEach((k, i) => { raw[k] = res[i]; });
      return ocBuild(raw);
    }
  }
  async function loadTreasury(){
    try{
      const d = await getJ('/.netlify/functions/btc-treasury', 12000);
      if(d && d.strategy && d.strategy.holdings > 0 && Array.isArray(d.tx)){
        if(!d.tx.length || Math.abs((d.tx[0].balance || 0) - d.tx[0].btc) >= 1){   // server's history was rate-limited or truncated: fetch it from here
          const h = await getJ(CG + 'public_treasury/strategy/transaction_history?per_page=250').catch(() => null);
          if(h) try{ const tx = ocShapeTreasury({ holdings: [{ coin_id: 'bitcoin', amount: d.strategy.holdings }] }, h, null).tx; if(tx.length >= d.tx.length) d.tx = tx; }catch(e){}
        }
        return d;
      }
      throw new Error('bad payload');
    }catch(e){
      const [a, b, c] = await Promise.all([getJ(CG + 'public_treasury/strategy'), getJ(CG + 'public_treasury/strategy/transaction_history?per_page=250').catch(() => null),
        getJ(CG + 'companies/public_treasury/bitcoin').catch(() => null)]);
      return ocShapeTreasury(a, b, c);
    }
  }

  // ---------- derived series ----------
  function lastIdx(a, upTo){ for(let i = upTo == null ? a.length - 1 : upTo; i >= 0; i--) if(a[i] != null) return i; return -1; }
  function prep(d){
    const n = d.days, t0 = Date.parse(d.start + 'T00:00:00Z');
    const ratio = (a, b) => a.map((v, i) => v != null && b[i] ? v / b[i] : null);
    const diff = (a, h) => a.map((v, i) => i >= h && v != null && a[i - h] != null ? v - a[i - h] : null);
    const mul = (a, b) => a.map((v, i) => v != null && b[i] != null ? v * b[i] : null);
    const D = Object.assign({}, d, { t: i => t0 + i * DAY, t0 });
    D.mvA = ratio(d.price, d.rp); D.mvL = ratio(d.price, d.lrp); D.mvS = ratio(d.price, d.srp);
    D.dL = diff(d.ls, 30); D.dS = diff(d.ss, 30);
    D.rcL = mul(d.lrp, d.ls); D.rcS = mul(d.srp, d.ss);
    D.rcTop = D.rcL.map((v, i) => v != null && D.rcS[i] != null ? v + D.rcS[i] : null);
    D.lastP = lastIdx(d.price);
    D.n = n;
    return D;
  }

  // Share of past days whose value is below v (null days skipped)
  function shareBelow(a, v){ let c = 0, k = 0; for(const x of a){ if(x == null) continue; k++; if(x < v) c++; } return k ? c / k : null; }

  // Power law: least squares of log10(price) on log10(days since the genesis block), every day since 2011.
  // Bands are quantiles of the residuals (how far real prices sat from the line).
  function fitPowerLaw(D){
    let sx = 0, sy = 0, sxx = 0, sxy = 0, k = 0; const pts = [];
    for(let i = 0; i < D.n; i++){
      const p = D.price[i]; if(p == null) continue;
      const x = Math.log10((D.t(i) - GENESIS) / DAY), y = Math.log10(p);
      pts.push([x, y]); sx += x; sy += y; sxx += x * x; sxy += x * y; k++;
    }
    const b = (k * sxy - sx * sy) / (k * sxx - sx * sx), a = (sy - b * sx) / k;
    const res = pts.map(p => p[1] - (a + b * p[0])).sort((u, v) => u - v);
    const q = p => { const f = (res.length - 1) * p, lo = Math.floor(f), hi = Math.ceil(f); return res[lo] + (res[hi] - res[lo]) * (f - lo); };
    const Q = { lo95: q(0.025), lo68: q(0.16), hi68: q(0.84), hi95: q(0.975) };
    const fairAt = t => Math.pow(10, a + b * Math.log10((t - GENESIS) / DAY));
    const at = t => { const f = fairAt(t); return { fair: f, lo95: f * Math.pow(10, Q.lo95), lo68: f * Math.pow(10, Q.lo68), hi68: f * Math.pow(10, Q.hi68), hi95: f * Math.pow(10, Q.hi95) }; };
    const position = (t, price) => { const r = Math.log10(price / fairAt(t)); let c = 0; for(const x of res) if(x < r) c++; return c / res.length; };
    return { a, b, Q, at, fairAt, position, days: k };
  }

  // Holder flows over the last 30 / 90 days → which way coins are moving
  function holderVerdict(D){
    const j = Math.min(lastIdx(D.ls), lastIdx(D.ss));
    if(j < 90) return null;
    const dL = D.ls[j] - D.ls[j - 30], dS = D.ss[j] - D.ss[j - 30], dL90 = D.ls[j] - D.ls[j - 90], dS90 = D.ss[j] - D.ss[j - 90];
    const kind = dL < 0 && dS > 0 ? 'distribution' : dL > 0 && dS < 0 ? 'accumulation' : dL >= 0 && dS >= 0 ? 'both-up' : 'both-down';
    return { j, dL, dS, dL90, dS90, kind, ls: D.ls[j], ss: D.ss[j] };
  }

  // Strategy: running average cost per day from the filings (a sale keeps the average, like a cost-basis sale)
  function mstrSeries(tx, fromT, toT){
    const days = Math.floor((toT - fromT) / DAY) + 1, avg = new Array(days).fill(null), bal = new Array(days).fill(null);
    let cost = 0, held = 0, k = 0;
    for(let i = 0; i < days; i++){
      const ds = new Date(fromT + i * DAY).toISOString().slice(0, 10);
      while(k < tx.length && tx[k].date <= ds){
        const t = tx[k++];
        if(t.type === 'buy'){ cost += t.usd || 0; held += t.btc; }
        else if(held > 0){ cost -= cost / held * Math.min(t.btc, held); held -= Math.min(t.btc, held); }
      }
      if(held > 0){ avg[i] = cost / held; bal[i] = held; }
    }
    return { avg, bal, days };
  }
  function mstrStats(T, now){
    const since = days => { const cut = new Date(now - days * DAY).toISOString().slice(0, 10); return T.tx.filter(t => t.date > cut); };
    const sum = (a, type) => a.filter(t => t.type === type).reduce((s, t) => s + t.btc, 0);
    const last30 = since(30), last90 = since(90), last365 = since(365);
    const buys = T.tx.filter(t => t.type === 'buy');
    return { bought30: sum(last30, 'buy'), bought90: sum(last90, 'buy'), sold365: sum(last365, 'sell'), sells365: last365.filter(t => t.type === 'sell').length,
      lastBuy: buys.length ? buys[buys.length - 1] : null };
  }

  // ---------- chart: one y axis, crosshair + tooltip on hover / tap ----------
  // o.series: { name, color, values | lo+hi (band), kind: 'line' | 'band' | 'pn', width, dash, fill, op, fmt, tip, noTip }
  function ocChart(box, o){
    if(!box) return;
    if(box.clientWidth === 0) S.dirty = true;   // drawn while the tab is hidden → redraw on next visit
    const W = Math.max(300, Math.round(box.clientWidth || 900)), small = W < 560;
    const H = o.H ? (small ? Math.round(o.H * 0.85) : o.H) : (small ? 240 : 300);
    const L = small ? 46 : 56, R = 10, T = 10, B = 24, from = o.from, to = Math.max(o.to, o.from + 1);
    const age = i => (o.t(i) - GENESIS) / DAY;
    const lx0 = Math.log10(age(from)), lx1 = Math.log10(age(to));
    const x = o.xLog ? i => L + (W - L - R) * (Math.log10(age(i)) - lx0) / (lx1 - lx0) : i => L + (W - L - R) * (i - from) / (to - from);
    // y range over what is visible
    let lo = Infinity, hi = -Infinity;
    const take = v => { if(v == null || !isFinite(v) || (o.log && v <= 0)) return; if(v < lo) lo = v; if(v > hi) hi = v; };
    o.series.forEach(s => { for(let i = from; i <= to; i++){ if(s.kind === 'band'){ take(s.lo[i]); take(s.hi[i]); } else take(s.values[i]); } });
    (o.hlines || []).forEach(h => take(h.v));
    if(o.zero){ take(0); }
    if(!isFinite(lo)){ box.innerHTML = ''; return; }
    let y0, y1, Y;
    if(o.log){ y0 = Math.log10(lo) - 0.04; y1 = Math.log10(hi) + 0.04; Y = v => T + (H - T - B) * (1 - (Math.log10(v) - y0) / (y1 - y0)); }
    else { const pad = (hi - lo) * 0.07 || Math.abs(hi) * 0.1 || 1; y0 = lo - (o.zero && lo >= 0 ? 0 : pad); y1 = hi + pad; Y = v => T + (H - T - B) * (1 - (v - y0) / (y1 - y0)); }
    const yFmt = o.yFmt || (v => String(v));
    let g = '';
    // y ticks
    const ticks = [];
    if(o.log){
      const dec = y1 - y0, mant = dec > 2.5 ? [1] : dec > 0.9 ? [1, 2, 5] : [1, 1.5, 2, 3, 5, 7];
      for(let e = Math.floor(y0); e <= Math.ceil(y1); e++) mant.forEach(m => { const v = m * Math.pow(10, e); if(Math.log10(v) >= y0 && Math.log10(v) <= y1) ticks.push(v); });
      if(dec > 6) for(let k = ticks.length - 2; k > 0; k -= 2) ticks.splice(k, 1);
    } else {
      const raw = (y1 - y0) / 5, mag = Math.pow(10, Math.floor(Math.log10(raw))), st = [1, 2, 2.5, 5, 10].map(m => m * mag).filter(s => s >= raw)[0];
      for(let v = Math.ceil(y0 / st) * st; v <= y1; v += st) ticks.push(Math.abs(v) < st / 1e6 ? 0 : v);
    }
    ticks.forEach(v => { const yy = Y(v).toFixed(1); g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + C.grid + '"/>'
      + '<text x="' + (L - 6) + '" y="' + (+yy + 3.5) + '" fill="' + C.axis + '" font-size="11" text-anchor="end">' + yFmt(v) + '</text>'; });
    // x ticks: years, quarters or months, at least ~70px apart
    const xt = []; const span = (o.t(to) - o.t(from)) / DAY;
    const startY = new Date(o.t(from)).getUTCFullYear(), endY = new Date(o.t(to)).getUTCFullYear();
    for(let yv = startY; yv <= endY + 1; yv++) for(let m = 0; m < 12; m++){
      const step = span > 1100 ? 12 : span > 500 ? 3 : span > 200 ? 2 : 1; if(m % step) continue;
      const i = Math.round((Date.UTC(yv, m, 1) - o.t(0)) / DAY); if(i < from || i > to) continue;
      xt.push({ i, label: step === 12 ? String(yv) : dShort(Date.UTC(yv, m, 1)) });
    }
    let lastX = -1e9;
    xt.forEach(tk => { const xx = x(tk.i); if(xx - lastX < (small ? 58 : 70) || xx > W - R - 14) return; lastX = xx;
      g += '<line x1="' + xx.toFixed(1) + '" x2="' + xx.toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="' + C.grid + '" stroke-opacity=".6"/>'
        + '<text x="' + xx.toFixed(1) + '" y="' + (H - 7) + '" fill="' + C.axis + '" font-size="11" text-anchor="middle">' + tk.label + '</text>'; });
    // marks
    const stride = Math.max(1, Math.floor((to - from) / ((W - L - R) * 1.5)));
    const idx = []; for(let i = from; i <= to; i += stride) idx.push(i); if(idx[idx.length - 1] !== to) idx.push(to);
    const linePath = (vals, fy) => { let p = '', pen = false; idx.forEach(i => { const v = vals[i]; if(v == null || (o.log && v <= 0)){ pen = false; return; } p += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + fy(v).toFixed(1); pen = true; }); return p; };
    const bandPath = (a, b) => { // closed polygon(s) between a (bottom) and b (top), split at gaps
      let out = '', seg = [];
      const flush = () => { if(seg.length > 1){ out += 'M' + seg.map(i => x(i).toFixed(1) + ' ' + Y(b[i]).toFixed(1)).join('L') + 'L' + seg.slice().reverse().map(i => x(i).toFixed(1) + ' ' + Y(a[i]).toFixed(1)).join('L') + 'Z'; } seg = []; };
      idx.forEach(i => { if(a[i] == null || b[i] == null || (o.log && (a[i] <= 0 || b[i] <= 0))) flush(); else seg.push(i); }); flush(); return out; };
    o.series.forEach(s => {
      if(s.kind === 'band') g += '<path d="' + bandPath(s.lo, s.hi) + '" fill="' + s.color + '" fill-opacity="' + (s.op || 0.25) + '" stroke="none"/>';
      else if(s.kind === 'pn'){
        const zero = s.values.map(v => v == null ? null : 0), pos = s.values.map(v => v == null ? null : Math.max(v, 0)), neg = s.values.map(v => v == null ? null : Math.min(v, 0));
        g += '<path d="' + bandPath(zero, pos) + '" fill="' + C.up + '" fill-opacity=".7"/><path d="' + bandPath(neg, zero) + '" fill="' + C.dn + '" fill-opacity=".7"/>';
      }
      else g += '<path d="' + linePath(s.values, Y) + '" fill="none" stroke="' + s.color + '" stroke-width="' + (s.width || 2) + '"' + (s.dash ? ' stroke-dasharray="' + s.dash + '"' : '') + ' stroke-linejoin="round" stroke-linecap="round"/>';
    });
    (o.hlines || []).forEach(h => { const yy = Y(h.v).toFixed(1); g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="' + (h.color || C.axis) + '" stroke-dasharray="4 4" stroke-opacity=".9"/>'
      + (h.label ? '<text x="' + (L + 6) + '" y="' + (+yy - 5) + '" fill="' + C.axis + '" font-size="11">' + h.label + '</text>' : ''); });
    (o.vlines || []).forEach(v => { const xx = x(v.i).toFixed(1); g += '<line x1="' + xx + '" x2="' + xx + '" y1="' + T + '" y2="' + (H - B) + '" stroke="' + C.axis + '" stroke-dasharray="3 4"/>'
      + (v.label ? '<text x="' + (+xx - 5) + '" y="' + (T + 12) + '" fill="' + C.axis + '" font-size="11" text-anchor="end">' + v.label + '</text>' : ''); });
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="' + esc(o.label || '') + '">' + g + '</svg>';
    hover(box, o, { W, H, L, R, T, B, x, Y, from, to });
  }
  function hover(box, o, m){
    const svg = box.querySelector && box.querySelector('svg'); if(!svg || !svg.addEventListener) return;
    const NS = 'http://www.w3.org/2000/svg', mk = (t, a) => { const e = document.createElementNS(NS, t); for(const k in a) e.setAttribute(k, a[k]); return e; };
    const gg = mk('g', { visibility: 'hidden' }), line = mk('line', { y1: m.T, y2: m.H - m.B, stroke: '#ece6d8', 'stroke-opacity': '.45', 'stroke-dasharray': '2 3' });
    gg.appendChild(line);
    const tipSeries = o.series.filter(s => !s.noTip);
    const dots = tipSeries.map(s => { const c = mk('circle', { r: 4, fill: s.color, stroke: '#0c1019', 'stroke-width': 2 }); gg.appendChild(c); return c; });
    svg.appendChild(gg);
    const tip = document.createElement('div'); tip.className = 'oc-tip'; box.appendChild(tip);
    // invert x: binary search over the index range (works for the log axis too)
    const at = sx => { let a = m.from, b = m.to; while(b - a > 1){ const mid = (a + b) >> 1; if(m.x(mid) < sx) a = mid; else b = mid; } return sx - m.x(a) < m.x(b) - sx ? a : b; };
    function show(ev){
      const r = svg.getBoundingClientRect(); if(!r.width) return;
      const i = at((ev.clientX - r.left) * m.W / r.width), px = m.x(i);
      line.setAttribute('x1', px); line.setAttribute('x2', px);
      tipSeries.forEach((s, k) => { const v = (s.tip || s.values || s.hi)[i], vy = s.kind === 'band' ? s.hi[i] : s.kind === 'pn' ? v : v;
        dots[k].setAttribute('visibility', v == null || vy == null ? 'hidden' : 'visible'); if(v != null && vy != null){ dots[k].setAttribute('cx', px); dots[k].setAttribute('cy', m.Y(vy)); } });
      gg.setAttribute('visibility', 'visible');
      tip.innerHTML = '<div class="d">' + dLong(o.t(i)) + '</div>' + tipSeries.map(s => { const v = (s.tip || s.values || s.hi)[i]; return v == null ? '' : '<div><i style="background:' + s.color + '"></i>' + s.name + ' <b>' + (s.fmt || o.yFmt)(v) + '</b></div>'; }).join('') + (o.extra ? o.extra(i) : '');
      tip.style.display = 'block';
      const bx = box.getBoundingClientRect(), cx = ev.clientX - bx.left, w = tip.offsetWidth;
      tip.style.left = Math.max(4, cx + 14 + w > bx.width ? cx - 14 - w : cx + 14) + 'px';
    }
    function hide(){ gg.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; }
    svg.addEventListener('pointermove', show); svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', ev => { if(ev.pointerType !== 'touch') hide(); });
    document.addEventListener('pointerdown', ev => { if(!svg.contains(ev.target)) hide(); });
  }
  function legend(box, items){
    if(!box) return;
    box.innerHTML = items.map(it => '<span><i class="' + (it.kind || '') + '" style="background:' + it.color + ';color:' + it.color + (it.op ? ';opacity:' + it.op : '') + '"></i>' + it.name + '</span>').join('');
  }
  function seg(box, onPick){
    if(!box || !box.querySelectorAll) return;
    const bs = box.querySelectorAll('button');
    bs.forEach(b => b.addEventListener('click', () => { bs.forEach(x => x.classList.toggle('on', x === b)); onPick(b.dataset.v); }));
  }
  const tile = (k, v, s, color) => '<div class="oc-tile"><div class="k">' + (color ? '<i style="background:' + color + '"></i>' : '') + k + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';

  // ---------- state ----------
  const S = { D: null, T: null, pl: null, costMode: 'price', costRange: 365, holdRange: 365, plAxis: 'time', plRange: 0 };
  function livePrice(){
    const v = parseFloat((el('priceInput') || {}).value);
    return isFinite(v) && v > 1000 ? v : (S.D ? S.D.price[S.D.lastP] : null);
  }
  const rangeFrom = (D, days, firstOk) => Math.max(firstOk || 0, days ? D.lastP - days : 0);
  const firstIdx = a => { for(let i = 0; i < a.length; i++) if(a[i] != null) return i; return 0; };

  // ---------- shared signals for the BTC Buy Score (one source of truth for MVRV / NUPL) ----------
  // คะแนนความน่าซื้อด้านบนอ่านค่าจากตรงนี้ ตัวเลข MVRV ทั้งแท็บจึงตรงกัน (ราคาสด ÷ ต้นทุนเฉลี่ยชุดเดียวกัน)
  function publishSignals(){
    const D = S.D; if(!D) return;
    const P = livePrice(); if(!(P > 0)) return;
    const i = Math.min(lastIdx(D.rp), lastIdx(D.srp));
    if(i < 0) return;
    const rp = D.rp[i], srp = D.srp[i];
    const sig = { price: P, asOf: D.t(i), mvrv: rp ? P / rp : null, sthRatio: srp ? P / srp : null,
      plPos: S.pl ? S.pl.position(Date.now(), P) : null };
    sig.nupl = sig.mvrv ? 1 - 1 / sig.mvrv : null;   // NUPL = 1 − Realized Cap ÷ Market Cap = 1 − 1/MVRV
    window.giBtcSignals = Object.assign(window.giBtcSignals || {}, sig);
    try{ window.dispatchEvent(new Event('gi-btc-signals')); }catch(e){}
  }

  // ---------- 1) cost basis & MVRV ----------
  function costSummary(){
    const D = S.D; if(!D) return;
    publishSignals();
    const P = livePrice();
    const i = Math.min(lastIdx(D.rp), lastIdx(D.lrp), lastIdx(D.srp));
    const rp = D.rp[i], lrp = D.lrp[i], srp = D.srp[i];
    el('ocCostAsOf').textContent = tr('ต้นทุนเฉลี่ย ณ ' + dLong(D.t(i)) + ' (ผู้ให้ข้อมูลหน่วงไว้ราว 1 สัปดาห์ แต่ต้นทุนเฉลี่ยขยับช้า) · ราคาและ MVRV ด้านล่างใช้ราคาสด',
      'Average costs as of ' + dLong(D.t(i)) + ' (the publisher holds back about a week; average costs move slowly) · price and MVRV below use the live price');
    const coh = (name, v, color) => tile(name, usd(v), 'MVRV <b>' + (P / v).toFixed(2) + '</b> · ' + (P >= v ? tr('กำไร ', 'profit ') : tr('ขาดทุน ', 'loss ')) + '<b class="' + cls(P / v - 1) + '">' + pct(P / v - 1) + '</b>', color);
    el('ocCostTiles').innerHTML = tile(tr('ราคา BTC ตอนนี้', 'BTC price now'), usd(P), tr('เทียบกับต้นทุนของแต่ละกลุ่ม →', 'compared with each group\'s cost →'), C.price)
      + coh(tr('ต้นทุนเฉลี่ยทั้งตลาด', 'Market cost (all)'), rp, C.rp) + coh(tr('ต้นทุนคนถือยาว (LTH)', 'Long-term holder cost'), lrp, C.lth) + coh(tr('ต้นทุนคนถือสั้น (STH)', 'Short-term holder cost'), srp, C.sth);
    const y0 = new Date(D.t(firstIdx(D.mvA))).getUTCFullYear(), yL = new Date(D.t(firstIdx(D.mvL))).getUTCFullYear();
    const mvA = P / rp, below = shareBelow(D.mvA, 1), belowL = shareBelow(D.mvL, 1), pctA = shareBelow(D.mvA, mvA);
    const pts = [];
    pts.push(P < srp
      ? tr('ราคาต่ำกว่าต้นทุนของคนถือสั้น ' + pct(P / srp - 1) + ' คนที่ซื้อในช่วง ~5 เดือนล่าสุดขาดทุนเฉลี่ย ถ้าราคาเด้งขึ้นไปแถว ' + usd(srp) + ' มักเจอแรงขายคืนทุน',
          'Price is ' + pct(P / srp - 1) + ' below short-term holders\' cost: people who bought in the last ~5 months are at a loss on average, so a bounce toward ' + usd(srp) + ' tends to meet break-even selling.')
      : tr('คนถือสั้นยังกำไรเฉลี่ย ' + pct(P / srp - 1) + ' ต้นทุนของกลุ่มนี้ที่ ' + usd(srp) + ' มักเป็นแนวรับในช่วงตลาดขาขึ้น',
          'Short-term holders are ' + pct(P / srp - 1) + ' in profit on average; their cost near ' + usd(srp) + ' tends to act as support in uptrends.'));
    pts.push(P < rp
      ? tr('ต่ำกว่าต้นทุนเฉลี่ยของทั้งตลาด (MVRV ' + mvA.toFixed(2) + ') ซึ่งเกิดแค่ ' + share(below) + ' ของวันตั้งแต่ปี ' + y0 + ' ส่วนใหญ่เป็นช่วงใกล้ก้นตลาดหมี',
          'Below the whole market\'s average cost (MVRV ' + mvA.toFixed(2) + '), which happened on only ' + share(below) + ' of days since ' + y0 + ', mostly near bear-market lows.')
      : tr('MVRV ทั้งตลาด ' + mvA.toFixed(2) + ' สูงกว่า ' + share(pctA) + ' ของวันในอดีตตั้งแต่ปี ' + y0 + ' (ยิ่งต่ำยิ่งถูกเมื่อเทียบกับประวัติ · ต่ำกว่า 1 มีแค่ ' + share(below) + ' ของวัน)',
          'Whole-market MVRV is ' + mvA.toFixed(2) + ', higher than on ' + share(pctA) + ' of days since ' + y0 + ' (lower = cheaper against history · below 1 on only ' + share(below) + ' of days).'));
    pts.push(P < lrp
      ? tr('ราคาต่ำกว่าต้นทุนของคนถือยาว (' + usd(lrp) + ') ด้วย เกิดแค่ ' + share(belowL) + ' ของวันตั้งแต่ปี ' + yL + ' เป็นโซนที่หายากมาก',
          'Price is below long-term holders\' cost too (' + usd(lrp) + '), seen on only ' + share(belowL) + ' of days since ' + yL + ', a rare zone.')
      : tr('ยังสูงกว่าต้นทุนของคนถือยาว ' + pct(P / lrp - 1) + ' (' + usd(lrp) + ') ราคาเคยต่ำกว่าเส้นนี้แค่ ' + share(belowL) + ' ของวันตั้งแต่ปี ' + yL,
          'Still ' + pct(P / lrp - 1) + ' above long-term holders\' cost (' + usd(lrp) + '); price was below that line on only ' + share(belowL) + ' of days since ' + yL + '.'));
    el('ocCostPoints').innerHTML = pts.map(s => '<li>' + s + '</li>').join('');
  }
  function costChart(){
    const D = S.D; if(!D) return;
    const mv = S.costMode === 'mvrv';
    const from = rangeFrom(D, S.costRange, firstIdx(D.rp));
    const series = mv
      ? [{ name: 'MVRV', color: C.rp, values: D.mvA, fmt: v => v.toFixed(2) }, { name: 'LTH MVRV', color: C.lth, values: D.mvL, fmt: v => v.toFixed(2) }, { name: 'STH MVRV', color: C.sth, values: D.mvS, fmt: v => v.toFixed(2) }]
      : [{ name: tr('ราคา BTC', 'BTC price'), color: C.price, values: D.price, width: 1.6, fmt: usd }, { name: tr('ต้นทุนทั้งตลาด', 'Realized price'), color: C.rp, values: D.rp, fmt: usd },
         { name: tr('ต้นทุน LTH', 'LTH realized price'), color: C.lth, values: D.lrp, fmt: usd }, { name: tr('ต้นทุน STH', 'STH realized price'), color: C.sth, values: D.srp, fmt: usd }];
    ocChart(el('ocCostChart'), { from, to: D.lastP, t: D.t, series, log: !mv || S.costRange === 0 || S.costRange > 730, yFmt: mv ? (v => (+v.toFixed(2)).toString()) : usdShort,
      hlines: mv ? [{ v: 1, label: tr('เท่าทุน (1.0)', 'Break-even (1.0)') }] : [],
      extra: mv ? (i => D.price[i] == null ? '' : '<div class="d">' + tr('ราคา', 'Price') + ' ' + usd(D.price[i]) + '</div>') : null,
      label: mv ? tr('กราฟ MVRV ทั้งตลาด คนถือยาว และคนถือสั้น', 'MVRV for the whole market, long-term and short-term holders') : tr('กราฟราคา BTC เทียบต้นทุนเฉลี่ยของแต่ละกลุ่ม', 'BTC price against each group\'s average cost') });
    legend(el('ocCostLegend'), mv
      ? [{ name: tr('MVRV ทั้งตลาด', 'MVRV (all)'), color: C.rp }, { name: 'LTH MVRV', color: C.lth }, { name: 'STH MVRV', color: C.sth }, { name: tr('เท่าทุน = 1.0', 'break-even = 1.0'), color: C.axis, kind: 'dash' }]
      : [{ name: tr('ราคา BTC', 'BTC price'), color: C.price }, { name: tr('ต้นทุนทั้งตลาด (Realized Price)', 'Realized price (all)'), color: C.rp }, { name: tr('ต้นทุนคนถือยาว (LTH)', 'LTH realized price'), color: C.lth }, { name: tr('ต้นทุนคนถือสั้น (STH)', 'STH realized price'), color: C.sth }]);
  }

  // ---------- 2) holders ----------
  function holdSummary(){
    const D = S.D, v = D && holderVerdict(D); if(!v) return;
    el('ocHoldAsOf').textContent = tr('ข้อมูลถึง ' + dLong(D.t(v.j)) + ' · เทียบกับ 30 วันก่อนหน้า', 'Data to ' + dLong(D.t(v.j)) + ' · compared with 30 days earlier');
    const V = {
      distribution: ['sell', tr('คนถือยาวกำลังขาย ให้คนซื้อใหม่รับช่วง', 'Long-term holders are selling to new buyers'),
        tr('30 วันล่าสุด เหรียญของคนถือยาวลดลง ' + btcN(-v.dL) + ' BTC ขณะที่คนถือสั้นเพิ่มขึ้น ' + btcN(v.dS) + ' BTC แปลว่าเหรียญเก่าถูกขายออกมา มักเห็นตอนราคาขึ้นแรงจนคนถือเก่าทำกำไร หรือช่วงตกใจขาย',
           'Over the last 30 days long-term holders\' coins fell by ' + btcN(-v.dL) + ' BTC while short-term holders gained ' + btcN(v.dS) + ' BTC: old coins are being sold, typical of profit-taking after strong rallies or of panic selling.')],
      accumulation: ['buy', tr('คนถือยาวไม่ขาย และถือเพิ่มขึ้น (สะสม)', 'Long-term holders are not selling and keep growing (accumulation)'),
        tr('30 วันล่าสุด เหรียญของคนถือยาวเพิ่มขึ้น ' + btcN(v.dL) + ' BTC (เหรียญที่ซื้อเมื่อ ~5 เดือนก่อนถูกถือต่อ) ขณะที่คนถือสั้นลดลง ' + btcN(-v.dS) + ' BTC แรงขายจากคนถือเก่ามีน้อย มักเห็นในช่วงตลาดซึมหรือช่วงเก็บของ',
           'Over the last 30 days long-term holders\' coins grew by ' + btcN(v.dL) + ' BTC (coins bought ~5 months ago are being held on) while short-term holders shrank by ' + btcN(-v.dS) + ' BTC: little selling from old holders, typical of quiet or accumulation phases.')],
      'both-up': ['', tr('ทั้งสองกลุ่มถือเพิ่มขึ้น', 'Both groups are growing'),
        tr('30 วันล่าสุด คนถือยาว ' + btcSigned(v.dL) + ' BTC และคนถือสั้น ' + btcSigned(v.dS) + ' BTC ไม่มีฝั่งไหนขายออกชัดเจน', 'Over the last 30 days long-term holders ' + btcSigned(v.dL) + ' BTC and short-term holders ' + btcSigned(v.dS) + ' BTC: no clear seller.')],
      'both-down': ['sell', tr('ทั้งสองกลุ่มลดลง', 'Both groups are shrinking'),
        tr('30 วันล่าสุด คนถือยาว ' + btcSigned(v.dL) + ' BTC และคนถือสั้น ' + btcSigned(v.dS) + ' BTC มีแรงขายจากทั้งสองฝั่ง', 'Over the last 30 days long-term holders ' + btcSigned(v.dL) + ' BTC and short-term holders ' + btcSigned(v.dS) + ' BTC: selling from both sides.')]
    }[v.kind];
    const box = el('ocHoldVerdict'); box.className = 'oc-verdict ' + V[0]; box.innerHTML = '<b>' + V[1] + '</b>' + V[2];
    const rcL = D.rcL[lastIdx(D.rcL)], rcS = D.rcS[lastIdx(D.rcS)];
    const t = el('ocHoldTiles'); t.className = 'oc-tiles three';
    t.innerHTML = tile(tr('คนถือยาว (LTH) ถืออยู่', 'Long-term holders hold'), btcShort(v.ls) + ' BTC', tr('30 วัน ', '30 days ') + '<b class="' + cls(v.dL) + '">' + btcSigned(v.dL) + '</b> · ' + tr('90 วัน ', '90 days ') + '<b class="' + cls(v.dL90) + '">' + btcSigned(v.dL90) + '</b>', C.lth)
      + tile(tr('คนถือสั้น (STH) ถืออยู่', 'Short-term holders hold'), btcShort(v.ss) + ' BTC', tr('30 วัน ', '30 days ') + '<b class="' + cls(v.dS) + '">' + btcSigned(v.dS) + '</b> · ' + tr('90 วัน ', '90 days ') + '<b class="' + cls(v.dS90) + '">' + btcSigned(v.dS90) + '</b>', C.sth)
      + (rcL && rcS ? tile(tr('เงินทุนอยู่ในมือคนถือยาว', 'Capital held by long-term holders'), share(rcL / (rcL + rcS)), 'LTH ' + usdShort(rcL) + ' · STH ' + usdShort(rcS)) : '');
  }
  function holdCharts(){
    const D = S.D; if(!D) return;
    const to = Math.min(lastIdx(D.dL), lastIdx(D.dS)), from = Math.max(0, to - S.holdRange);
    const extra = (sup, name) => i => (sup[i] == null ? '' : '<div class="d">' + name + ' ' + btcN(sup[i]) + ' BTC</div>') + (D.price[i] == null ? '' : '<div class="d">' + tr('ราคา', 'Price') + ' ' + usd(D.price[i]) + '</div>');
    const fmtB = v => btcSigned(v) + ' BTC';
    ocChart(el('ocLthChart'), { from, to, t: D.t, H: 210, zero: true, series: [{ name: tr('LTH เปลี่ยนใน 30 วัน', 'LTH 30-day change'), color: C.lth, kind: 'pn', values: D.dL, fmt: fmtB }],
      yFmt: v => btcShort(v), extra: extra(D.ls, tr('LTH ถือ', 'LTH holds')), label: tr('การเปลี่ยนแปลง 30 วันของเหรียญคนถือยาว', '30-day change in long-term holder supply') });
    ocChart(el('ocSthChart'), { from, to, t: D.t, H: 210, zero: true, series: [{ name: tr('STH เปลี่ยนใน 30 วัน', 'STH 30-day change'), color: C.sth, kind: 'pn', values: D.dS, fmt: fmtB }],
      yFmt: v => btcShort(v), extra: extra(D.ss, tr('STH ถือ', 'STH holds')), label: tr('การเปลี่ยนแปลง 30 วันของเหรียญคนถือสั้น', '30-day change in short-term holder supply') });
    const zeros = D.rcL.map(v => v == null ? null : 0);
    ocChart(el('ocRcChart'), { from, to, t: D.t, H: 220, zero: true, yFmt: usdShort,
      series: [{ name: tr('LTH', 'LTH'), color: C.lth, kind: 'band', lo: zeros, hi: D.rcL, op: 0.55, tip: D.rcL, fmt: usdShort },
               { name: tr('STH', 'STH'), color: C.sth, kind: 'band', lo: D.rcL, hi: D.rcTop, op: 0.55, tip: D.rcS, fmt: usdShort }],
      extra: i => D.rcTop[i] == null ? '' : '<div class="d">' + tr('รวม ', 'Total ') + usdShort(D.rcTop[i]) + ' · LTH ' + share(D.rcL[i] / D.rcTop[i]) + '</div>',
      label: tr('Realized Cap แยกคนถือยาวและคนถือสั้น', 'Realized cap split by long-term and short-term holders') });
    legend(el('ocHoldLegend'), [{ name: tr('เพิ่มขึ้นใน 30 วัน', 'Up over 30 days'), color: C.up, kind: 'box' }, { name: tr('ลดลงใน 30 วัน', 'Down over 30 days'), color: C.dn, kind: 'box' },
      { name: tr('เงินทุนคนถือยาว', 'Long-term holders\' capital'), color: C.lth, kind: 'box', op: 0.7 }, { name: tr('เงินทุนคนถือสั้น', 'Short-term holders\' capital'), color: C.sth, kind: 'box', op: 0.7 }]);
  }

  // ---------- 3) power law ----------
  function plSummary(){
    const D = S.D, M = S.pl; if(!M) return;
    const P = livePrice(), now = Date.now(), b = M.at(now), pos = M.position(now, P);
    el('ocPlAsOf').textContent = tr('เส้นคำนวณจากราคารายวัน ' + M.days.toLocaleString('en-US') + ' วัน (' + dLong(D.t(firstIdx(D.price))) + ' – ' + dLong(D.t(D.lastP)) + ') · ค่าวันนี้ใช้ราคาสด',
      'Fitted on ' + M.days.toLocaleString('en-US') + ' daily prices (' + dLong(D.t(firstIdx(D.price))) + ' – ' + dLong(D.t(D.lastP)) + ') · today uses the live price');
    el('ocPlTiles').innerHTML = tile(tr('เส้นกลางวันนี้', 'Trend line today'), usd(b.fair), tr('ราคาตอนนี้ ', 'Price now ') + '<b class="' + cls(P / b.fair - 1) + '">' + pct(P / b.fair - 1) + '</b> ' + tr('จากเส้น', 'from it'), C.rp)
      + tile(tr('พื้น (ล่าง 2.5% ของวัน)', 'Floor (lowest 2.5% of days)'), usd(b.lo95), tr('ห่างจากราคาตอนนี้ ', 'From today\'s price ') + '<b>' + pct(b.lo95 / P - 1) + '</b>')
      + tile(tr('เพดาน (บน 2.5% ของวัน)', 'Ceiling (top 2.5% of days)'), usd(b.hi95), tr('ห่างจากราคาตอนนี้ ', 'From today\'s price ') + '<b>' + pct(b.hi95 / P - 1) + '</b>')
      + tile(tr('ตำแหน่งเทียบประวัติ', 'Position vs history'), share(pos), tr('0% = ถูกสุดเมื่อเทียบเส้น · 100% = แพงสุด', '0% = cheapest vs the line · 100% = most expensive'));
    const yr = M.fairAt(now + 365 * DAY) / b.fair - 1;
    el('ocPlPoints').innerHTML = [
      tr('ราคาตอนนี้เทียบกับเส้นแนวโน้ม ถูกกว่า ' + share(1 - pos) + ' ของวันในอดีต' + (pos < 0.16 ? ' (อยู่ในกรอบล่างสุด ซึ่งในอดีตเป็นช่วงก้นตลาดหมี)' : pos > 0.84 ? ' (อยู่ในกรอบบน ซึ่งในอดีตเป็นช่วงใกล้ยอด)' : ''),
        'Against the trend line, today\'s price is cheaper than on ' + share(1 - pos) + ' of past days' + (pos < 0.16 ? ' (in the lowest band, where past bear-market lows sat)' : pos > 0.84 ? ' (in the upper band, where past tops sat)' : '') + '.'),
      tr('โมเดล: ราคา ∝ อายุเครือข่าย ยกกำลัง ' + M.b.toFixed(2) + ' · อายุเพิ่ม 2 เท่า เส้นกลางเพิ่มราว ' + Math.round(Math.pow(2, M.b)) + ' เท่า · ตอนนี้เส้นกลางขึ้นราว ' + pct(yr, 0) + ' ต่อปี และจะช้าลงเรื่อยๆ',
        'Model: price ∝ network age to the power ' + M.b.toFixed(2) + ' · doubling the age multiplies the line by about ' + Math.round(Math.pow(2, M.b)) + ' · the line now rises about ' + pct(yr, 0) + ' a year and keeps slowing.'),
      tr('เป็นการลากเส้นจากอดีต ไม่ใช่คำทำนายที่รับประกัน ราคาเคยอยู่นอกกรอบจาง 5% ของวัน', 'It extends the past and is not a guaranteed forecast; price sat outside the light band on 5% of days.')
    ].map(s => '<li>' + s + '</li>').join('');
    const rows = [[Date.UTC(2026, 11, 31)], [Date.UTC(2027, 11, 31)], [Date.UTC(2028, 11, 31)], [Date.UTC(2030, 11, 31)]].filter(r => r[0] > now);
    el('ocPlProj').innerHTML = '<thead><tr><th>' + tr('วันที่', 'Date') + '</th><th>' + tr('พื้น', 'Floor') + '</th><th>' + tr('กรอบล่าง 68%', 'Lower 68%') + '</th><th>' + tr('เส้นกลาง', 'Trend') + '</th><th>' + tr('กรอบบน 68%', 'Upper 68%') + '</th><th>' + tr('เพดาน', 'Ceiling') + '</th></tr></thead><tbody>'
      + '<tr class="now"><td>' + tr('วันนี้', 'Today') + '<small> · ' + usd(P) + '</small></td><td>' + usd(b.lo95) + '</td><td>' + usd(b.lo68) + '</td><td>' + usd(b.fair) + '</td><td>' + usd(b.hi68) + '</td><td>' + usd(b.hi95) + '</td></tr>'
      + rows.map(r => { const v = M.at(r[0]); return '<tr><td>' + dLong(r[0]) + '</td><td>' + usd(v.lo95) + '</td><td>' + usd(v.lo68) + '</td><td>' + usd(v.fair) + '</td><td>' + usd(v.hi68) + '</td><td>' + usd(v.hi95) + '</td></tr>'; }).join('') + '</tbody>';
  }
  function plChart(){
    const D = S.D, M = S.pl; if(!M) return;
    const end = Math.floor((Date.UTC(2028, 11, 31) - D.t0) / DAY), n = end + 1;
    if(!S.plCache || S.plCache.n !== n){
      const c = { n, fair: [], lo95: [], hi95: [], lo68: [], hi68: [] };
      for(let i = 0; i < n; i++){ const v = M.at(D.t(i)); c.fair.push(v.fair); c.lo95.push(v.lo95); c.hi95.push(v.hi95); c.lo68.push(v.lo68); c.hi68.push(v.hi68); }
      c.price = D.price.concat(new Array(Math.max(0, n - D.price.length)).fill(null));
      S.plCache = c;
    }
    const c = S.plCache, from = S.plRange ? Math.max(0, D.lastP - S.plRange) : firstIdx(D.price);
    ocChart(el('ocPlChart'), { from, to: end, t: D.t, log: true, xLog: S.plAxis === 'log', yFmt: usdShort, H: 320,
      series: [{ name: tr('กรอบ 95%', '95% band'), color: C.rp, kind: 'band', lo: c.lo95, hi: c.hi95, op: 0.1, noTip: true },
               { name: tr('กรอบ 68%', '68% band'), color: C.rp, kind: 'band', lo: c.lo68, hi: c.hi68, op: 0.18, noTip: true },
               { name: tr('เส้นกลาง', 'Trend'), color: C.rp, values: c.fair, width: 1.8, fmt: usd },
               { name: tr('ราคา BTC', 'BTC price'), color: C.price, values: c.price, width: 1.5, fmt: usd }],
      vlines: [{ i: D.lastP, label: tr('วันนี้', 'today') }],
      extra: i => '<div class="d">' + tr('พื้น ', 'Floor ') + usd(c.lo95[i]) + ' · ' + tr('เพดาน ', 'Ceiling ') + usd(c.hi95[i]) + '</div>',
      label: tr('ราคา BTC เทียบเส้น power law และกรอบราคา', 'BTC price against the power-law line and bands') });
    legend(el('ocPlLegend'), [{ name: tr('ราคา BTC', 'BTC price'), color: C.price }, { name: tr('เส้นกลาง (power law)', 'Trend (power law)'), color: C.rp },
      { name: tr('กรอบ 68% ของวัน', '68% of days'), color: C.rp, kind: 'box', op: 0.45 }, { name: tr('กรอบ 95% ของวัน (พื้น–เพดาน)', '95% of days (floor–ceiling)'), color: C.rp, kind: 'box', op: 0.2 }]);
  }

  // ---------- 4) Strategy ----------
  function mstrSummary(){
    const T = S.T; if(!T) return;
    const s = T.strategy, P = livePrice() || (s.value && s.holdings ? s.value / s.holdings : null), now = Date.now();
    if(!P) return;
    const value = s.holdings * P, pnl = value - s.cost, avg = s.avgCost || s.cost / s.holdings, st = mstrStats(T, now);
    const lastTx = T.tx.length ? T.tx[T.tx.length - 1] : null;
    el('ocMstrAsOf').textContent = tr('ยอดถือตามแบบ 8-K ล่าสุด' + (lastTx ? ' (' + dLong(Date.parse(lastTx.date)) + ')' : '') + ' · มูลค่าและกำไร/ขาดทุนคิดจากราคาสด ' + usd(P),
      'Holdings per the latest 8-K' + (lastTx ? ' (' + dLong(Date.parse(lastTx.date)) + ')' : '') + ' · value and profit/loss use the live price ' + usd(P));
    el('ocMstrTiles').innerHTML = tile(tr('BTC ที่ถือ', 'BTC held'), btcN(s.holdings), (s.pctSupply != null ? s.pctSupply.toFixed(2) + tr('% ของ BTC ทั้งหมด · ', '% of all BTC · ') : '') + tr('มูลค่า ', 'worth ') + usdShort(value), C.lth)
      + tile(tr('ต้นทุนเฉลี่ย', 'Average cost'), usd(avg), tr('จ่ายไปรวม ', 'Paid in total ') + usdShort(s.cost), C.rp)
      + tile(tr('กำไร/ขาดทุน (ยังไม่ขาย)', 'Unrealised profit/loss'), '<span class="' + cls(pnl) + '">' + (pnl > 0 ? '+' : '') + usdShort(pnl) + '</span>', '<b class="' + cls(pnl) + '">' + pct(P / avg - 1) + '</b> ' + tr('เทียบต้นทุน', 'vs cost'))
      + tile('mNAV', s.mnav != null ? s.mnav.toFixed(2) + '×' : '–', s.mnav == null ? '' : s.mnav < 1 ? tr('หุ้นถูกกว่า BTC ที่บริษัทถือ', 'shares worth less than its BTC') : tr('หุ้นแพงกว่า BTC ที่บริษัทถือ', 'shares worth more than its BTC'));
    const pts = [];
    pts.push(P < avg
      ? tr('BTC ต้องขึ้นอีก ' + pct(avg / P - 1) + ' ไปที่ ' + usd(avg) + ' พอร์ตของ Strategy ถึงจะกลับมาเท่าทุน', 'BTC has to rise ' + pct(avg / P - 1) + ' to ' + usd(avg) + ' for Strategy\'s stack to break even.')
      : tr('Strategy ยังกำไร BTC ต้องลงอีก ' + pct(avg / P - 1) + ' ไปที่ ' + usd(avg) + ' ถึงจะขาดทุน', 'Strategy is in profit; BTC would have to fall ' + pct(avg / P - 1) + ' to ' + usd(avg) + ' for it to be at a loss.'));
    if(st.lastBuy) pts.push(tr('ซื้อล่าสุด ' + dLong(Date.parse(st.lastBuy.date)) + ' จำนวน ' + btcN(st.lastBuy.btc) + ' BTC' + (st.lastBuy.usd ? ' เฉลี่ย ' + usd(st.lastBuy.usd / st.lastBuy.btc) + '/BTC' : '') + ' · 30 วันล่าสุดซื้อรวม ' + btcN(st.bought30) + ' BTC · 90 วัน ' + btcN(st.bought90) + ' BTC',
      'Latest buy ' + dLong(Date.parse(st.lastBuy.date)) + ': ' + btcN(st.lastBuy.btc) + ' BTC' + (st.lastBuy.usd ? ' at ' + usd(st.lastBuy.usd / st.lastBuy.btc) + '/BTC' : '') + ' · bought ' + btcN(st.bought30) + ' BTC in the last 30 days, ' + btcN(st.bought90) + ' in 90 days.'));
    if(st.sells365) pts.push(tr('ในรอบ 12 เดือน Strategy ขาย BTC ' + st.sells365 + ' ครั้ง รวม ' + btcN(st.sold365) + ' BTC (ดูรายการด้านล่าง)', 'In the last 12 months Strategy sold BTC ' + st.sells365 + ' times, ' + btcN(st.sold365) + ' BTC in total (see the list below).'));
    if(s.mnav != null) pts.push(s.mnav < 1
      ? tr('mNAV ' + s.mnav.toFixed(2) + ' คือตลาดให้ราคาหุ้นต่ำกว่า BTC ที่บริษัทถือ การออกหุ้นใหม่มาซื้อ BTC จะลดมูลค่าต่อหุ้น จึงซื้อเพิ่มได้ยากขึ้น', 'An mNAV of ' + s.mnav.toFixed(2) + ' means the market values the shares below the BTC held, so issuing shares to buy more BTC dilutes holders and gets harder.')
      : tr('mNAV ' + s.mnav.toFixed(2) + ' คือตลาดให้ราคาหุ้นสูงกว่า BTC ที่ถือ บริษัทยังออกหุ้นมาซื้อ BTC เพิ่มได้คุ้ม', 'An mNAV of ' + s.mnav.toFixed(2) + ' means the shares are valued above the BTC held, so issuing shares to buy more BTC still adds BTC per share.'));
    el('ocMstrPoints').innerHTML = pts.map(x => '<li>' + x + '</li>').join('');
    el('ocMstrTx').innerHTML = '<thead><tr><th>' + tr('วันที่', 'Date') + '</th><th>' + tr('รายการ', 'Type') + '</th><th>BTC</th><th>' + tr('ราคาเฉลี่ย', 'Avg price') + '</th><th>' + tr('ถือรวม', 'Holdings') + '</th><th></th></tr></thead><tbody>'
      + T.tx.slice(-8).reverse().map(t => '<tr><td>' + dLong(Date.parse(t.date)) + '</td><td class="' + (t.type === 'buy' ? 'oc-up' : 'oc-dn') + '">' + (t.type === 'buy' ? tr('ซื้อ', 'Buy') : tr('ขาย', 'Sell')) + '</td><td>' + btcN(t.btc) + '</td><td>' + (t.usd ? usd(t.usd / t.btc) : '–') + '</td><td>' + btcN(t.balance) + '</td><td>'
        + (t.url ? '<a href="' + esc(t.url) + '" target="_blank" rel="noopener">' + (/8-k/i.test(t.url) ? '8-K' : tr('ที่มา', 'Source')) + ' ↗</a>' : '') + '</td></tr>').join('') + '</tbody>';
    el('ocMstrTop').innerHTML = '<thead><tr><th>' + tr('บริษัท', 'Company') + '</th><th>BTC</th><th>' + tr('ต้นทุนเฉลี่ย', 'Avg cost') + '</th></tr></thead><tbody>'
      + (T.top || []).map(c => '<tr><td>' + esc(c.name) + ' <small>' + esc(c.symbol) + '</small></td><td>' + btcN(c.btc) + '</td><td>' + (c.avgCost ? usd(c.avgCost) : '<small>' + tr('ไม่เปิดเผย', 'n/a') + '</small>') + '</td></tr>').join('') + '</tbody>';
  }
  function mstrCharts(){
    const T = S.T, D = S.D; if(!T || !D || !T.tx.length) return;
    const from = Math.max(0, Math.floor((Date.parse(T.tx[0].date + 'T00:00:00Z') - D.t0) / DAY)), to = D.lastP;
    const ms = mstrSeries(T.tx, D.t(from), D.t(to)), pad = a => new Array(from).fill(null).concat(a);
    const avg = pad(ms.avg), bal = pad(ms.bal), zero = bal.map(v => v == null ? null : 0);
    ocChart(el('ocMstrChart'), { from, to, t: D.t, log: true, yFmt: usdShort, H: 260,
      series: [{ name: tr('ราคา BTC', 'BTC price'), color: C.price, values: D.price, width: 1.6, fmt: usd }, { name: tr('ต้นทุนเฉลี่ย Strategy', 'Strategy average cost'), color: C.rp, values: avg, fmt: usd }],
      extra: i => D.price[i] && avg[i] ? '<div class="d">' + tr('กำไร/ขาดทุน ', 'Profit/loss ') + pct(D.price[i] / avg[i] - 1) + '</div>' : '',
      label: tr('ราคา BTC เทียบต้นทุนเฉลี่ยของ Strategy', 'BTC price against Strategy\'s average cost') });
    ocChart(el('ocMstrHoldChart'), { from, to, t: D.t, zero: true, yFmt: v => btcShort(v), H: 150,
      series: [{ name: tr('BTC ที่ถือ', 'BTC held'), color: C.lth, kind: 'band', lo: zero, hi: bal, op: 0.5, tip: bal, fmt: v => btcN(v) + ' BTC' }],
      label: tr('จำนวน BTC ที่ Strategy ถือ', 'BTC held by Strategy') });
  }

  // ---------- wiring ----------
  function note(){
    el('ocNote').innerHTML = tr('ต้นทุนเฉลี่ย (Realized Price) และจำนวนเหรียญคนถือยาว/สั้น: ไฟล์สาธารณะของ BGeometrics (charts.bgeometrics.com) อัปเดตทุกวัน แต่หน่วงไว้ราว 1 สัปดาห์ · ต้นทุนคนถือสั้นมีย้อนหลังราว 4 ปี · MVRV = ราคา ÷ ต้นทุน (คำนวณเอง) · Power law: คำนวณเองจากราคารายวันตั้งแต่ 2011 · Strategy และบริษัทอื่น: CoinGecko public treasury (อ้างอิงแบบ 8-K) · ต้นทุนเฉลี่ยรายวันในกราฟคำนวณเองจากรายการซื้อขาย อาจต่างจากตัวเลขของบริษัทเล็กน้อย',
      'Realized prices and long/short-term holder supply: BGeometrics public files (charts.bgeometrics.com), updated daily but held back about a week · short-term holder cost covers about 4 years · MVRV = price ÷ cost (computed here) · Power law: fitted here on daily prices since 2011 · Strategy and other companies: CoinGecko public treasury (from 8-K filings) · the daily average cost in the chart is rebuilt from the filings and can differ slightly from the company\'s figure');
  }
  function renderAll(){
    try{ costSummary(); costChart(); }catch(e){}
    try{ holdSummary(); holdCharts(); }catch(e){}
    try{ plSummary(); plChart(); }catch(e){}
    try{ mstrSummary(); mstrCharts(); }catch(e){}
  }
  function status(){
    const s = el('ocStatus'), D = S.D, T = S.T, parts = [];
    if(D) parts.push(tr('on-chain ถึง ', 'on-chain to ') + dLong(D.t(Math.min(lastIdx(D.rp), lastIdx(D.ls)))));
    else if(S.holdErr) parts.push(tr('ดึงข้อมูล on-chain ไม่สำเร็จ ลองรีเฟรชอีกครั้ง', 'Could not load on-chain data, refresh to retry'));
    if(T){ const lt = T.tx[T.tx.length - 1]; if(lt) parts.push('Strategy ' + tr('ถึง ', 'to ') + dLong(Date.parse(lt.date))); }
    else if(S.mstrErr) parts.push(tr('ดึงข้อมูล Strategy ไม่สำเร็จ', 'Could not load Strategy data'));
    if(parts.length) s.textContent = parts.join(' · ');
  }

  let started = false;
  window.ocActivate = function(){
    if(started) return; started = true;
    note();
    seg(el('ocCostMode'), v => { S.costMode = v; costChart(); });
    seg(el('ocCostRange'), v => { S.costRange = +v; costChart(); });
    seg(el('ocHoldRange'), v => { S.holdRange = +v; holdCharts(); });
    seg(el('ocPlAxis'), v => { S.plAxis = v; plChart(); });
    seg(el('ocPlRange'), v => { S.plRange = +v; plChart(); });
    const hp = loadHolders().then(d => { S.D = prep(d); S.pl = fitPowerLaw(S.D); }).catch(() => { S.holdErr = true; });
    const tp = loadTreasury().then(t => { S.T = t; }).catch(() => { S.mstrErr = true; });
    hp.then(() => { try{ costSummary(); costChart(); holdSummary(); holdCharts(); plSummary(); plChart(); }catch(e){} status(); });
    tp.then(() => { try{ mstrSummary(); }catch(e){} status(); });
    Promise.all([hp, tp]).then(() => { try{ mstrSummary(); mstrCharts(); }catch(e){} status(); });
    // the live price moves the "now" numbers; charts stay as they are
    let shownP = 0, shownAt = 0;
    setInterval(() => {
      if(document.hidden || !document.body.classList.contains('theme-btc')) return;
      const p = livePrice(); if(!p || (Math.abs(p / (shownP || 1) - 1) < 0.001 && Date.now() - shownAt < 30000)) return;
      shownP = p; shownAt = Date.now();
      try{ costSummary(); plSummary(); mstrSummary(); }catch(e){}
    }, 5000);
    let rz = null, lastW = window.innerWidth;
    window.addEventListener('resize', () => { if(window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(rz); rz = setTimeout(() => { if(document.body.classList.contains('theme-btc')) renderAll(); else S.dirty = true; }, 250); });
    window.ocRedraw = () => { if(S.dirty){ S.dirty = false; renderAll(); } };
  };
  window.__oc = { ocBuild, ocShapeTreasury, prep, fitPowerLaw, holderVerdict, mstrSeries, mstrStats, shareBelow, ocChart, S, renderAll };   // tests
})();
