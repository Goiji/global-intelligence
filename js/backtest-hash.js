(function(){
  // ---------- Hash Ribbons backtest: daily hashrate + BTC price (blockchain.com), loaded when the tab is first opened ----------
  // Capitulation = 30-day average hashrate below the 60-day average. Dips back in within HR_MERGE days
  // count as the same capitulation, and ones shorter than HR_MIN days are ignored as noise.
  // Buy signal = first day after the 30-day average is back on top when price momentum is also up
  // (10-day average price above the 20-day), before the next capitulation starts.
  const HR_MERGE = 10, HR_MIN = 7, HR_H = [30, 90, 180, 365], HR_SPLIT = '2021-01-01';

  function sma(a, k){ const o = []; let s = 0; for(let i = 0; i < a.length; i++){ s += a[i]; if(i >= k) s -= a[i - k]; o.push(i >= k - 1 ? s / k : null); } return o; }
  const median = a => { if(!a.length) return null; const b = a.slice().sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
  const share = (a, f) => a.length ? a.filter(f).length / a.length : null;

  function hrStats(D){
    const dates = D.dates, p = D.btc, n = p.length;
    const s30 = sma(D.hash, 30), s60 = sma(D.hash, 60), p10 = sma(p, 10), p20 = sma(p, 20);
    // the last day may still be trading, so it never counts as a finished 'later' point
    const fwd = (i, h) => i + h < n - 1 ? p[i + h] / p[i] - 1 : null;
    const under = i => s60[i] != null && s30[i] < s60[i];

    const raw = []; let st = -1;
    for(let i = 59; i < n; i++){ const u = under(i); if(u && st < 0) st = i; if(!u && st >= 0){ raw.push([st, i]); st = -1; } }
    if(st >= 0) raw.push([st, null]);
    const merged = [];
    raw.forEach(r => { const l = merged[merged.length - 1]; if(l && l[1] != null && r[0] - l[1] < HR_MERGE) l[1] = r[1]; else merged.push(r.slice()); });
    const caps = merged.filter(r => (r[1] == null ? n - 1 : r[1]) - r[0] >= HR_MIN);

    const rows = caps.map((c, k) => {
      const a = c[0], b = c[1], end = b == null ? n - 1 : b, next = caps[k + 1] ? caps[k + 1][0] : n;
      let lo = a; for(let i = a; i <= end; i++) if(p[i] < p[lo]) lo = i;
      let sig = null; if(b != null) for(let i = b; i < next; i++) if(p10[i] > p20[i]){ sig = i; break; }
      const r = { from: dates[a], to: b == null ? null : dates[b], ongoing: b == null, days: end - a,
        hashDrop: Math.min.apply(null, s30.slice(a, end + 1)) / s60[a] - 1, lowFromStart: p[lo] / p[a] - 1, low: dates[lo],
        signal: null };
      if(sig != null){
        const yr = Math.min(n - 1, sig + 365); let mn = sig + 1 <= yr ? p[sig + 1] : null; for(let i = sig + 1; i <= yr; i++) if(p[i] < mn) mn = p[i];
        r.signal = { i: sig, date: dates[sig], price: p[sig], wait: sig - b, aboveLow: p[sig] / p[lo] - 1,
          fwd: HR_H.map(h => fwd(sig, h)), worst365: mn == null ? null : Math.min(0, mn / p[sig] - 1), worstFull: sig + 365 < n - 1 };
      }
      return r;
    });

    // every day vs signal days, for the whole history and for 2021 on
    const group = (I, S) => HR_H.map((h, k) => {
      const all = I.map(i => fwd(i, h)).filter(x => x != null), sg = S.map(r => r.signal.fwd[k]).filter(x => x != null);
      return { h, sigN: sg.length, sigMed: median(sg), sigUp: share(sg, x => x > 0), allN: all.length, allMed: median(all), allUp: share(all, x => x > 0) };
    });
    const sigs = rows.filter(r => r.signal), days = []; for(let i = 59; i < n; i++) days.push(i);
    const split = dates.findIndex(d => d >= HR_SPLIT);
    const eras = [
      { id: 'all', from: dates[59], sigs, cmp: group(days, sigs) },
      { id: 'old', from: dates[59], to: dates[split - 1], sigs: sigs.filter(r => r.signal.date < HR_SPLIT), cmp: group(days.filter(i => i < split), sigs.filter(r => r.signal.date < HR_SPLIT)) },
      { id: 'new', from: HR_SPLIT, sigs: sigs.filter(r => r.signal.date >= HR_SPLIT), cmp: group(days.filter(i => i >= split), sigs.filter(r => r.signal.date >= HR_SPLIT)) }
    ];

    // where things stand on the latest day (raw, before the noise filter)
    let since = n - 1; while(since > 59 && under(since - 1) === under(n - 1)) since--;
    const last = sigs[sigs.length - 1];
    const now = { date: dates[n - 1], under: under(n - 1), days: n - 1 - since, since: dates[since], ratio: s30[n - 1] / s60[n - 1] - 1, btc: p[n - 1],
      momentum: p10[n - 1] > p20[n - 1], hash30: s30[n - 1],
      lastSignal: last ? { date: last.signal.date, price: last.signal.price, change: p[n - 1] / last.signal.price - 1, daysAgo: n - 1 - last.signal.i } : null };
    return { first: dates[0], last: dates[n - 1], days: n, s30, s60, rows, eras, now, noConfirm: rows.filter(r => !r.ongoing && !r.signal).length };
  }

  // blockchain.com raw → aligned daily rows (same rules as netlify/functions/hash-history.js)
  function hrAlign(hj, pj){
    const day = s => new Date(Number(s) * 1000).toISOString().slice(0, 10), hm = {}, pm = {};
    ((hj && hj.values) || []).forEach(v => { const y = Number(v && v.y); if(isFinite(y) && y > 0) hm[day(v.x)] = Number((y / 1e6).toPrecision(4)); });
    ((pj && pj.values) || []).forEach(v => { const y = Number(v && v.y); if(isFinite(y) && y > 0) pm[day(v.x)] = y; });
    const dates = Object.keys(pm).filter(d => d in hm).sort();
    if(dates.length < 1000) throw new Error('too little history');
    return { dates, hash: dates.map(d => hm[d]), btc: dates.map(d => pm[d]) };
  }
  async function hrGet(url){
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 15000);
    try{ const r = await fetch(url, { signal: ctrl.signal }); if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  }
  async function hrLoad(){
    try{
      const d = await hrGet('/.netlify/functions/hash-history');
      if(d && d.dates && d.dates.length >= 1000 && d.hash.length === d.dates.length && d.btc.length === d.dates.length) return d;
      throw new Error('bad payload');
    }catch(e){
      const Q = '?timespan=all&format=json&sampled=false&cors=true', API = 'https://api.blockchain.info/charts/';
      const [h, p] = await Promise.all([hrGet(API + 'hash-rate' + Q), hrGet(API + 'market-price' + Q)]);
      return hrAlign(h, p);
    }
  }
  window.hrStats = hrStats; window.hrAlign = hrAlign;   // tests

  const tr = window.tr || ((th) => th);
  const pct = (x, d) => { if(x == null) return '–'; const t = (x * 100).toFixed(d == null ? 0 : d); return +t === 0 ? '0%' : (x > 0 ? '+' : '') + t + '%'; };
  const pc = x => x == null ? '–' : Math.round(x * 100) + '%';
  const cls = x => x == null ? '' : x < 0 ? 'neg' : 'pos';
  const loc = (window.GI_LOCALE || 'th-TH') + '-u-ca-gregory';
  const dm = s => { const [y, m, d] = s.split('-'); return new Date(+y, +m - 1, +d).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const usd = x => x >= 100 ? '$' + Math.round(x).toLocaleString('en-US') : '$' + x.toFixed(x >= 1 ? 2 : 3);
  const big = x => x == null ? '–' : (x > 0 ? '+' : '') + (Math.abs(x) >= 10 ? Math.round(x * 100).toLocaleString('en-US') : (x * 100).toFixed(0)) + '%';
  const hlab = h => h === 365 ? tr('1 ปี', '1 year') : h + ' ' + tr('วัน', 'days');

  function hrRender(D){
    const S = hrStats(D), el = id => document.getElementById(id), N = S.now;

    el('hrNow').innerHTML = '<div class="hr-now ' + (N.under ? 'cap' : 'ok') + '"><b>' + (N.under
        ? tr('ตอนนี้: อยู่ในช่วงนักขุดถอดใจ (Capitulation)', 'Now: miners are capitulating')
        : tr('ตอนนี้: hashrate ปกติ (30 วันอยู่เหนือ 60 วัน)', 'Now: hashrate is healthy (30-day above 60-day)')) + '</b><span>'
      + (N.under
        ? tr('hashrate เฉลี่ย 30 วันต่ำกว่า 60 วันมา ' + N.days + ' วัน (ตั้งแต่ ' + dm(N.since) + ') ห่างกัน ' + pct(N.ratio, 1) + (N.days < HR_MIN ? ' (เพิ่งเริ่ม ยังสั้นเกินกว่าจะนับเป็นรอบ อาจเป็นแค่ข้อมูลแกว่ง)' : '') + ' · ยังไม่มีสัญญาณซื้อ รอให้เส้น 30 วันกลับขึ้นเหนือ 60 วัน และราคาเริ่มมีแรงส่ง',
             '30-day average hashrate has been below the 60-day for ' + N.days + ' days (since ' + dm(N.since) + '), ' + pct(N.ratio, 1) + ' apart' + (N.days < HR_MIN ? ' (just started, too short to count yet, may be noise)' : '') + ' · No buy signal yet: that needs the 30-day back above the 60-day and price momentum turning up')
        : tr('30 วันอยู่เหนือ 60 วัน ' + pct(N.ratio, 1) + ' มา ' + N.days + ' วัน', '30-day is ' + pct(N.ratio, 1) + ' above the 60-day, for ' + N.days + ' days'))
      + (N.lastSignal ? ' · ' + tr('สัญญาณซื้อล่าสุด ' + dm(N.lastSignal.date) + ' ที่ ' + usd(N.lastSignal.price) + ' ถึงวันนี้ ', 'Last buy signal ' + dm(N.lastSignal.date) + ' at ' + usd(N.lastSignal.price) + ', since then ') + '<b class="' + cls(N.lastSignal.change) + '">' + pct(N.lastSignal.change, 1) + '</b>' : '')
      + '</span></div>';

    el('hrSignals').innerHTML = '<thead><tr><th>' + tr('ช่วงนักขุดถอดใจ', 'Capitulation') + '</th><th>' + tr('BTC ลงต่ำสุดในช่วงนี้', 'BTC low in it') + '<small>' + tr('เทียบวันเริ่ม', 'vs first day') + '</small></th><th>' + tr('สัญญาณซื้อ', 'Buy signal') + '</th>'
      + HR_H.map(h => '<th>' + hlab(h) + '<small>' + tr('หลังสัญญาณ', 'after') + '</small></th>').join('') + '<th>' + tr('ลงต่ออีกสุด', 'Worst dip after') + '<small>' + tr('ภายใน 1 ปี', 'within 1 year') + '</small></th></tr></thead><tbody>'
      + S.rows.slice().reverse().map(r => {
        const g = r.signal;
        return '<tr' + (g ? '' : ' class="hr-none"') + '><td><b>' + dm(r.from) + '</b><small>' + (r.ongoing ? tr('ยังไม่จบ', 'still running') + ' · ' : tr('ถึง ', 'to ') + dm(r.to) + ' · ') + r.days + ' ' + tr('วัน', 'days') + ' · hashrate ' + pct(r.hashDrop, 0) + '</small></td>'
          + '<td class="' + cls(r.lowFromStart) + '">' + pct(r.lowFromStart, 0) + '</td>'
          + (g ? '<td><b>' + dm(g.date) + '</b><small>' + usd(g.price) + ' · ' + tr('เหนือจุดต่ำ ', 'above the low ') + pct(g.aboveLow, 0) + '</small></td>'
              + g.fwd.map(x => '<td class="' + cls(x) + '">' + big(x) + '</td>').join('')
              + '<td class="' + cls(g.worst365) + '">' + (g.worst365 == null ? '–' : pct(g.worst365, 0) + (g.worstFull ? '' : '<small>' + tr('ยังไม่ครบปี', 'year not over') + '</small>')) + '</td>'
            : '<td colspan="' + (HR_H.length + 2) + '" class="hr-why">' + (r.ongoing ? tr('ยังอยู่ในช่วงนี้ ยังไม่มีสัญญาณ', 'still in it, no signal yet') : tr('ไม่มีสัญญาณ: ราคาไม่มีแรงส่งก่อนนักขุดถอดใจรอบถัดไป', 'no signal: price momentum never turned up before the next capitulation')) + '</td>')
          + '</tr>'; }).join('') + '</tbody>';

    const eraName = { all: tr('ทั้งหมด', 'All years'), old: tr('ก่อน 2021', 'Before 2021'), new: tr('2021 – ปัจจุบัน', '2021 – today') };
    el('hrCompare').innerHTML = '<thead><tr><th>' + tr('ช่วงปี', 'Years') + '</th><th>' + tr('ซื้อตอน', 'Bought on') + '</th>'
      + HR_H.map(h => '<th>' + hlab(h) + '<small>' + tr('ค่ากลาง · ขึ้นกี่ %', 'median · share up') + '</small></th>').join('') + '</tr></thead><tbody>'
      + S.eras.map(e => ['sig', 'all'].map(k => '<tr' + (k === 'all' ? ' class="bt-normal"' : '') + '>' + (k === 'sig' ? '<td rowspan="2"><b>' + eraName[e.id] + '</b><small>' + e.sigs.length + ' ' + tr('สัญญาณ', 'signals') + '</small></td>' : '')
        + '<td>' + (k === 'sig' ? tr('วันสัญญาณซื้อ', 'Signal days') : tr('ทุกวัน', 'Every day')) + '</td>'
        + e.cmp.map(c => { const m = c[k + 'Med'], u = c[k + 'Up']; return '<td class="' + cls(m) + '">' + big(m) + '<small>' + pc(u) + (k === 'sig' ? ' · ' + c.sigN + ' ' + tr('ครั้ง', 'cases') : '') + '</small></td>'; }).join('') + '</tr>').join('')).join('') + '</tbody>';

    // ---- points ----
    const A = S.eras[0], O = S.eras[1], Nw = S.eras[2], y1 = e => e.cmp[3], m3 = e => e.cmp[1];
    const sigs = A.sigs, aboveLow = median(sigs.map(r => r.signal.aboveLow));
    const deep = sigs.filter(r => r.signal.worst365 != null && r.signal.worst365 <= -0.2);
    const nUp = (e, k) => e.sigs.filter(r => r.signal.fwd[k] != null && r.signal.fwd[k] > 0).length, nDone = (e, k) => e.sigs.filter(r => r.signal.fwd[k] != null).length;
    const pts = [
      tr('สัญญาณซื้อ ' + sigs.length + ' ครั้งตั้งแต่ปี ' + sigs[0].signal.date.slice(0, 4) + ': 1 ปีต่อมา BTC สูงกว่าเดิม ' + nUp(A, 3) + ' จาก ' + nDone(A, 3) + ' ครั้ง (ค่ากลาง ' + big(y1(A).sigMed) + ') เทียบกับซื้อวันไหนก็ได้ที่ขึ้น ' + pc(y1(A).allUp) + ' ของวัน (ค่ากลาง ' + big(y1(A).allMed) + ')',
        sigs.length + ' buy signals since ' + sigs[0].signal.date.slice(0, 4) + ': a year later BTC was higher ' + nUp(A, 3) + ' of ' + nDone(A, 3) + ' times (median ' + big(y1(A).sigMed) + '), against ' + pc(y1(A).allUp) + ' of all days (median ' + big(y1(A).allMed) + ').'),
      tr('ผลดีส่วนใหญ่มาจากยุคแรก: ก่อน 2021 สัญญาณ 1 ปีต่อมาขึ้น ' + nUp(O, 3) + ' จาก ' + nDone(O, 3) + ' ครั้ง แต่ตั้งแต่ 2021 ขึ้น ' + nUp(Nw, 3) + ' จาก ' + nDone(Nw, 3) + ' ครั้ง (ค่ากลาง ' + big(y1(Nw).sigMed) + ' เทียบทุกวัน ' + big(y1(Nw).allMed) + ') ส่วน 90 วันหลังสัญญาณตั้งแต่ 2021 ค่ากลาง ' + big(m3(Nw).sigMed) + ' เทียบทุกวัน ' + big(m3(Nw).allMed),
        'Most of the edge is from the early years: before 2021 BTC was higher a year after ' + nUp(O, 3) + ' of ' + nDone(O, 3) + ' signals, but since 2021 only ' + nUp(Nw, 3) + ' of ' + nDone(Nw, 3) + ' (median ' + big(y1(Nw).sigMed) + ' vs ' + big(y1(Nw).allMed) + ' for every day). 90 days after a signal since 2021: median ' + big(m3(Nw).sigMed) + ' vs ' + big(m3(Nw).allMed) + '.'),
      tr('ไม่ได้ซื้อที่ก้น: สัญญาณมาหลังจุดต่ำสุดของช่วงนักขุดถอดใจ ราคาสูงกว่าจุดนั้นแล้วค่ากลาง ' + pct(aboveLow) + ' และหลังสัญญาณ ราคายังลงต่ออีก 20% ขึ้นไปภายใน 1 ปี ' + deep.length + ' จาก ' + sigs.length + ' ครั้ง' + (deep.length ? ' (' + deep.slice(-3).map(r => r.signal.date.slice(0, 4) + ' ' + pct(r.signal.worst365)).join(', ') + ')' : ''),
        'It does not buy the bottom: the signal came after the low of the capitulation, at a median ' + pct(aboveLow) + ' above it, and BTC still fell another 20%+ within a year after ' + deep.length + ' of ' + sigs.length + ' signals' + (deep.length ? ' (' + deep.slice(-3).map(r => r.signal.date.slice(0, 4) + ' ' + pct(r.signal.worst365)).join(', ') + ').' : '.')),
      tr('ช่วงนักขุดถอดใจไม่ได้แปลว่าราคาต้องร่วง: BTC ลงต่ำกว่าวันเริ่มช่วงเกิน 20% แค่ ' + S.rows.filter(r => r.lowFromStart <= -0.2).length + ' จาก ' + S.rows.length + ' รอบ' + (S.noConfirm ? ' และมี ' + S.noConfirm + ' รอบที่ไม่เกิดสัญญาณเลย เพราะราคาไม่ฟื้นก่อนรอบถัดไปจะเริ่ม' : ''),
        'A capitulation does not mean a crash: BTC fell more than 20% below the first day in only ' + S.rows.filter(r => r.lowFromStart <= -0.2).length + ' of ' + S.rows.length + (S.noConfirm ? ', and ' + S.noConfirm + ' never produced a signal because price did not recover before the next one began.' : '.')),
      tr('ตั้งแต่ 2021 นักขุดถอดใจบ่อยขึ้นมาก (' + S.rows.filter(r => r.from >= HR_SPLIT).length + ' รอบใน ' + Math.round((S.days - D.dates.indexOf(D.dates.find(d => d >= HR_SPLIT))) / 365) + ' ปี เทียบ ' + S.rows.filter(r => r.from < HR_SPLIT).length + ' รอบใน 10 ปีก่อนหน้า) เมื่อสัญญาณถี่ขึ้น แต่ละครั้งก็มีความหมายน้อยลง',
        'Since 2021 capitulations have become much more frequent (' + S.rows.filter(r => r.from >= HR_SPLIT).length + ' in ' + Math.round((S.days - D.dates.indexOf(D.dates.find(d => d >= HR_SPLIT))) / 365) + ' years, against ' + S.rows.filter(r => r.from < HR_SPLIT).length + ' in the ten years before), so each one says less.')
    ];
    el('hrPoints').innerHTML = pts.map(s => '<li>' + s + '</li>').join('');

    el('hrNote').innerHTML = tr('ข้อมูลรายวัน (UTC) ' + dm(S.first) + ' – ' + dm(S.last) + ' · hashrate: blockchain.com (ประมาณจากจำนวนบล็อกต่อวัน จึงแกว่งมาก เส้นเฉลี่ย 30/60 วันช่วยกรอง) · BTC: blockchain.com ราคาตลาดรายวัน · ช่วงนักขุดถอดใจ = hashrate เฉลี่ย 30 วันต่ำกว่า 60 วัน ถ้ากลับลงไปใหม่ภายใน ' + HR_MERGE + ' วันนับเป็นรอบเดียวกัน และไม่นับรอบที่สั้นกว่า ' + HR_MIN + ' วัน · สัญญาณซื้อ = วันแรกหลังเส้น 30 วันกลับขึ้นเหนือ 60 วัน ที่ราคาเฉลี่ย 10 วันอยู่เหนือ 20 วัน · ปีแรก ๆ ราคาต่ำมาก ผลตอบแทนจึงเป็นหลักพัน % · สัญญาณมีไม่ถึง 25 ครั้ง ตัวอย่างน้อย · อดีตไม่ได้บอกอนาคต',
      'Daily data (UTC) ' + dm(S.first) + ' – ' + dm(S.last) + ' · Hashrate: blockchain.com (estimated from blocks found per day, so it is noisy; the 30/60-day averages smooth it) · BTC: blockchain.com daily market price · Capitulation = 30-day average hashrate below the 60-day; a dip back within ' + HR_MERGE + ' days counts as the same one, and ones shorter than ' + HR_MIN + ' days are ignored · Buy signal = first day after the 30-day is back above the 60-day with the 10-day average price above the 20-day · Prices were tiny in the early years, so returns there run into the thousands of % · Fewer than 25 signals, a small sample · The past does not predict the future');

    hrChart(el('hrChart'), D, S);
  }

  function hrChart(box, D, S){
    const n = D.btc.length, W = 900, H = 360, L = 46, R = 46, T = 10, B = 22, MID = 218, GAP = 24;
    const x = i => L + (W - L - R) * i / (n - 1);
    const s30 = S.s30, s60 = S.s60, RMAX = 0.25;
    const ratio = s30.map((v, i) => v == null || s60[i] == null ? null : v / s60[i] - 1);
    const plo = Math.log(Math.min.apply(null, D.btc) * 0.8), phi = Math.log(Math.max.apply(null, D.btc) * 1.1);
    const yP = v => T + (MID - T) * (1 - (Math.log(v) - plo) / (phi - plo));
    const yH = v => MID + GAP + (H - B - MID - GAP) * (1 - (Math.max(-RMAX, Math.min(RMAX, v)) + RMAX) / (2 * RMAX));
    const ix = s => { const k = D.dates.indexOf(s); return k < 0 ? n - 1 : k; };
    let g = S.rows.map(r => '<rect x="' + x(ix(r.from)).toFixed(1) + '" y="' + T + '" width="' + Math.max(2, x(r.to ? ix(r.to) : n - 1) - x(ix(r.from))).toFixed(1) + '" height="' + (H - T - B) + '" fill="rgba(255,101,119,.18)"/>').join('');
    D.dates.forEach((d, i) => { if(d.slice(5) === '01-01' && +d.slice(0, 4) % 2 === 0) g += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#1b2540"/><text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" fill="#8e9bb5" font-size="10" text-anchor="middle">' + d.slice(0, 4) + '</text>'; });
    [1, 100, 10000].forEach(v => { if(Math.log(v) > plo && Math.log(v) < phi) g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yP(v) + '" y2="' + yP(v) + '" stroke="#24304a" stroke-dasharray="3 4"/><text x="' + (L - 4) + '" y="' + (yP(v) + 3) + '" fill="#f7931a" font-size="10" text-anchor="end">$' + (v >= 1000 ? v / 1000 + 'k' : v) + '</text>'; });
    [-0.2, 0, 0.2].forEach(v => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yH(v) + '" y2="' + yH(v) + '" stroke="' + (v ? '#24304a' : '#8e9bb5') + '" stroke-dasharray="' + (v ? '3 4' : '0') + '" stroke-opacity="' + (v ? 1 : .5) + '"/><text x="' + (W - R + 4) + '" y="' + (yH(v) + 3) + '" fill="#4cc9f0" font-size="10">' + (v > 0 ? '+' : '') + v * 100 + '%</text>'; });
    { let a = '', b = ''; const z = yH(0).toFixed(1);   // fill above zero green, below red
      ratio.forEach((v, i) => { if(v == null) return; const px = x(i).toFixed(1), py = yH(v).toFixed(1);
        a += 'M' + px + ' ' + z + 'V' + (v > 0 ? py : z); b += 'M' + px + ' ' + z + 'V' + (v < 0 ? py : z); });
      g += '<path d="' + a + '" stroke="rgba(69,212,131,.55)" stroke-width="1.2"/><path d="' + b + '" stroke="rgba(255,101,119,.75)" stroke-width="1.2"/>'; }
    g += '<text x="' + L + '" y="' + (MID + GAP - 6) + '" fill="#8e9bb5" font-size="10">' + tr('hashrate 30 วัน เทียบ 60 วัน', 'hashrate 30-day vs 60-day') + '</text>';
    g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + (MID + GAP / 2) + '" y2="' + (MID + GAP / 2) + '" stroke="#24304a"/>';
    const path = (arr, fy) => { let d = '', pen = false; arr.forEach((v, i) => { if(v == null){ pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + fy(v).toFixed(1); pen = true; }); return d; };
    g += '<path d="' + path(D.btc, yP) + '" fill="none" stroke="#f7931a" stroke-width="1.6"/>';
    S.rows.forEach(r => { if(!r.signal) return; const cx = x(r.signal.i), cy = yP(r.signal.price);
      g += '<path d="M' + cx.toFixed(1) + ' ' + (cy + 5).toFixed(1) + 'l-5 9h10z" fill="#45d483" stroke="#0b1020" stroke-width="1"/>'; });
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + tr('กราฟราคา BTC กับ hashrate เฉลี่ย 30 และ 60 วัน พร้อมสัญญาณซื้อ', 'BTC price and 30/60-day average hashrate with buy signals') + '">' + g + '</svg>';
    const sigAt = {}; S.rows.forEach(r => { if(r.signal) sigAt[r.signal.i] = r.signal; });
    if(window.btHover) window.btHover(box, { W, H, L, R, T, B, n, x,
      label: i => dm(D.dates[i]),
      bands: S.rows.map(r => ({ from: ix(r.from), to: r.to ? ix(r.to) : n - 1, name: tr('นักขุดถอดใจ ', 'Capitulation ') + r.days + ' ' + tr('วัน', 'days') })),
      series: [
        { name: 'BTC', color: '#f7931a', values: D.btc, y: yP, fmt: usd },
        { name: tr('30 วัน เทียบ 60 วัน', '30d vs 60d'), color: '#4cc9f0', values: ratio, y: yH, fmt: v => pct(v, 1) }
      ],
      extra: i => { const eh = v => v == null ? '–' : v < 1 ? (v * 1000).toPrecision(3) + ' PH/s' : v.toPrecision(3) + ' EH/s';
        let out = '<div class="d">Hashrate ' + tr('เฉลี่ย 30 วัน ', '30-day avg ') + eh(s30[i]) + ' · 60 ' + tr('วัน ', 'day ') + eh(s60[i]) + '</div>';
        let k = -1; for(let j = Math.max(0, i - 6); j <= Math.min(n - 1, i + 6); j++) if(sigAt[j]){ k = j; break; }
        return out + (k < 0 ? '' : '<div style="color:#45d483;font-weight:700">▲ ' + tr('สัญญาณซื้อ ', 'Buy signal ') + dm(D.dates[k]) + '</div>'); } });
  }

  let started = false;
  window.btHashActivate = async function(){
    if(started) return; started = true;
    try{ hrRender(await hrLoad()); }
    catch(e){
      started = false;   // let a later visit to the tab try again
      const s = document.getElementById('hrStatus');
      if(s) s.textContent = tr('ดึงข้อมูล hashrate ไม่สำเร็จ ลองเปิดแท็บนี้ใหม่อีกครั้ง', 'Could not load hashrate data. Open this tab again to retry.');
    }
  };
  window.__hrTest = { hrRender, hrLoad };
})();
