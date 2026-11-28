if(window.giApplyStatic) window.giApplyStatic();   // ข้อความ data-en ของแท็บ BTC
(function(){
  const tr = window.tr || ((th) => th);

  // ---------- interpolation helper ----------
  // points: array of [value, score], sorted by value ascending. score 10 = most attractive to buy.
  function interpScore(value, points){
    if(value <= points[0][0]) return points[0][1];
    if(value >= points[points.length-1][0]) return points[points.length-1][1];
    for(let i=0;i<points.length-1;i++){
      const [v0,s0] = points[i];
      const [v1,s1] = points[i+1];
      if(value >= v0 && value <= v1){
        const t = (value - v0) / (v1 - v0);
        return s0 + t*(s1-s0);
      }
    }
    return points[points.length-1][1];
  }

  const NUPL_POINTS = [[-0.5,10],[0,8.5],[0.25,7],[0.5,5],[0.75,3],[1.0,1]];
  const Z_POINTS     = [[-2,10],[0,8.5],[1,7],[3,5],[5,3],[7,1.5],[9,1]];
  const MVRV_POINTS  = [[0.8,10],[1,9],[1.5,7],[2,5.5],[2.5,4],[3.5,2],[4.5,1]];
  // อีก 3 มุมที่ไม่ได้มาจาก Realized Cap ทั้งตลาดเหมือน NUPL/MVRV/MVRV-Z (สามตัวนั้นนับรวมเป็นมุมเดียว)
  // ราคา ÷ ต้นทุนคนถือสั้น (STH): ต่ำกว่า 1 = คนซื้อช่วง ~5 เดือนล่าสุดขาดทุนเฉลี่ย
  const STH_POINTS   = [[0.7,10],[0.85,8.5],[1,6.5],[1.2,4.5],[1.5,2.5],[2,1]];
  // ตำแหน่งเทียบ Power Law (0 = ถูกสุดเทียบเส้นในอดีต, 1 = แพงสุด)
  const PL_POINTS    = [[0,10],[0.1,9],[0.3,7],[0.5,5],[0.7,3],[0.9,1.5],[1,1]];
  // Puell Multiple: รายได้นักขุดวันนี้ ÷ ค่าเฉลี่ย 365 วัน (ต่ำ = นักขุดลำบาก มักเป็นช่วงก้นรอบ)
  const PUELL_POINTS = [[0.4,10],[0.6,8.5],[0.8,7],[1,5.5],[1.5,3.5],[2.5,1.5],[4,1]];

  function nuplZoneLabel(v){
    if(v<0) return tr('Capitulation — โซนตื่นตระหนก', 'Capitulation');
    if(v<0.25) return tr('Hope / Fear — เริ่มมีความหวัง', 'Hope / Fear');
    if(v<0.5) return tr('Optimism / Belief — เชื่อมั่น', 'Optimism / Belief');
    if(v<0.75) return tr('Belief / Denial — มั่นใจสูง', 'Belief / Denial');
    return tr('Euphoria / Greed — คลั่งไคล้ (เสี่ยง)', 'Euphoria / Greed (risky)');
  }
  function zZoneLabel(v){
    if(v<0) return tr('Undervalued อย่างมาก', 'Deeply undervalued');
    if(v<1) return tr('โซนถูก', 'Cheap zone');
    if(v<3) return tr('มูลค่ากลาง (Fair)', 'Fair value');
    if(v<5) return tr('เริ่มแพง', 'Getting expensive');
    if(v<7) return 'Overvalued';
    return tr('Extreme Euphoria (จุดสูงสุดในอดีต)', 'Extreme euphoria (past cycle tops)');
  }
  function mZoneLabel(v){
    if(v<1) return tr('ต่ำกว่าราคาต้นทุนเฉลี่ยของตลาด', 'Below the market\'s average cost basis');
    if(v<1.5) return tr('โซนถูก', 'Cheap zone');
    if(v<2.5) return tr('มูลค่ากลาง (Fair)', 'Fair value');
    if(v<3.5) return 'Overvalued';
    return 'Extreme Overvalued';
  }

  function scoreColor(s){
    if(s>=7) return 'var(--green)';
    if(s>=4) return 'var(--amber)';
    return 'var(--red)';
  }

  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // ---------- elements ----------
  const el = id => document.getElementById(id);

  // ---------- storage: window.storage (Claude artifact) with localStorage fallback ----------
  async function storageGet(key){
    try{
      if(window.storage){ const r = await window.storage.get(key); return r ? r.value : null; }
    }catch(e){}
    try{ return localStorage.getItem(key); }catch(e){ return null; }
  }
  async function storageSet(key, value){
    try{
      if(window.storage){ await window.storage.set(key, value); return; }
    }catch(e){}
    try{ localStorage.setItem(key, value); }catch(e){}
  }

  // Wrap fetch with a hard timeout so one slow/dead API never hangs the whole page.
  async function fetchWithTimeout(url, ms = 6000, opts = {}){
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try{
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  const nuplRange=el('nuplRange'), nuplNum=el('nuplNum'), nuplPill=el('nuplScorePill'), nuplZone=el('nuplZone');
  const zRange=el('zRange'), zNum=el('zNum'), zPill=el('zScorePill'), zZone=el('zZone');
  const mRange=el('mRange'), mNum=el('mNum'), mPill=el('mScorePill'), mZone=el('mZone');
  const nuplDisplay=el('nuplDisplay'), zDisplay=el('zDisplay'), mDisplay=el('mDisplay');
  const priceInput=el('priceInput'), athInput=el('athInput');
  const pxDisplay=el('pxDisplay'), athDisplay=el('athDisplay'), ddDisplay=el('ddDisplay');
  const ddBig=el('ddBig'), ddBar=el('ddBar');
  const needle=null, scoreNumber=el('scoreNumber'), verdict=el('verdict'), breakdown=el('breakdown');
  const statusEl=el('status');
  // ค่าใน 3 ช่องนี้เริ่มจากค่าตั้งต้นใน HTML (0.5 / 3 / 2) ซึ่งไม่ใช่ข้อมูลจริง — ห้ามนับเข้าคะแนนจนกว่าจะได้ค่าจริง
  // (ดึงได้ / แคช / ชุดเดียวกับการ์ดต้นทุน / ผู้ใช้กรอกเอง) เดิมถ้าดึง MVRV-Z ไม่ได้ คะแนนจะคิดจาก 3 เงียบๆ
  [nuplNum, zNum, mNum].forEach(n => { n.dataset.placeholder = '1'; });
  const markReal = n => { delete n.dataset.placeholder; };
  const isReal = n => n.dataset.placeholder !== '1';

  // ---------- manual fallback toggle (hidden unless auto-fetch fails, or user opts in) ----------
  function wireManualToggle(btnId, rowId){
    const btn = el(btnId), row = el(rowId);
    btn.addEventListener('click', () => {
      const showing = row.style.display !== 'none';
      row.style.display = showing ? 'none' : 'flex';
      btn.textContent = showing ? tr('✏️ กรอกเองชั่วคราว', '✏️ Enter manually') : tr('✕ ซ่อนช่องกรอกเอง', '✕ Hide manual input');
    });
  }
  wireManualToggle('nuplManualBtn', 'nuplManualRow');
  wireManualToggle('zManualBtn', 'zManualRow');
  wireManualToggle('mManualBtn', 'mManualRow');

  function syncPair(range, num){
    range.addEventListener('input', ()=>{ num.value = range.value; markReal(num); recompute(); save(); });
    num.addEventListener('input', ()=>{ range.value = num.value; markReal(num); recompute(); save(); });
  }
  syncPair(nuplRange, nuplNum);
  syncPair(zRange, zNum);
  syncPair(mRange, mNum);
  // จำว่าผู้ใช้พิมพ์ราคา/ATH เองหรือเปล่า — ไม่งั้นทุกครั้งที่รีเฟรช ระบบ auto-fetch จะทับค่าที่พิมพ์เอง
  // เงียบๆ (ป้ายบนหน้าจอเขียนว่า "แก้เองได้เสมอ" แต่ของเดิมโดนทับทุกครั้ง)
  priceInput.addEventListener('input', ()=>{ priceInput.dataset.manual='1'; recompute(); save(); });
  athInput.addEventListener('input', ()=>{ athInput.dataset.manual='1'; recompute(); save(); });

  function fmtUSD(n){
    if(n==null || isNaN(n)) return '—';
    return '$' + Number(n).toLocaleString(undefined,{maximumFractionDigits:0});
  }

  function timeAgo(ts){
    if(!ts) return '';
    const mins = Math.round((Date.now() - ts) / 60000);
    if(mins < 1) return tr('เมื่อสักครู่', 'just now');
    if(mins < 60) return mins + tr(' นาทีที่แล้ว', ' min ago');
    const hrs = Math.round(mins / 60);
    return hrs + tr(' ชม.ที่แล้ว', 'h ago');
  }

  function recompute(){
    if(lastMining) renderMining();   // price moved → cost margin / miner verdict follow it
    const nupl = isReal(nuplNum) ? parseFloat(nuplNum.value) : NaN;
    const z = isReal(zNum) ? parseFloat(zNum.value) : NaN;
    const m = isReal(mNum) ? parseFloat(mNum.value) : NaN;
    const price = parseFloat(priceInput.value);
    const ath = parseFloat(athInput.value);

    // interpScore(NaN) เคยได้คะแนนต่ำสุด (1) — ค่าที่ไม่มีต้องเป็น NaN แล้วไม่ถูกนับ
    const sNupl = isNaN(nupl) ? NaN : interpScore(nupl, NUPL_POINTS);
    const sZ = isNaN(z) ? NaN : interpScore(z, Z_POINTS);
    const sM = isNaN(m) ? NaN : interpScore(m, MVRV_POINTS);

    nuplDisplay.textContent = isNaN(nupl) ? '–' : nupl.toFixed(3);
    zDisplay.textContent = isNaN(z) ? '–' : z.toFixed(2);
    mDisplay.textContent = isNaN(m) ? '–' : m.toFixed(2);

    nuplPill.textContent = isNaN(sNupl) ? '–' : sNupl.toFixed(1);
    nuplPill.style.background = 'transparent'; nuplPill.style.color = scoreColor(sNupl);
    nuplPill.style.border = '1px solid ' + scoreColor(sNupl);
    nuplZone.textContent = isNaN(nupl) ? tr('รอข้อมูล', 'loading') : nuplZoneLabel(nupl);

    zPill.textContent = isNaN(sZ) ? '–' : sZ.toFixed(1);
    zPill.style.background='transparent'; zPill.style.color = scoreColor(sZ);
    zPill.style.border = '1px solid ' + scoreColor(sZ);
    zZone.textContent = isNaN(z) ? tr('รอข้อมูล', 'loading') : zZoneLabel(z);

    mPill.textContent = isNaN(sM) ? '–' : sM.toFixed(1);
    mPill.style.background='transparent'; mPill.style.color = scoreColor(sM);
    mPill.style.border = '1px solid ' + scoreColor(sM);
    mZone.textContent = isNaN(m) ? tr('รอข้อมูล', 'loading') : mZoneLabel(m);

    let dd = null;
    if(price && ath && ath>0){
      dd = Math.max(0, (1 - price/ath) * 100);
    }

    // 4 มุมที่ไม่ซ้ำกัน ให้น้ำหนักเท่ากัน มุมไหนยังไม่มีข้อมูลก็ไม่นับ (ไม่เดาแทน)
    // ไม่มีโบนัส ATH drawdown แล้ว: ราคาที่ลงลึกทำให้ MVRV/STH/Power Law ต่ำลงเองอยู่แล้ว ถ้าบวกอีกจะนับซ้ำ
    const sig = window.giBtcSignals || {};
    const valParts = [sNupl, sZ, sM].filter(isNum);
    const avg = valParts.length ? valParts.reduce((a, b) => a + b, 0) / valParts.length : NaN;
    const pillars = [
      { key: 'val', name: tr('มูลค่าเทียบต้นทุนทั้งตลาด', 'Value vs whole-market cost'), note: 'NUPL · MVRV · MVRV-Z', v: isNaN(avg) ? null : avg },
      { key: 'sth', name: tr('ราคาเทียบต้นทุนคนถือสั้น', 'Price vs short-term holder cost'), note: isNum(sig.sthRatio) ? '× ' + sig.sthRatio.toFixed(2) : '', v: isNum(sig.sthRatio) ? interpScore(sig.sthRatio, STH_POINTS) : null },
      { key: 'pl', name: tr('ตำแหน่งเทียบ Power Law', 'Position vs power law'), note: isNum(sig.plPos) ? Math.round(sig.plPos * 100) + '%' : '', v: isNum(sig.plPos) ? interpScore(sig.plPos, PL_POINTS) : null },
      { key: 'puell', name: tr('รายได้นักขุด (Puell)', 'Miner revenue (Puell)'), note: isNum(sig.puell) ? sig.puell.toFixed(2) : '', v: isNum(sig.puell) ? interpScore(sig.puell, PUELL_POINTS) : null }
    ];
    const have = pillars.filter(p => isNum(p.v));
    const rawTotal = have.length ? have.reduce((a, p) => a + p.v, 0) / have.length : NaN;
    const final = Math.min(10, Math.max(1, rawTotal));

    // update price / dd UI
    pxDisplay.textContent = price ? fmtUSD(price) : '—';
    athDisplay.textContent = ath ? fmtUSD(ath) : '—';
    ddDisplay.textContent = dd!=null ? '-' + dd.toFixed(1) + '%' : '—';
    ddBig.textContent = dd!=null ? '-' + dd.toFixed(1) + '%' : '—';
    ddBar.style.width = dd!=null ? Math.min(100, dd) + '%' : '0%';

    // gauge needle removed — just color the big number
    scoreNumber.textContent = isNaN(final) ? '–' : final.toFixed(1);
    scoreNumber.style.color = isNaN(final) ? '' : scoreColor(final);

    let verdictText, verdictColor;
    if(isNaN(final)){ verdictText=tr('รอข้อมูล…', 'Waiting for data…'); verdictColor='var(--sub)'; }
    else if(final>=8){ verdictText=tr('ถูกมากเมื่อเทียบกับประวัติ', 'Historically very cheap'); verdictColor='var(--green)'; }
    else if(final>=6.5){ verdictText=tr('ค่อนข้างถูกเมื่อเทียบกับประวัติ', 'Historically cheap'); verdictColor='var(--green)'; }
    else if(final>=4){ verdictText=tr('กลาง ๆ เมื่อเทียบกับประวัติ', 'Around historical fair value'); verdictColor='var(--amber)'; }
    else if(final>=2.5){ verdictText=tr('ค่อนข้างแพงเมื่อเทียบกับประวัติ', 'Historically expensive'); verdictColor='var(--red)'; }
    else{ verdictText=tr('แพงมาก ใกล้โซนคึกคักเกินเหตุในอดีต', 'Very expensive, near past euphoria'); verdictColor='var(--red)'; }
    verdict.textContent = verdictText;
    verdict.style.borderColor = verdictColor;
    verdict.style.color = verdictColor;

    const row = p => '<div class="bs-row' + (isNum(p.v) ? '' : ' off') + '"><span>' + p.name + (p.note ? ' <small>' + p.note + '</small>' : '') + '</span>'
      + '<span class="bs-bar"><i style="width:' + (isNum(p.v) ? (p.v * 10).toFixed(0) : 0) + '%;background:' + (isNum(p.v) ? scoreColor(p.v) : 'transparent') + '"></i></span>'
      + '<span class="v"' + (isNum(p.v) ? ' style="color:' + scoreColor(p.v) + '"' : '') + '>' + (isNum(p.v) ? p.v.toFixed(1) : tr('รอข้อมูล', 'loading')) + '</span></div>';
    breakdown.innerHTML = pillars.map(row).join('')
      + '<div class="bs-foot">' + tr('เฉลี่ย ' + have.length + ' จาก 4 มุมที่ไม่ซ้ำกัน · NUPL, MVRV และ MVRV-Z มาจากข้อมูลชุดเดียวกัน จึงนับรวมเป็นมุมเดียว · ใช้ดูว่าราคาถูกหรือแพงเทียบอดีต ไม่ใช่คำแนะนำการลงทุน',
        'Average of ' + have.length + ' of 4 independent angles · NUPL, MVRV and MVRV-Z come from the same data, so they count as one · shows cheap vs expensive against history, not investment advice') + '</div>';
  }

  // ค่า MVRV / NUPL ใช้ชุดเดียวกับการ์ดต้นทุนตลาดด้านล่าง (ราคาสด ÷ ต้นทุนเฉลี่ย) ตัวเลขทั้งแท็บจึงตรงกัน
  // ถ้าผู้ใช้เปิดช่องกรอกเองอยู่ จะไม่ทับค่าที่พิมพ์
  function applySharedValuation(){
    const g = window.giBtcSignals || {};
    if(isNum(g.mvrv) && el('mManualRow').style.display === 'none'){
      mNum.value = g.mvrv.toFixed(2); markReal(mNum); mRange.value = Math.max(0.8, Math.min(4.5, g.mvrv));
      setBadge('mAuto', true, Date.now());
      el('mUpdated').textContent = tr('ราคาสด ÷ ต้นทุนเฉลี่ยทั้งตลาด (ชุดเดียวกับการ์ดต้นทุนด้านล่าง)', 'Live price ÷ market cost basis (same data as the cost card below)');
    }
    if(isNum(g.nupl) && el('nuplManualRow').style.display === 'none'){
      nuplNum.value = g.nupl.toFixed(3); markReal(nuplNum); nuplRange.value = Math.max(-0.5, Math.min(1, g.nupl));
      setBadge('nuplAuto', true, Date.now());
      el('nuplUpdated').textContent = tr('= 1 − 1/MVRV (ข้อมูลชุดเดียวกับ MVRV)', '= 1 − 1/MVRV (same data as MVRV)');
    }
  }
  window.addEventListener('gi-btc-signals', () => { applySharedValuation(); recompute(); });
  window.__buyTest = { recompute, applySharedValuation };   // tests

  // ---------- persistence ----------
  let saveTimer=null;
  function save(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async ()=>{
      await storageSet('btc-score-inputs', JSON.stringify({
        nupl: nuplNum.value, z: zNum.value, m: mNum.value,
        real: { nupl: isReal(nuplNum), z: isReal(zNum), m: isReal(mNum) },
        price: priceInput.value, ath: athInput.value,
        // เก็บ flag ไว้ด้วย ไม่งั้นเปิดหน้าใหม่แล้วราคาที่พิมพ์เองจะถูก auto-fetch ทับ
        priceManual: priceInput.dataset.manual === '1',
        athManual: athInput.dataset.manual === '1',
        bgToken: el('bgToken').value
      }));
    }, 400);
  }

  async function load(){
    try{
      const raw = await storageGet('btc-score-inputs');
      if(raw){
        const d = JSON.parse(raw);
        // บันทึกรุ่นเก่าไม่มี real → ถือว่าจริงเฉพาะค่าที่ไม่ใช่ค่าตั้งต้นใน HTML
        const wasReal = (k, n, v) => d.real ? !!d.real[k] : String(v) !== n.defaultValue;
        if(d.nupl!=null){ nuplNum.value=d.nupl; nuplRange.value=d.nupl; if(wasReal('nupl', nuplNum, d.nupl)) markReal(nuplNum); }
        if(d.z!=null){ zNum.value=d.z; zRange.value=d.z; if(wasReal('z', zNum, d.z)) markReal(zNum); }
        if(d.m!=null){ mNum.value=d.m; mRange.value=d.m; if(wasReal('m', mNum, d.m)) markReal(mNum); }
        if(d.price) priceInput.value=d.price;
        if(d.ath) athInput.value=d.ath;
        if(d.priceManual) priceInput.dataset.manual='1';
        if(d.athManual) athInput.dataset.manual='1';
        if(d.bgToken) el('bgToken').value=d.bgToken;
      }
    }catch(e){ /* no saved data yet */ }
    recompute();
  }
  el('bgToken').addEventListener('change', save);

  // ---------- fetch live price/ATH ----------
  // ราคาสดล่าสุดที่ดึงได้ ใช้คำนวณ Open Interest (USD → BTC) เสมอ แม้ช่องกรอกจะถูกผู้ใช้แก้เองอยู่
  let lastLivePrice = null;
  let lastLiveAt = 0;   // เวลาที่ได้ราคาจากสตรีมสดล่าสุด (ดูด้านล่าง "ราคา BTC แบบเรียลไทม์")

  async function fetchPrice(){
    try{
      const r = await fetchWithTimeout('https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false', 6000);
      const data = await r.json();
      const price = data.market_data.current_price.usd;
      const ath = data.market_data.ath.usd;
      if(!isFinite(price) || !isFinite(ath)) throw new Error('no price in CoinGecko response');
      // ไม่ทับค่าที่ผู้ใช้พิมพ์เอง (ถ้าอยากกลับไปใช้ค่าสด กดปุ่ม "↻ ใช้ราคาสด" ที่การ์ด ATH)
      // ถ้าสตรีมสดจาก Binance ทำงานอยู่ ไม่เอาราคา CoinGecko (ช้ากว่า 1–5 นาที) มาทับให้ตัวเลขกระโดดถอยหลัง
      const streaming = Date.now() - lastLiveAt < 60000;
      if(!streaming) lastLivePrice = Math.round(price);
      if(priceInput.dataset.manual !== '1' && !streaming) priceInput.value = Math.round(price);
      if(athInput.dataset.manual !== '1') athInput.value = Math.round(ath);
      return true;
    }catch(e){
      return false;
    }
  }

  // ปุ่ม "↻ ใช้ราคาสด" — ล้าง flag ที่ว่าผู้ใช้แก้เอง แล้วดึงราคาตลาดกลับมาใส่ช่องกรอก
  const useLivePriceBtn = el('useLivePriceBtn');
  if(useLivePriceBtn){
    useLivePriceBtn.addEventListener('click', async ()=>{
      delete priceInput.dataset.manual;
      delete athInput.dataset.manual;
      useLivePriceBtn.textContent = tr('⏳ กำลังดึงราคาสด…', '⏳ Fetching live price…');
      const ok = await fetchPrice();
      useLivePriceBtn.textContent = ok ? tr('↻ ใช้ราคาสด', '↻ Use live price') : tr('↻ ลองใหม่', '↻ Try again');
      if(!ok) statusEl.textContent = tr('ดึงราคาสดไม่สำเร็จ — ลองกด "รีเฟรชทั้งหมด" อีกครั้ง', 'Couldn\'t fetch the live price. Try "Refresh all" again.');
      recompute(); save();
    });
  }

  // ---------- fetch on-chain metrics (NUPL / MVRV Z-Score / MVRV Ratio) ----------
  // Primary source: BGeometrics / bitcoin-data.com Bitcoin Data API (api.bgeometrics.com).
  // Works with or without a token, but a free token (portal.bgeometrics.com/login, no card
  // needed) raises the limit from a very tight anonymous/IP quota to 8 req/hour · 15 req/day.
  // A couple of candidate endpoint slugs are tried per metric since the exact slug isn't
  // documented in one single place — first one that returns valid JSON wins.
  // Fallback: if BGeometrics fails (no token + rate-limited, endpoint down, etc.) we silently
  // fall back to deriving the same 3 metrics live from Coin Metrics' free Community API
  // (raw Market Cap / Realized Cap → MVRV Ratio, NUPL, MVRV Z-Score), so the dashboard still
  // works even without a BGeometrics token.

  // Fallback: CoinMetrics Community API used to work here, but as of testing it now
  // returns HTTP 400 even on textbook-exact requests — the free community tier appears
  // to be discontinued/broken. Removed as a fallback (no point calling a dead endpoint).
  // Instead: every attempt is logged so failures are diagnosable, not silent.
  let debugLog = [];
  function logAttempt(label, url, result){
    debugLog.push({ label, url, result, ts: new Date().toLocaleTimeString() });
  }
  // escape ก่อนยัดลง innerHTML — d.result/d.url มีข้อความจาก response ของ API ภายนอก (และจาก token
  // ที่ผู้ใช้พิมพ์เอง) ปนอยู่ จึงไม่ควรถือว่าเป็น HTML ที่ปลอดภัย
  function dbgEsc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  }
  function renderDebugLog(){
    const box = el('debugLog');
    if(!box) return;
    box.innerHTML = debugLog.map(d =>
      `<div>${dbgEsc(d.ts)} · <b>${dbgEsc(d.label)}</b> → ${dbgEsc(d.result)}<br><span style="opacity:0.6;">${dbgEsc(d.url)}</span></div>`
    ).join('<hr style="border-color:var(--line); margin:6px 0;">');
  }

  function bgToken(){ return (el('bgToken').value || '').trim(); }
  function bgUrl(slug){
    const t = bgToken();
    return 'https://api.bgeometrics.com/v1/' + slug + (t ? ('?token=' + encodeURIComponent(t)) : '');
  }

  function extractLatestValue(json){
    let item = json;
    if(Array.isArray(json)) item = json[json.length-1];
    else if(json && Array.isArray(json.data)) item = json.data[json.data.length-1];
    if(item==null) return null;
    if(typeof item !== 'object'){ const v=parseFloat(item); return isNaN(v)?null:v; }
    for(const k in item){
      if(/date|time|unix|^d$|^thedate$/i.test(k)) continue;
      const v = parseFloat(item[k]);
      if(!isNaN(v)) return v;
    }
    return null;
  }

  async function tryBgSlugs(slugs){
    for(const slug of slugs){
      const url = bgUrl(slug);

      // Attempt 1: direct call (works if BGeometrics ever enables CORS for this origin).
      try{
        const r = await fetchWithTimeout(url, 5000);
        if(r.ok){
          const json = await r.json();
          const v = extractLatestValue(json);
          if(v!=null && !isNaN(v)){ logAttempt(slug, url, 'OK (direct) → ' + v); return v; }
          logAttempt(slug, url, tr('OK แต่ parse ค่าไม่ได้ (', 'OK but could not parse a value (') + JSON.stringify(json).slice(0,120) + ')');
        }else{
          logAttempt(slug, url, 'HTTP ' + r.status + ' (direct)');
        }
      }catch(e){
        logAttempt(slug, url, 'CORS/network block (direct): ' + e.message);
      }

      // Attempt 2: same request routed through a free CORS proxy (allorigins.win) —
      // needed because api.bgeometrics.com doesn't send CORS headers for browser calls.
      const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      try{
        const r2 = await fetchWithTimeout(proxyUrl, 6000);
        if(r2.ok){
          const json2 = await r2.json();
          const v2 = extractLatestValue(json2);
          if(v2!=null && !isNaN(v2)){ logAttempt(slug, proxyUrl, 'OK (via proxy) → ' + v2); return v2; }
          logAttempt(slug, proxyUrl, tr('OK (proxy) แต่ parse ค่าไม่ได้', 'OK (proxy) but could not parse a value'));
        }else{
          logAttempt(slug, proxyUrl, 'HTTP ' + r2.status + ' (proxy)');
        }
      }catch(e2){
        logAttempt(slug, proxyUrl, tr('proxy ก็ล้มเหลว: ', 'proxy failed too: ') + e2.message);
      }
    }
    return null;
  }

  const BG_SLUGS = {
    nupl: ['nupl/last', 'nupl'],
    z: ['mvrv-zscore/last', 'mvrv-zscore', 'mvrv-z-score/last'],
    m: ['mvrv/last', 'mvrv']
  };

  // ชั้นแรก (เพิ่มใหม่): ให้เซิร์ฟเวอร์ของเราดึงให้ผ่าน /.netlify/functions/onchain
  // เหตุผล: api.bgeometrics.com ไม่ส่ง CORS header → เบราว์เซอร์ยิงตรงไม่เคยได้ ต้องพึ่ง proxy ฟรี
  // (allorigins) ซึ่งหลุดบ่อย และโควต้า BGeometrics (8 ครั้ง/ชม. · 15 ครั้ง/วัน/IP) เป็น "ต่อ IP"
  // → ผู้ใช้แต่ละคนกินโควต้าตัวเอง แถมยิง 2 นาทีต่อ 1 ค่า (ยิงตรงที่ต้องโดนบล็อก + ยิงผ่าน proxy)
  // พอย้ายมาฝั่งเซิร์ฟเวอร์: ไม่มี CORS, แคช 8 ชม. ใช้ร่วมกันทุกคน, และถ้าตั้ง env BGEOMETRICS_TOKEN
  // ไว้ที่ Netlify ก็ใช้โควต้าตัวนั้น — ผู้ใช้ไม่ต้องพิมพ์ token ในหน้าเว็บอีก
  const SERVER_METRIC = { nupl: 'nupl', z: 'mvrv-zscore', m: 'mvrv' };
  async function tryServerMetric(key){
    const metric = SERVER_METRIC[key];
    if(!metric) return null;
    const url = '/.netlify/functions/onchain?metric=' + metric;
    try{
      const r = await fetchWithTimeout(url, 8000);
      const j = await r.json();
      const v = parseFloat(j && j.value);
      if(!isFinite(v)){
        const why = (j && j.error) ? j.error + (j.details && j.details.length ? ' — ' + j.details.join(' | ') : '') : 'no value in response';
        throw new Error(why);
      }
      logAttempt(key, url, 'OK (' + tr('เซิร์ฟเวอร์', 'server') + (j.cached ? tr(' · แคช', ' · cached') : '') + (j.stale ? tr(' · ค่าเก่า', ' · stale') : '') + ') → ' + v);
      return v;
    }catch(e){
      logAttempt(key, url, tr('เซิร์ฟเวอร์ดึงไม่ได้: ', 'server fetch failed: ') + e.message);
      return null;
    }
  }

  // ---------- per-metric 8-hour cache ----------
  // These metrics only actually update ~once/day at the source, so refetching more often
  // than every 8h just burns the free BGeometrics quota for nothing. Each metric caches
  // independently, so one metric failing doesn't block the other two from using their cache.
  const CACHE_TTL_MS = 8 * 3600 * 1000;

  const memoryCache = {}; // in-session safety net, in case window.storage read/write ever hiccups

  async function getCache(key){
    try{
      const raw = await storageGet('oc-cache-' + key);
      if(raw) return JSON.parse(raw);
    }catch(e){}
    if(memoryCache[key]) return memoryCache[key]; // fall back to this session's own last-good value
    return null;
  }
  async function setCache(key, value){
    memoryCache[key] = { value, ts: Date.now() };
    await storageSet('oc-cache-' + key, JSON.stringify(memoryCache[key]));
  }

  async function resolveMetric(key, slugs, applyFn, force){
    if(!force){
      const cached = await getCache(key);
      if(cached && (Date.now() - cached.ts) < CACHE_TTL_MS){
        applyFn(cached.value);
        setBadge(key + 'Auto', true, cached.ts);
        logAttempt(key, '(cache)', tr('ใช้ค่าแคช อายุ ' + Math.round((Date.now()-cached.ts)/60000) + ' นาที ไม่ยิง request ใหม่', 'using cached value, ' + Math.round((Date.now()-cached.ts)/60000) + ' min old, no new request'));
        return true;
      }
    }
    // ลำดับ: เซิร์ฟเวอร์เรา → ยิงตรง (เผื่อ CORS เปิดแล้ว) → ผ่าน proxy allorigins
    let v = await tryServerMetric(key);
    if(v == null) v = await tryBgSlugs(slugs);
    if(v != null){
      applyFn(v);
      await setCache(key, v);
      setBadge(key + 'Auto', true, Date.now());
      return true;
    }
    // fetch failed — fall back to stale cache if we have one, otherwise reveal manual entry
    const stale = await getCache(key);
    if(stale){
      applyFn(stale.value);
      setBadge(key + 'Auto', 'stale', stale.ts);
      logAttempt(key, '(fallback)', tr('ดึงใหม่ล้มเหลว ใช้ค่าเก่าจาก ', 'refetch failed, using stale value from ') + new Date(stale.ts).toLocaleString());
      return true;
    }
    logAttempt(key, '(fallback)', tr('ดึงใหม่ล้มเหลว และไม่มีค่าแคชเก่าเลย (ไม่เคยดึงสำเร็จมาก่อนสำหรับตัวนี้)', 'refetch failed and there is no cached value (never fetched successfully for this metric)'));
    setBadge(key + 'Auto', false);
    return false;
  }

  async function fetchOnChainMetrics(force){
    setBadge('nuplAuto', null); setBadge('zAuto', null); setBadge('mAuto', null);
    debugLog = [];

    const [nuplOk, zOk, mOk] = await Promise.all([
      resolveMetric('nupl', BG_SLUGS.nupl, v => { if(window.giBtcSignals && isNum(window.giBtcSignals.nupl)) return; nuplNum.value = v.toFixed(3); markReal(nuplNum); nuplRange.value = Math.max(-0.5,Math.min(1,v)); }, force),
      resolveMetric('z',    BG_SLUGS.z,    v => { zNum.value = v.toFixed(2); markReal(zNum); zRange.value = Math.max(-2,Math.min(9,v)); }, force),
      resolveMetric('m',    BG_SLUGS.m,    v => { if(window.giBtcSignals && isNum(window.giBtcSignals.mvrv)) return; mNum.value = v.toFixed(2); markReal(mNum); mRange.value = Math.max(0.8,Math.min(4.5,v)); }, force)
    ]);

    renderDebugLog();
    return nuplOk || zOk || mOk;
  }

  function setBadge(id, state, ts){
    const b = el(id);
    const metricKey = id.replace('Auto', '');
    const manualBtn = el(metricKey + 'ManualBtn');
    const manualRow = el(metricKey + 'ManualRow');
    const updatedEl = el(metricKey + 'Updated');

    if(state === true){
      b.textContent = tr('อัตโนมัติ ✓', 'Auto ✓'); b.className = 'auto-badge ok';
      if(updatedEl) updatedEl.textContent = tr('อัปเดต ', 'Updated ') + timeAgo(ts);
      if(manualRow) manualRow.style.display = 'none';
      if(manualBtn) manualBtn.textContent = tr('✏️ กรอกเองชั่วคราว', '✏️ Enter manually');
    }else if(state === 'stale'){
      b.textContent = tr('ใช้ค่าเก่า', 'Stale'); b.className = 'auto-badge';
      if(updatedEl) updatedEl.textContent = tr('ดึงใหม่ไม่สำเร็จ — ใช้ค่าจากเมื่อ ', 'Refresh failed, using the value from ') + timeAgo(ts);
      if(manualRow) manualRow.style.display = 'none';
    }else if(state === null){
      b.textContent = '…'; b.className = 'auto-badge';
    }else{
      b.textContent = tr('ดึงไม่สำเร็จ', 'Failed'); b.className = 'auto-badge fail';
      if(updatedEl) updatedEl.textContent = '';
      // auto-reveal the manual fallback so there's still a usable number for the score
      if(manualRow) manualRow.style.display = 'flex';
      if(manualBtn) manualBtn.textContent = tr('✕ ซ่อนช่องกรอกเอง', '✕ Hide manual input');
    }
  }

  // Hyperliquid metaAndAssetCtxs → BTC perp open interest in USD (openInterest is in coins).
  function hyperliquidBtcOiUsd(j){
    if(!Array.isArray(j) || !j[0] || !Array.isArray(j[0].universe) || !Array.isArray(j[1])) return null;
    const i = j[0].universe.findIndex(u => u && u.name === 'BTC');
    const ctx = i >= 0 ? j[1][i] : null;
    const usd = ctx ? (parseFloat(ctx.openInterest) || 0) * (parseFloat(ctx.markPx || ctx.oraclePx) || 0) : 0;
    return usd > 0 ? usd : null;
  }
  // CoinGecko /derivatives list + Hyperliquid USD → one CEX + DEX total, keyed by exchange.
  // Hyperliquid is only added when CoinGecko has no Hyperliquid BTC contract of its own.
  function combineBtcOpenInterest(cgList, hlUsd){
    const byExchange = {};
    let totalUsd = 0;
    (Array.isArray(cgList) ? cgList : []).forEach(t => {
      if(!t || t.index_id !== 'BTC' || t.expired_at != null || !t.open_interest) return;
      const oi = parseFloat(t.open_interest) || 0;
      totalUsd += oi;
      byExchange[t.market] = (byExchange[t.market] || 0) + oi;
    });
    const cgHasHl = Object.keys(byExchange).some(m => /hyperliquid/i.test(m));
    if(hlUsd && !cgHasHl){ totalUsd += hlUsd; byExchange.Hyperliquid = hlUsd; }
    return { totalUsd, byExchange };
  }
  // BTC ที่ขุดออกมาแล้วโดยประมาณ: 19,687,500 BTC ตอน halving 20 เม.ย. 2024 + ~450 BTC/วัน (3.125 × 144 บล็อก)
  // คลาดไม่เกินราว 0.1% ซึ่งพอสำหรับคิดสัดส่วน OI ต่อเหรียญทั้งหมด (halving ครั้งหน้า ~เม.ย. 2028 เหลือ 225/วัน)
  function btcSupplyApprox(now){
    const days = Math.max(0, ((now || Date.now()) - Date.UTC(2024, 3, 20)) / 86400000);
    const toHalving = Math.min(days, (Date.UTC(2028, 3, 17) - Date.UTC(2024, 3, 20)) / 86400000);
    return Math.min(21e6, 19687500 + toHalving * 450 + Math.max(0, days - toHalving) * 225);
  }
  // OI (BTC) ÷ BTC ทั้งหมด = เลเวอเรจในตลาดอนุพันธ์เทียบกับขนาดตลาด (ไม่ต้องใช้ข้อมูลย้อนหลัง)
  function oiLeverageZone(pct){
    if(!(pct > 0)) return null;
    return pct >= 4.5 ? { dot:'🔴', th:'เลเวอเรจสูงมาก', en:'Very high leverage', color:'var(--red)' }
      : pct >= 3.5 ? { dot:'🟠', th:'เลเวอเรจสูง', en:'High leverage', color:'var(--amber)' }
      : pct >= 2.5 ? { dot:'🟡', th:'ปกติ', en:'Normal', color:'' }
      : { dot:'🟢', th:'เลเวอเรจเบา', en:'Light leverage', color:'var(--green)' };
  }
  if(typeof window !== 'undefined') window.__oiTest = { hyperliquidBtcOiUsd, combineBtcOpenInterest, btcSupplyApprox, oiLeverageZone };

  // ---------- Sentiment & Leverage (Fear&Greed + funding rate + open interest) ----------
  // Fear & Greed: CoinMarketCap (keyless public API) เป็นแหล่งหลักตามคำขอผู้ใช้ อัปเดตอัตโนมัติ
  // ลำดับ: Netlify Function (CMC keyless) → ตรง CMC public API → alternative.me fallback
  // Funding Rate / Open Interest: Binance Futures public market-data endpoints, no key needed.
  async function fetchSentimentLeverage(){
    // ---- Fear & Greed from CoinMarketCap (อัตโนมัติ) ----
    let fngDone = false;
    const fngAttempts = [
      {
        name: 'CoinMarketCap (via server)',
        url: '/.netlify/functions/cmc-fear-greed',
        parse: async (r) => {
          const j = await r.json();
          if(!isFinite(j.value)) throw new Error('no value');
          return { v: parseInt(j.value,10), cls: j.classification || j.value_classification || j.valueClassification, src: j.source || 'coinmarketcap' };
        }
      },
      {
        name: 'CoinMarketCap (direct)',
        url: 'https://pro-api.coinmarketcap.com/public-api/v3/fear-and-greed/latest',
        parse: async (r) => {
          const j = await r.json();
          let entry = j.data;
          if(Array.isArray(entry)) entry = entry[0];
          const v = parseInt(entry && entry.value,10);
          const cls = entry && (entry.value_classification || entry.classification || entry.valueClassification);
          if(!isFinite(v)) throw new Error('no value');
          return { v, cls, src: 'coinmarketcap' };
        }
      },
      {
        name: 'alternative.me (fallback)',
        url: 'https://api.alternative.me/fng/?limit=1',
        parse: async (r) => {
          const j = await r.json();
          const v = parseInt(j.data[0].value,10);
          const cls = j.data[0].value_classification;
          if(!isFinite(v)) throw new Error('no value');
          return { v, cls, src: 'alternative.me' };
        }
      }
    ];
    for(const attempt of fngAttempts){
      try{
        const r = await fetchWithTimeout(attempt.url, 6000);
        if(!r.ok) throw new Error('HTTP ' + r.status);
        const { v, cls, src } = await attempt.parse(r);
        el('fngNum').textContent = v;
        el('fngNum').style.color = v>=75 ? 'var(--red)' : v<=25 ? 'var(--green)' : 'var(--amber)';
        el('fngLabel').textContent = cls || '';
        el('fngLabel').title = tr('อัปเดตอัตโนมัติจาก ', 'Auto-updated from ') + src + ' · ' + new Date().toLocaleTimeString(window.GI_LOCALE || 'th-TH');
        fngDone = true;
        break;
      }catch(e){ /* try next source */ }
    }
    if(!fngDone) el('fngLabel').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');

    try{
      const r = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', 5000);
      const j = await r.json();
      const fr = parseFloat(j.lastFundingRate) * 100;
      el('fundingNum').textContent = (fr>=0?'+':'') + fr.toFixed(4) + '%';
      el('fundingNum').style.color = Math.abs(fr) > 0.03 ? 'var(--red)' : 'var(--green)';
      el('fundingLabel').textContent = Math.abs(fr) > 0.03 ? tr('สูงผิดปกติ — เลเวอเรจฝั่งเดียวหนาแน่น', 'Unusually high: crowded one-sided leverage') : tr('ปกติ', 'Normal');
    }catch(e){ el('fundingLabel').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); }

    // Open Interest — aggregated across ALL exchanges (not just Binance), using CoinGecko's
    // free public /derivatives endpoint (no key needed). It lists every BTC perpetual/futures
    // contract on every tracked exchange with open_interest in USD; we sum them all up and
    // convert to BTC using the live price we already fetched, plus show the top few exchanges
    // by size for context.
    // Hyperliquid (the largest perp DEX) is added from its own public info API. If CoinGecko
    // already lists a Hyperliquid BTC contract we keep CoinGecko's number and skip this one,
    // so the DEX is never counted twice.
    const hlPromise = fetchWithTimeout('https://api.hyperliquid.xyz/info', 8000, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' })
    }).then(r => r.json()).then(hyperliquidBtcOiUsd).catch(() => null);
    try{
      const [cg, hlUsd] = await Promise.all([
        fetchWithTimeout('https://api.coingecko.com/api/v3/derivatives', 8000).then(r => r.json()).catch(() => null),
        hlPromise,
      ]);
      const { totalUsd, byExchange } = combineBtcOpenInterest(cg, hlUsd);
      if(!totalUsd) throw new Error('no open interest data');

      // ใช้ราคาตลาดล่าสุดที่ดึงได้ก่อนเสมอ แล้วค่อย fallback ไปใช้ค่าที่อยู่ในช่องกรอก
      const price = lastLivePrice || parseFloat(priceInput.value) || null;
      const totalBtc = price ? totalUsd / price : null;

      el('oiNum').textContent = totalBtc
        ? totalBtc.toLocaleString(undefined,{maximumFractionDigits:0}) + ' BTC'
        : '$' + totalUsd.toLocaleString(undefined,{maximumFractionDigits:0});
      const oiPct = totalBtc ? totalBtc / btcSupplyApprox() * 100 : null;
      const oiZ = oiLeverageZone(oiPct);
      el('oiNum').style.color = oiZ ? oiZ.color : '';
      el('oiZone').textContent = oiZ ? oiZ.dot + ' ' + tr(oiZ.th, oiZ.en) + tr(' · ' + oiPct.toFixed(2) + '% ของ BTC ทั้งหมด', ' · ' + oiPct.toFixed(2) + '% of all BTC') : '';

      const n = Object.keys(byExchange).length;
      const top3 = Object.entries(byExchange).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([name])=>name);
      const hlKey = Object.keys(byExchange).find(m => /hyperliquid/i.test(m));
      const hlOi = hlKey ? byExchange[hlKey] : 0;
      const hlNote = hlOi ? (' · Hyperliquid ' + (price ? (hlOi / price).toLocaleString(undefined,{maximumFractionDigits:0}) + ' BTC' : '$' + (hlOi/1e9).toFixed(2) + 'bn')) : '';
      el('oiLabel').textContent = tr('รวม ' + n + ' ตลาด CEX + DEX (', 'Across ' + n + ' exchanges, CEX + DEX (') + top3.join(', ') + ' ...)' + hlNote;
    }catch(e){ el('oiLabel').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); el('oiZone').textContent = ''; }
  }

  // ---------- BTC Liquidation Heatmap (estimate) ----------
  // No exchange publishes everyone's liquidation prices for free (Coinglass's own map needs its
  // paid API), so this models them from public data, the same way the paid maps do:
  //   each hour, new leverage = OI increase (Binance BTCUSDT perp) + a small share of volume,
  //   opened across the candle's range, split long/short by taker buy share, spread over assumed
  //   leverage tiers → liquidation prices. A level is removed once price trades through it and
  //   fades slowly (positions close on their own). The total is scaled to combined BTC perp OI
  //   (Binance + OKX + Bybit + Hyperliquid). Calls run from the visitor's browser (like Funding/OI)
  //   because some of these APIs block datacenter IPs. Falls back to OKX when Binance is blocked.
  const LIQ_LEV = [[5, 0.10], [10, 0.25], [25, 0.30], [50, 0.22], [100, 0.13]]; // [leverage, share]
  const LIQ_MMR = 0.005;        // maintenance margin
  const LIQ_VOL_SHARE = 0.025;  // share of hourly volume treated as fresh leverage (churn the OI delta misses)
  const LIQ_HALF_LIFE_H = 96;   // un-liquidated positions also close by themselves over time
  const LIQ_BINS = 180;
  const HOUR = 3600000;

  function liqPrice(entry, lev, side){
    return side === 'long' ? entry * (1 - 1 / lev + LIQ_MMR) : entry * (1 + 1 / lev - LIQ_MMR);
  }

  // candles: [{t,h,l,c,vol,buy}] oldest first, hourly (vol/buy in USD); oiByT: Map(t → OI USD) or null.
  function buildLiqHeatmap(candles, oiByT, opts){
    const o = opts || {};
    const bins = o.bins || LIQ_BINS, scale = o.scale || 1;
    const show = Math.max(1, Math.min(o.show || candles.length, candles.length));
    const start = candles.length - show;
    let lo = Infinity, hi = -Infinity;
    for(let i = start; i < candles.length; i++){ lo = Math.min(lo, candles[i].l); hi = Math.max(hi, candles[i].h); }
    const last = candles[candles.length - 1].c;
    const pad = (hi - lo) * 0.3 + last * 0.03;
    lo -= pad; hi += pad;
    const step = (hi - lo) / bins;
    const toBin = (p) => Math.floor((p - lo) / step);
    const decay = Math.pow(0.5, 1 / LIQ_HALF_LIFE_H);
    const L = new Float64Array(bins), S = new Float64Array(bins);
    const longM = new Float32Array(show * bins), shortM = new Float32Array(show * bins);
    const spread = (arr, p0, p1, amt) => {
      const b0 = toBin(Math.min(p0, p1)), b1 = toBin(Math.max(p0, p1));
      if(b1 < 0 || b0 >= bins || !(amt > 0)) return;
      const per = amt / (b1 - b0 + 1);
      for(let b = Math.max(0, b0); b <= Math.min(bins - 1, b1); b++) arr[b] += per;
    };
    let prevOi = null;
    for(let i = 0; i < candles.length; i++){
      const k = candles[i];
      // 1) price traded through these levels → those positions are gone
      for(let b = Math.max(0, toBin(k.l)); b < bins; b++) L[b] = 0;
      for(let b = Math.min(bins - 1, toBin(k.h)); b >= 0; b--) S[b] = 0;
      // 2) slow fade
      for(let b = 0; b < bins; b++){ L[b] *= decay; S[b] *= decay; }
      // 3) fresh leverage opened in this candle
      const oi = oiByT ? oiByT.get(k.t) : undefined;
      let fresh = LIQ_VOL_SHARE * (k.vol || 0);
      if(oi != null && prevOi != null) fresh += Math.max(0, oi - prevOi);
      if(oi != null) prevOi = oi;
      fresh *= scale;
      const buyShare = k.vol > 0 && k.buy != null && isFinite(k.buy) ? Math.min(0.7, Math.max(0.3, k.buy / k.vol)) : 0.5;
      if(fresh > 0) for(const [lev, w] of LIQ_LEV){
        spread(L, liqPrice(k.l, lev, 'long'), liqPrice(k.h, lev, 'long'), fresh * buyShare * w);
        spread(S, liqPrice(k.l, lev, 'short'), liqPrice(k.h, lev, 'short'), fresh * (1 - buyShare) * w);
      }
      // 4) snapshot this column
      if(i >= start){
        const off = (i - start) * bins;
        for(let b = 0; b < bins; b++){ longM[off + b] = L[b]; shortM[off + b] = S[b]; }
      }
    }
    return { cols: show, bins, lo, hi, step, longM, shortM, candles: candles.slice(start), curL: Array.from(L), curS: Array.from(S), last };
  }

  // Densest cluster above (shorts) and below (longs) the current price, within ±15%, using a 5-bin window.
  function liqClusters(hm){
    const center = (b) => hm.lo + (b + 0.5) * hm.step;
    const pick = (arr, above) => {
      let best = null;
      for(let b = 0; b < hm.bins; b++){
        const p = center(b);
        if(above ? p <= hm.last : p >= hm.last) continue;
        if(Math.abs(p / hm.last - 1) > 0.15) continue;
        let sum = 0;
        for(let d = -2; d <= 2; d++) sum += arr[b + d] || 0;
        if(sum > 0 && (!best || sum > best.usd)) best = { price: p, usd: sum, pct: (p / hm.last - 1) * 100 };
      }
      return best;
    };
    return { up: pick(hm.curS, true), down: pick(hm.curL, false) };
  }

  const LIQ_STOPS = [[0, [10, 7, 22]], [0.12, [36, 13, 82]], [0.3, [58, 36, 150]], [0.5, [38, 110, 190]], [0.68, [31, 168, 166]], [0.84, [92, 214, 118]], [1, [246, 228, 80]]];
  function liqColor(x){
    x = Math.max(0, Math.min(1, x));
    for(let i = 1; i < LIQ_STOPS.length; i++){
      const [p1, c1] = LIQ_STOPS[i];
      if(x <= p1){
        const [p0, c0] = LIQ_STOPS[i - 1], f = (x - p0) / (p1 - p0 || 1);
        return [0, 1, 2].map((j) => Math.round(c0[j] + (c1[j] - c0[j]) * f));
      }
    }
    return LIQ_STOPS[LIQ_STOPS.length - 1][1].slice();
  }

  function fmtLiqUsd(v){
    if(!(v > 0)) return '$0';
    if(v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if(v >= 1e6) return '$' + (v / 1e6).toFixed(v >= 1e8 ? 0 : 1) + 'M';
    if(v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
    return '$' + v.toFixed(0);
  }
  const fmtLiqPx = (p) => '$' + Math.round(p).toLocaleString('en-US');

  function parseBinanceKlines(rows){
    return (Array.isArray(rows) ? rows : []).map((k) => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4], vol: +k[7], buy: +k[10] }))
      .filter((k) => k.h > 0 && k.l > 0 && k.c > 0 && isFinite(k.t));
  }
  // openInterestHist rows are snapshots at the END of each period → key them to the candle that ends there.
  function parseBinanceOiHist(rows){
    const m = new Map();
    (Array.isArray(rows) ? rows : []).forEach((r) => {
      const v = parseFloat(r && r.sumOpenInterestValue), ts = Number(r && r.timestamp);
      if(v > 0 && isFinite(ts)) m.set(Math.floor(ts / HOUR) * HOUR - HOUR, v);
    });
    return m;
  }
  function parseOkxCandles(j){
    const rows = (j && Array.isArray(j.data)) ? j.data : [];
    return rows.map((k) => ({ t: +k[0], h: +k[2], l: +k[3], c: +k[4], vol: +k[7] || (+k[6] * +k[4]) || 0, buy: null }))
      .filter((k) => k.h > 0 && k.l > 0 && k.c > 0 && isFinite(k.t)).sort((a, b) => a.t - b.t);
  }
  function parseOkxOiHist(j){
    const m = new Map();
    ((j && Array.isArray(j.data)) ? j.data : []).forEach((r) => {
      const ts = Number(r[0]), v = parseFloat(r[1]);
      if(v > 0 && isFinite(ts)) m.set(Math.floor(ts / HOUR) * HOUR - HOUR, v);
    });
    return m;
  }

  async function liqJson(url, ms, opts){
    const r = await fetchWithTimeout(url, ms || 8000, opts);
    if(!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }

  async function fetchLiqData(){
    let candles = null, oi = null, src = '';
    try{
      const [k, h] = await Promise.all([
        liqJson('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=500'),
        liqJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500').catch(() => null),
      ]);
      candles = parseBinanceKlines(k);
      oi = h ? parseBinanceOiHist(h) : null;
      src = 'Binance';
    }catch(e){ candles = null; }
    if(!candles || candles.length < 48){
      const [k, h] = await Promise.all([
        liqJson('https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1H&limit=300'),
        liqJson('https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-volume?ccy=BTC&period=1H').catch(() => null),
      ]);
      candles = parseOkxCandles(k);
      oi = h ? parseOkxOiHist(h) : null;
      src = 'OKX';
    }
    if(!candles || candles.length < 48) throw new Error('no candles');
    if(oi && oi.size < 24) oi = null;

    // Scale to the whole perp market: the source's own latest OI vs. the sum of the big venues now.
    let baseOi = 0;
    if(oi) for(const v of oi.values()) baseOi = v; // Map keeps insertion order → last = latest for Binance; OKX sorted below
    if(oi && src === 'OKX'){ const keys = [...oi.keys()].sort((a, b) => a - b); baseOi = oi.get(keys[keys.length - 1]); }
    const venues = await Promise.all([
      src === 'Binance' ? Promise.resolve(baseOi || null)
        : liqJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=5m&limit=1', 6000).then((j) => parseFloat(j[0].sumOpenInterestValue) || null).catch(() => null),
      src === 'OKX' ? Promise.resolve(null)
        : liqJson('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP', 6000).then((j) => parseFloat(j.data[0].oiUsd) || null).catch(() => null),
      liqJson('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT', 6000).then((j) => parseFloat(j.result.list[0].openInterestValue) || null).catch(() => null),
      liqJson('https://api.hyperliquid.xyz/info', 7000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) })
        .then((j) => hyperliquidBtcOiUsd(j)).catch(() => null),
    ]);
    const names = [src === 'Binance' ? 'Binance' : (venues[0] ? 'Binance' : null), 'OKX', venues[2] ? 'Bybit' : null, venues[3] ? 'Hyperliquid' : null];
    if(src !== 'OKX' && !venues[1]) names[1] = null;
    const totalOi = venues.reduce((s, v) => s + (v || 0), 0) + (src === 'OKX' ? (baseOi || 0) : 0);
    const scale = baseOi > 0 && totalOi > baseOi ? Math.min(6, totalOi / baseOi) : 1;
    return { candles, oi, src, scale, totalOi, venues: names.filter(Boolean), at: Date.now() };
  }

  const liqState = { days: 3, data: null, hm: null, loading: false, geo: null };

  function liqRebuild(){
    const d = liqState.data;
    if(!d) return;
    liqState.hm = buildLiqHeatmap(d.candles, d.oi, { show: liqState.days * 24, scale: d.scale });
    const c = liqClusters(liqState.hm);
    const pct = (x) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1) + '%';
    const parts = [];
    if(c.up) parts.push('<span style="color:var(--green)">▲ ' + tr('Short liq หนาสุดด้านบน', 'Densest short liqs above') + '</span> <b>' + fmtLiqPx(c.up.price) + '</b> (' + pct(c.up.pct) + ') ≈ ' + fmtLiqUsd(c.up.usd));
    if(c.down) parts.push('<span style="color:var(--red)">▼ ' + tr('Long liq หนาสุดด้านล่าง', 'Densest long liqs below') + '</span> <b>' + fmtLiqPx(c.down.price) + '</b> (' + pct(c.down.pct) + ') ≈ ' + fmtLiqUsd(c.down.usd));
    el('liqSum').innerHTML = parts.join('<br>');
    const time = new Date(d.tickAt || d.at).toLocaleTimeString(window.GI_LOCALE || 'th-TH', { hour: '2-digit', minute: '2-digit' });
    el('liqSrc').textContent = tr('ประมาณจาก ', 'Modelled from ') + d.src + ' BTCUSDT perp' + (d.oi ? ' (OI + ' + tr('ราคา ราย ชม.', 'hourly price') + ')' : tr(' (ราคา/วอลุ่ม ราย ชม.)', ' (hourly price/volume)'))
      + (d.scale > 1 && d.totalOi ? tr(' · สเกลตาม OI รวม ', ' · scaled to combined OI ') + fmtLiqUsd(d.totalOi) + ' (' + d.venues.join(', ') + ')' : '')
      + tr(' · อัปเดต ', ' · updated ') + time;
    renderLiq();
  }

  function renderLiq(){
    const cv = el('liqCanvas'), wrap = el('liqWrap'), hm = liqState.hm;
    if(!cv || !wrap || !hm || typeof cv.getContext !== 'function') return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    if(!W || !H) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const narrow = W < 520;
    const axisW = narrow ? 50 : 64, profW = narrow ? 34 : 64, axisH = 22;
    const plotW = W - axisW - profW, plotH = H - axisH;
    const { cols, bins, lo, hi } = hm;
    const yOf = (p) => (hi - p) / (hi - lo) * plotH;
    liqState.geo = { plotW, plotH, cols, bins };

    ctx.fillStyle = '#0a0716'; ctx.fillRect(0, 0, W, H);

    // reference level = 99.5th percentile of non-zero cells, so one spike doesn't wash everything out
    const tot = new Float32Array(cols * bins), sample = [];
    for(let i = 0; i < tot.length; i++){ tot[i] = hm.longM[i] + hm.shortM[i]; if(tot[i] > 0 && (i % 7 === 0)) sample.push(tot[i]); }
    sample.sort((a, b) => a - b);
    const ref = sample.length ? sample[Math.floor(sample.length * 0.995)] : 1;

    const off = document.createElement('canvas');
    off.width = cols; off.height = bins;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cols, bins);
    for(let x = 0; x < cols; x++){
      for(let row = 0; row < bins; row++){
        const b = bins - 1 - row, v = tot[x * bins + b];
        const [r, g, bl] = liqColor(Math.pow(Math.min(1, v / ref), 1.1));
        const p = (row * cols + x) * 4;
        img.data[p] = r; img.data[p + 1] = g; img.data[p + 2] = bl; img.data[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, plotW, plotH);

    // price grid + right axis
    const raw = (hi - lo) / 6, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const stepP = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
    ctx.font = '10px ' + (getComputedStyle(document.body).fontFamily || 'sans-serif');
    ctx.textBaseline = 'middle';
    for(let p = Math.ceil(lo / stepP) * stepP; p <= hi; p += stepP){
      const y = Math.round(yOf(p)) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW + profW, y); ctx.stroke();
      ctx.fillStyle = '#8d95a6'; ctx.textAlign = 'left';
      ctx.fillText(narrow ? (p / 1000).toFixed(stepP < 1000 ? 1 : 0) + 'k' : Math.round(p).toLocaleString('en-US'), plotW + profW + 6, y);
    }

    // time axis
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center'; ctx.fillStyle = '#8d95a6';
    const nT = Math.max(2, Math.floor(plotW / (narrow ? 90 : 120)));
    for(let i = 0; i < nT; i++){
      const x = Math.round((i + 0.5) / nT * cols);
      const c = hm.candles[Math.min(cols - 1, x)];
      if(!c) continue;
      const d = new Date(c.t);
      const lbl = d.toLocaleDateString(window.GI_LOCALE || 'th-TH', { day: 'numeric', month: 'short' }) + ' ' + String(d.getHours()).padStart(2, '0') + ':00';
      ctx.fillText(lbl, (x + 0.5) / cols * plotW, H - 7);
    }

    // price line
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 3.2;
    const path = () => { ctx.beginPath(); hm.candles.forEach((c, i) => { const x = (i + 0.5) / cols * plotW, y = yOf(c.c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
    path(); ctx.stroke();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4; path(); ctx.stroke();

    // current-liquidation profile (right strip): red = longs, green = shorts
    let pMax = 0;
    for(let b = 0; b < bins; b++) pMax = Math.max(pMax, hm.curL[b], hm.curS[b]);
    const bh = plotH / bins;
    ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(plotW, 0, profW, plotH);
    for(let b = 0; b < bins && pMax > 0; b++){
      const y = (bins - 1 - b) * bh;
      if(hm.curL[b] > 0){ ctx.fillStyle = 'rgba(228,106,114,0.85)'; ctx.fillRect(plotW + 2, y, Math.max(1, hm.curL[b] / pMax * (profW - 6)), Math.max(1, bh - 0.3)); }
      if(hm.curS[b] > 0){ ctx.fillStyle = 'rgba(90,196,146,0.85)'; ctx.fillRect(plotW + 2, y, Math.max(1, hm.curS[b] / pMax * (profW - 6)), Math.max(1, bh - 0.3)); }
    }

    // current price marker
    const yNow = Math.round(yOf(hm.last)) + 0.5;
    ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(240,219,164,0.7)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(plotW - 4, yNow); ctx.lineTo(plotW + profW, yNow); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#d4b26a'; ctx.fillRect(plotW + profW + 1, yNow - 8, axisW - 2, 16);
    ctx.fillStyle = '#06080e'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(narrow ? (hm.last / 1000).toFixed(1) + 'k' : Math.round(hm.last).toLocaleString('en-US'), plotW + profW + 5, yNow);
    ctx.beginPath(); ctx.arc((cols - 0.5) / cols * plotW, yOf(hm.last), 3, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  }

  function liqHover(clientX, clientY){
    const tip = el('liqHover'), wrap = el('liqWrap'), hm = liqState.hm, g = liqState.geo;
    if(!tip || !hm || !g || !wrap.getBoundingClientRect) return;
    const r = wrap.getBoundingClientRect(), x = clientX - r.left, y = clientY - r.top;
    if(x < 0 || y < 0 || x > g.plotW || y > g.plotH){ tip.hidden = true; return; }
    const col = Math.min(g.cols - 1, Math.floor(x / g.plotW * g.cols));
    const b = Math.max(0, Math.min(g.bins - 1, g.bins - 1 - Math.floor(y / g.plotH * g.bins)));
    const c = hm.candles[col], price = hm.lo + (b + 0.5) * hm.step;
    // sum ±1 bin so the number is a readable band, not a sliver
    let lq = 0, sq = 0;
    for(let d = -1; d <= 1; d++){ const bb = b + d; if(bb < 0 || bb >= g.bins) continue; lq += hm.longM[col * g.bins + bb]; sq += hm.shortM[col * g.bins + bb]; }
    const d = new Date(c.t);
    tip.innerHTML = '<div style="color:var(--sub)">' + d.toLocaleString(window.GI_LOCALE || 'th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + '</div>'
      + '<div>' + tr('ราคา', 'Price') + ' <b>' + fmtLiqPx(price) + '</b> (' + ((price / c.c - 1) * 100 >= 0 ? '+' : '') + ((price / c.c - 1) * 100).toFixed(1) + '%)</div>'
      + (sq > lq ? '<div style="color:var(--green)">' + tr('Short liq ประมาณ ', 'Est. short liqs ') + fmtLiqUsd(sq) + '</div>' : '')
      + (lq > 0 && lq >= sq ? '<div style="color:var(--red)">' + tr('Long liq ประมาณ ', 'Est. long liqs ') + fmtLiqUsd(lq) + '</div>' : '')
      + (lq + sq <= 0 ? '<div style="color:var(--sub)">' + tr('แทบไม่มี', 'Almost none') + '</div>' : '');
    tip.hidden = false;
    const tw = tip.offsetWidth || 150, th = tip.offsetHeight || 60;
    tip.style.left = Math.max(4, x + 14 + tw > r.width ? x - tw - 14 : x + 14) + 'px';
    tip.style.top = Math.max(4, Math.min(r.height - th - 4, y - th / 2)) + 'px';
  }

  // Light refresh every minute while the ₿ tab is open: only the newest 3 candles + OI rows
  // (a few hundred bytes, Binance weight ~2), merged into the loaded history. Full reload every 30 min.
  async function liqTick(){
    const d = liqState.data;
    if(liqState.loading) return;
    if(!d || d.src !== 'Binance' || Date.now() - d.at > 30 * 60 * 1000) return fetchLiqHeatmap(true);
    try{
      const [k, h] = await Promise.all([
        liqJson('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=3', 6000),
        liqJson('https://fapi.binance.com/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=3', 6000).catch(() => null),
      ]);
      const fresh = parseBinanceKlines(k);
      if(!fresh.length) return;
      const idx = new Map(d.candles.map((c, i) => [c.t, i]));
      for(const c of fresh){ if(idx.has(c.t)) d.candles[idx.get(c.t)] = c; else d.candles.push(c); }
      d.candles.sort((a, b) => a.t - b.t);
      if(d.candles.length > 520) d.candles.splice(0, d.candles.length - 500);
      if(h && d.oi) for(const [t, v] of parseBinanceOiHist(h)) d.oi.set(t, v);
      d.tickAt = Date.now();
      liqRebuild();
    }catch(e){ /* keep the last good map; the next tick tries again */ }
  }

  async function fetchLiqHeatmap(force){
    if(liqState.loading) return;
    if(!force && liqState.data && Date.now() - liqState.data.at < 10 * 60 * 1000){ liqRebuild(); return; }
    liqState.loading = true;
    try{
      liqState.data = await fetchLiqData();
      el('liqMsg').hidden = true;
      liqRebuild();
    }catch(e){
      if(!liqState.data){ el('liqMsg').hidden = false; el('liqMsg').textContent = tr('ดึงข้อมูลไม่สำเร็จ ลองใหม่ภายหลัง หรือดูบน Coinglass', 'Could not load data. Try later, or open Coinglass'); }
    }finally{ liqState.loading = false; }
  }

  (function wireLiq(){
    const wrap = el('liqWrap'), ranges = el('liqRanges');
    if(ranges) ranges.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('button[data-days]') : null;
      if(!btn) return;
      liqState.days = parseInt(btn.dataset.days, 10) || 3;
      ranges.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      liqRebuild();
    });
    if(!wrap) return;
    wrap.addEventListener('mousemove', (ev) => liqHover(ev.clientX, ev.clientY));
    wrap.addEventListener('mouseleave', () => { el('liqHover').hidden = true; });
    let hideT = 0;
    const onTouch = (ev) => { const t = ev.touches && ev.touches[0]; if(t){ liqHover(t.clientX, t.clientY); clearTimeout(hideT); hideT = setTimeout(() => { el('liqHover').hidden = true; }, 2500); } };
    wrap.addEventListener('touchstart', onTouch, { passive: true });
    wrap.addEventListener('touchmove', onTouch, { passive: true });
    // the ₿ tab may be hidden when data lands (width 0) → draw again whenever the box gets a size
    let lastW = 0;
    if(typeof ResizeObserver === 'function'){
      new ResizeObserver(() => { const w = wrap.clientWidth; if(w && w !== lastW){ lastW = w; renderLiq(); } }).observe(wrap);
    }else{
      window.addEventListener('resize', () => renderLiq());
    }
  })();
  if(typeof window !== 'undefined') window.__liqTest = { liqPrice, buildLiqHeatmap, liqClusters, liqColor, fmtLiqUsd, liqTick, liqState, parseBinanceKlines, parseBinanceOiHist, parseOkxCandles };

  // ---------- ยอดล้างพอร์ต BTC 1/4/12/24 ชม. (ของจริง ไม่ใช่ประมาณการ) ----------
  // มาจาก /.netlify/functions/liquidations เท่านั้น (Coinalyze ต้องใช้ API key ฝั่งเซิร์ฟเวอร์) แคช 5 นาที
  // ตัวเลขทุกตัวมาจาก API ไม่มีค่าใส่มือ ถ้าดึงไม่ได้การ์ดจะค้างที่ "–"
  const REKT_WINDOWS = ['1h', '4h', '12h', '24h'];
  let rektAt = 0;
  function fmtRekt(v){
    if(!isFinite(v)) return '–';
    const a = Math.abs(v);
    return a >= 1e9 ? '$' + (v / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (v / 1e6).toFixed(2) + 'M' : a >= 1e3 ? '$' + (v / 1e3).toFixed(1) + 'K' : '$' + Math.round(v);
  }
  // สัดส่วน long ของยอดล้าง → [สี, คำอธิบาย] (เกณฑ์เดียวกับ "อ่านสี" ในปุ่ม i)
  function rektZone(w){
    if(!w || !(w.total > 0)) return null;
    const lp = w.long / w.total;
    return lp >= 0.65 ? ['🟢', tr('long โดนล้างเป็นหลัก (' + Math.round(lp * 100) + '%)', 'mostly longs liquidated (' + Math.round(lp * 100) + '%)')]
      : lp <= 0.35 ? ['🔴', tr('short โดนล้างเป็นหลัก (' + Math.round((1 - lp) * 100) + '%)', 'mostly shorts liquidated (' + Math.round((1 - lp) * 100) + '%)')]
      : ['🟡', tr('โดนล้างพอ ๆ กันทั้งสองฝั่ง (long ' + Math.round(lp * 100) + '%)', 'both sides hit about equally (longs ' + Math.round(lp * 100) + '%)')];
  }
  function rektBar(w){
    if(!w || !(w.total > 0)) return '';
    const lp = w.long / w.total * 100;
    return '<i class="l" style="width:' + lp.toFixed(1) + '%"></i><i class="s" style="width:' + (100 - lp).toFixed(1) + '%"></i>';
  }
  const rektPct = (w, side) => (w && w.total > 0) ? (w[side] / w.total * 100).toFixed(1) + '%' : '–';
  function renderRekt(d){
    const W = d.windows || {};
    REKT_WINDOWS.forEach(function(k){
      const box = el('rektGrid').querySelector('.rekt-box[data-w="' + k + '"]'), w = W[k];
      if(!box) return;
      const ok = w && w.total > 0, lp = ok ? w.long / w.total * 100 : 0, sp = ok ? 100 - lp : 0, longSide = lp > sp;
      const tag = box.querySelector('.rekt-tag');
      tag.className = 'rekt-tag' + (ok ? (longSide ? ' l' : ' s') : '');
      tag.textContent = ok ? (longSide ? tr('long โดนหนัก', 'longs hit') : tr('short โดนหนัก', 'shorts hit')) : tr('แทบไม่มี', 'quiet');
      const big = box.querySelector('.rekt-big');
      big.innerHTML = ok ? (longSide ? lp : sp).toFixed(1) + '%<small>' + (longSide ? 'Long' : 'Short') + '</small>' : '–';
      big.style.color = ok ? (longSide ? 'var(--green)' : 'var(--red)') : '';
      box.querySelector('.rekt-bar').innerHTML = rektBar(w);
      box.querySelector('b.l').textContent = ok ? lp.toFixed(1) + '%' : '–';
      box.querySelector('b.s').textContent = ok ? sp.toFixed(1) + '%' : '–';
    });
    const z = rektZone(d.windows && d.windows['24h']);
    let txt = z ? z[0] + ' 24' + tr(' ชม.: ', 'h: ') + z[1] : tr('24 ชม. ที่ผ่านมาแทบไม่มีการล้างพอร์ต', 'Almost no liquidations in the last 24h');
    el('rektMeaning').innerHTML = '<b>' + tr('ความหมาย:', 'What it means:') + '</b> ' + txt.replace(/[&<>]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]));
    const ex = (d.exchanges || []).filter((e) => e.total > 0), sum = ex.reduce((a, e) => a + e.total, 0);
    el('rektEx').textContent = sum > 0 ? tr('ตลาดที่โดนล้างมากสุด 24 ชม.: ', 'Largest exchange share, 24h: ') + ex.slice(0, 3).map((e) => { const pc = e.total / sum * 100; return e.name + ' ' + (pc < 1 ? '<1' : Math.round(pc)) + '%'; }).join(' · ') : '';
    const names = [...new Set((d.markets || []).map((m) => String(m).split(' ')[0]))];
    const when = d.at ? new Date(d.at).toLocaleTimeString(window.GI_LOCALE || 'th-TH', { hour:'2-digit', minute:'2-digit' }) : '';
    el('rektAt').textContent = when ? 'LIVE · ' + tr('อัปเดต ', 'updated ') + when + (d.stale ? tr(' (ข้อมูลล่าสุดที่ดึงได้)', ' (last good copy)') : '') : '';
    el('rektAt').classList.toggle('off', !!d.stale || !when);
    el('rektNote').textContent = tr('Coinalyze (API ฟรี) รวม BTC perpetual futures ' + names.length + ' ตลาด: ', 'Coinalyze (free API), BTC perpetual futures on ' + names.length + ' exchanges: ') + names.join(', ')
      + tr(' · อัปเดตทุกนาที · นับเฉพาะ BTC · สัดส่วนใกล้เคียง CoinGlass แต่ไม่ตรงเป๊ะ เพราะนับตลาดคนละชุด', ' · refreshed every minute · BTC only · the split is close to CoinGlass but not identical, since the exchange lists differ');
  }
  async function fetchRekt(){
    rektAt = Date.now();
    let d = null;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/liquidations', 12000);
      d = await r.json().catch(() => null);
      if(!r.ok || !d || !d.windows) d = null;
    }catch(e){ d = null; }
    if(d){ renderRekt(d); return true; }
    // ไม่บอกผู้ชมเรื่องตั้งค่าเซิร์ฟเวอร์ (เช่นยังไม่มี key) ข้อความเดียวกับดึงไม่สำเร็จทั่วไป
    el('rektMeaning').textContent = tr('ดึงข้อมูลไม่สำเร็จ ลองใหม่ภายหลัง หรือดูบน CoinGlass', 'Could not load data. Try later, or open CoinGlass');
    return false;
  }
  setInterval(() => { if(document.body.classList.contains('theme-btc') && !document.hidden && Date.now() - rektAt >= 55 * 1000) fetchRekt(); }, 60 * 1000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden && document.body.classList.contains('theme-btc') && Date.now() - rektAt >= 55 * 1000) fetchRekt(); });
  if(typeof window !== 'undefined') window.__rektTest = { fmtRekt, rektZone, rektPct, renderRekt, fetchRekt };

  // ---------- DVOL (Deribit BTC implied volatility, "VIX ของ BTC") ----------
  // ชั้นแรก: /.netlify/functions/dvol (แคช 5 นาที) · ถ้าเซิร์ฟเวอร์ล่ม ดึงตรงจาก Deribit public API
  // (ไม่ต้องใช้ key) แล้วแปลงแท่งเทียนรายวัน [ts, open, high, low, close] เป็นค่าปิดรายวันเอง
  function dvolFromCandles(j){
    const rows = (j && j.result && j.result.data) || [];
    const byDay = {};
    rows.forEach(function(c){
      const v = c && Number(c[4]);
      if(isFinite(v) && v > 5 && v < 400) byDay[new Date(Number(c[0])).toISOString().slice(0,10)] = Math.round(v * 100) / 100;
    });
    const days = Object.keys(byDay).sort().slice(-366).map(function(d){ return [d, byDay[d]]; });
    if(!days.length) throw new Error('no candles');
    const latest = days[days.length - 1][1], prev = days.length > 1 ? days[days.length - 2][1] : null;
    return { latest, prev, change: prev != null ? Math.round((latest - prev) * 100) / 100 : null, date: days[days.length - 1][0], hist: days, source: 'deribit (direct)' };
  }
  function dvolZone(v){
    return v >= 80 ? tr('🔴 ตื่นตระหนก', '🔴 Panic') : v >= 60 ? tr('🟠 กังวล', '🟠 Worried') : v >= 40 ? tr('🟡 ปกติ', '🟡 Normal') : tr('🟢 เงียบมาก', '🟢 Very quiet');
  }
  async function fetchDvol(){
    let d = null;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/dvol', 8000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
      if(!isNum(d.latest)) throw new Error('no value');
    }catch(e){
      try{
        const now = Date.now();
        const r = await fetchWithTimeout('https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=' + (now - 380 * 86400000) + '&end_timestamp=' + now, 8000);
        if(!r.ok) throw new Error('HTTP ' + r.status);
        d = dvolFromCandles(await r.json());
      }catch(e2){ d = null; }
    }
    if(!d){ el('dvolZone').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); return; }
    const v = d.latest, ch = d.change;
    el('dvolNum').innerHTML = v.toFixed(1) + (isNum(ch) ? '<span class="delta ' + (ch > 0 ? 'down' : ch < 0 ? 'up' : 'flat') + '">' + (ch > 0 ? '+' : '') + ch.toFixed(1) + '</span>' : '');
    el('dvolNum').style.color = v >= 80 ? 'var(--red)' : v >= 60 ? 'var(--amber)' : '';
    el('dvolZone').textContent = dvolZone(v) + tr(' · คาดแกว่ง ±', ' · implied ±') + (v / Math.sqrt(365)).toFixed(1) + tr('%/วัน', '%/day');
    el('dvolZone').title = 'Deribit · ' + (d.source || '') + ' · ' + (d.date || '');
    if(window.giSetSpark) window.giSetSpark('spDvol', d, { upIsBad:true, dec:0 });
  }

  // ---------- Options positioning (Deribit): 25Δ risk reversal tile + dealer gamma (GEX) panel ----------
  // ทั้งสองมาจาก /.netlify/functions/options-gex (คำนวณจาก option BTC ทุกตัวบน Deribit แคช 5 นาที)
  // ไม่มีตัวสำรองฝั่งหน้าเว็บ: ถ้าเซิร์ฟเวอร์ดึงไม่ได้ การ์ดจะบอกว่าดึงไม่สำเร็จ
  const fmtPx = (v) => isNum(v) ? '$' + Math.round(v).toLocaleString('en-US') : '–';
  const fmtSignPct = (v, dec) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v * 100).toFixed(dec == null ? 1 : dec) + '%';
  const fmtVol = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  const escTxt = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function fmtUsdBig(v){
    if(!isNum(v)) return '–';
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    return s + (a >= 1e9 ? '$' + (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (a / 1e3).toFixed(0) + 'K' : '$' + Math.round(a));
  }
  function rrZone(v){
    return v <= -6 ? ['🔴', tr('put แพงกว่ามาก: คนจ่ายแพงเพื่อประกันขาลง', 'puts much pricier: people pay up for downside cover'), 'var(--red)']
      : v <= -2 ? ['🟠', tr('put แพงกว่า: ตลาดเอียงไปทางกันขาลง', 'puts pricier: the market leans toward downside cover'), 'var(--amber)']
      : v < 2 ? ['🟡', tr('พอ ๆ กัน: ไม่เอียงฝั่งไหนชัด', 'balanced: no clear lean'), '']
      : v < 6 ? ['🔵', tr('call แพงกว่า: คนเริ่มไล่ซื้อขาขึ้น', 'calls pricier: people are reaching for upside'), 'var(--cool)']
      : ['🟢', tr('call แพงกว่ามาก: ไล่ซื้อขาขึ้นแรง', 'calls much pricier: strong upside chasing'), 'var(--green)'];
  }
  // แท่ง RR ของแต่ละวันหมดอายุ (ลบ = แดงลงล่าง, บวก = เขียวขึ้นบน)
  function rrTermSvg(rows){
    if(!rows || rows.length < 2) return '';
    const W = 300, H = 62, max = Math.max(2, ...rows.map(r => Math.abs(r.rr))), mid = H / 2, bw = W / rows.length;
    let g = '<line x1="0" x2="' + W + '" y1="' + mid + '" y2="' + mid + '" stroke="var(--line)"/>';
    rows.forEach(function(r, i){
      const h = Math.max(1, Math.abs(r.rr) / max * (mid - 3));
      g += '<rect x="' + (i * bw + bw * 0.18).toFixed(1) + '" y="' + (r.rr >= 0 ? mid - h : mid).toFixed(1) + '" width="' + (bw * 0.64).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (r.rr >= 0 ? 'var(--green)' : 'var(--red)') + '"></rect>';
    });
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + tr('RR แต่ละวันหมดอายุ', 'RR by expiry') + '">' + g + '</svg>'
      + '<div class="etf-tip" hidden></div>'
      + '<div class="cap"><span>' + rows[0].code + '</span><span>' + tr('RR แต่ละวันหมดอายุ (ใกล้ → ไกล)', 'RR by expiry (near → far)') + '</span><span>' + rows[rows.length - 1].code + '</span></div>';
  }
  // ชี้เมาส์ / แตะแท่ง → วันหมดอายุ, RR, IV ของ put/call และความหมาย
  function rrTipHtml(r){
    const z = rrZone(r.rr);
    return '<b>' + escTxt(r.code) + '</b> · ' + tr('อีก ', 'in ') + Math.round(r.days) + tr(' วัน', ' days')
      + '<br>RR <b style="color:' + (z[2] || 'inherit') + '">' + fmtVol(r.rr) + '</b> ' + tr('จุด vol', 'vol pts')
      + (isNum(r.put25) && isNum(r.call25) ? '<small>' + tr('put 25Δ IV ', '25Δ put IV ') + r.put25.toFixed(1) + '% · ' + tr('call 25Δ IV ', '25Δ call IV ') + r.call25.toFixed(1) + '%</small>' : '')
      + '<small>' + z[0] + ' ' + z[1] + '</small>';
  }
  function bindRrTip(box, rows){
    const svg = box.querySelector('svg'), tip = box.querySelector('.etf-tip');
    if(!svg || !tip || !rows.length) return;
    const rects = svg.querySelectorAll('rect');
    function show(ev){
      const r = svg.getBoundingClientRect();
      if(!r.width) return;
      const i = Math.max(0, Math.min(rows.length - 1, Math.floor((ev.clientX - r.left) / r.width * rows.length)));
      tip.innerHTML = rrTipHtml(rows[i]);
      tip.hidden = false;
      const x = (i + 0.5) / rows.length * r.width + (r.left - box.getBoundingClientRect().left), half = tip.offsetWidth / 2 + 4;
      tip.style.left = Math.max(half, Math.min(box.clientWidth - half, x)) + 'px';
      rects.forEach((el2, k) => el2.classList.toggle('hl', k === i));
    }
    function hide(){ tip.hidden = true; rects.forEach(el2 => el2.classList.remove('hl')); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function(ev){ if(ev.pointerType === 'mouse') hide(); });
    document.addEventListener('pointerdown', function(ev){ if(!svg.contains(ev.target)) hide(); });
  }
  function renderRr(d){
    const rr = d && d.rr, c30 = rr && rr.cm && rr.cm[30];
    if(!c30 || !isNum(c30.rr)){ el('rrZone').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); return; }
    const z = rrZone(c30.rr);
    // เทียบกับจุดในประวัติที่ใกล้ 24 ชม. ก่อนที่สุด (เก็บทุก ~3 ชม.)
    let ch = null;
    const hist = (rr.hist || []).filter(p => Array.isArray(p) && isNum(p[1]));
    const now = Date.parse(d.at) || Date.now();
    const old = hist.filter(p => now - p[0] >= 18 * 3600000).pop();
    if(old && now - old[0] <= 36 * 3600000) ch = c30.rr - old[1];
    el('rrNum').innerHTML = fmtVol(c30.rr) + '<span class="unit">' + tr('จุด vol · 30 วัน', 'vol pts · 30d') + '</span>'
      + (isNum(ch) ? '<span class="delta ' + (ch > 0 ? 'up' : ch < 0 ? 'down' : 'flat') + '" title="' + tr('เทียบ 24 ชม. ก่อน', 'vs 24h ago') + '">' + fmtVol(ch) + tr(' จาก 24 ชม.', ' vs 24h') + '</span>' : '');
    el('rrNum').style.color = z[2];
    el('rrZone').textContent = z[0] + ' ' + z[1] + (isNum(ch) && Math.abs(ch) >= 0.5 ? (ch > 0 ? tr(' · กำลังหันไปให้ค่า call มากขึ้น', ' · turning toward calls') : tr(' · กำลังหันไปให้ค่า put มากขึ้น', ' · turning toward puts')) : '');
    el('rrLegs').innerHTML = tr('ประกันขาลง (put 25Δ) IV ', 'Downside cover (25Δ put) IV ') + '<b>' + c30.put25.toFixed(1) + '%</b> · ' + tr('ตั๋วขาขึ้น (call 25Δ) IV ', 'upside (25Δ call) IV ') + '<b>' + c30.call25.toFixed(1) + '%</b>' + (isNum(c30.atm) ? ' · ATM ' + c30.atm.toFixed(1) + '%' : '');
    el('rrCm').innerHTML = [7, 30, 90].map(function(n){
      const c = rr.cm[n];
      if(!c || !isNum(c.rr)) return '';
      return '<div>' + n + tr(' วัน', ' days') + '<b style="color:' + rrZone(c.rr)[2] + '">' + fmtVol(c.rr) + '</b></div>';
    }).join('');
    el('rrTerm').innerHTML = rrTermSvg(rr.expiries || []);
    bindRrTip(el('rrTerm'), rr.expiries || []);
    if(hist.length >= 4 && window.giSetSpark){
      const days = Math.max(1, Math.round((hist[hist.length - 1][0] - hist[0][0]) / 86400000));
      window.giSetSpark('spRr', { hist }, { dec: 1, color: 'var(--cool)', cap: tr('RR 30 วัน ย้อนหลัง ' + days + ' วัน', 'RR 30d, last ' + days + ' days') });
    }
    el('rrZone').title = 'Deribit · ' + (d.at || '') + (d.stale ? ' (stale)' : '');
  }

  const gexState = { data: null, band: 0.2, at: 0, loading: false };
  function gexMeaning(g, spot){
    const z = g.zeroGamma, pos = g.total >= 0;
    const dist = isNum(z) ? z / spot - 1 : null;
    const head = pos ? '🟢 <b>' + tr('Gamma บวก (โหมดหน่วงการแกว่ง)', 'Positive gamma (damping mode)') + '</b>: '
      + tr('dealer ขายตอนราคาขึ้นและซื้อตอนราคาลง ราคามักวิ่งในกรอบและแกว่งน้อยลง', 'dealers sell rallies and buy dips, so price tends to stay in a range and swing less')
      : '🔴 <b>' + tr('Gamma ลบ (โหมดเร่งการแกว่ง)', 'Negative gamma (amplifying mode)') + '</b>: '
      + tr('dealer ต้องขายตามตอนราคาลงและซื้อตามตอนราคาขึ้น ราคาจึงวิ่งแรงและเป็นเทรนด์ได้ง่าย', 'dealers must sell into falls and buy into rallies, so moves get bigger and trends run more easily');
    let flip = '';
    if(isNum(z)){
      flip = pos
        ? tr(' · ถ้าราคาหลุดลงต่ำกว่า <b>' + fmtPx(z) + '</b> (' + fmtSignPct(dist) + ' จากตอนนี้) จะเปลี่ยนเป็นโหมดเร่งการแกว่ง', ' · if price falls below <b>' + fmtPx(z) + '</b> (' + fmtSignPct(dist) + ' from here) it flips to amplifying mode')
        : tr(' · ต้องขึ้นไปยืนเหนือ <b>' + fmtPx(z) + '</b> (' + fmtSignPct(dist) + ' จากตอนนี้) dealer ถึงจะกลับมาช่วยหน่วงการแกว่ง', ' · price has to get back above <b>' + fmtPx(z) + '</b> (' + fmtSignPct(dist) + ' from here) before dealers start damping moves again');
    }else flip = tr(' · ไม่มีจุดเปลี่ยนในช่วง ±30% จากราคาตอนนี้', ' · no flip within ±30% of the current price');
    return [pos ? 'pos' : 'neg', head + flip];
  }
  // แบบจำลองนี้บอกได้แค่ "ขนาดคร่าว ๆ" (Deribit อย่างเดียว + สมมติว่า dealer ถือฝั่งไหน) จึงปัดเหลือ 2 หลักแรก
  // ไม่ให้ตัวเลขอย่าง 20,389 BTC ดูแม่นกว่าที่โมเดลรู้จริง
  function gexRoughBtc(v){
    const a = Math.abs(v);
    if(!isNum(a) || a === 0) return '0';
    const mag = Math.pow(10, Math.max(0, Math.floor(Math.log10(a)) - 1));
    const r = Math.round(a / mag) * mag;
    return r >= 1000 ? (r / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'k' : String(r);
  }
  function renderGexStats(d){
    const g = d.gex, spot = d.spot;
    el('gexSpot').textContent = fmtPx(spot);
    el('gexSpotSub').textContent = tr('ดัชนี Deribit', 'Deribit index') + ' · ' + new Date(d.at).toLocaleTimeString(window.GI_LOCALE || 'th-TH', { hour: '2-digit', minute: '2-digit' }) + (d.stale ? tr(' (ค่าเก่า)', ' (stale)') : '');
    el('gexZero').textContent = fmtPx(g.zeroGamma);
    el('gexZeroSub').textContent = isNum(g.zeroGamma) ? fmtSignPct(g.zeroGamma / spot - 1) + tr(' จากราคาตอนนี้', ' from price') : tr('ไม่มีในช่วง ±30%', 'none within ±30%');
    el('gexTotal').textContent = fmtUsdBig(g.total);
    el('gexTotal').style.color = g.total >= 0 ? 'var(--green)' : 'var(--red)';
    el('gexTotalSub').textContent = tr('ต่อราคาขยับ 1% · ', 'per 1% move · ') + (g.total >= 0 ? tr('บวก = หน่วง', 'positive = damping') : tr('ลบ = เร่ง', 'negative = amplifying'));
    el('gexWalls').innerHTML = '<span style="color:var(--green)">' + fmtPx(g.callWall) + '</span> / <span style="color:var(--red)">' + fmtPx(g.putWall) + '</span>';
    el('gexWallsSub').textContent = tr('แนวต้าน / แนวรับจาก option', 'option resistance / support');
    const m = gexMeaning(g, spot);
    el('gexMeaning').className = 'gex-meaning ' + m[0];
    el('gexMeaning').innerHTML = m[1];
    el('gexFlows').innerHTML = (g.flows || []).map(function(f){
      const buy = f.btc >= 0;
      return '<div class="rekt-box"><div class="rekt-top"><span class="rekt-lbl">' + (f.move < 0 ? tr('ราคาลง ', 'Price down ') : tr('ราคาขึ้น ', 'Price up ')) + Math.abs(f.move * 100) + '%</span><span class="rekt-tag">' + fmtPx(f.price) + '</span></div>'
        + '<div class="rekt-big ' + (buy ? 'buy' : 'sell') + '">' + (buy ? tr('ซื้อ ~', 'Buy ~') : tr('ขาย ~', 'Sell ~')) + gexRoughBtc(f.btc) + '<small>BTC</small></div>'
        + '<div class="rekt-row"><span>≈ ' + fmtUsdBig(Math.abs(f.usd)) + '</span><span>' + ((f.move < 0) === !buy ? tr('ตามทิศราคา', 'with the move') : tr('สวนทิศราคา', 'against the move')) + '</span></div></div>';
    }).join('');
    const ex = (g.expiries || []).slice(0, 4).map(e => e.code + ' ' + e.share + '%').join(' · ');
    el('gexExp').textContent = tr('gamma มาจากวันหมดอายุไหนมากสุด: ', 'Where the gamma sits by expiry: ') + ex + tr(' · ตัวเลขซื้อ/ขายคือแรงป้องกันความเสี่ยงรวมของ dealer ตามแบบจำลอง ถ้าราคาไปถึงระดับนั้น (ราคาไปเร็ว dealer อาจเทรดไม่ทันทั้งหมด)', ' · buy/sell figures are the modelled total dealer hedge if price gets there (in a fast move dealers may not hedge it all)');
  }
  // แกนราคาแนวตั้ง ใช้ร่วมกันทั้ง GEX และ volume profile
  function priceAxis(lo, hi, T, H){
    const y = (p) => T + (hi - p) / (hi - lo) * H;
    const raw = (hi - lo) / 8, mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
    const ticks = [];
    for(let p = Math.ceil(lo / step) * step; p <= hi; p += step) ticks.push(p);
    return { y, ticks };
  }
  const kLbl = (p) => p >= 1000 ? (p / 1000).toFixed(p % 1000 ? 1 : 0) + 'k' : String(Math.round(p));
  function hLine(x1, x2, y, color, dash, label, side, W){
    let s = '<line x1="' + x1 + '" x2="' + x2 + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="' + color + '" stroke-width="1.3"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
    if(label){
      const tw = label.length * 6.1 + 8, tx = side === 'r' ? x2 - tw - 2 : x1 + 2;
      s += '<rect x="' + tx.toFixed(1) + '" y="' + (y - 8).toFixed(1) + '" width="' + tw.toFixed(1) + '" height="15" rx="3" fill="#0a0e17" stroke="' + color + '" stroke-width=".8" opacity=".95"/>'
        + '<text x="' + (tx + 4).toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '" fill="' + color + '">' + label + '</text>';
    }
    return s;
  }
  function renderGexChart(){
    const d = gexState.data, box = el('gexChart'), wrap = el('gexWrap');
    if(!d || !box || !wrap) return;
    const W = wrap.clientWidth, Hh = wrap.clientHeight;
    if(!W || !Hh) return;
    const g = d.gex, spot = d.spot, band = gexState.band;
    const lo = spot * (1 - band), hi = spot * (1 + band);
    const rows = (g.byStrike || []).filter(r => r.k >= lo && r.k <= hi);
    const L = W < 520 ? 46 : 58, T = 10, B = 10, H = Hh - T - B;
    const gap = 8, colB = Math.round((W - L) * 0.34), xA0 = L + 4, xA1 = W - colB - gap, xB0 = xA1 + gap, xB1 = W - 4;
    const ax = priceAxis(lo, hi, T, H), y = ax.y;
    let s = '';
    ax.ticks.forEach(p => { s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(p).toFixed(1) + '" y2="' + y(p).toFixed(1) + '" stroke="#161d2b"/><text x="' + (L - 6) + '" y="' + (y(p) + 3.5).toFixed(1) + '" fill="#8d95a6" text-anchor="end">' + kLbl(p) + '</text>'; });
    // column A: strike bars, puts left of centre, calls right
    const maxA = Math.max(1, ...rows.map(r => Math.max(r.call, -r.put)));
    const cA = (xA0 + xA1) / 2, half = (xA1 - xA0) / 2 - 2;
    const ks = rows.map(r => r.k).sort((a, b) => a - b);
    let minGap = Infinity; for(let i = 1; i < ks.length; i++) minGap = Math.min(minGap, ks[i] - ks[i - 1]);
    const bh = Math.max(1.5, Math.min(14, (isFinite(minGap) ? minGap : (hi - lo) / 40) / (hi - lo) * H * 0.8));
    s += '<line x1="' + cA + '" x2="' + cA + '" y1="' + T + '" y2="' + (T + H) + '" stroke="#2a3346"/>';
    rows.forEach(function(r){
      const yy = y(r.k) - bh / 2, wc = r.call / maxA * half, wp = -r.put / maxA * half;
      if(wp > 0.3) s += '<rect x="' + (cA - wp).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + wp.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="var(--red)" opacity=".85"/>';
      if(wc > 0.3) s += '<rect x="' + cA.toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + wc.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="var(--green)" opacity=".85"/>';
    });
    // column B: total GEX if spot were at each price (area left/right of a zero line)
    const curve = (g.curve || []).filter(c => c[0] >= lo && c[0] <= hi);
    const maxB = Math.max(1, ...curve.map(c => Math.abs(c[1])));
    const cB = (xB0 + xB1) / 2, hb = (xB1 - xB0) / 2 - 2, xb = (v) => cB + v / maxB * hb;
    s += '<rect x="' + xB0 + '" y="' + T + '" width="' + (xB1 - xB0) + '" height="' + H + '" fill="rgba(255,255,255,.02)" rx="4"/>';
    s += '<line x1="' + cB + '" x2="' + cB + '" y1="' + T + '" y2="' + (T + H) + '" stroke="#2a3346"/>';
    if(curve.length > 1){
      const pts = curve.map(c => xb(c[1]).toFixed(1) + ',' + y(c[0]).toFixed(1));
      const area = 'M' + cB + ',' + y(curve[0][0]).toFixed(1) + ' L' + pts.join(' L') + ' L' + cB + ',' + y(curve[curve.length - 1][0]).toFixed(1) + 'Z';
      s += '<clipPath id="gexClipP"><rect x="' + cB + '" y="' + T + '" width="' + (xB1 - cB) + '" height="' + H + '"/></clipPath><clipPath id="gexClipN"><rect x="' + xB0 + '" y="' + T + '" width="' + (cB - xB0) + '" height="' + H + '"/></clipPath>';
      s += '<path d="' + area + '" fill="var(--green)" opacity=".28" clip-path="url(#gexClipP)"/><path d="' + area + '" fill="var(--red)" opacity=".28" clip-path="url(#gexClipN)"/>';
      s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#cfd6e4" stroke-width="1.4"/>';
      s += '<text x="' + (cB - 4) + '" y="' + (T + H - 4) + '" fill="#e46a72" text-anchor="end" font-size="9">' + tr('← เร่ง', '← amplify') + '</text><text x="' + (cB + 4) + '" y="' + (T + H - 4) + '" fill="#5ac492" font-size="9">' + tr('หน่วง →', 'damp →') + '</text>';
    }
    // reference lines
    if(isNum(g.putWall) && g.putWall >= lo && g.putWall <= hi) s += hLine(L, xA1, y(g.putWall), '#e46a72', '2 3', 'Put wall ' + kLbl(g.putWall), 'r', W);
    if(isNum(g.callWall) && g.callWall >= lo && g.callWall <= hi) s += hLine(L, xA1, y(g.callWall), '#5ac492', '2 3', 'Call wall ' + kLbl(g.callWall), 'r', W);
    if(isNum(g.zeroGamma) && g.zeroGamma >= lo && g.zeroGamma <= hi) s += hLine(L, W, y(g.zeroGamma), '#f4c95d', '6 4', 'Zero γ ' + kLbl(g.zeroGamma), 'r', W);
    s += hLine(L, W, y(spot), '#ece6d8', '', tr('ราคา ', 'Price ') + kLbl(spot), 'r', W);
    if(!rows.length) s += '<text x="' + (W / 2) + '" y="' + (Hh / 2) + '" fill="#8d95a6" text-anchor="middle">' + tr('ไม่มี strike ในช่วงนี้', 'No strikes in this range') + '</text>';
    box.innerHTML = '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + tr('GEX ของ dealer แยกตาม strike และจุด zero gamma', 'Dealer GEX by strike and the zero-gamma level') + '">' + s + '</svg>';
    gexState.geo = { lo, hi, T, H, rows, curve, W, Hh };
  }
  function gexHover(cx, cy){
    const st = gexState.geo, wrap = el('gexWrap'), tip = el('gexHover');
    if(!st || !wrap || !tip) return;
    const r = wrap.getBoundingClientRect(), py = cy - r.top, px = cx - r.left;
    if(py < st.T || py > st.T + st.H){ tip.hidden = true; return; }
    const price = st.hi - (py - st.T) / st.H * (st.hi - st.lo);
    let best = null; st.rows.forEach(rw => { if(!best || Math.abs(rw.k - price) < Math.abs(best.k - price)) best = rw; });
    let cv = null; st.curve.forEach(c => { if(!cv || Math.abs(c[0] - price) < Math.abs(cv[0] - price)) cv = c; });
    let h = '';
    if(best) h += '<b>Strike ' + fmtPx(best.k) + '</b><br><span style="color:var(--green)">Call ' + fmtUsdBig(best.call) + '</span> · OI ' + best.callOi.toLocaleString('en-US') + ' BTC<br><span style="color:var(--red)">Put ' + fmtUsdBig(best.put) + '</span> · OI ' + best.putOi.toLocaleString('en-US') + ' BTC<br>' + tr('สุทธิ ', 'Net ') + fmtUsdBig(best.net) + tr(' ต่อ 1%', ' per 1%');
    if(cv) h += '<br><span style="color:var(--sub)">' + tr('ถ้าราคาอยู่ที่ ', 'If price were ') + fmtPx(cv[0]) + ': ' + tr('GEX รวม ', 'total GEX ') + '</span><b style="color:' + (cv[1] >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtUsdBig(cv[1]) + '</b>';
    tip.innerHTML = h; tip.hidden = false;
    const tw = tip.offsetWidth || 200, th = tip.offsetHeight || 80;
    tip.style.left = Math.max(4, Math.min(r.width - tw - 4, px + (px > r.width / 2 ? -tw - 12 : 12))) + 'px';
    tip.style.top = Math.max(4, Math.min(r.height - th - 4, py - th / 2)) + 'px';
  }
  async function fetchOptionsGex(force){
    if(gexState.loading) return;
    if(!force && gexState.data && Date.now() - gexState.at < 4 * 60 * 1000) return;
    gexState.loading = true;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/options-gex', 12000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if(!d || !d.gex || !isNum(d.spot)) throw new Error('bad payload');
      gexState.data = d; gexState.at = Date.now();
      renderGexStats(d); renderGexChart(); renderRr(d);
      if(vpState.data) renderVp();
    }catch(e){
      if(!gexState.data){
        el('gexMeaning').textContent = tr('ดึงข้อมูล option จาก Deribit ไม่สำเร็จ ลองใหม่ภายหลัง', 'Could not load Deribit option data. Try again later.');
        el('rrZone').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
      }
    }finally{ gexState.loading = false; }
  }

  // ---------- Volume profile / VPOC (Binance BTCUSDT perp, สำรองด้วย OKX แล้ว Deribit) ----------
  const VP_RANGES = {
    '1d': { binance: '5m', n: 288, okx: '5m', on: 288, deribit: 5, days: 1, th: '1 วัน', en: '1 day' },
    '7d': { binance: '15m', n: 672, okx: '1H', on: 168, deribit: 15, days: 7, th: '7 วัน', en: '7 days' },
    '30d': { binance: '1h', n: 720, okx: '4H', on: 180, deribit: 60, days: 30, th: '30 วัน', en: '30 days' }
  };
  const vpState = { r: '7d', cache: {}, data: null, loading: false };
  function niceStep(raw){
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) || raw;
  }
  // candles [{h,l,c,vol,buy}] → bins of equal price width; each candle's volume spread evenly over its high–low
  function buildVolumeProfile(candles, target){
    const cs = (candles || []).filter(k => k.h > 0 && k.l > 0 && k.h >= k.l && k.vol > 0);
    if(cs.length < 10) return null;
    let lo = Infinity, hi = -Infinity, tot = 0;
    cs.forEach(k => { if(k.l < lo) lo = k.l; if(k.h > hi) hi = k.h; });
    const step = niceStep((hi - lo) / (target || 70));
    const base = Math.floor(lo / step) * step, n = Math.max(1, Math.ceil((hi - base) / step));
    const bins = Array.from({ length: n }, (_, i) => ({ lo: base + i * step, hi: base + (i + 1) * step, vol: 0, buy: 0 }));
    let buyKnown = false;
    cs.forEach(function(k){
      const bShare = isNum(k.buy) && k.vol > 0 ? Math.max(0, Math.min(1, k.buy / k.vol)) : null;
      if(bShare != null) buyKnown = true;
      const i0 = Math.min(n - 1, Math.floor((k.l - base) / step)), i1 = Math.min(n - 1, Math.floor((k.h - base) / step));
      const span = k.h - k.l;
      for(let i = i0; i <= i1; i++){
        const part = span > 0 ? (Math.min(k.h, bins[i].hi) - Math.max(k.l, bins[i].lo)) / span : 1 / (i1 - i0 + 1);
        if(part <= 0) continue;
        const v = k.vol * part;
        bins[i].vol += v; if(bShare != null) bins[i].buy += v * bShare;
      }
      tot += k.vol;
    });
    let poc = 0; bins.forEach((b, i) => { if(b.vol > bins[poc].vol) poc = i; });
    // value area: grow from the POC toward whichever neighbour has more volume until 70% is inside
    let a = poc, b = poc, inside = bins[poc].vol;
    while(inside < tot * 0.7 && (a > 0 || b < n - 1)){
      const up = b < n - 1 ? bins[b + 1].vol : -1, dn = a > 0 ? bins[a - 1].vol : -1;
      if(up >= dn){ b++; inside += up; } else { a--; inside += dn; }
    }
    return { bins, step, poc: (bins[poc].lo + bins[poc].hi) / 2, pocIdx: poc, vaLo: a, vaHi: b, vah: bins[b].hi, val: bins[a].lo, total: tot, buyKnown, last: cs[cs.length - 1].c, from: cs[0].t, to: cs[cs.length - 1].t };
  }
  async function fetchVpCandles(r){
    const c = VP_RANGES[r];
    try{
      const k = parseBinanceKlines(await liqJson('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=' + c.binance + '&limit=' + c.n, 9000));
      if(k.length >= 10) return { candles: k, src: 'Binance BTCUSDT perp · ' + c.binance };
    }catch(e){}
    try{
      const o = parseOkxCandles(await liqJson('https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=' + c.okx + '&limit=' + c.on, 9000));
      if(o.length >= 10) return { candles: o, src: 'OKX BTC-USDT-SWAP · ' + c.okx };
    }catch(e){}
    const now = Date.now(), d = parseDeribitChart(await liqJson('https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&resolution=' + c.deribit + '&start_timestamp=' + (now - c.days * 86400000) + '&end_timestamp=' + now, 9000));
    if(d.length < 10) throw new Error('no candles');
    return { candles: d, src: 'Deribit BTC-PERPETUAL · ' + c.deribit + 'm' };
  }
  // Deribit chart data (column arrays; cost = USD volume) → the same candle shape as parseBinanceKlines
  function parseDeribitChart(j){
    const r = (j && j.result) || {};
    return (r.ticks || []).map((t, i) => ({ t: +t, h: +r.high[i], l: +r.low[i], c: +r.close[i], vol: +(r.cost && r.cost[i]) || 0, buy: null }))
      .filter((k) => k.h > 0 && k.l > 0 && k.c > 0 && isFinite(k.t));
  }
  function vpMeaning(p, px){
    const toPoc = p.poc / px - 1;
    if(px > p.vah) return ['pos', '🟢 <b>' + tr('ราคาอยู่เหนือ value area', 'Price is above the value area') + '</b>: ' + tr('ตลาดกำลังลองราคาที่สูงขึ้น ถ้ายืนเหนือ VAH ' + fmtPx(p.vah) + ' ได้ ขอบนี้มักกลายเป็นแนวรับ ถ้าหลุดกลับเข้ามา มักย้อนไปหา VPOC ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ')', 'the market is testing higher prices. If it holds above the VAH at ' + fmtPx(p.vah) + ', that edge often turns into support; if it slips back inside, it often rotates to the VPOC at ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ').')];
    if(px < p.val) return ['neg', '🔴 <b>' + tr('ราคาอยู่ใต้ value area', 'Price is below the value area') + '</b>: ' + tr('ผู้ขายคุมเกม ตลาดกำลังลองราคาที่ต่ำลง VAL ' + fmtPx(p.val) + ' มักกลายเป็นแนวต้าน ถ้ากลับขึ้นไปยืนในกรอบได้ มักวิ่งไปหา VPOC ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ')', 'sellers are in control and the market is testing lower prices. The VAL at ' + fmtPx(p.val) + ' often becomes resistance; if price gets back inside, it often runs to the VPOC at ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ').')];
    return ['mid', '🔵 <b>' + tr('ราคาอยู่ใน value area', 'Price is inside the value area') + '</b>: ' + tr('ตลาดสมดุล มักแกว่งระหว่าง VAL ' + fmtPx(p.val) + ' ถึง VAH ' + fmtPx(p.vah) + ' โดยมี VPOC ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ') เป็นแม่เหล็ก ถ้าหลุดขอบไหนแล้วยืนได้ มักวิ่งต่อไปทางนั้น', 'a balanced market that tends to rotate between the VAL at ' + fmtPx(p.val) + ' and the VAH at ' + fmtPx(p.vah) + ', with the VPOC at ' + fmtPx(p.poc) + ' (' + fmtSignPct(toPoc) + ') as the magnet. A break that holds outside either edge tends to keep going.')];
  }
  function renderVp(){
    const st = vpState.data, box = el('vpChart'), wrap = el('vpWrap');
    if(!st || !box || !wrap) return;
    const p = st.p, px = p.last;
    el('vpPx').textContent = fmtPx(px);
    el('vpPxSub').textContent = tr(VP_RANGES[vpState.r].th + ' ล่าสุด', 'last ' + VP_RANGES[vpState.r].en);
    el('vpPoc').textContent = fmtPx(p.poc); el('vpPocSub').textContent = fmtSignPct(p.poc / px - 1) + tr(' จากราคา', ' from price');
    el('vpVah').textContent = fmtPx(p.vah); el('vpVahSub').textContent = fmtSignPct(p.vah / px - 1) + tr(' จากราคา', ' from price');
    el('vpVal').textContent = fmtPx(p.val); el('vpValSub').textContent = fmtSignPct(p.val / px - 1) + tr(' จากราคา', ' from price');
    const m = vpMeaning(p, px);
    el('vpMeaning').className = 'gex-meaning ' + m[0]; el('vpMeaning').innerHTML = m[1];
    el('vpSrc').textContent = st.src + ' · ' + tr('ช่องละ ', 'bin ') + fmtPx(p.step) + ' · ' + tr('volume รวม ', 'total volume ') + fmtUsdBig(p.total);
    const W = wrap.clientWidth, Hh = wrap.clientHeight;
    if(!W || !Hh) return;
    const bins = p.bins, lo = bins[0].lo, hi = bins[bins.length - 1].hi;
    const L = W < 520 ? 46 : 58, T = 10, B = 10, H = Hh - T - B, xR = W - (W < 520 ? 70 : 96);
    const ax = priceAxis(lo, hi, T, H), y = ax.y, maxV = Math.max(...bins.map(b => b.vol)) || 1;
    let s = '';
    ax.ticks.forEach(t => { s += '<line x1="' + L + '" x2="' + W + '" y1="' + y(t).toFixed(1) + '" y2="' + y(t).toFixed(1) + '" stroke="#161d2b"/><text x="' + (L - 6) + '" y="' + (y(t) + 3.5).toFixed(1) + '" fill="#8d95a6" text-anchor="end">' + kLbl(t) + '</text>'; });
    bins.forEach(function(b, i){
      const y0 = y(b.hi) + 0.4, h = Math.max(0.8, y(b.lo) - y(b.hi) - 0.8), w = b.vol / maxV * (xR - L - 6);
      const inVa = i >= p.vaLo && i <= p.vaHi, isPoc = i === p.pocIdx;
      const col = isPoc ? '#f4c95d' : inVa ? '#5aa7e0' : '#3a4356';
      if(p.buyKnown && b.vol > 0 && !isPoc){
        const wb = w * (b.buy / b.vol);
        s += '<rect x="' + (L + 2) + '" y="' + y0.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + col + '" opacity="' + (inVa ? .9 : .8) + '"/>'
          + '<rect x="' + (L + 2) + '" y="' + (y0 + h - Math.max(1, h * 0.28)).toFixed(1) + '" width="' + wb.toFixed(1) + '" height="' + Math.max(1, h * 0.28).toFixed(1) + '" fill="var(--green)" opacity=".75"/>'
          + '<rect x="' + (L + 2 + wb).toFixed(1) + '" y="' + (y0 + h - Math.max(1, h * 0.28)).toFixed(1) + '" width="' + (w - wb).toFixed(1) + '" height="' + Math.max(1, h * 0.28).toFixed(1) + '" fill="var(--red)" opacity=".6"/>';
      }else s += '<rect x="' + (L + 2) + '" y="' + y0.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + col + '"/>';
    });
    s += '<rect x="' + L + '" y="' + y(p.vah).toFixed(1) + '" width="' + (W - L) + '" height="' + (y(p.val) - y(p.vah)).toFixed(1) + '" fill="rgba(90,167,224,.05)"/>';
    s += hLine(L, W, y(p.vah), '#5aa7e0', '3 3', 'VAH ' + kLbl(p.vah), 'r', W);
    s += hLine(L, W, y(p.val), '#5aa7e0', '3 3', 'VAL ' + kLbl(p.val), 'r', W);
    const zg = gexState.data && gexState.data.gex && gexState.data.gex.zeroGamma;
    if(isNum(zg) && zg >= lo && zg <= hi) s += hLine(L, W, y(zg), '#f4c95d', '6 4', 'Zero γ ' + kLbl(zg), 'r', W);
    s += hLine(L, W, y(p.poc), '#f4c95d', '', 'VPOC ' + kLbl(p.poc), 'r', W);
    s += hLine(L, W, y(px), '#ece6d8', '', tr('ราคา ', 'Price ') + kLbl(px), 'r', W);
    box.innerHTML = '<svg width="' + W + '" height="' + Hh + '" viewBox="0 0 ' + W + ' ' + Hh + '" role="img" aria-label="' + tr('Volume profile ของ BTC และ VPOC', 'BTC volume profile and VPOC') + '">' + s + '</svg>';
    st.geo = { lo, hi, T, H };
  }
  function vpHover(cx, cy){
    const st = vpState.data, wrap = el('vpWrap'), tip = el('vpHover');
    if(!st || !st.geo || !wrap || !tip) return;
    const r = wrap.getBoundingClientRect(), py = cy - r.top, px = cx - r.left, G = st.geo;
    if(py < G.T || py > G.T + G.H){ tip.hidden = true; return; }
    const price = G.hi - (py - G.T) / G.H * (G.hi - G.lo);
    const b = st.p.bins.find(x => price >= x.lo && price < x.hi) || st.p.bins[st.p.bins.length - 1];
    const share = b.vol / st.p.total;
    tip.innerHTML = '<b>' + fmtPx(b.lo) + ' – ' + fmtPx(b.hi) + '</b><br>Volume ' + fmtUsdBig(b.vol) + ' (' + (share * 100).toFixed(1) + '%)'
      + (st.p.buyKnown && b.vol > 0 ? '<br><span style="color:var(--green)">' + tr('ซื้อ ', 'Buy ') + Math.round(b.buy / b.vol * 100) + '%</span> · <span style="color:var(--red)">' + tr('ขาย ', 'Sell ') + Math.round(100 - b.buy / b.vol * 100) + '%</span>' : '');
    tip.hidden = false;
    const tw = tip.offsetWidth || 180, th = tip.offsetHeight || 60;
    tip.style.left = Math.max(4, Math.min(r.width - tw - 4, px + (px > r.width / 2 ? -tw - 12 : 12))) + 'px';
    tip.style.top = Math.max(4, Math.min(r.height - th - 4, py - th / 2)) + 'px';
  }
  async function fetchVpoc(force){
    const r = vpState.r, hit = vpState.cache[r];
    if(!force && hit && Date.now() - hit.at < 5 * 60000){ vpState.data = hit; renderVp(); return; }
    if(vpState.loading) return;
    vpState.loading = true;
    try{
      const got = await fetchVpCandles(r);
      const p = buildVolumeProfile(got.candles, r === '1d' ? 60 : 75);
      if(!p) throw new Error('too few candles');
      vpState.cache[r] = { p, src: got.src, at: Date.now() };
      if(vpState.r === r){ vpState.data = vpState.cache[r]; renderVp(); }
    }catch(e){
      if(!vpState.data) el('vpMeaning').textContent = tr('ดึงแท่งเทียนจาก Binance/OKX/Deribit ไม่สำเร็จ ลองใหม่ภายหลัง', 'Could not load candles from Binance, OKX or Deribit. Try again later.');
    }finally{ vpState.loading = false; }
  }
  (function wireOptionsAndVp(){
    function wireRanges(id, attr, fn){
      const g = el(id); if(!g) return;
      g.addEventListener('click', (ev) => {
        const btn = ev.target && ev.target.closest ? ev.target.closest('button[' + attr + ']') : null;
        if(!btn) return;
        g.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
        fn(btn.getAttribute(attr));
      });
    }
    wireRanges('gexRanges', 'data-band', (v) => { gexState.band = parseFloat(v) || 0.2; renderGexChart(); });
    wireRanges('vpRanges', 'data-r', (v) => { vpState.r = VP_RANGES[v] ? v : '7d'; fetchVpoc(false); });
    [['gexWrap', 'gexHover', gexHover, renderGexChart], ['vpWrap', 'vpHover', vpHover, renderVp]].forEach(function(row){
      const wrap = el(row[0]); if(!wrap) return;
      const tip = () => el(row[1]);
      wrap.addEventListener('mousemove', (ev) => row[2](ev.clientX, ev.clientY));
      wrap.addEventListener('mouseleave', () => { tip().hidden = true; });
      let hideT = 0;
      const onTouch = (ev) => { const t = ev.touches && ev.touches[0]; if(t){ row[2](t.clientX, t.clientY); clearTimeout(hideT); hideT = setTimeout(() => { tip().hidden = true; }, 2500); } };
      wrap.addEventListener('touchstart', onTouch, { passive: true });
      wrap.addEventListener('touchmove', onTouch, { passive: true });
      // the ₿ tab may be hidden when data lands (width 0) → draw again whenever the box gets a size
      let lastW = 0;
      if(typeof ResizeObserver === 'function') new ResizeObserver(() => { const w = wrap.clientWidth; if(w && w !== lastW){ lastW = w; row[3](); } }).observe(wrap);
      else window.addEventListener('resize', () => row[3]());
    });
  })();
  setInterval(() => { if(document.body.classList.contains('theme-btc') && !document.hidden){ fetchOptionsGex(false); fetchVpoc(false); } }, 5 * 60 * 1000);
  if(typeof window !== 'undefined') window.__optTest = { gexRoughBtc, buildVolumeProfile, parseDeribitChart, rrZone, rrTipHtml, rrTermSvg, gexMeaning, niceStep, gexState, vpState };

  // ---------- BTC Spot ETF Flow (สหรัฐฯ รายวัน, US$ ล้าน) ----------
  // มาจาก /.netlify/functions/etf-flow เท่านั้น (Farside ไม่มี CORS และกันบอท ต้องดึงฝั่งเซิร์ฟเวอร์)
  // ข้อมูลออกวันละครั้งหลังตลาดสหรัฐฯ ปิด ไม่ใช่ real-time
  function etfZone(v){
    return v >= 500 ? [tr('🟢 ไหลเข้าแรง', '🟢 Strong inflow'), 'var(--green)']
      : v >= 100 ? [tr('🔵 ไหลเข้า', '🔵 Inflow'), 'var(--cool)']
      : v > -100 ? [tr('🟡 ทรงตัว', '🟡 Flat'), '']
      : v > -500 ? [tr('🟠 ไหลออก', '🟠 Outflow'), 'var(--amber)']
      : [tr('🔴 ไหลออกแรง', '🔴 Strong outflow'), 'var(--red)'];
  }
  function fmtFlow(v){ return (v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 }) + 'M'; }
  function etfBarsSvg(hist){
    const pts = (hist || []).filter(p => isNum(p[1]));
    if(pts.length < 2) return '';
    const W = 300, H = 64, max = Math.max.apply(null, pts.map(p => Math.abs(p[1]))) || 1, mid = H / 2, bw = W / pts.length;
    const bars = pts.map(function(p, i){
      const h = Math.max(1, Math.abs(p[1]) / max * (mid - 2));
      return '<rect x="' + (i * bw + bw * 0.15).toFixed(1) + '" y="' + (p[1] >= 0 ? mid - h : mid).toFixed(1) + '" width="' + (bw * 0.7).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (p[1] >= 0 ? 'var(--green)' : 'var(--red)') + '"/>';
    }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + tr('กระแสเงิน ETF 30 วัน', 'ETF flow, 30 days') + '">'
      + '<line x1="0" x2="' + W + '" y1="' + mid + '" y2="' + mid + '" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>' + bars + '</svg>'
      + '<div class="spark-cap"><span>' + pts[0][0] + '</span><span>' + tr(pts.length + ' วันทำการ', pts.length + ' trading days') + '</span><span>' + pts[pts.length - 1][0] + '</span></div>';
  }
  // ชี้เมาส์ / แตะแท่ง → บอกวันที่และยอด +/− ของวันนั้น
  function bindEtfTip(box, pts){
    const svg = box.querySelector('svg'), tip = box.querySelector('.etf-tip');
    if(!svg || !tip || !pts.length) return;
    const rects = svg.querySelectorAll('rect');
    function show(ev){
      const r = svg.getBoundingClientRect();
      if(!r.width) return;
      const i = Math.max(0, Math.min(pts.length - 1, Math.floor((ev.clientX - r.left) / r.width * pts.length)));
      const v = pts[i][1];
      tip.innerHTML = pts[i][0] + ' · <b style="color:' + (v >= 0 ? 'var(--green)' : 'var(--red)') + '">' + fmtFlow(v) + '</b>';
      const x = (i + 0.5) / pts.length * r.width + (r.left - box.getBoundingClientRect().left);
      tip.style.left = Math.max(60, Math.min(box.clientWidth - 60, x)) + 'px';
      tip.hidden = false;
      rects.forEach((el2, k) => el2.classList.toggle('hl', k === i));
    }
    function hide(){ tip.hidden = true; rects.forEach(el2 => el2.classList.remove('hl')); }
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', function(ev){ if(ev.pointerType === 'mouse') hide(); });
    document.addEventListener('pointerdown', function(ev){ if(!svg.contains(ev.target)) hide(); });
  }
  async function fetchEtfFlow(){
    let d = null;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/etf-flow', 12000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
      if(!isNum(d.net)) throw new Error('no value');
    }catch(e){ d = null; }
    if(!d){ el('etfZone').textContent = tr('ดึงไม่สำเร็จ (ข้อมูลรายวัน ลองใหม่ภายหลัง)', 'Unavailable (daily data, try later)'); return; }
    const z = etfZone(d.net);
    el('etfNum').textContent = fmtFlow(d.net);
    el('etfNum').style.color = z[1];
    const miss = d.partial && d.missing && d.missing.length ? d.missing.slice(0, 3).join(', ') + (d.missing.length > 3 ? ' +' + (d.missing.length - 3) : '') : '';
    el('etfZone').textContent = z[0] + tr(' · วันที่ ', ' · ') + d.date + (d.stale ? tr(' (ข้อมูลเก่า)', ' (stale)') : '')
      + (miss ? tr(' · ⏳ ยังรายงานไม่ครบ รอ ' + miss + ' ตัวเลขยังเปลี่ยนได้', ' · ⏳ incomplete, waiting for ' + miss + ', number may still change') : '');
    el('etfZone').title = (d.source || '') + ' · ' + (d.fetchedAt || '');
    const funds = (d.funds || []).map(f => f[0] + ' ' + fmtFlow(f[1])).join(' · ');
    el('etfSums').textContent = tr('รวม 5 วัน ', '5-day ') + fmtFlow(d.sum5) + tr(' · 30 วัน ', ' · 30-day ') + fmtFlow(d.sum30) + (funds ? ' · ' + funds : '');
    el('etfBars').innerHTML = etfBarsSvg(d.hist) + '<div class="etf-tip" hidden></div>';
    bindEtfTip(el('etfBars'), (d.hist || []).filter(p => isNum(p[1])));
  }

  // ---------- Stablecoin Market Cap (มูลค่ารวม stablecoin ทั้งหมด ≈ CRYPTOCAP:STABLE.C) ----------
  // ชั้นแรก: /.netlify/functions/stablecoins (แคช 1 ชม. + สำเนาใน localStorage) · ถ้าล่ม ดึงตรงจาก DefiLlama
  // เกณฑ์เดียว (stableVerdict) ใช้ทั้งสีตัวเลขและบทวิเคราะห์ใต้ตัวเลข การ์ดกับคำอธิบายจึงไม่มีทางขัดกัน
  const STABLE_DIRECT = 'https://stablecoins.llama.fi/stablecoincharts/all';
  function stableVerdict(p7, p30){
    const has7 = isNum(p7), has30 = isNum(p30);
    if(!has7 && !has30) return { key:'none', color:'', label:tr('ยังไม่มีข้อมูลย้อนหลังพอ', 'Not enough history yet'), read:'' };
    if((has7 && p7 <= -1) || (has30 && p30 <= -1.5)) return { key:'out', color:'var(--red)', label:tr('🔴 เงินไหลออก', '🔴 Outflow'),
      read:tr('มูลค่า stablecoin หดตัว = คนถอนเงินสดออกจากโลกคริปโต กำลังซื้อที่รอเข้าตลาดลดลง เป็นสัญญาณลบต่อ BTC ในระยะกลาง',
              'Stablecoin supply is shrinking = cash is leaving crypto and the buying power waiting on the sidelines is falling, a negative sign for BTC over the medium term') };
    if(((has30 && p30 >= 1.5) || (has7 && p7 >= 1)) && (!has7 || p7 > -0.25)) return { key:'in', color:'var(--green)', label:tr('🟢 เงินไหลเข้า', '🟢 Inflow'),
      read:tr('มูลค่า stablecoin โตขึ้น = มีเงินใหม่เข้ามาในระบบ เป็นกำลังซื้อพร้อมเข้าซื้อ BTC และเหรียญอื่น หนุนราคาในระยะกลาง',
              'Stablecoin supply is growing = new money is coming in, buying power ready for BTC and other coins that supports prices over the medium term') };
    return { key:'flat', color:'var(--amber)', label:tr('🟡 ทรงตัว', '🟡 Flat'),
      read:tr('มูลค่า stablecoin แทบไม่เปลี่ยน = ไม่มีเงินใหม่ไหลเข้าหรือออกชัดเจน ราคาต้องพึ่งแรงอื่น ดู ETF Flow และ Open Interest ประกอบ',
              'Stablecoin supply is barely moving = no clear new money in or out, so price depends on other drivers; check ETF Flow and Open Interest') };
  }
  function fmtStableBn(v){ return '$' + (v >= 1000 ? (v / 1000).toFixed(2) + 'T' : v.toFixed(2) + 'B'); }
  function fmtStableCh(abs, pct){
    if(!isNum(pct)) return '–';
    const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
    return sign + Math.abs(pct).toFixed(2) + '%' + (isNum(abs) ? ' (' + sign + '$' + Math.abs(abs).toFixed(1) + 'B)' : '');
  }
  // DefiLlama rows → รูปเดียวกับที่ฟังก์ชันตอบ (ใช้ตอนเซิร์ฟเวอร์ล่ม)
  function stableFromLlama(rows){
    const byDay = {};
    (Array.isArray(rows) ? rows : []).forEach(function(r){
      const sec = Number(r && r.date), t = r && r.totalCirculatingUSD;
      if(!isFinite(sec) || sec <= 0 || !t || typeof t !== 'object') return;
      let sum = 0; Object.keys(t).forEach(function(k){ const n = Number(t[k]); if(isFinite(n) && n > 0) sum += n; });
      const bn = sum / 1e9;
      if(bn >= 1 && bn <= 100000) byDay[new Date(sec * 1000).toISOString().slice(0,10)] = Math.round(bn * 100) / 100;
    });
    const days = Object.keys(byDay).sort().map(function(d){ return [d, byDay[d]]; });
    if(!days.length) throw new Error('no rows');
    const last = days[days.length - 1], lastT = Date.parse(last[0] + 'T00:00:00Z');
    function ch(n){
      for(let i = days.length - 2; i >= 0; i--) if(Date.parse(days[i][0] + 'T00:00:00Z') <= lastT - n * 86400000){
        const b = days[i][1]; return b > 0 ? [Math.round((last[1] - b) * 100) / 100, Math.round((last[1] / b - 1) * 10000) / 100] : [null, null];
      }
      return [null, null];
    }
    const c7 = ch(7), c30 = ch(30);
    return { latest:last[1], date:last[0], ch7:c7[0], ch7Pct:c7[1], ch30:c30[0], ch30Pct:c30[1], hist:days.slice(-366), source:'defillama (direct)' };
  }
  async function fetchStablecoins(){
    let d = null;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/stablecoins', 10000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      d = await r.json();
      if(!isNum(d.latest)) throw new Error('no value');
    }catch(e){
      try{
        const r = await fetchWithTimeout(STABLE_DIRECT, 15000);
        if(!r.ok) throw new Error('HTTP ' + r.status);
        d = stableFromLlama(await r.json());
      }catch(e2){ d = null; }
    }
    if(!d){ el('stableZone').textContent = tr('ดึงไม่สำเร็จ (ลองใหม่ภายหลัง)', 'Unavailable (try later)'); return; }
    const v = stableVerdict(d.ch7Pct, d.ch30Pct);
    const p7 = d.ch7Pct;
    el('stableNum').innerHTML = fmtStableBn(d.latest) + (isNum(p7) ? '<span class="delta ' + (p7 > 0 ? 'up' : p7 < 0 ? 'down' : 'flat') + '">' + (p7 > 0 ? '+' : '') + p7.toFixed(2) + '% 7D</span>' : '');
    el('stableNum').style.color = v.color;
    el('stableNum').dataset.verdict = v.key;
    el('stableZone').textContent = v.label + tr(' · ข้อมูลวันที่ ', ' · as of ') + d.date + (d.stale ? tr(' (ข้อมูลเก่า)', ' (stale)') : '');
    el('stableChanges').textContent = tr('7 วัน ', '7d ') + fmtStableCh(null, d.ch7Pct) + tr(' · 30 วัน ', ' · 30d ') + fmtStableCh(null, d.ch30Pct);
    el('stableChanges').title = tr('7 วัน ', '7d ') + fmtStableCh(d.ch7, d.ch7Pct) + ' · ' + tr('30 วัน ', '30d ') + fmtStableCh(d.ch30, d.ch30Pct);
    el('stableZone').dataset.verdict = v.key;
    el('stableZone').title = v.read + ' · DefiLlama · ' + (d.source || '');
    if(window.giSetSpark) window.giSetSpark('spStable', d, v.color ? { dec:0, color:v.color } : { dec:0 });   // เส้นกราฟสีเดียวกับคำตัดสิน
  }
  if(typeof window !== 'undefined') window.__stableTest = { stableVerdict, stableFromLlama, fmtStableBn, fmtStableCh };

  // ---------- Miners: cost to mine 1 BTC + are miners selling? ----------
  // Raw inputs (difficulty, fees, Hash Ribbons, Puell) come from /.netlify/functions/btc-mining;
  // the cost is worked out here from fixed network-average assumptions (MINE_DEFAULTS).
  // var, not let: recompute() calls renderMining() and can run before this line is reached.
  var lastMining = null;
  const MINE_TWO32 = 4294967296;
  // eff = J/TH ของเครื่องเฉลี่ยทั้งเครือข่าย ซึ่งไม่มีใครรู้แน่ จึงโชว์เป็นช่วง effLo–effHi ด้วย (คำตัดสินใช้ค่ากลาง)
  const MINE_DEFAULTS = { kwh: 0.05, eff: 22, effLo: 18, effHi: 28 };
  // Hash Ribbons ที่เพิ่งตัดลงไม่กี่วันมักกลับไปกลับมา ยังไม่นับเป็นสัญญาณ "ถูกบีบ" จนกว่าจะค้างครบ
  const RIBBON_CONFIRM_DAYS = 3;

  // US$ per BTC. difficulty × 2^32 = hashes per block; × J/TH ÷ 1e12 = joules; ÷ 3.6e6 = kWh.
  function mineCost(difficulty, subsidy, fee, kwh, eff){
    if(!(difficulty > 0) || !(subsidy > 0) || !(kwh > 0) || !(eff > 0)) return null;
    const kwhPerBlock = difficulty * MINE_TWO32 / 1e12 * eff / 3.6e6;
    const reward = subsidy + (fee > 0 ? fee : 0);
    const elec = kwhPerBlock * kwh / reward;
    return { elec, kwhPerBlock, reward };
  }
  // US$ earned per PH/s per day at this price
  function mineHashprice(difficulty, reward, price){
    if(!(difficulty > 0) || !(reward > 0) || !(price > 0)) return null;
    return reward * price * 86400 * 1e15 / (difficulty * MINE_TWO32);
  }
  function mineMarginVerdict(price, c){
    if(!(price > 0) || !c) return { key:'none', color:'', label:'' };
    if(price < c.elec) return { key:'cash', color:'var(--red)', label:tr('🔴 ราคาต่ำกว่าค่าไฟ: นักขุดขาดทุนทุกบล็อก', '🔴 Price below the power cost: miners lose on every block') };
    if(price < c.elec * 1.2) return { key:'squeeze', color:'#e8894a', label:tr('🟠 ราคาเหนือค่าไฟไม่ถึง 20%: นักขุดถูกบีบ', '🟠 Price less than 20% above power: miners squeezed') };
    if(price < c.elec * 1.5) return { key:'thin', color:'var(--amber)', label:tr('🟡 ราคาเหนือค่าไฟ 20–50%: พอไปได้', '🟡 Price 20–50% above power: getting by') };
    return { key:'healthy', color:'var(--green)', label:tr('🟢 ราคาเหนือค่าไฟ 50% ขึ้นไป: นักขุดกำไรดี', '🟢 Price 50%+ above power: healthy margins') };
  }
  // ribbon: 'capitulation' | 'recovery' | 'normal' | null; margin = price ÷ power cost − 1
  function minerVerdict(ribbon, puell, margin, belowElec, ribbonDays){
    const why = [];
    const early = ribbon === 'capitulation' && isNum(ribbonDays) && ribbonDays < RIBBON_CONFIRM_DAYS;
    if(ribbon === 'capitulation' && !early) why.push(tr('Hash Ribbons ตัดลง (นักขุดปิดเครื่อง)', 'Hash Ribbons crossed down (machines switching off)'));
    if(belowElec) why.push(tr('ราคาต่ำกว่าค่าไฟ', 'price below electricity cost'));
    if(isNum(puell) && puell < 0.5) why.push(tr('Puell ต่ำกว่า 0.5 (รายได้หดหนัก)', 'Puell below 0.5 (revenue squeezed)'));
    if(!why.length && early) return { key:'watch', color:'var(--amber)', label:tr('🟡 เริ่มมีสัญญาณ ยังไม่ยืนยัน', '🟡 Early sign, not confirmed'),
      why:[tr('Hash Ribbons เพิ่งตัดลง ' + ribbonDays + ' วัน (ต้องค้างอย่างน้อย ' + RIBBON_CONFIRM_DAYS + ' วันถึงนับ)', 'Hash Ribbons crossed down ' + ribbonDays + ' day(s) ago (needs ' + RIBBON_CONFIRM_DAYS + '+ days to count)')] };
    if(why.length) return { key:'stress', color:'var(--red)', label:tr('🔴 ถูกบีบ: มีแนวโน้มเทขาย', '🔴 Under stress: likely selling'), why };
    if(isNum(puell) && puell >= 2) return { key:'profit', color:'#e8894a', label:tr('🟠 ขายทำกำไรมากกว่าปกติ', '🟠 Selling for profit more than usual'), why:[tr('Puell 2 ขึ้นไป รายได้ดีผิดปกติ', 'Puell 2 or more: unusually rich revenue')] };
    if(ribbon === 'recovery') return { key:'recovery', color:'var(--green)', label:tr('🟢 ช่วงปิดเครื่องจบ: แรงขายลดลง', '🟢 Capitulation over: selling easing'), why:[tr('Hash Ribbons เพิ่งตัดขึ้น ในอดีตมักเป็นจังหวะซื้อที่ดี', 'Hash Ribbons just crossed up, historically a good time to buy')] };
    if(isNum(margin) && margin >= 0.5 && (!isNum(puell) || puell < 1.2)) return { key:'hold', color:'var(--cool)', label:tr('🔵 กำไรดี ไม่มีแรงกดดัน: มีแนวโน้มเก็บเหรียญ', '🔵 Comfortable: likely holding coins'), why:[tr('ราคาเหนือค่าไฟ 50% ขึ้นไป และ Puell ยังไม่สูง', 'price 50%+ over the power cost and Puell not stretched')] };
    return { key:'normal', color:'var(--amber)', label:tr('🟡 ปกติ: ขายราวเท่าที่ขุดได้', '🟡 Normal: selling about what they mine'), why:[tr('ไม่มีสัญญาณบีบหรือขายทำกำไร', 'no stress or profit-taking signal')] };
  }
  function mineUsd(v){ return isNum(v) ? '$' + (v >= 1000 ? (Math.round(v / 100) / 10).toLocaleString('en-US') + 'k' : Math.round(v).toLocaleString('en-US')) : '–'; }
  function ribbonSvg(hist){
    if(!hist || hist.length < 2) return '';
    const vals = hist.flatMap((r) => [r[1], r[2]]);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = (hi - lo) || 1, W = 300, H = 56;
    const path = (j) => hist.map((r, i) => (i ? 'L' : 'M') + (i / (hist.length - 1) * W).toFixed(1) + ',' + (H - 3 - (r[j] - lo) / span * (H - 6)).toFixed(1)).join('');
    const last = hist[hist.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<path d="' + path(2) + '" fill="none" stroke="var(--sub)" stroke-width="1.5" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>'
      + '<path d="' + path(1) + '" fill="none" stroke="' + (last[1] < last[2] ? 'var(--red)' : 'var(--green)') + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>'
      + '<div class="spark-cap"><span>' + tr('6 เดือน · 30 วัน / 60 วัน', '6 months · 30d / 60d') + '</span><span>' + last[1] + ' / ' + last[2] + ' EH/s</span></div>';
  }

  function renderMining(){
    const d = lastMining;
    if(!d || !el('mineCost')) return;
    const inp = MINE_DEFAULTS;
    const typed = parseFloat(priceInput.value);
    const price = typed > 0 ? typed : d.price;
    const c = mineCost(d.difficulty, d.subsidy, d.feePerBlock, inp.kwh, inp.eff);
    const mv = mineMarginVerdict(price, c);
    const margin = c && price > 0 ? price / c.elec - 1 : null;
    el('mineCost').textContent = c ? mineUsd(c.elec) : '–';
    const cLo = mineCost(d.difficulty, d.subsidy, d.feePerBlock, inp.kwh, inp.effLo), cHi = mineCost(d.difficulty, d.subsidy, d.feePerBlock, inp.kwh, inp.effHi);
    if(el('mineRange')) el('mineRange').textContent = cLo && cHi
      ? tr('ช่วงที่เป็นไปได้ ' + mineUsd(cLo.elec) + '–' + mineUsd(cHi.elec) + ' (เครื่อง ' + inp.effLo + '–' + inp.effHi + ' J/TH · ค่ากลาง ' + inp.eff + ') · ค่าไฟ $' + inp.kwh + '/kWh · ไม่รวมค่าเครื่องและค่าดำเนินการ',
          'Plausible range ' + mineUsd(cLo.elec) + '–' + mineUsd(cHi.elec) + ' (machines ' + inp.effLo + '–' + inp.effHi + ' J/TH · midpoint ' + inp.eff + ') · power $' + inp.kwh + '/kWh · excludes machines and running costs')
      : '';
    el('mineCost').style.color = mv.color;
    el('mineCost').dataset.verdict = mv.key;
    el('mineCostZone').textContent = c ? (mv.label + (isNum(margin) ? ' (' + tr('ราคา ', 'price ') + (margin >= 0 ? '+' : '') + Math.round(margin * 100) + '%)' : '')) : tr('ดึงไม่สำเร็จ (ลองใหม่ภายหลัง)', 'Unavailable (try later)');
    el('mineCostZone').dataset.verdict = mv.key;
    if(c){
      el('mineCostSub').textContent = tr('ค่าไฟต่อ 1 BTC ', 'Power cost per BTC ') + mineUsd(c.elec) + tr(' · ราคา ', ' · price ') + mineUsd(price);
      // scale: the power cost and 1.5× it (green from there) as ticks, price as a dot
      const top = c.elec * 1.5, lo = Math.min(c.elec, price || c.elec) * 0.8, hi = Math.max(top, price || top) * 1.1;
      const pos = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
      const e = pos(c.elec), a = pos(top), p = price > 0 ? pos(price) : null;
      el('mineScale').innerHTML = '<div class="bar" style="--e:' + e.toFixed(1) + '%; --a:' + a.toFixed(1) + '%;"></div>'
        + '<i class="pin" style="left:' + e.toFixed(1) + '%"></i><i class="pin" style="left:' + a.toFixed(1) + '%"></i>'
        + (p != null ? '<i class="pin px" style="left:' + p.toFixed(1) + '%; background:' + (mv.color || 'var(--text)') + '"></i>' : '')
        + '<span class="lbl' + (e < 12 ? ' l0' : '') + '" style="left:' + e.toFixed(1) + '%">' + tr('ค่าไฟ', 'power') + '</span>'
        + '<span class="lbl' + (a > 88 ? ' l1' : '') + '" style="left:' + a.toFixed(1) + '%">' + tr('ค่าไฟ +50%', 'power +50%') + '</span>';
      const hp = mineHashprice(d.difficulty, c.reward, price);
      const breakeven = price > 0 ? price * c.reward / c.kwhPerBlock : null;
      el('mineNet').textContent = 'Hashprice ' + (isNum(hp) ? '$' + hp.toFixed(1) + tr('/PH/วัน', '/PH/day') : '–')
        + ' · Hashrate ' + (isNum(d.hashrateEh) ? Math.round(d.hashrateEh).toLocaleString('en-US') + ' EH/s' : '–')
        + (isNum(breakeven) ? tr(' · ค่าไฟคุ้มทุนที่ราคานี้ ≤ $', ' · break-even power price ≤ $') + breakeven.toFixed(3) + '/kWh' : '')
        + tr(' · ข้อมูลวันที่ ', ' · as of ') + (d.date || '–') + (d.stale ? tr(' (ข้อมูลเก่า)', ' (stale)') : '');
    }
    const rib = d.ribbon ? d.ribbon.state : null;
    const v = minerVerdict(rib, d.puell, margin, !!(c && price > 0 && price < c.elec), d.ribbon ? d.ribbon.days : null);
    el('mineVerdict').textContent = v.label;
    el('mineVerdict').style.color = v.color;
    el('mineVerdict').dataset.verdict = v.key;
    el('mineWhy').textContent = tr('เหตุผล: ', 'Why: ') + v.why.join(' · ');
    const ribTxt = !d.ribbon ? '–' : (d.ribbon.state === 'capitulation' ? tr('🔴 30 วัน < 60 วัน ', '🔴 30d < 60d ') + tr('มา ', 'for ') + d.ribbon.days + tr(' วัน', ' days')
      : d.ribbon.state === 'recovery' ? tr('🟢 เพิ่งตัดขึ้น ', '🟢 crossed up ') + d.ribbon.days + tr(' วันก่อน', ' days ago')
      : tr('30 วัน > 60 วัน (ปกติ)', '30d > 60d (normal)'));
    const puTxt = !isNum(d.puell) ? '–' : d.puell.toFixed(2) + (d.puell < 0.5 ? tr(' (ต่ำมาก)', ' (very low)') : d.puell >= 2 ? tr(' (สูง)', ' (high)') : d.puell < 0.8 ? tr(' (ต่ำ)', ' (low)') : tr(' (กลาง)', ' (mid)'));
    const mTxt = isNum(margin) ? (margin >= 0 ? '+' : '') + Math.round(margin * 100) + tr('% เทียบค่าไฟ', '% vs power cost') : '–';
    el('mineSigs').innerHTML = '<div><span>Hash Ribbons</span><b>' + ribTxt + '</b></div>'
      + '<div><span>Puell Multiple</span><b>' + puTxt + '</b></div>'
      + '<div><span>' + tr('ราคาเทียบต้นทุน', 'Price vs cost') + '</span><b>' + mTxt + '</b></div>';
    el('mineRibbon').innerHTML = ribbonSvg(d.hist);
  }

  async function fetchMining(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/btc-mining', 20000);
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const d = await r.json();
      if(!isNum(d.difficulty)) throw new Error('no difficulty');
      lastMining = d;
      if(isNum(d.puell)){ window.giBtcSignals = Object.assign(window.giBtcSignals || {}, { puell: d.puell }); try{ window.dispatchEvent(new Event('gi-btc-signals')); }catch(e){} }
    }catch(e){
      if(!lastMining){
        el('mineCostZone').textContent = tr('ดึงไม่สำเร็จ (ลองใหม่ภายหลัง)', 'Unavailable (try later)');
        el('mineWhy').textContent = tr('ดึงไม่สำเร็จ (ลองใหม่ภายหลัง)', 'Unavailable (try later)');
        return;
      }
    }
    renderMining();
  }
  if(typeof window !== 'undefined') window.__mineTest = { mineCost, mineHashprice, mineMarginVerdict, minerVerdict, ribbonSvg };

  // ---------- Bitcoin Halving Countdown ----------
  // Primary: pure date arithmetic, no network call, cannot hang or fail — based on the
  // widely-cited estimate (~Apr 17, 2028, block 1,050,000) that CoinGecko/mempool.space/
  // major trackers currently agree on. Shows instantly on every page load.
  // Optional refinement: try mempool.space once per calendar day (short 4s timeout, if it
  // doesn't answer in time we just keep the date-math estimate) to recompute from the real
  // current block height for a slightly tighter number. Cached so it only ever fires once/day.
  const HALVING_BLOCK = 1050000;
  const HALVING_ESTIMATED_DATE = new Date('2028-04-17T00:00:00Z');

  function renderHalvingFromDate(){
    const now = new Date();
    const days = Math.max(0, Math.ceil((HALVING_ESTIMATED_DATE - now) / 86400000));
    el('halvingDays').textContent = days.toLocaleString();
    el('halvingBlockInfo').textContent = tr('ประมาณการจากวันที่ (~17 เม.ย. 2028) · block เป้าหมาย 1,050,000', 'Estimated from the date (~17 Apr 2028) · target block 1,050,000');
  }

  async function refineHalvingFromBlockHeight(){
    const today = new Date().toISOString().slice(0,10);
    try{
      const raw = await storageGet('halving-cache');
      if(raw){
        const c = JSON.parse(raw);
        if(c.date === today){
          el('halvingDays').textContent = c.days.toLocaleString();
          el('halvingBlockInfo').textContent = tr('Block ปัจจุบัน: ', 'Current block: ') + c.height.toLocaleString() + tr(' · เหลืออีก ', ' · ') + c.blocksRemaining.toLocaleString() + tr(' บล็อก', ' blocks to go');
          return; // already refined today, no need to hit the network again
        }
      }
    }catch(e){ /* no cache yet, fall through to fetch */ }

    try{
      const r = await fetchWithTimeout('https://mempool.space/api/blocks/tip/height', 4000);
      const heightText = await r.text();
      const height = parseInt(heightText, 10);
      if(isNaN(height)) throw new Error('bad height');
      const blocksRemaining = Math.max(0, HALVING_BLOCK - height);
      const days = Math.ceil((blocksRemaining * 600) / 86400);
      el('halvingDays').textContent = days.toLocaleString();
      el('halvingBlockInfo').textContent = tr('Block ปัจจุบัน: ', 'Current block: ') + height.toLocaleString() + tr(' · เหลืออีก ', ' · ') + blocksRemaining.toLocaleString() + tr(' บล็อก', ' blocks to go');
      await storageSet('halving-cache', JSON.stringify({ date: today, height, blocksRemaining, days }));
    }catch(e){
      // timeout or network error — silently keep the date-math estimate already shown, no error message needed
    }
  }

  async function fetchHalvingCountdown(){
    renderHalvingFromDate(); // instant, always works
    await refineHalvingFromBlockHeight(); // best-effort refinement, capped at 4s, cached daily
  }

  async function refreshAll(force){
    statusEl.textContent = tr('กำลังอัปเดต…', 'Updating…');
    const priceOk = await fetchPrice(); // must resolve first: OI conversion below needs a live price
    fetchLiqHeatmap(force); // not awaited: heavier, and the status line should not wait for it
    fetchVpoc(force);
    const [metricsOk] = await Promise.all([fetchOnChainMetrics(force), fetchSentimentLeverage(), fetchHalvingCountdown(), fetchDvol(), fetchEtfFlow(), fetchStablecoins(), fetchOptionsGex(force), fetchRekt(), fetchMining()]);
    recompute();
    save();
    // บอกให้ชัดเมื่อค่าที่ใช้คำนวณไม่ใช่ราคาสด (ผู้ใช้พิมพ์เอง) — ไม่งั้นจะเข้าใจผิดว่าคะแนนมาจากราคาตลาด
    const manualNote = (priceInput.dataset.manual === '1' || athInput.dataset.manual === '1')
      ? tr(' · ใช้ราคา/ATH ที่คุณกรอกเอง', ' · using the price/ATH you entered') : '';
    if(priceOk && metricsOk){
      statusEl.textContent = tr('อัปเดต ', 'Updated ') + new Date().toLocaleTimeString(window.GI_LOCALE || 'th-TH', { hour:'2-digit', minute:'2-digit' }) + manualNote;
    }else if(priceOk){
      statusEl.textContent = tr('ตัวชี้วัด on-chain ยังอัปเดตไม่ได้ — กรอกเองได้ด้านบน', 'On-chain metrics couldn\'t update. You can enter them above.') + manualNote;
    }else{
      statusEl.textContent = tr('อัปเดตข้อมูลไม่ได้ในขณะนี้ — กรอกค่าเองได้ด้านบน', 'Can\'t update data right now. You can enter values above.') + manualNote;
    }
  }

  // ---------- ราคา BTC แบบเรียลไทม์ ----------
  // เดิมราคาดึงจาก CoinGecko ครั้งเดียวตอนเปิดหน้า (และ CoinGecko เองช้ากว่าตลาด 1–5 นาที) จึงไม่ทันกราฟ
  // ตอนนี้ฟังราคาจาก Binance BTCUSDT ผ่าน WebSocket (ชุดเดียวกับกราฟ BINANCE:BTCUSDT) อัปเดต ~ทุก 1 วิ
  // ทำงานเฉพาะตอนเปิดแท็บ BTC อยู่และหน้าจอไม่ได้ถูกซ่อน · ถ้า WebSocket ใช้ไม่ได้ ถอยไปโพล REST ทุก 15 วิ
  const LIVE_POLL_MS = 15000;
  let liveWs = null, livePollTimer = null, liveRetry = 0, liveRetryTimer = null, liveRenderTimer = null, livePending = null;
  function btcTabActive(){ return document.body.classList.contains('theme-btc') && !document.hidden; }
  function applyLivePrice(p){
    if(!isFinite(p) || p <= 0) return;
    lastLivePrice = Math.round(p);
    lastLiveAt = Date.now();
    livePending = p;
    if(liveRenderTimer) return;            // รวบอัปเดตเป็นอย่างมากวินาทีละครั้ง
    liveRenderTimer = setTimeout(function(){
      liveRenderTimer = null;
      if(priceInput.dataset.manual === '1') return;   // ผู้ใช้กรอกราคาเอง — ไม่ทับ
      const v = Math.round(livePending);
      priceInput.value = v;
      if(athInput.dataset.manual !== '1' && v > (parseFloat(athInput.value) || 0)) athInput.value = v;  // ทำ ATH ใหม่
      recompute();
    }, 1000);
  }
  function startLivePolling(){
    if(livePollTimer) return;
    const tick = async function(){
      if(!btcTabActive()) return;
      try{
        const r = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', 5000);
        const j = await r.json();
        applyLivePrice(parseFloat(j.price));
      }catch(e){ /* ครั้งหน้าลองใหม่ */ }
    };
    tick();
    livePollTimer = setInterval(tick, LIVE_POLL_MS);
  }
  function startLive(){
    if(!btcTabActive() || liveWs || livePollTimer) return;
    if(typeof WebSocket !== 'function' || liveRetry > 3){ startLivePolling(); return; }
    try{
      const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@miniTicker');
      liveWs = ws;
      ws.onmessage = function(ev){
        try{ applyLivePrice(parseFloat(JSON.parse(ev.data).c)); liveRetry = 0; }catch(e){}
      };
      ws.onerror = function(){ try{ ws.close(); }catch(e){} };
      ws.onclose = function(){
        if(liveWs !== ws) return;
        liveWs = null;
        if(!btcTabActive()) return;
        liveRetry++;
        clearTimeout(liveRetryTimer);
        liveRetryTimer = setTimeout(startLive, Math.min(30000, 1000 * Math.pow(2, liveRetry)));
      };
    }catch(e){ liveWs = null; startLivePolling(); }
  }
  function stopLive(){
    clearTimeout(liveRetryTimer);
    if(liveWs){ const ws = liveWs; liveWs = null; try{ ws.close(); }catch(e){} }
    if(livePollTimer){ clearInterval(livePollTimer); livePollTimer = null; }
  }
  function syncLivePrice(){ if(btcTabActive()) startLive(); else stopLive(); }
  window.btcLiveSync = syncLivePrice;   // เรียกจากตัวสลับแท็บ
  document.addEventListener('visibilitychange', syncLivePrice);

  el('refreshBtn').addEventListener('click', () => refreshAll(true)); // manual click always bypasses the 8h cache

  // Fear & Greed จาก CMC อัปเดตวันละครั้ง แต่ให้โพลอัตโนมัติทุก 60 นาที + เมื่อกลับมาเปิดแท็บ BTC
  setInterval(fetchSentimentLeverage, 60*60*1000);
  setInterval(() => { if(document.body.classList.contains('theme-btc') && !document.hidden) liqTick(); }, 60*1000);
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden && document.body.classList.contains('theme-btc')){ fetchSentimentLeverage(); liqTick(); }
  });


  // ---------- TradingView candlestick chart ----------
  // Free tv.js widget has no external API to read/write drawings from our own code.
  // What IS free and does persist real user drawings/indicators across sessions:
  // the widget's own built-in "Sign in" (top-right of the chart) — that's TradingView's
  // own free account save, no Charting Library approval needed. We also preload a
  // default EMA study every load so at least a baseline indicator never "disappears",
  // even for someone not signed in.
  let tvStarted = false;
  function loadTradingViewChart(){
    if(tvStarted) return;   // เรียกซ้ำได้ ไม่โหลดสคริปต์/สร้าง widget ซ้ำ
    tvStarted = true;
    const container = el('tv_chart_container');
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = () => {
      try{
        container.innerHTML = '';
        /* global TradingView */
        new TradingView.widget({
          autosize: true,
          symbol: 'BINANCE:BTCUSDT',
          interval: 'D',
          timezone: 'Etc/UTC',
          theme: 'dark',
          style: '1', // candles
          locale: window.GI_LANG === 'en' ? 'en' : 'th',
          toolbar_bg: '#0c1019',
          backgroundColor: '#0a0d15',   // ให้กลืนกับธีมการ์ด
          gridColor: 'rgba(255,255,255,0.04)',
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_side_toolbar: false,
          withdateranges: true,
          hide_legend: false,
          save_image: false,
          studies: ['MAExp@tv-basicstudies'],
          container_id: 'tv_chart_container'
        });
      }catch(e){
        container.innerHTML = '<div class="chart-loading">' + tr('โหลดกราฟไม่สำเร็จ — ลองรีเฟรชหน้าอีกครั้ง', 'Couldn\'t load the chart. Try reloading the page.') + '</div>';
      }
    };
    script.onerror = () => {
      container.innerHTML = '<div class="chart-loading">' + tr('โหลดกราฟไม่สำเร็จ — ลองรีเฟรชหน้าอีกครั้ง', 'Couldn\'t load the chart. Try reloading the page.') + '</div>';
    };
    document.body.appendChild(script);
  }
  // ไม่โหลดทันทีแล้ว — ถูกเรียกจากแท็บสวิตช์เชอร์ตอนกดแท็บ BTC ครั้งแรก (และทันทีถ้าเปิดมาที่ #btc)
  window.loadTvChart = loadTradingViewChart;

  load().then(()=>{
    refreshAll(false);
  });

})();
