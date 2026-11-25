(function(){
  // ---------- BTC vs DVOL backtest: daily Deribit data, loaded when the tab is first opened ----------
  // Big falls are picked by window; inside each window the peak is the highest close and the bottom
  // the lowest close after it. A window with no end is still running.
  const BDV_FALLS = [
    { id: 'y2021', th: 'จีนไล่เหมือง 2021', en: '2021 China mining ban', from: '2021-04-01', to: '2021-07-31' },
    { id: 'y2022', th: 'ตลาดหมี 2022 (Luna, FTX)', en: '2022 bear market (Luna, FTX)', from: '2021-11-01', to: '2022-12-31' },
    { id: 'y2024', th: 'เยนแข็ง ส.ค. 2024', en: 'Aug 2024 yen unwind', from: '2024-03-01', to: '2024-08-31' },
    { id: 'y2025', th: 'ภาษีทรัมป์ 2025', en: '2025 tariff shock', from: '2025-01-01', to: '2025-04-30' },
    { id: 'y2526', th: 'ขาลง ต.ค. 2025 – 2026', en: 'Oct 2025 – 2026 slide', from: '2025-10-01', to: '2026-07-31' },
    { id: 'now', th: 'รอบล่าสุด (ยังไม่จบ)', en: 'Latest (still running)', from: '2026-10-01', to: null }
  ];
  const BDV_ZONES = [[0, 40], [40, 50], [50, 60], [60, 80], [80, Infinity]];

  function bdvStats(D, falls){
    const v = D.dvol, p = D.btc, dates = D.dates, n = p.length;
    const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
    const median = a => { const b = a.slice().sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };
    // the last day is still trading, so it never counts as a finished 'later' point
    const fwd = (i, h) => i + h < n - 1 ? p[i + h] / p[i] - 1 : null;
    const at = s => { for(let i = 0; i < n; i++) if(dates[i] >= s) return i; return n; };
    const upTo = s => { let k = -1; for(let i = 0; i < n; i++) if(dates[i] <= s) k = i; return k; };
    const share = (a, f) => a.length ? a.filter(f).length / a.length : null;
    const topYear = I => { const c = {}; I.forEach(i => { const y = dates[i].slice(0, 4); c[y] = (c[y] || 0) + 1; });
      const y = Object.keys(c).sort((a, b) => c[b] - c[a])[0]; return y ? { year: y, share: c[y] / I.length } : null; };
    const prevYearMedian = i => i >= 180 ? median(v.slice(Math.max(0, i - 365), i)) : null;

    const fallRows = falls.map(f => {
      const a = at(f.from), b = f.to ? upTo(f.to) : n - 1;
      if(a >= n || b < a) return null;
      let pk = a; for(let i = a; i <= b; i++) if(p[i] > p[pk]) pk = i;
      let tr = pk; for(let i = pk; i <= b; i++) if(p[i] < p[tr]) tr = i;
      let vm = pk; for(let i = pk; i <= tr; i++) if(v[i] > v[vm]) vm = i;
      let rec = null; for(let i = tr; i < n; i++) if(p[i] >= p[pk]){ rec = i; break; }
      return { id: f.id, th: f.th, en: f.en, ongoing: !f.to, peak: dates[pk], trough: dates[tr], days: tr - pk,
        fall: p[tr] / p[pk] - 1, dvPeak: v[pk], dvPeakYear: prevYearMedian(pk), dvMax: v[vm], dvMaxAt: dates[vm], dvMaxLead: tr - vm, dvBottom: v[tr],
        after30: f.to ? fwd(tr, 30) : null, after90: f.to ? fwd(tr, 90) : null, recovered: rec == null ? null : dates[rec], recoverDays: rec == null ? null : rec - tr };
    }).filter(Boolean);

    const zoneOf = I => { const f30 = I.map(i => fwd(i, 30)).filter(x => x != null), f90 = I.map(i => fwd(i, 90)).filter(x => x != null);
      return { days: I.length, med30: f30.length ? median(f30) : null, up30: share(f30, x => x > 0), med90: f90.length ? median(f90) : null, up90: share(f90, x => x > 0),
        worst90: f90.length ? Math.min.apply(null, f90) : null, top: topYear(I) }; };
    const inZone = (lo, hi) => { const I = []; for(let i = 0; i < n; i++) if(v[i] >= lo && v[i] < hi) I.push(i); return I; };
    const zones = BDV_ZONES.map(z => Object.assign({ lo: z[0], hi: z[1] }, zoneOf(inZone(z[0], z[1]))));
    const high = zoneOf(inZone(60, Infinity)), all = zoneOf(inZone(0, Infinity));

    // DVOL is an annualised % → expected 1-sd move over h days = DVOL × √(h/365)
    const swing = [7, 30].map(h => { const r = [];
      for(let i = 0; i < n; i++){ const f = fwd(i, h); if(f != null) r.push(Math.abs(Math.log(1 + f)) / (v[i] / 100 * Math.sqrt(h / 365))); }
      return { h, count: r.length, in1: share(r, x => x <= 1), in2: share(r, x => x <= 2), typical: median(r) }; });
    let over = 0, overN = 0;
    for(let i = 0; i + 31 < n; i++){
      const lr = []; for(let j = i; j < i + 30; j++) lr.push(Math.log(p[j + 1] / p[j]));
      const m = mean(lr), rv = Math.sqrt(mean(lr.map(x => (x - m) * (x - m)))) * Math.sqrt(365) * 100;
      overN++; if(v[i] > rv) over++;
    }

    // jumps: DVOL at least 30% above its own 30-day average; one per 30 days
    const spikes = [];
    for(let i = 30; i < n; i++){
      if(v[i] < 1.3 * mean(v.slice(i - 30, i))) continue;
      if(spikes.length && i - spikes[spikes.length - 1].i <= 30) continue;
      spikes.push({ i, date: dates[i], dvol: v[i], before7: p[i] / p[i - 7] - 1, after90: fwd(i, 90) });
    }

    const years = [];
    for(let y = +dates[0].slice(0, 4); y <= +dates[n - 1].slice(0, 4); y++){
      const I = []; for(let i = 1; i < n; i++) if(dates[i].slice(0, 4) === String(y)) I.push(i);
      if(I.length < 60) continue;
      const r = I.map(i => Math.log(p[i] / p[i - 1])), c = I.map(i => v[i] - v[i - 1]), mr = mean(r), mc = mean(c);
      let sxy = 0, sxx = 0, syy = 0; r.forEach((x, k) => { sxy += (x - mr) * (c[k] - mc); sxx += (x - mr) * (x - mr); syy += (c[k] - mc) * (c[k] - mc); });
      years.push({ year: String(y), days: I.length, dvolAvg: mean(I.map(i => v[i])), corr: sxy / Math.sqrt(sxx * syy) });
    }
    return { first: dates[0], last: dates[n - 1], days: n, latest: { dvol: v[n - 1], btc: p[n - 1] }, falls: fallRows, zones, high, all, swing,
      over: overN ? over / overN : null, spikes, years };
  }

  // Deribit raw → aligned daily rows (same rules as netlify/functions/dvol-history.js)
  function bdvAlign(candles, chart){
    const day = t => new Date(Number(t)).toISOString().slice(0, 10), dv = {}, px = {};
    candles.forEach(c => { const x = Number(c && c[4]); if(isFinite(x) && x > 5 && x < 400) dv[day(c[0])] = Math.round(x * 100) / 100; });
    ((chart && chart.ticks) || []).forEach((t, i) => { const x = Number(chart.close[i]); if(isFinite(x) && x > 0) px[day(t)] = x; });
    const dates = Object.keys(dv).filter(d => d in px).sort();
    if(dates.length < 400) throw new Error('too little history');
    return { dates, dvol: dates.map(d => dv[d]), btc: dates.map(d => px[d]) };
  }
  async function bdvGet(url){
    const ctrl = new AbortController(), t = setTimeout(() => ctrl.abort(), 12000);
    try{ const r = await fetch(url, { signal: ctrl.signal }); if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  }
  async function bdvLoad(){
    try{
      const d = await bdvGet('/.netlify/functions/dvol-history');
      if(d && d.dates && d.dates.length >= 400 && d.dvol.length === d.dates.length && d.btc.length === d.dates.length) return d;
      throw new Error('bad payload');
    }catch(e){
      const API = 'https://www.deribit.com/api/v2/public/', start = Date.UTC(2021, 2, 1), now = Date.now();
      const candles = []; let end = now;
      for(let k = 0; k < 6 && end; k++){
        const j = await bdvGet(API + 'get_volatility_index_data?currency=BTC&resolution=1D&start_timestamp=' + start + '&end_timestamp=' + end);
        candles.push.apply(candles, (j.result && j.result.data) || []); end = j.result && j.result.continuation;
      }
      const c = await bdvGet(API + 'get_tradingview_chart_data?instrument_name=BTC-PERPETUAL&resolution=1D&start_timestamp=' + start + '&end_timestamp=' + now);
      return bdvAlign(candles, c.result);
    }
  }
  window.bdvStats = bdvStats; window.bdvAlign = bdvAlign; window.BDV_FALLS = BDV_FALLS;   // tests

  const tr = window.tr || ((th) => th);
  const pct = (x, d) => x == null ? '–' : (x > 0 ? '+' : '') + (x * 100).toFixed(d == null ? 0 : d) + '%';
  const pc = x => x == null ? '–' : Math.round(x * 100) + '%';
  const cls = x => x == null ? '' : x < 0 ? 'neg' : 'pos';
  const loc = (window.GI_LOCALE || 'th-TH') + '-u-ca-gregory';
  const dm = s => { const [y, m, d] = s.split('-'); return new Date(+y, +m - 1, +d).toLocaleDateString(loc, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const usd = x => '$' + Math.round(x).toLocaleString('en-US');

  function bdvRender(D){
    const S = bdvStats(D, BDV_FALLS), el = id => document.getElementById(id);
    el('bdvFalls').innerHTML = '<thead><tr><th>' + tr('รอบ', 'Fall') + '</th><th>' + tr('BTC ลงสุด', 'BTC fall') + '</th><th>DVOL ' + tr('ตอนยอด', 'at peak') + '</th><th>DVOL ' + tr('สูงสุดช่วงลง', 'high in fall') + '</th><th>DVOL ' + tr('ตอนก้น', 'at bottom') + '</th><th>' + tr('30 วันหลังก้น', '30 days after') + '</th><th>' + tr('90 วันหลังก้น', '90 days after') + '</th><th>' + tr('กลับยอดเดิม', 'Back to peak') + '</th></tr></thead><tbody>'
      + S.falls.map(r => '<tr><td><b>' + tr(r.th, r.en) + '</b><small>' + dm(r.peak) + ' → ' + dm(r.trough) + ' · ' + r.days + ' ' + tr('วัน', 'days') + '</small></td>'
        + '<td class="neg">' + pct(r.fall, 1) + '</td>'
        + '<td>' + r.dvPeak.toFixed(0) + (r.dvPeakYear != null ? '<small>' + tr('ค่ากลางปีก่อน ', 'prior-year median ') + r.dvPeakYear.toFixed(0) + '</small>' : '') + '</td>'
        + '<td>' + r.dvMax.toFixed(0) + '<small>' + (r.dvMaxLead === 0 ? tr('วันเดียวกับก้น', 'on the bottom day') : r.dvMaxLead + ' ' + tr('วันก่อนก้น', 'days before bottom')) + '</small></td>'
        + '<td>' + r.dvBottom.toFixed(0) + '</td>'
        + '<td class="' + cls(r.after30) + '">' + pct(r.after30, 1) + '</td><td class="' + cls(r.after90) + '">' + pct(r.after90, 1) + '</td>'
        + '<td>' + (r.ongoing ? tr('ยังไม่จบ', 'still running') : r.recovered ? r.recoverDays + ' ' + tr('วัน', 'days') + '<small>' + dm(r.recovered) + '</small>' : tr('ยังไม่กลับ', 'not yet')) + '</td></tr>').join('')
      + '<tr class="bt-normal"><td><b>' + tr('ทุกวัน (ค่ากลาง)', 'Every day (median)') + '</b><small>' + S.days + ' ' + tr('วัน', 'days') + '</small></td><td>–</td><td colspan="3">' + tr('DVOL ค่ากลาง ', 'DVOL median ') + median(D.dvol).toFixed(0) + '</td><td class="' + cls(S.all.med30) + '">' + pct(S.all.med30, 1) + '</td><td class="' + cls(S.all.med90) + '">' + pct(S.all.med90, 1) + '</td><td>–</td></tr></tbody>';

    el('bdvZones').innerHTML = '<thead><tr><th>DVOL</th><th>' + tr('จำนวนวัน', 'Days') + '</th><th>' + tr('ค่ากลาง 30 วัน', 'Median, 30 days') + '</th><th>' + tr('ขึ้นกี่ %', 'Share up') + '</th><th>' + tr('ค่ากลาง 90 วัน', 'Median, 90 days') + '</th><th>' + tr('ขึ้นกี่ %', 'Share up') + '</th><th>' + tr('ส่วนใหญ่มาจากปี', 'Mostly from') + '</th></tr></thead><tbody>'
      + S.zones.map(z => '<tr><td><b>' + (z.hi === Infinity ? '≥ ' + z.lo : z.lo === 0 ? '< ' + z.hi : z.lo + '–' + z.hi) + '</b></td><td>' + z.days + '</td><td class="' + cls(z.med30) + '">' + pct(z.med30, 1) + '</td><td>' + pc(z.up30) + '</td><td class="' + cls(z.med90) + '">' + pct(z.med90, 1) + '</td><td>' + pc(z.up90) + '</td><td>' + (z.top ? z.top.year + '<small>' + pc(z.top.share) + tr(' ของวันในโซนนี้', ' of these days') + '</small>' : '–') + '</td></tr>').join('') + '</tbody>';

    el('bdvSwing').innerHTML = '<thead><tr><th>' + tr('ช่วงเวลา', 'Horizon') + '</th><th>' + tr('อยู่ในกรอบ ±1 เท่า', 'Inside ±1×') + '<small>' + tr('ทฤษฎี ~68%', 'theory ~68%') + '</small></th><th>' + tr('อยู่ในกรอบ ±2 เท่า', 'Inside ±2×') + '<small>' + tr('ทฤษฎี ~95%', 'theory ~95%') + '</small></th><th>' + tr('ตัวอย่างวันนี้', 'Today\'s range') + '</th></tr></thead><tbody>'
      + S.swing.map(s => { const band = S.latest.dvol / 100 * Math.sqrt(s.h / 365);
        return '<tr><td><b>' + s.h + ' ' + tr('วันข้างหน้า', 'days ahead') + '</b><small>' + s.count + ' ' + tr('วันที่นับ', 'days counted') + '</small></td><td>' + pc(s.in1) + '</td><td>' + pc(s.in2) + '</td><td>±' + (band * 100).toFixed(1) + '%<small>' + usd(S.latest.btc * Math.exp(-band)) + ' – ' + usd(S.latest.btc * Math.exp(band)) + '</small></td></tr>'; }).join('') + '</tbody>';

    // ---- points ----
    const done = S.falls.filter(r => !r.ongoing), quietTop = done.filter(r => r.dvPeakYear != null && r.dvPeak < r.dvPeakYear);
    const withYear = done.filter(r => r.dvPeakYear != null), calmer = done.filter(r => r.dvBottom < r.dvMax);
    const leads = done.map(r => r.dvMaxLead), leadMin = Math.min.apply(null, leads), leadMax = Math.max.apply(null, leads);
    const sw30 = S.swing[1], hy = S.high.top, y0 = S.years[0], yl = S.years[S.years.length - 1];
    const sell = S.spikes.filter(s => s.before7 <= -0.1 && s.after90 != null), rally = S.spikes.filter(s => s.before7 >= 0.1 && s.after90 != null);
    const upN = a => a.filter(s => s.after90 > 0).length;
    const together = S.years.filter(y => y.corr > 0).map(y => y.year), against = S.years.filter(y => y.corr < -0.2).map(y => y.year);
    const pts = [
      tr('DVOL บอก "ขนาด" ของการแกว่งได้ค่อนข้างตรง: อีก 30 วันต่อมาราคาอยู่ในกรอบที่ DVOL บอกไว้ ' + pc(sw30.in1) + ' ของวัน (ทฤษฎีคือ 68%) และหลุดกรอบ 2 เท่าแค่ ' + pc(1 - sw30.in2),
        'DVOL sizes the swing fairly well: 30 days later BTC was inside the range DVOL implied on ' + pc(sw30.in1) + ' of days (theory says 68%), and outside twice that range only ' + pc(1 - sw30.in2) + ' of the time.'),
      tr('แต่ DVOL มักตั้งไว้สูงกว่าความผันผวนที่เกิดขึ้นจริงในเดือนถัดไป (' + pc(S.over) + ' ของวัน) คนซื้อออปชันยอมจ่ายเผื่อไว้ก่อนเสมอ',
        'It usually runs high: DVOL was above the volatility BTC actually showed over the next 30 days on ' + pc(S.over) + ' of days. Option buyers pay extra for cover.'),
      tr('DVOL ไม่ได้บอกทิศทาง: วันที่ DVOL 60 ขึ้นไป BTC อีก 90 วันมีค่ากลาง ' + pct(S.high.med90) + (hy ? ' แต่ ' + pc(hy.share) + ' ของวันเหล่านั้นอยู่ในปี ' + hy.year + (hy.year === '2022' ? ' ซึ่งเป็นตลาดหมีทั้งปี' : '') : '') + ' ส่วนระดับ DVOL เองลดจากเฉลี่ย ' + y0.dvolAvg.toFixed(0) + ' ในปี ' + y0.year + ' เหลือ ' + yl.dvolAvg.toFixed(0) + ' ในปี ' + yl.year + ' เลขเดียวกันจึงมีความหมายต่างกันในแต่ละยุค',
        'DVOL is not a direction signal: on days at 60 or above, BTC\'s median 90 days later was ' + pct(S.high.med90) + (hy ? ', but ' + pc(hy.share) + ' of those days were in ' + hy.year + (hy.year === '2022' ? ', a bear market all year' : '') : '') + '. DVOL itself has fallen from an average of ' + y0.dvolAvg.toFixed(0) + ' in ' + y0.year + ' to ' + yl.dvolAvg.toFixed(0) + ' in ' + yl.year + ', so the same number means different things in different years.'),
      tr('อย่ารอให้ DVOL พุ่งเพื่อหาก้น: ' + (leadMin > 0 ? 'ทั้ง ' + done.length + ' รอบที่จบแล้ว DVOL ทำจุดสูงสุดก่อนก้นจริง ' : 'ใน ' + done.length + ' รอบที่จบแล้ว จุดสูงสุดของ DVOL ห่างจากก้น ') + leadMin + '–' + leadMax + ' วัน และ' + (calmer.length === done.length ? 'ทุกรอบ' : ' ' + calmer.length + ' จาก ' + done.length + ' รอบ') + ' ก้นจริงมาตอนที่ DVOL ลดลงจากจุดนั้นแล้ว ส่วนตอนยอด DVOL ก็ไม่ได้เตือนล่วงหน้า (ต่ำกว่าค่ากลางของปีก่อน ' + quietTop.length + ' จาก ' + withYear.length + ' รอบ สูงกว่า ' + (withYear.length - quietTop.length) + ' รอบ)',
        'Do not wait for a DVOL spike to call the bottom: ' + (leadMin > 0 ? 'in all ' + done.length + ' finished falls DVOL topped ' : 'across ' + done.length + ' finished falls DVOL topped ') + leadMin + '–' + leadMax + ' days before the real low, and ' + (calmer.length === done.length ? 'every time' : 'in ' + calmer.length + ' of ' + done.length) + ' the low came once DVOL had already eased. At the peak it gave no warning either: below its prior-year median in ' + quietTop.length + ' of ' + withYear.length + ' falls, above it in ' + (withYear.length - quietTop.length) + '.'),
      tr('DVOL กระโดดเกิน 30% ของค่าเฉลี่ย 30 วันมีแค่ ' + S.spikes.length + ' ครั้ง: หลังราคาร่วงแรง (7 วันลง 10% ขึ้นไป) BTC อีก 90 วันสูงกว่าเดิม ' + upN(sell) + ' จาก ' + sell.length + ' ครั้ง ส่วนหลังราคาพุ่งแรง ' + upN(rally) + ' จาก ' + rally.length + ' ครั้ง ตัวอย่างน้อยเกินจะใช้เป็นสัญญาณซื้อขาย',
        'DVOL jumped 30% above its 30-day average only ' + S.spikes.length + ' times. After a sharp drop (BTC down 10%+ in 7 days) BTC was higher 90 days later ' + upN(sell) + ' of ' + sell.length + ' times; after a sharp rally, ' + upN(rally) + ' of ' + rally.length + '. Far too few cases to trade on.')
    ];
    if(together.length) pts.push(tr('DVOL ไม่ได้ขึ้นเฉพาะตอนราคาลง: ปี ' + together.join(', ') + ' DVOL ขยับไปทางเดียวกับราคา (ราคาพุ่งก็ทำให้ DVOL สูงได้)' + (against.length ? ' ส่วนปี ' + against.join(', ') + ' ขยับสวนทางกันชัด' : ''),
      'DVOL does not only rise in sell-offs: in ' + together.join(', ') + ' it moved with the price (a fast rally lifts it too)' + (against.length ? ', while in ' + against.join(', ') + ' it clearly moved against it.' : '.')));
    el('bdvPoints').innerHTML = pts.map(s => '<li>' + s + '</li>').join('');

    el('bdvNote').innerHTML = tr('ข้อมูลรายวัน (UTC) ' + dm(S.first) + ' – ' + dm(S.last) + ' (วันล่าสุดยังไม่จบ จึงไม่นับเป็นผลข้างหน้า) · DVOL: Deribit ราคาปิดรายวัน · BTC: Deribit BTC-PERPETUAL ราคาปิดรายวัน (ใกล้เคียงราคา spot) · "กรอบ ±1 เท่า" = DVOL × √(วัน/365) · ช่วงที่ซ้อนกันไม่เป็นอิสระต่อกัน ตัวเลขจึงดูแน่นกว่าความจริง · DVOL มีข้อมูลแค่ราว ' + Math.round(S.days / 365) + ' ปี จำนวนรอบที่ราคาลงแรงยังน้อย · อดีตไม่ได้บอกอนาคต',
      'Daily data (UTC) ' + dm(S.first) + ' – ' + dm(S.last) + ' (the latest day is unfinished, so it is not used as a forward result) · DVOL: Deribit daily close · BTC: Deribit BTC-PERPETUAL daily close (close to spot) · "±1× range" = DVOL × √(days/365) · Overlapping windows are not independent, so results look firmer than they are · DVOL only has about ' + Math.round(S.days / 365) + ' years of history, so there are few big falls to learn from · The past does not predict the future');

    bdvChart(el('bdvChart'), D, S);
  }
  const median = a => { const b = a.slice().sort((x, y) => x - y), k = b.length >> 1; return b.length % 2 ? b[k] : (b[k - 1] + b[k]) / 2; };

  function bdvChart(box, D, S){
    const n = D.btc.length, W = 900, H = 300, L = 46, R = 34, T = 10, B = 22, VMAX = 160;
    const x = i => L + (W - L - R) * i / (n - 1);
    const lo = Math.log(Math.min.apply(null, D.btc) * 0.9), hi = Math.log(Math.max.apply(null, D.btc) * 1.05);
    const yP = v => T + (H - T - B) * (1 - (Math.log(v) - lo) / (hi - lo));
    const yV = v => T + (H - T - B) * (1 - Math.min(v, VMAX) / VMAX);
    const ix = s => { const k = D.dates.indexOf(s); return k < 0 ? 0 : k; };
    let g = S.falls.map(r => '<rect x="' + x(ix(r.peak)).toFixed(1) + '" y="' + T + '" width="' + Math.max(3, x(ix(r.trough)) - x(ix(r.peak))).toFixed(1) + '" height="' + (H - T - B) + '" fill="rgba(255,101,119,.16)"/>').join('');
    [40, 80, 120].forEach(v => { g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yV(v) + '" y2="' + yV(v) + '" stroke="#24304a" stroke-dasharray="3 4"/><text x="' + (W - R + 4) + '" y="' + (yV(v) + 3) + '" fill="#4cc9f0" font-size="10">' + v + '</text>'; });
    [20000, 40000, 80000].forEach(v => { if(Math.log(v) > lo && Math.log(v) < hi) g += '<text x="' + (L - 4) + '" y="' + (yP(v) + 3) + '" fill="#f7931a" font-size="10" text-anchor="end">' + (v / 1000) + 'k</text>'; });
    D.dates.forEach((d, i) => { if(d.slice(5) === '01-01') g += '<line x1="' + x(i).toFixed(1) + '" x2="' + x(i).toFixed(1) + '" y1="' + T + '" y2="' + (H - B) + '" stroke="#1b2540"/><text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" fill="#8e9bb5" font-size="10" text-anchor="middle">' + d.slice(0, 4) + '</text>'; });
    const path = (arr, fy) => arr.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + fy(v).toFixed(1)).join('');
    g += '<path d="' + path(D.dvol, yV) + '" fill="none" stroke="#4cc9f0" stroke-width="1.1" opacity=".85"/>';
    g += '<path d="' + path(D.btc, yP) + '" fill="none" stroke="#f7931a" stroke-width="1.8"/>';
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + tr('กราฟ BTC และ DVOL รายวันตั้งแต่ 2021', 'Daily BTC and DVOL since 2021') + '">' + g + '</svg>';
    if(window.btHover) window.btHover(box, { W, H, L, R, T, B, n, x,
      label: i => dm(D.dates[i]),
      bands: S.falls.map(r => ({ from: ix(r.peak), to: ix(r.trough), name: tr(r.th, r.en) + ' · ' + pct(r.fall, 1) })),
      series: [
        { name: 'BTC', color: '#f7931a', values: D.btc, y: yP, fmt: usd },
        { name: 'DVOL', color: '#4cc9f0', values: D.dvol, y: yV, fmt: v => v.toFixed(1) }
      ],
      extra: i => '<div class="d">' + tr('คาดแกว่ง 30 วัน ±', '30-day implied ±') + (D.dvol[i] * Math.sqrt(30 / 365)).toFixed(1) + '%</div>' });
  }

  let started = false;
  window.btDvolActivate = async function(){
    if(started) return; started = true;
    try{ bdvRender(await bdvLoad()); }
    catch(e){
      started = false;   // let a later visit to the tab try again
      const s = document.getElementById('bdvStatus');
      if(s) s.textContent = tr('ดึงข้อมูลจาก Deribit ไม่สำเร็จ ลองเปิดแท็บนี้ใหม่อีกครั้ง', 'Could not load Deribit data. Open this tab again to retry.');
    }
  };
  window.__bdvTest = { bdvRender, bdvLoad };
})();
