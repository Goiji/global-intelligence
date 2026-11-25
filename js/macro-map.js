(function(){
  const tr = window.tr || ((th) => th);
  const EN = window.GI_LANG === 'en';
  const $ = (id) => document.getElementById(id);
  const num = (v) => typeof v === 'number' && isFinite(v);
  const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const sgn = (v, d = 1) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d);
  const monthOf = (iso) => { try{ return new Date(iso + 'T00:00:00Z').toLocaleDateString((window.GI_LOCALE || 'th-TH') + '-u-ca-gregory', { month: 'short', year: 'numeric', timeZone: 'UTC' }); }catch(e){ return iso; } };

  // ── data helpers ─────────────────────────────────────────────────────────────────────────────
  // change over ~30 days of a markets.js series ({ latest, date, hist: [[iso, v], ...] }, oldest first)
  function chg30(s, pct){
    if(!s || !num(s.latest) || !Array.isArray(s.hist) || !s.hist.length) return null;
    const end = new Date((s.date || s.hist[s.hist.length - 1][0]) + 'T00:00:00Z').getTime() - 30 * 86400000;
    let base = null;
    for(const p of s.hist){ if(new Date(p[0] + 'T00:00:00Z').getTime() <= end) base = p[1]; }
    if(!num(base)) return null;
    return pct ? (s.latest / base - 1) * 100 : s.latest - base;
  }
  function chgYear(s){
    if(!s || !num(s.latest) || !Array.isArray(s.hist) || !s.hist.length || !num(s.hist[0][1])) return null;
    return (s.latest / s.hist[0][1] - 1) * 100;
  }
  function riseFromLow(s){   // unemployment: latest minus the lowest reading of the past 12 months
    if(!s || !num(s.latest) || !Array.isArray(s.hist) || !s.hist.length) return null;
    const vals = s.hist.map((p) => p[1]).filter(num);
    return vals.length ? s.latest - Math.min.apply(null, vals) : null;
  }
  function klinePct(k){       // Binance daily klines, oldest first → % change first open → last close
    if(!Array.isArray(k) || k.length < 2) return null;
    const a = parseFloat(k[0][1]), b = parseFloat(k[k.length - 1][4]);
    return num(a) && num(b) && a > 0 ? { pct: (b / a - 1) * 100, last: b } : null;
  }

  // ── the decision map: nodes (score > 0 = pushes the Fed toward keeping rates high) ─────────────
  // weights for the overall tilt; nodes without a weight are drawn but not scored
  const NODES = [
    { id: 'fed', th: 'เฟด', en: 'The Fed', x: 500, y: 330, w: 250, h: 112, zone: 'fed' },
    { id: 'inflation', th: 'เงินเฟ้อ', en: 'Inflation', x: 130, y: 430, w: 196, h: 90, wt: 3, zone: 'mandate' },
    { id: 'expect', th: 'เงินเฟ้อคาดการณ์', en: 'Inflation expectations', x: 130, y: 250, w: 196, h: 90, wt: 2, zone: 'mandate' },
    { id: 'labour', th: 'ตลาดแรงงาน', en: 'Jobs', x: 640, y: 590, w: 196, h: 90, wt: 3, zone: 'mandate' },
    { id: 'demand', th: 'การใช้จ่าย', en: 'Spending', x: 360, y: 590, w: 196, h: 90, wt: 1.5, zone: 'mandate' },
    { id: 'product', th: 'ผลิตภาพ', en: 'Productivity', x: 130, y: 590, w: 196, h: 90, wt: 1, zone: 'mandate' },
    { id: 'y10', th: 'บอนด์ยีลด์ 10 ปี', en: '10-year yield', x: 870, y: 250, w: 196, h: 90, wt: 1, zone: 'market' },
    { id: 'oil', th: 'ราคาน้ำมัน', en: 'Oil', x: 360, y: 70, w: 196, h: 90, wt: 1, zone: 'shock' },
    { id: 'war', th: 'ความเสี่ยงสงคราม', en: 'War risk', x: 130, y: 70, w: 196, h: 90, zone: 'shock' },
    { id: 'supply', th: 'อุปทานพันธบัตร', en: 'Bond supply', x: 640, y: 70, w: 196, h: 90, zone: 'shock' },
    { id: 'ai', th: 'AI', en: 'AI', x: 870, y: 470, w: 196, h: 90, zone: 'shock' }
  ];
  // [from, to, sign, strength 3 = well established · 2 = usually · 1 = unreliable / slow, th, en, bend]
  // sign: '+' = when `from` rises, `to` tends to rise · '-' = the opposite · '±' = either way
  const EDGES = [
    ['inflation', 'fed', '+', 3, 'เงินเฟ้อพื้นฐาน (Core PCE) สูงกว่าเป้า 2% → เฟดคงหรือขึ้นดอกเบี้ย นี่คือเป้าหมายตามกฎหมายข้อแรก', 'Core PCE above the 2% target keeps rates high. It is half of the Fed\'s legal mandate.'],
    ['labour', 'fed', '-', 3, 'ว่างงานเพิ่มขึ้นเร็ว → เฟดลดดอกเบี้ย (เป้าหมายข้อสอง: จ้างงานเต็มที่) ถ้าว่างงานขึ้นจากจุดต่ำสุดรอบปีเกิน ~0.5 จุด อดีตมักตามด้วยภาวะถดถอย', 'Fast-rising unemployment brings cuts (the other half of the mandate). A rise of ~0.5 pt from the 12-month low has usually meant recession.'],
    ['expect', 'fed', '+', 3, 'ถ้าคนเริ่มเชื่อว่าเงินเฟ้อจะสูงไปอีกหลายปี เฟดต้องเข้มขึ้นเพื่อรักษาความน่าเชื่อถือ', 'If people start to expect high inflation for years, the Fed has to lean harder to keep its credibility.', -40],
    ['fed', 'expect', '-', 2, 'เฟดที่น่าเชื่อถือช่วยตรึงความคาดหวังเงินเฟ้อระยะยาวไว้', 'A credible Fed keeps long-run expectations anchored.', -40],
    ['expect', 'inflation', '+', 2, 'ความคาดหวังส่งผลจริงผ่านการต่อรองค่าจ้างและการตั้งราคา', 'Expectations feed into wage deals and price setting.'],
    ['demand', 'inflation', '+', 2, 'การใช้จ่ายโตเร็วกว่ากำลังการผลิต → ราคาสินค้าและบริการขึ้น', 'Spending growing faster than supply pushes prices up.'],
    ['demand', 'labour', '-', 2, 'คนใช้จ่ายมาก บริษัทจ้างงานเพิ่ม ว่างงานลด', 'Strong spending means more hiring and lower unemployment.'],
    ['product', 'inflation', '-', 2, 'ผลิตได้มากขึ้นต่อชั่วโมง ต้นทุนแรงงานต่อหน่วยลด เศรษฐกิจโตได้โดยไม่ร้อนแรง', 'More output per hour lowers unit labour costs, so growth runs without overheating.'],
    ['oil', 'inflation', '+', 2, 'น้ำมันแพงดันเงินเฟ้อทั่วไปทันที แต่ส่งถึงเงินเฟ้อพื้นฐานไม่มาก เฟดมักมองข้ามถ้าเป็นช็อกชั่วคราว', 'Pricier oil lifts headline inflation at once but core only a little. The Fed usually looks through a one-off shock.'],
    ['oil', 'demand', '-', 2, 'น้ำมันแพงเหมือนภาษีที่เก็บจากผู้บริโภค เหลือเงินใช้จ่ายอย่างอื่นน้อยลง', 'Expensive fuel works like a tax on consumers and squeezes other spending.', 30],
    ['oil', 'expect', '+', 1, 'ราคาน้ำมันหน้าปั๊มขยับความคาดหวังระยะสั้นได้มาก แต่ระยะยาวขยับน้อย', 'Pump prices sway short-term expectations a lot, long-term ones much less.'],
    ['war', 'oil', '+', 2, 'สงครามในพื้นที่ผลิตหรือเส้นทางขนส่งน้ำมัน → ราคาพุ่ง แต่สงครามที่ไม่กระทบอุปทานแทบไม่ขยับราคา', 'War near oil fields or shipping lanes spikes prices. Wars that miss supply barely move them.'],
    ['war', 'y10', '±', 1, 'ระยะสั้นเงินไหลเข้าพันธบัตรสหรัฐฯ (ยีลด์ลง) แต่ถ้าต้องใช้งบสงครามมาก หรือน้ำมันดันเงินเฟ้อ ยีลด์อาจขึ้น', 'Short term, money runs to Treasuries (yields fall). Big war spending or oil-driven inflation can push yields up instead.', -60],
    ['supply', 'y10', '+', 2, 'รัฐบาลกู้มาก ต้องออกพันธบัตรเพิ่ม นักลงทุนขอผลตอบแทนส่วนเพิ่ม (term premium) สูงขึ้น', 'Heavy borrowing means more bonds to sell, so investors demand a higher term premium.'],
    ['fed', 'y10', '+', 2, 'ดอกเบี้ยนโยบายส่งถึงยีลด์ 2 ปีแทบเต็มที่ แต่ถึงยีลด์ 10 ปีแค่บางส่วน ส่วนที่เหลือขึ้นกับเงินเฟ้อคาดการณ์และ term premium', 'Policy moves pass almost fully to the 2-year yield but only partly to the 10-year, which also carries expectations and term premium.', 30],
    ['y10', 'fed', '-', 2, 'ยีลด์ยาวพุ่งเอง ทำให้สินเชื่อตึงตัวแทนเฟด เฟดจึงไม่ต้องขึ้นดอกเบี้ยเพิ่ม (เช่น ปลายปี 2023)', 'A jump in long yields tightens credit for the Fed, so it needs to hike less (late 2023).', 30],
    ['fed', 'demand', '-', 2, 'ดอกเบี้ยสูงทำให้การกู้ซื้อบ้าน รถ และลงทุนแพงขึ้น ผลเต็มที่ใช้เวลา 1–2 ปี', 'High rates make mortgages, car loans and investment dearer. The full effect takes 1–2 years.', 20],
    ['y10', 'demand', '-', 2, 'ดอกเบี้ยบ้าน 30 ปีและหุ้นกู้อิงยีลด์ 10 ปี', 'US 30-year mortgages and corporate bonds price off the 10-year yield.', -30],
    ['ai', 'demand', '+', 2, 'ตอนนี้: เงินลงทุนศูนย์ข้อมูลและไฟฟ้าก้อนใหญ่ดันการลงทุนภาคธุรกิจ', 'Now: huge data-centre and power spending boosts business investment.', 40],
    ['ai', 'product', '+', 1, 'อนาคต: อาจเพิ่มผลิตภาพได้มาก แต่ประวัติศาสตร์ชี้ว่าเทคโนโลยีใหม่ใช้เวลาหลายปีกว่าจะเห็นในตัวเลข', 'Later: may lift productivity a lot, but past technologies took years to show up in the data.', 70],
    ['ai', 'labour', '±', 1, 'อาจแทนที่งานบางประเภทและสร้างงานใหม่ ผลสุทธิต่อการจ้างงานยังไม่ชัด', 'It may replace some jobs and create others. The net effect on employment is unclear.']
  ];

  const D = { fred: null, mk: null, ex: null, mm: null, btc: null, gold: null };
  const S = (k) => D.mk && D.mk.series && D.mk.series[k];
  const it = (src, k) => D[src] && (src === 'fred' ? D.fred[k] : D[src].items && D[src].items[k]);

  // Each reader returns { v: big text, s: small text, score, th, en } (score null = not scored)
  const READ = {
    inflation(){
      const c = it('fred', 'corePce'); if(!c || !num(c.value)) return null;
      const v = c.value, gap = v - 2;
      return { v: v.toFixed(1) + '%', s: 'Core PCE YoY · ' + monthOf(c.date), score: clamp(gap / 1), src: 'BEA via FRED PCEPILFE',
        th: gap > 0.5 ? `สูงกว่าเป้า 2% อยู่ ${gap.toFixed(1)} จุด เฟดยังวางใจไม่ได้` : gap > 0.1 ? 'ใกล้เป้าแล้วแต่ยังไม่ถึง' : 'อยู่ที่เป้าหรือต่ำกว่า เปิดทางให้ลดดอกเบี้ย',
        en: gap > 0.5 ? `${gap.toFixed(1)} pt above the 2% target. Not comfortable yet.` : gap > 0.1 ? 'Close to target, not there yet.' : 'At or below target, which leaves room to cut.' };
    },
    expect(){
      const f = it('mm', 'fwd5y5y'), b = it('ex', 'be10');
      const x = f && num(f.value) ? { v: f.value, lab: '5y5y', ch: f.change1m } : b && num(b.value) ? { v: b.value, lab: '10Y breakeven', ch: null } : null;
      if(!x) return null;
      // these are CPI-based: about 2.3–2.5% is consistent with 2% PCE inflation
      const score = clamp((x.v - 2.4) / 0.35);
      return { v: x.v.toFixed(2) + '%', s: x.lab + (num(x.ch) ? ' · 1M ' + sgn(x.ch, 2) : ''), score, src: x.lab === '5y5y' ? 'FRED T5YIFR' : 'FRED T10YIE',
        th: score > 0.3 ? 'ตลาดเริ่มเชื่อว่าเงินเฟ้อจะสูงยาว เป็นสัญญาณที่เฟดกังวลที่สุด' : score < -0.3 ? 'ตลาดคาดเงินเฟ้อต่ำ ไม่มีแรงกดดันจากด้านนี้' : 'ยังตรึงอยู่ในระดับที่สอดคล้องกับเป้า 2%',
        en: score > 0.3 ? 'Markets expect inflation to stay high. The signal the Fed fears most.' : score < -0.3 ? 'Markets expect low inflation. No pressure from here.' : 'Still anchored at a level consistent with 2%.' };
    },
    labour(){
      const u = it('fred', 'unrate'); if(!u || !num(u.value)) return null;
      const rise = riseFromLow(S('unrate'));
      const score = clamp(0.5 * clamp((4.3 - u.value) / 0.7) + 0.5 * (num(rise) ? clamp((0.2 - rise) / 0.3) : 0));
      return { v: u.value.toFixed(1) + '%', s: tr('อัตราว่างงาน', 'Unemployment') + ' · ' + monthOf(u.date) + (num(rise) ? ' · ' + tr('จากต่ำสุด 12M ', 'vs 12M low ') + sgn(rise) : ''), score, src: 'BLS via FRED UNRATE',
        th: num(rise) && rise >= 0.5 ? `ว่างงานขึ้นจากจุดต่ำสุดรอบปี ${rise.toFixed(1)} จุด สัญญาณเตือนถดถอย เฟดมีแนวโน้มลดดอกเบี้ย` : score > 0.3 ? 'ตลาดแรงงานยังแน่น เฟดไม่ต้องรีบช่วย' : score < -0.3 ? 'ตลาดแรงงานอ่อนลงชัด เพิ่มน้ำหนักให้ลดดอกเบี้ย' : 'ตลาดแรงงานชะลอแบบค่อยเป็นค่อยไป',
        en: num(rise) && rise >= 0.5 ? `Up ${rise.toFixed(1)} pt from the 12-month low, a recession warning. Leans toward cuts.` : score > 0.3 ? 'Jobs market still tight. No rush to help.' : score < -0.3 ? 'Jobs market clearly weakening. Adds weight to cuts.' : 'Jobs market cooling gradually.' };
    },
    demand(){
      const r = it('mm', 'realPce'); if(!r || !num(r.value)) return null;
      const score = clamp((r.value - 2) / 1.5);
      return { v: sgn(r.value) + '%', s: tr('การบริโภคจริง YoY', 'Real spending YoY') + ' · ' + monthOf(r.date), score, src: 'BEA via FRED PCEC96',
        th: score > 0.3 ? 'คนอเมริกันยังใช้จ่ายแรง เสี่ยงให้เงินเฟ้อค้าง' : score < -0.3 ? 'การใช้จ่ายชะลอ ลดแรงกดดันเงินเฟ้อ' : 'การใช้จ่ายโตใกล้ค่าปกติ (~2%)',
        en: score > 0.3 ? 'Americans are still spending hard, which keeps inflation sticky.' : score < -0.3 ? 'Spending is slowing, easing price pressure.' : 'Spending growing near its normal ~2%.' };
    },
    product(){
      const p = it('mm', 'productivity'); if(!p || !num(p.value)) return null;
      const score = -0.6 * clamp((p.value - 1.5) / 1.5);
      return { v: sgn(p.value) + '%', s: tr('ผลผลิตต่อชั่วโมง YoY', 'Output per hour YoY') + ' · ' + monthOf(p.date), score, src: 'BLS via FRED OPHNFB',
        th: p.value > 2 ? 'ผลิตภาพโตดี ช่วยให้เศรษฐกิจโตได้โดยเงินเฟ้อไม่เร่ง' : p.value < 1 ? 'ผลิตภาพโตช้า ต้นทุนแรงงานต่อหน่วยกดดันราคา' : 'ผลิตภาพโตใกล้ค่าเฉลี่ยระยะยาว (~1.5%)',
        en: p.value > 2 ? 'Strong productivity lets the economy grow without faster inflation.' : p.value < 1 ? 'Weak productivity, so labour costs press on prices.' : 'Near its long-run average (~1.5%).' };
    },
    y10(){
      const s = S('us10y'); if(!s || !num(s.latest)) return null;
      const c = chg30(s);
      const score = num(c) ? -0.6 * clamp(c / 0.4) : 0;
      return { v: s.latest.toFixed(2) + '%', s: 'US 10Y' + (num(c) ? ' · 1M ' + sgn(c * 100, 0) + ' bp' : ''), score, src: 'FRED DGS10 + Cboe TNX',
        th: num(c) && c > 0.2 ? 'ยีลด์ยาวขึ้นแรง ทำให้ภาวะการเงินตึงตัวแทนเฟดไปส่วนหนึ่ง' : num(c) && c < -0.2 ? 'ยีลด์ยาวลง ภาวะการเงินผ่อนคลายขึ้นเอง' : 'ยีลด์ยาวเคลื่อนไหวไม่มาก',
        en: num(c) && c > 0.2 ? 'Long yields jumped, doing part of the Fed\'s tightening for it.' : num(c) && c < -0.2 ? 'Long yields fell, loosening conditions on their own.' : 'Long yields little changed.' };
    },
    oil(){
      const o = it('mm', 'oil'); if(!o || !num(o.value)) return null;
      const c = o.change1m;
      const score = num(c) ? 0.5 * clamp(c / 20) : 0;
      return { v: '$' + o.value.toFixed(0), s: 'WTI' + (num(c) ? ' · 1M ' + sgn(c) + '%' : ''), score, src: 'EIA via FRED DCOILWTICO',
        th: num(c) && c > 10 ? 'น้ำมันขึ้นแรง ดันเงินเฟ้อทั่วไป แต่ก็ชะลอการใช้จ่าย' : num(c) && c < -10 ? 'น้ำมันลงแรง ช่วยกดเงินเฟ้อทั่วไป' : 'ราคาน้ำมันไม่ใช่ประเด็นหลักตอนนี้',
        en: num(c) && c > 10 ? 'Oil up sharply: lifts headline inflation but also slows spending.' : num(c) && c < -10 ? 'Oil down sharply, which pulls headline inflation lower.' : 'Oil is not a major factor right now.' };
    },
    war(){
      const o = S('ovx'); if(!o || !num(o.latest)) return null;
      return { v: 'OVX ' + o.latest.toFixed(0), s: tr('ความผันผวนน้ำมัน (ตัวแทนความเสี่ยง)', 'Oil volatility (risk proxy)'), score: null, src: 'Cboe OVX via FRED',
        th: o.latest > 45 ? 'ตลาดน้ำมันตื่นตระหนก มักเกิดเมื่อสงครามกระทบอุปทาน' : o.latest > 35 ? 'ตลาดน้ำมันเริ่มกังวลสูงกว่าปกติ' : 'ตลาดน้ำมันยังไม่ตื่นตระหนก (ค่าปกติ ~25–35)',
        en: o.latest > 45 ? 'Oil market in panic, typical when war hits supply.' : o.latest > 35 ? 'Oil market more nervous than usual.' : 'Oil market calm (normal is ~25–35).' };
    },
    supply(){
      const d = it('mm', 'debt'); if(!d || !num(d.levelTn)) return null;
      return { v: '$' + d.levelTn.toFixed(1) + 'T', s: tr('หนี้รัฐบาลสหรัฐฯ', 'US federal debt') + (num(d.value) ? ' · YoY ' + sgn(d.value) + '%' : ''), score: null, src: 'US Treasury via FRED GFDEBTN',
        th: `หนี้เพิ่มปีละ ~${num(d.value) ? d.value.toFixed(0) : '?'}% ต้องออกพันธบัตรใหม่ต่อเนื่อง เป็นแรงดันยีลด์ยาวที่เฟดคุมไม่ได้`,
        en: `Debt growing ~${num(d.value) ? d.value.toFixed(0) : '?'}% a year means a steady flood of new bonds, a pressure on long yields the Fed does not control.` };
    },
    ai(){
      const n = S('nasdaq100'); const c = chgYear(n);
      return { v: num(c) ? 'NDX ' + sgn(c, 0) + '%' : tr('เชิงคุณภาพ', 'Qualitative'), s: tr('Nasdaq-100 รอบ 12 เดือน (ตัวแทนกระแส AI)', 'Nasdaq-100, 12 months (AI-trade proxy)'), score: null, src: 'FRED NASDAQ100 + Cboe',
        th: 'ตอนนี้ AI ดันการลงทุน (เงินเฟ้อ) แต่ในอนาคตอาจเพิ่มผลิตภาพ (ลดเงินเฟ้อ) ผลสุทธิต่อเฟดยังสรุปไม่ได้ จึงไม่นับในคะแนน',
        en: 'Today AI lifts investment (inflationary); later it may lift productivity (disinflationary). The net effect is unknowable, so it is not scored.' };
    }
  };

  function computeTilt(reads){
    let sw = 0, s = 0; const parts = [];
    NODES.forEach((n) => { const r = reads[n.id]; if(n.wt && r && num(r.score)){ sw += n.wt; s += n.wt * r.score; parts.push({ id: n.id, c: n.wt * r.score, score: r.score }); } });
    if(!sw) return null;
    parts.sort((a, b) => Math.abs(b.c) - Math.abs(a.c));
    return { tilt: s / sw, parts, coverage: sw };
  }
  const tiltLabel = (t) => t > 0.35 ? tr('กดดันให้คงหรือขึ้นดอกเบี้ย', 'Pressure to hold or hike') : t > 0.12 ? tr('เอียงไปทางเข้มงวด', 'Leaning hawkish') : t < -0.35 ? tr('มีช่องให้ลดดอกเบี้ย', 'Room to cut') : t < -0.12 ? tr('เอียงไปทางลด', 'Leaning to cut') : tr('สมดุล รอดูข้อมูล', 'Balanced, data-dependent');
  const tone = (s) => !num(s) ? 'ext' : s > 0.25 ? 'hot' : s < -0.25 ? 'cool' : '';
  const toneColor = (s) => !num(s) ? 'var(--ext)' : s > 0.25 ? 'var(--hot)' : s < -0.25 ? 'var(--cool)' : '#55627f';
  const nodeName = (id) => { const n = NODES.find((x) => x.id === id); return n ? tr(n.th, n.en) : id; };
  const CONF = { 3: ['เกิดแทบทุกครั้ง', 'Almost always'], 2: ['เกิดบ่อย', 'Usually'], 1: ['ไม่แน่นอน', 'Unreliable'] };
  const chip = (c) => `<span class="mm-chip c${c}">${tr(CONF[c][0], CONF[c][1])}</span>`;

  // ── SVG map ──────────────────────────────────────────────────────────────────────────────────
  function edgeGeom(a, b, bend){
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    const cx = mx - dy / L * (bend || 0), cy = my + dx / L * (bend || 0);
    const exit = (n, tx, ty, pad) => {    // point where the line from n's centre toward (tx,ty) leaves its box
      const ux = tx - n.x, uy = ty - n.y;
      const k = Math.min(Math.abs((n.w / 2 + pad) / (ux || 1e-9)), Math.abs((n.h / 2 + pad) / (uy || 1e-9)));
      return [n.x + ux * k, n.y + uy * k];
    };
    const p0 = exit(a, cx, cy, 2), p1 = exit(b, cx, cy, 7);
    return `M${p0[0].toFixed(1)},${p0[1].toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
  }
  const EDGE_COL = { '+': 'var(--hot)', '-': 'var(--cool)', '±': 'var(--ext)' };
  let selected = 'fed', reads = {}, tiltInfo = null;

  const ICON = { inflation: '🔥', expect: '🧠', labour: '👷', demand: '🛒', product: '⚙️', y10: '📈', oil: '🛢️', war: '⚔️', supply: '🏛️', ai: '🤖', fed: '🏦' };
  function drawMap(){
    const map = $('mmMap'); if(!map) return;
    const byId = {}; NODES.forEach((n) => { byId[n.id] = n; });
    let h = '<svg viewBox="0 0 1000 650" role="img" aria-label="' + esc(tr('แผนผังปัจจัยที่มีผลต่อการตัดสินใจของเฟด', 'Map of the forces behind Fed decisions')) + '"><defs>';
    ['hot', 'cool', 'ext'].forEach((k) => { h += `<marker id="mmA-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--${k})"/></marker>`; });
    h += '<linearGradient id="mmNodeG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1b2646"/><stop offset="1" stop-color="#111a31"/></linearGradient>'
      + '<linearGradient id="mmFedG" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2a2a35"/><stop offset=".5" stop-color="#1c2440"/><stop offset="1" stop-color="#151d36"/></linearGradient>'
      + '<pattern id="mmDots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#ffffff10"/></pattern></defs>';
    h += '<rect width="1000" height="650" fill="url(#mmDots)"/>';
    h += `<rect class="mm-band" x="14" y="10" width="972" height="120" rx="20" fill="rgba(179,157,219,.045)"/><text class="mm-zl" x="986" y="146" text-anchor="end">${esc(tr('แรงจากภายนอก', 'OUTSIDE FORCES'))}</text>`;
    h += `<path class="mm-band" d="M34,186 H226 a20,20 0 0 1 20,20 V522 H754 a20,20 0 0 1 20,20 V626 a20,20 0 0 1 -20,20 H34 a20,20 0 0 1 -20,-20 V206 a20,20 0 0 1 20,-20 Z" fill="rgba(76,201,240,.04)"/><text class="mm-zl" x="22" y="178">${esc(tr('ภารกิจของเฟด · ราคา + การจ้างงาน', 'THE MANDATE · PRICES + JOBS'))}</text>`;
    const F = byId.fed;
    [80, 130, 190].forEach((r, i) => { h += `<ellipse class="mm-ring" cx="${F.x}" cy="${F.y}" rx="${r * 1.55}" ry="${r}" stroke-dasharray="${i ? '2 6' : ''}"/>`; });
    EDGES.forEach((e, i) => {
      const a = byId[e[0]], b = byId[e[1]]; const k = e[2] === '+' ? 'hot' : e[2] === '-' ? 'cool' : 'ext';
      h += `<path class="mm-edge" data-i="${i}" d="${edgeGeom(a, b, e[7])}" stroke="${EDGE_COL[e[2]]}" style="color:${EDGE_COL[e[2]]}" stroke-width="${[0, 1.3, 2, 3][e[3]]}" ${e[3] === 1 || e[2] === '±' ? 'stroke-dasharray="3 5"' : ''} marker-end="url(#mmA-${k})"/>`;
    });
    NODES.forEach((n) => {
      const r = reads[n.id];
      const isFed = n.id === 'fed';
      const col = isFed ? 'var(--accent,#d4b26a)' : toneColor(r && r.score);
      const val = isFed ? (fedRangeText() || '—') : (r ? r.v : '—');
      const sub = isFed ? (tiltInfo ? tiltLabel(tiltInfo.tilt) : '') : (r ? r.s : tr('ไม่มีข้อมูล', 'no data'));
      const sc = r && num(r.score) ? r.score : null;
      const badge = isFed || sc == null ? '' : sc > 0.25 ? '▲' : sc < -0.25 ? '▼' : '●';
      const x0 = n.x - n.w / 2, y0 = n.y - n.h / 2, pad = isFed ? 20 : 18;
      const vcol = isFed ? '' : sc == null ? (r ? '#d9c9f5' : '#6f7ea3') : sc > 0.25 ? 'var(--hot)' : sc < -0.25 ? 'var(--cool)' : '#eef3ff';
      h += `<g class="mm-node${isFed ? ' mm-fed' : ''}${n.id === selected ? ' sel' : ''}" data-id="${n.id}" tabindex="0" role="button" aria-label="${esc(tr(n.th, n.en) + ' ' + val)}">`
        + `<rect class="box" x="${x0}" y="${y0}" width="${n.w}" height="${n.h}" rx="${isFed ? 22 : 16}"/>`
        + (isFed ? '' : `<rect x="${x0}" y="${y0 + 14}" width="4" height="${n.h - 28}" rx="2" fill="${col}"/>`)
        + `<text class="nl" x="${x0 + pad}" y="${y0 + (isFed ? 28 : 25)}">${ICON[n.id] || ''} ${esc(tr(n.th, n.en))}</text>`
        + (badge ? `<text class="badge" x="${x0 + n.w - 14}" y="${y0 + 24}" text-anchor="end" fill="${col}">${badge}</text>` : '')
        + `<text class="nv" x="${x0 + pad}" y="${n.y + (isFed ? 16 : 11)}"${vcol ? ` style="fill:${vcol}"` : ''}>${esc(val)}</text>`
        + `<text class="ns" x="${x0 + pad}" y="${y0 + n.h - (isFed ? 16 : 13)}"${isFed ? ' style="fill:#d4b26a;font-weight:700"' : ''}>${esc(String(sub).length > 29 ? String(sub).slice(0, 28) + '…' : sub)}</text></g>`;
    });
    h += '</svg>';
    map.innerHTML = h;
    if(map.querySelectorAll){
      Array.prototype.forEach.call(map.querySelectorAll('.mm-node'), (g) => {
        const pick = () => { selected = g.getAttribute('data-id'); highlight(); drawPanel(); };
        g.addEventListener('click', pick);
        g.addEventListener('keydown', (ev) => { if(ev.key === 'Enter' || ev.key === ' '){ ev.preventDefault(); pick(); } });
        g.addEventListener('mouseenter', () => highlight(g.getAttribute('data-id')));
        g.addEventListener('mouseleave', () => highlight());
      });
    }
    highlight();
  }
  function highlight(hover){
    const id = hover || selected; const map = $('mmMap'); if(!map || !map.querySelectorAll) return;
    Array.prototype.forEach.call(map.querySelectorAll('.mm-edge'), (p) => {
      const e = EDGES[+p.getAttribute('data-i')]; const on = id === 'fed' && !hover ? false : (e[0] === id || e[1] === id);
      p.classList.toggle('on', on); p.classList.toggle('dim', !(id === 'fed' && !hover) && !on);
    });
    Array.prototype.forEach.call(map.querySelectorAll('.mm-node'), (g) => g.classList.toggle('sel', g.getAttribute('data-id') === selected));
  }
  function fedRangeText(){
    const u = it('fred', 'upper'), l = it('fred', 'lower');
    return u && l && num(u.value) && num(l.value) ? l.value.toFixed(2) + '–' + u.value.toFixed(2) + '%' : null;
  }
  function linkLi(e, dirOut){
    const other = dirOut ? e[1] : e[0];
    const arrow = e[2] === '+' ? '<b class="hot">↑</b>' : e[2] === '-' ? '<b class="cool">↓</b>' : '<b class="ext">↕</b>';
    return `<li>${arrow} <b>${esc(nodeName(other))}</b>${chip(e[3])}<br><span class="muted">${esc(tr(e[4], e[5]))}</span></li>`;
  }
  function drawPanel(){
    const p = $('mmPanel'); if(!p) return;
    const n = NODES.find((x) => x.id === selected);
    const out = EDGES.filter((e) => e[0] === selected), inn = EDGES.filter((e) => e[1] === selected);
    let h = '';
    if(selected === 'fed'){
      const effr = it('fred', 'effr');
      h += `<div class="mm-k">${esc(tr('ศูนย์กลาง', 'Centre'))}</div><h3>${esc(tr('ธนาคารกลางสหรัฐฯ (เฟด)', 'Federal Reserve'))}</h3>`
        + `<div class="mm-big">${esc(fedRangeText() || '—')}</div>`
        + (effr && num(effr.value) ? `<div class="mm-sub">EFFR ${effr.value.toFixed(2)}%</div>` : '')
        + `<p>${esc(tr('เฟดมีสองภารกิจ: คุมเงินเฟ้อให้อยู่ราว 2% และให้คนมีงานทำมากที่สุด กล่องซ้ายและล่างคือข้อมูลสองภารกิจนี้ กล่องบนคือแรงจากภายนอกที่เฟดคุมไม่ได้แต่ต้องรับมือ', 'Two jobs: inflation near 2% and maximum employment. The left and bottom boxes track those two goals. The top row holds outside forces the Fed cannot control but has to react to.'))}</p>`;
      if(tiltInfo){
        h += `<div class="mm-h4">${esc(tr('แต่ละปัจจัยดันไปทางไหน (− ลด · + คง/ขึ้น)', 'What each factor is doing (− cut · + hold/hike)'))}</div><ul class="mm-links" style="font-size:12px">`;
        tiltInfo.parts.forEach((q) => {
          const w = Math.round(Math.abs(q.score) * 50);
          h += `<li style="display:grid;grid-template-columns:7.5em 1fr 3.2em;gap:8px;align-items:center;padding:4px 0;border:0"><span>${esc(nodeName(q.id))}</span>`
            + `<span style="height:6px;background:#202b42;border-radius:99px;position:relative"><i style="position:absolute;top:0;bottom:0;${q.score >= 0 ? 'left:50%' : 'right:50%'};width:${w}%;background:${toneColor(q.score)};border-radius:99px"></i><i style="position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:#55627f"></i></span>`
            + `<b class="${tone(q.score)}" style="text-align:right">${sgn(q.score * 100, 0)}</b></li>`;
        });
        h += '</ul>';
      }
      h += `<div class="mm-sub" style="margin-top:6px">${esc(tr('แตะกล่องอื่นบนแผนผังเพื่อดูว่าแต่ละปัจจัยส่งผลต่ออะไร', 'Tap any other box to see what it affects'))}</div>`;
    } else {
      const r = reads[selected];
      h += `<div class="mm-k">${esc(tr({ mandate: 'ภารกิจของเฟด', market: 'ตลาดพันธบัตร', shock: 'แรงจากภายนอก' }[n.zone], { mandate: 'Mandate', market: 'Bond market', shock: 'Outside force' }[n.zone]))}</div>`
        + `<h3>${esc(tr(n.th, n.en))}</h3>`
        + `<div class="mm-big ${r ? tone(r.score) : ''}">${esc(r ? r.v : '—')}</div><div class="mm-sub">${esc(r ? r.s : tr('ยังโหลดข้อมูลไม่ได้', 'Data not loaded'))}</div>`
        + (r ? `<p><b>${esc(tr('ตอนนี้: ', 'Now: '))}</b>${esc(tr(r.th, r.en))}</p>` : '')
        + (r && num(r.score) ? `<div class="mm-sub">${esc(tr('คะแนนต่อเฟด ', 'Score toward the Fed '))}<b class="${tone(r.score)}">${sgn(r.score * 100, 0)}</b> ${esc(tr('(บวก = ดันให้ดอกเบี้ยสูง, ลบ = เปิดทางลด)', '(+ = keeps rates high, − = room to cut)'))}</div>` : '');
      if(out.length) h += `<div class="mm-h4">${esc(tr('ส่งผลต่อ', 'Pushes on'))}</div><ul class="mm-links">${out.map((e) => linkLi(e, true)).join('')}</ul>`;
      if(inn.length) h += `<div class="mm-h4">${esc(tr('ได้รับผลจาก', 'Pushed by'))}</div><ul class="mm-links">${inn.map((e) => linkLi(e, false)).join('')}</ul>`;
      if(r && r.src) h += `<div class="mm-sub">${esc(tr('ที่มา: ', 'Source: '))}${esc(r.src)}</div>`;
    }
    p.innerHTML = h;
  }

  // ── market transmission ──────────────────────────────────────────────────────────────────────
  // rows: [id, th, en, stage]; stage 1 = rates & money channels, 2 = assets
  const ROWS = [
    ['us2y', 'ยีลด์ 2 ปี', '2-year yield', 1], ['us10y', 'ยีลด์ 10 ปี', '10-year yield', 1], ['real', 'ยีลด์ที่แท้จริง 10 ปี', '10-year real yield', 1],
    ['usd', 'ดอลลาร์ (DXY)', 'US dollar (DXY)', 1], ['liq', 'สภาพคล่องสุทธิ', 'Net liquidity', 1], ['credit', 'ส่วนต่างหุ้นกู้เสี่ยง', 'Junk-bond spread', 1],
    ['ndx', 'Nasdaq-100', 'Nasdaq-100', 2], ['btc', 'Bitcoin', 'Bitcoin', 2], ['gold', 'ทองคำ', 'Gold', 2], ['ust', 'พันธบัตรระยะยาว (ราคา)', 'Long Treasuries (price)', 2]
  ];
  // per scenario: row → [direction 1 up / -1 down / 0 mixed, confidence 3/2/1, optional note th, en]
  const SCEN = [
    { id: 'hfl', th: 'ดอกเบี้ยสูงนาน', en: 'Higher for longer',
      trig: ['เงินเฟ้อค้างเหนือเป้า เฟดส่งสัญญาณไม่รีบลดดอกเบี้ย', 'Inflation sticks above target and the Fed signals no rush to cut.'],
      hist: ['2022 – ต.ค. 2023: เฟดขึ้นดอกเบี้ยจาก 0.25% ถึง 5.50% Nasdaq-100 ลง ~33% และ BTC ลง ~64% ในปี 2022 ยีลด์ 10 ปีแตะ ~5% ในต.ค. 2023', '2022 – Oct 2023: the Fed went from 0.25% to 5.50%. In 2022 the Nasdaq-100 fell ~33% and BTC ~64%; the 10-year touched ~5% in Oct 2023.'],
      r: { us2y: [1, 3], us10y: [1, 2], real: [1, 3], usd: [1, 2], liq: [-1, 2], credit: [1, 1],
        ndx: [-1, 2, 'หุ้นเทคมูลค่าอิงกำไรอนาคตไกล จึงโดนส่วนลดแรงที่สุด', 'Tech valuations rest on far-off profits, so a higher discount rate hurts most'],
        btc: [-1, 2, 'สภาพคล่องหดเป็นลบต่อ BTC แต่ความสัมพันธ์ไม่คงที่', 'Draining liquidity hurts BTC, though the link comes and goes'],
        gold: [-1, 1, 'ตามทฤษฎีลง แต่ปี 2023–25 ทองขึ้นแรงทั้งที่ยีลด์แท้จริงสูง เพราะธนาคารกลางทั่วโลกซื้อ', 'Theory says down, yet gold rallied in 2023–25 with high real yields as central banks bought'],
        ust: [-1, 3] } },
    { id: 'dis', th: 'เงินเฟ้อชะลอ', en: 'Disinflation',
      trig: ['เงินเฟ้อลดลงสู่เป้าโดยเศรษฐกิจยังไม่ถดถอย ตลาดเริ่มคาดการลดดอกเบี้ย', 'Inflation eases toward target without a recession, and markets price in cuts.'],
      hist: ['พ.ย.–ธ.ค. 2023: เงินเฟ้อชะลอ ยีลด์ 10 ปีลงจาก ~5% เหลือ ~3.8% Nasdaq-100 ทำจุดสูงสุดใหม่ BTC และทองขึ้น', 'Nov–Dec 2023: inflation cooled, the 10-year fell from ~5% to ~3.8%, the Nasdaq-100 hit a record, BTC and gold rose.'],
      r: { us2y: [-1, 3], us10y: [-1, 2], real: [-1, 2], usd: [-1, 2], liq: [1, 1], credit: [-1, 2],
        ndx: [1, 2, 'ใช้ได้เมื่อ "ลดเพราะเงินเฟ้อลง" ถ้าลดเพราะเศรษฐกิจทรุด หุ้นมักลง', 'Holds when cuts come from lower inflation; cuts forced by a slump usually sink stocks'],
        btc: [1, 2], gold: [1, 2], ust: [1, 3] } },
    { id: 'credit', th: 'วิกฤตสินเชื่อ', en: 'Credit stress',
      trig: ['ธนาคารหรือผู้กู้รายใหญ่มีปัญหา ความกลัวลาม เฟดอัดสภาพคล่องและลดดอกเบี้ย', 'A bank or big borrower fails, fear spreads, and the Fed floods liquidity and cuts.'],
      hist: ['มี.ค. 2023 (SVB): ยีลด์ 2 ปีร่วง ~1 จุดใน 3 วัน เฟดปล่อยกู้ฉุกเฉินจนงบดุลเพิ่ม ~3 แสนล้านดอลลาร์ใน 1 สัปดาห์ BTC ขึ้น ~20% ในเดือนนั้น แต่ มี.ค. 2020 BTC ร่วง ~50% ใน 2 วัน', 'Mar 2023 (SVB): the 2-year fell ~1 pt in 3 days and emergency lending added ~$300bn to the Fed balance sheet in a week; BTC rose ~20% that month. In Mar 2020 BTC fell ~50% in 2 days.'],
      r: { us2y: [-1, 3], us10y: [-1, 2], real: [0, 1, 'ปี 2008 ยีลด์แท้จริงกลับพุ่งเพราะคนเทขาย TIPS', 'In 2008 real yields spiked as TIPS were dumped'],
        usd: [1, 2, 'ช่วงแรกทุกคนแย่งดอลลาร์ (2008, มี.ค. 2020)', 'Early on everyone scrambles for dollars (2008, Mar 2020)'],
        liq: [1, 2, 'เฟดอัดเงินเข้า แต่ตลาดยังรู้สึกตึง', 'The Fed adds reserves even as markets feel tight'], credit: [1, 3],
        ndx: [-1, 3], btc: [0, 1, 'สวนทางกันในแต่ละครั้ง: 2020 ร่วง, 2023 ขึ้น', 'Opposite each time: fell in 2020, rose in 2023'],
        gold: [1, 2, 'อาจลงก่อนเพราะคนขายทุกอย่างเพื่อหาเงินสด แล้วค่อยขึ้น', 'Can drop first in a dash for cash, then rise'],
        ust: [1, 3, 'ยกเว้นช่วงสั้นๆ มี.ค. 2020 ที่แม้แต่พันธบัตรก็ถูกขาย', 'Except briefly in Mar 2020, when even Treasuries were sold'] } },
    { id: 'oil', th: 'น้ำมันช็อก', en: 'Oil shock',
      trig: ['อุปทานน้ำมันสะดุด (สงคราม/คว่ำบาตร) ราคาพุ่ง เงินเฟ้อทั่วไปขึ้น แต่การใช้จ่ายถูกกด', 'Oil supply is disrupted (war, sanctions). Prices jump, headline inflation rises, spending gets squeezed.'],
      hist: ['ก.พ.–มี.ค. 2022 รัสเซียบุกยูเครน: WTI ปิดเหนือ $120 ทองแตะ ~$2,070 ในวันเดียวกัน (8 มี.ค.) จากนั้นเฟดเริ่มขึ้นดอกเบี้ย', 'Feb–Mar 2022, Russia invades Ukraine: WTI closed above $120 and gold hit ~$2,070 on the same day (8 Mar), then the Fed began hiking.'],
      r: { us2y: [1, 2], us10y: [0, 1, 'เงินเฟ้อดันขึ้น ความกลัวเศรษฐกิจดึงลง', 'Inflation pushes up, growth fears pull down'],
        real: [-1, 1, 'เงินเฟ้อคาดการณ์ขึ้นเร็วกว่ายีลด์', 'Expected inflation rises faster than yields'],
        usd: [1, 1, 'สหรัฐฯ ส่งออกพลังงานสุทธิแล้ว ดอลลาร์มักแข็งเทียบสกุลประเทศนำเข้าน้ำมัน', 'The US is now a net energy exporter, so the dollar tends to gain on oil importers'],
        liq: [0, 1], credit: [1, 1],
        ndx: [-1, 2], btc: [-1, 1], gold: [1, 2, 'ได้แรงหนุนจากความเสี่ยงภูมิรัฐศาสตร์', 'Supported by geopolitical fear'],
        ust: [0, 1, 'เงินเฟ้อกดราคา แต่คนหนีความเสี่ยงหนุนราคา', 'Inflation weighs, safe-haven buying supports'] } },
    { id: 'term', th: 'ตลาดพันธบัตรกดดัน', en: 'Bond-market pressure',
      trig: ['ยีลด์ยาวพุ่งเองโดยเฟดไม่ได้ขึ้นดอกเบี้ย เพราะกังวลหนี้รัฐบาลและการออกพันธบัตร (term premium)', 'Long yields jump without any Fed hike, on worries about government debt and bond supply (term premium).'],
      hist: ['ส.ค.–ต.ค. 2023: ยีลด์ 10 ปีจาก ~4% เป็น ~5% ระหว่างที่เฟดหยุดขึ้นดอกเบี้ย / เม.ย. 2025 หลังประกาศภาษีนำเข้า ยีลด์ขึ้นแรงพร้อมดอลลาร์อ่อน ซึ่งปกติไม่เกิดพร้อมกัน', 'Aug–Oct 2023: the 10-year went from ~4% to ~5% while the Fed paused. Apr 2025, after the tariff announcement: yields jumped while the dollar fell, an unusual combination.'],
      r: { us2y: [0, 1, 'แทบไม่ขยับเพราะเฟดไม่ได้เปลี่ยนนโยบาย', 'Barely moves, since the Fed has not changed course'], us10y: [1, 3], real: [1, 2],
        usd: [0, 1, 'ถ้าเป็นเรื่องความเชื่อมั่นต่อสหรัฐฯ ดอลลาร์อาจอ่อนแม้ยีลด์ขึ้น', 'If it is about confidence in the US, the dollar can fall even as yields rise'],
        liq: [-1, 1], credit: [1, 1], ndx: [-1, 2], btc: [0, 1], gold: [1, 2, 'คนหันหาสินทรัพย์ที่ไม่ใช่หนี้รัฐบาล', 'Buyers seek assets that are nobody\'s debt'], ust: [-1, 3] } }
  ];

  // actual move of each row over ~30 days: { d: -1/0/1, txt }
  function actuals(){
    const A = {};
    const put = (k, v, flat, fmt) => { if(num(v)) A[k] = { d: Math.abs(v) < flat ? 0 : v > 0 ? 1 : -1, txt: fmt(v) }; };
    const bp = (v) => sgn(v * 100, 0) + ' bp';
    put('us2y', chg30(S('us2y')), 0.05, bp);
    const c10 = chg30(S('us10y')); put('us10y', c10, 0.05, bp);
    const ry = it('ex', 'ry10'); put('real', ry && ry.change1m, 0.05, bp);
    put('usd', chg30(S('dollar'), true), 0.75, (v) => sgn(v) + '%');
    const nl = it('mm', 'netLiq'); put('liq', nl && nl.change1m, 40, (v) => sgn(v, 0) + (EN ? ' bn' : ' พันล้าน$'));
    const hy = it('mm', 'hy'); put('credit', hy && hy.change1m, 0.1, bp);
    put('ndx', chg30(S('nasdaq100'), true), 1.5, (v) => sgn(v) + '%');
    put('btc', D.btc && D.btc.pct, 4, (v) => sgn(v) + '%');
    put('gold', D.gold && D.gold.pct, 1.5, (v) => sgn(v) + '%');
    if(num(c10)) put('ust', -8 * c10, 0.4, (v) => '≈' + sgn(v) + '%');   // ~8-year duration
    return A;
  }
  function matchScore(sc, A){
    let tot = 0, got = 0, n = 0;
    Object.keys(sc.r).forEach((k) => {
      const [d, c] = sc.r[k]; const a = A[k]; if(!d || !a) return;
      tot += c; n++; if(a.d === d) got += c; else if(a.d === 0) got += c * 0.35;
    });
    return n >= 4 ? got / tot : null;
  }
  let scen = null;
  function drawScenarios(){
    const A = actuals();
    const scores = SCEN.map((s) => matchScore(s, A));
    let best = -1; scores.forEach((v, i) => { if(num(v) && (best < 0 || v > scores[best])) best = i; });
    if(!scen) scen = best >= 0 ? SCEN[best].id : SCEN[0].id;
    const bar = $('mmScen');
    if(bar){
      bar.innerHTML = SCEN.map((s, i) => `<button type="button" role="tab" data-id="${s.id}" class="${s.id === scen ? 'on' : ''}" aria-selected="${s.id === scen}">${esc(tr(s.th, s.en))}`
        + `<small>${num(scores[i]) ? esc(tr('เข้ากับ 30 วันล่าสุด ', 'fits last 30 days ')) + Math.round(scores[i] * 100) + '%' + (i === best ? ' ★' : '') : esc(tr('รอข้อมูล', 'waiting for data'))}</small>`
        + `<span class="bar"><i style="width:${num(scores[i]) ? Math.round(scores[i] * 100) : 0}%"></i></span></button>`).join('');
      if(bar.querySelectorAll) Array.prototype.forEach.call(bar.querySelectorAll('button'), (b) => b.addEventListener('click', () => { scen = b.getAttribute('data-id'); drawScenarios(); }));
    }
    const s = SCEN.find((x) => x.id === scen);
    const story = $('mmStory');
    const fedAct = s.id === 'hfl' ? ['เฟดคงดอกเบี้ยสูง', 'Fed holds rates high'] : s.id === 'dis' ? ['เฟดเริ่มลดดอกเบี้ย', 'Fed starts cutting'] : s.id === 'credit' ? ['เฟดลดเร็ว + ปล่อยกู้ฉุกเฉิน', 'Fed cuts fast + emergency lending'] : s.id === 'oil' ? ['เฟดลังเล: เงินเฟ้อขึ้น แต่เศรษฐกิจชะลอ', 'Fed torn: inflation up, growth down'] : ['เฟดไม่ได้ทำอะไร ตลาดขยับเอง', 'Fed does nothing; the market moves on its own'];
    if(story){
      story.className = 'mm-chain';
      story.innerHTML = `<div class="step"><div class="mm-k">① ${esc(tr('จุดเริ่มต้น', 'Trigger'))}</div>${esc(tr(s.trig[0], s.trig[1]))}</div><div class="to">➜</div>`
        + `<div class="step fed"><div class="mm-k">② ${esc(tr('เฟดตอบสนอง', 'Fed response'))}</div><b>${esc(tr(fedAct[0], fedAct[1]))}</b><div class="mm-sub" style="margin-top:4px">${esc(tr('ตอนนี้ ', 'Now '))}${esc(fedRangeText() || '—')}</div></div><div class="to">➜</div>`
        + `<div class="step"><div class="mm-k">📜 ${esc(tr('เคยเกิดจริง', 'When it happened'))}</div>${esc(tr(s.hist[0], s.hist[1]))}</div>`;
    }
    const row = (k) => {
      const meta = ROWS.find((r) => r[0] === k); const [d, c, nth, nen] = s.r[k]; const a = A[k];
      const icon = d > 0 ? '<span class="d hot">▲</span>' : d < 0 ? '<span class="d cool">▼</span>' : '<span class="d ext">↕</span>';
      const verdict = !a || !d ? '' : a.d === d ? '<span class="vd ok">✓</span>' : a.d === 0 ? '<span class="vd meh">–</span>' : '<span class="vd no">✗</span>';
      return `<div class="mm-row">${icon}<div><div class="n">${esc(tr(meta[1], meta[2]))}${chip(c)}</div>${nth ? `<div class="why">${esc(tr(nth, nen))}</div>` : ''}</div>`
        + `<div class="act">${esc(tr('30 วัน', '30 days'))}<b>${a ? esc(a.txt) + verdict : '—'}</b></div></div>`;
    };
    const flow = $('mmFlow');
    if(flow) flow.innerHTML = `<div class="mm-col"><h4>③ ${esc(tr('ช่องทาง: ดอกเบี้ย เงิน สินเชื่อ', 'Channels: rates, money, credit'))}</h4>${ROWS.filter((r) => r[3] === 1).map((r) => row(r[0])).join('')}</div>`
      + '<div class="mm-arrow">➜</div>'
      + `<div class="mm-col"><h4>④ ${esc(tr('สินทรัพย์', 'Assets'))}</h4>${ROWS.filter((r) => r[3] === 2).map((r) => row(r[0])).join('')}</div>`;
    const bs = $('mmBestScen'), bsub = $('mmBestSub');
    if(bs && best >= 0){
      bs.textContent = tr(SCEN[best].th, SCEN[best].en) + ' · ' + Math.round(scores[best] * 100) + '%';
      const second = scores.map((v, i) => [v, i]).filter((x) => num(x[0]) && x[1] !== best).sort((a, b) => b[0] - a[0])[0];
      if(bsub) bsub.textContent = tr('ดูจากทิศทางยีลด์ ดอลลาร์ สภาพคล่อง หุ้น BTC และทอง', 'Based on the direction of yields, the dollar, liquidity, stocks, BTC and gold') + (second ? tr(' · รองลงมา: ', ' · Runner-up: ') + tr(SCEN[second[1]].th, SCEN[second[1]].en) + ' ' + Math.round(second[0] * 100) + '%' : '');
    }
    return { scores, best };
  }


  // ── prediction-market odds ───────────────────────────────────────────────────────────────────
  const BUCKETS = [['cut50', 'ลด ≥50bp', 'Cut ≥50bp', '#2b8fd6', -50], ['cut25', 'ลด 25bp', 'Cut 25bp', '#4cc9f0', -25], ['hold', 'คงที่', 'Hold', '#8e9bb5', 0], ['hike25', 'ขึ้น 25bp', 'Hike 25bp', '#ff9f5a', 25], ['hike50', 'ขึ้น ≥50bp', 'Hike ≥50bp', '#ff6577', 50]];
  function oddsSummary(odds){
    if(!odds) return null;
    let top = null, exp = 0;
    BUCKETS.forEach((b) => { const v = odds[b[0]]; if(num(v)){ exp += v / 100 * b[4]; if(!top || v > odds[top[0]]) top = b; } });
    return top ? { top, p: odds[top[0]], exp } : null;
  }
  const dayOf = (iso) => { try{ return new Date(iso + 'T12:00:00Z').toLocaleDateString((window.GI_LOCALE || 'th-TH') + '-u-ca-gregory', { day: 'numeric', month: 'short', timeZone: 'UTC' }); }catch(e){ return iso; } };
  function drawOdds(){
    const box = $('mmOdds'); if(!box) return;
    const o = D.odds;
    if(!o || (!o.kalshi && !o.polymarket)){ box.innerHTML = `<div class="mm-tile mm-sub">${esc(D.oddsTried ? tr('ดึงข้อมูลตลาดคาดการณ์ไม่ได้ จะลองใหม่', 'Could not load prediction markets, retrying') : tr('กำลังโหลดโอกาส…', 'Loading odds…'))}</div>`; return; }
    box.innerHTML = [['kalshi', 'Kalshi', 'https://kalshi.com/markets/kxfeddecision'], ['polymarket', 'Polymarket', 'https://polymarket.com/']].map(([k, name, url]) => {
      const src = o[k]; if(!src || !src.meetings || !src.meetings.length) return `<div class="mm-tile"><div class="mm-k">${name}</div><div class="mm-sub">${esc(tr('ไม่มีข้อมูล', 'No data'))}</div></div>`;
      const m = src.meetings[0], sm = oddsSummary(m.odds);
      const link = k === 'polymarket' && m.slug ? 'https://polymarket.com/event/' + encodeURIComponent(m.slug) : url;
      const pctTxt = (v) => !num(v) ? '—' : v > 0 && v < 1 ? '<1%' : v.toFixed(0) + '%';
      return `<div class="mm-tile" style="--tile-accent:${sm ? sm.top[3] : '#d4b26a'}"><div class="mm-oddhead"><div class="mm-k">${name} · ${esc(tr('ประชุม ', 'FOMC '))}${esc(dayOf(m.date))}</div><a href="${link}" target="_blank" rel="noopener">${esc(tr('ดูตลาด ↗', 'Market ↗'))}</a></div>`
        + (sm ? `<div class="mm-big" style="margin-top:8px"><span style="color:${sm.top[3]}">${sm.p.toFixed(0)}%</span> <span style="font-size:17px;font-weight:700">${esc(tr(sm.top[1], sm.top[2]))}</span></div>` : '')
        + `<div class="mm-ladder">${BUCKETS.map((b) => { const v = m.odds[b[0]]; const isTop = sm && sm.top[0] === b[0];
            const hh = num(v) ? Math.max(3, v * 0.8) : 3;
            return `<div class="mm-lc${isTop ? ' mm-lt' : ''}"><span class="mm-lk"><span class="mm-lp" style="bottom:${hh + 4}px">${pctTxt(v)}</span><span class="mm-lb" style="height:${hh}px;${isTop ? `background:linear-gradient(180deg,${b[3]},${b[3]}88);box-shadow:0 0 18px ${b[3]}55` : num(v) && v >= 5 ? `background:${b[3]}66` : ''}"></span></span><span class="mm-ln">${esc(tr(b[1], b[2]))}</span></div>`; }).join('')}</div>`
        + (sm ? `<div class="mm-path">${esc(tr('ค่าคาดหมายถ่วงน้ำหนัก ', 'Probability-weighted move '))}<b style="color:var(--text)">${sgn(sm.exp, 0)} bp</b>${num(m.volume) && m.volume > 0 ? ' · ' + esc(tr('ปริมาณซื้อขาย ', 'volume ')) + '$' + (m.volume >= 1e6 ? (m.volume / 1e6).toFixed(1) + 'M' : Math.round(m.volume / 1e3) + 'K') : ''}`
          + src.meetings.slice(1).map((x) => { const q = oddsSummary(x.odds); return q ? `<br>${esc(dayOf(x.date))}: ${esc(tr(q.top[1], q.top[2]))} ${q.p.toFixed(0)}%` : ''; }).join('') + '</div>' : '')
        + '</div>';
    }).join('');
  }

  // half-circle dial: left = room to cut, right = pressure to stay high
  function dialSvg(t){
    const cx = 120, cy = 112, R = 92;
    const pt = (a, r) => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
    const arc = (a0, a1, r) => { const p = pt(a0, r), q = pt(a1, r); return `M${p[0].toFixed(1)},${p[1].toFixed(1)} A${r},${r} 0 0 1 ${q[0].toFixed(1)},${q[1].toFixed(1)}`; };
    const a = Math.PI / 2 - clamp(t) * Math.PI / 2 * 0.94;   // needle angle
    const tip = pt(a, R - 18), b1 = pt(a + Math.PI / 2, 6), b2 = pt(a - Math.PI / 2, 6);
    let h = `<svg viewBox="0 0 240 140" aria-hidden="true"><defs><linearGradient id="mmDialG" x1="0" x2="1"><stop offset="0" stop-color="#2b8fd6"/><stop offset=".3" stop-color="#4cc9f0"/><stop offset=".5" stop-color="#55627f"/><stop offset=".7" stop-color="#ff9f5a"/><stop offset="1" stop-color="#ff6577"/></linearGradient></defs>`;
    h += `<path d="${arc(Math.PI, 0, R)}" stroke="#1d2744" stroke-width="18" fill="none" stroke-linecap="round"/>`;
    h += `<path d="${arc(Math.PI, 0, R)}" stroke="url(#mmDialG)" stroke-width="12" fill="none" stroke-linecap="round" opacity=".95"/>`;
    for(let i = 0; i <= 10; i++){ const aa = Math.PI - i * Math.PI / 10, p = pt(aa, R - 14), q = pt(aa, R - (i % 5 ? 19 : 24)); h += `<line x1="${p[0].toFixed(1)}" y1="${p[1].toFixed(1)}" x2="${q[0].toFixed(1)}" y2="${q[1].toFixed(1)}" stroke="#55627f" stroke-width="${i % 5 ? 1 : 1.6}"/>`; }
    h += `<polygon points="${tip[0].toFixed(1)},${tip[1].toFixed(1)} ${b1[0].toFixed(1)},${b1[1].toFixed(1)} ${b2[0].toFixed(1)},${b2[1].toFixed(1)}" fill="#f3f6ff"/><circle cx="${cx}" cy="${cy}" r="9" fill="#f3f6ff"/><circle cx="${cx}" cy="${cy}" r="4" fill="#0b1020"/>`;
    h += `<text class="lbl" x="18" y="136">${esc(tr('ลด', 'Cut'))}</text><text class="lbl" x="${cx}" y="14" text-anchor="middle">${esc(tr('คง', 'Hold'))}</text><text class="lbl" x="222" y="136" text-anchor="end">${esc(tr('คง/ขึ้น', 'High'))}</text>`;
    return h + '</svg>';
  }

  function drawHero(){
    const fr = fedRangeText();
    if($('mmFedRange')) $('mmFedRange').textContent = fr || '—';
    const effr = it('fred', 'effr'), cp = it('fred', 'corePce');
    const bits = [];
    if(effr && num(effr.value)) bits.push('EFFR ' + effr.value.toFixed(2) + '%');
    if(effr && num(effr.value) && cp && num(cp.value)) bits.push(tr('ดอกเบี้ยแท้จริง (EFFR − Core PCE) ', 'Real policy rate (EFFR − core PCE) ') + sgn(effr.value - cp.value, 1) + '%');
    if($('mmFedSub')) $('mmFedSub').innerHTML = esc(bits.join(' · ')) + (effr && cp && num(effr.value) && num(cp.value) ? '<br>' + esc(effr.value - cp.value > 1 ? tr('สูงกว่าระดับกลางๆ (~0.5–1%) = ยังเข้มงวด', 'Above the ~0.5–1% neutral zone, so still restrictive') : effr.value - cp.value < 0.3 ? tr('ใกล้หรือต่ำกว่าระดับกลางๆ = ไม่ได้เข้มงวดแล้ว', 'At or below neutral, so no longer restrictive') : tr('อยู่ในโซนกลางๆ (~0.5–1%)', 'Inside the ~0.5–1% neutral zone')) : '');
    if(tiltInfo){
      if($('mmTiltLabel')){ $('mmTiltLabel').textContent = tiltLabel(tiltInfo.tilt); $('mmTiltLabel').className = 'mm-big ' + tone(tiltInfo.tilt); }
      if($('mmDial')) $('mmDial').innerHTML = dialSvg(tiltInfo.tilt);
      if($('mmDrivers')) $('mmDrivers').innerHTML = tiltInfo.parts.slice(0, 3).map((q) => {
        const r = reads[q.id];
        return `<li><b class="${tone(q.score)}">${q.score > 0.25 ? '▲' : q.score < -0.25 ? '▼' : '•'} ${esc(nodeName(q.id))} ${esc(r.v)}</b> · ${esc(tr(r.th, r.en))}</li>`;
      }).join('');
    }
  }

  function renderAll(){
    reads = {};
    Object.keys(READ).forEach((k) => { try{ const r = READ[k](); if(r) reads[k] = r; }catch(e){ console.warn('[macro-map]', k, e); } });
    tiltInfo = computeTilt(reads);
    drawHero(); drawOdds(); drawMap(); drawPanel(); drawScenarios();
  }

  function drawStatic(){
    const notes = [
      ['คะแนน "เฟดเอียงไปทางไหน" เป็นการถ่วงน้ำหนักแบบง่ายของเรา (เงินเฟ้อและแรงงานหนักสุด) ไม่ใช่โมเดลของเฟด และไม่ใช่คำทำนายการประชุมครั้งหน้า', 'The tilt score is our own simple weighting (inflation and jobs count most). It is not the Fed\'s model and not a forecast of the next meeting.'],
      ['ข้อมูลเศรษฐกิจออกช้า: Core PCE และการใช้จ่ายช้า ~1 เดือน ผลิตภาพและหนี้รัฐบาลเป็นรายไตรมาส ขณะที่ยีลด์ ดอลลาร์ BTC และทองเป็นรายวันหรือสด', 'Economic data lag: core PCE and spending run ~1 month behind, productivity and federal debt are quarterly, while yields, the dollar, BTC and gold are daily or live.'],
      ['ความสัมพันธ์ "ไม่แน่นอน" (ป้ายแดง) คือที่ประวัติศาสตร์ให้ผลสวนทางกันบ่อย เช่น ทองขึ้นพร้อมดอกเบี้ยแท้จริงสูงในปี 2023–25 หรือ BTC ที่ร่วงในวิกฤตปี 2020 แต่ขึ้นในวิกฤตธนาคารปี 2023', '"Unreliable" links (red tag) are ones history has broken often, e.g. gold rising with high real yields in 2023–25, or BTC crashing in the 2020 panic but rallying in the 2023 bank scare.'],
      ['% ความเข้ากันของฉากทัศน์ดูแค่ทิศทาง 30 วันล่าสุด หลายฉากทัศน์อาจเกิดพร้อมกัน และตลาดมักเคลื่อนไหวก่อนข้อมูลจริง', 'The scenario fit only checks the direction of the last 30 days. Several scenarios can overlap, and markets usually move before the data do.'],
      ['พันธบัตรระยะยาว (ราคา) ประมาณจากยีลด์ 10 ปี × duration ~8 ปี ส่วน "สภาพคล่องสุทธิ" = งบดุลเฟด − บัญชีกระทรวงการคลัง (TGA) − Reverse Repo เป็นตัวชี้วัดที่นักวิเคราะห์นิยมใช้ ไม่ใช่ตัวเลขทางการ', 'Long Treasuries (price) are estimated from the 10-year yield × ~8-year duration. "Net liquidity" = Fed balance sheet − Treasury General Account − reverse repo, a popular analyst gauge, not an official figure.'],
      ['โอกาสจาก Kalshi และ Polymarket คือราคาที่คนใช้เงินจริงซื้อขาย (ราคา 0.90 ดอลลาร์ ≈ โอกาส 90%) สะท้อนความเห็นของตลาด ไม่ใช่คำทำนายที่แม่นเสมอ เราแสดงเพื่อข้อมูลเท่านั้น ไม่ได้ชวนให้เข้าไปเดิมพัน', 'Kalshi and Polymarket odds are real-money prices ($0.90 ≈ 90% chance). They show market opinion, not a guaranteed forecast, and are shown for information only, not as an invitation to bet.'],
      ['ไม่ใช่คำแนะนำการลงทุน', 'Not investment advice.']
    ];
    if($('mmNotes')) $('mmNotes').innerHTML = notes.map((n) => `<li>${esc(tr(n[0], n[1]))}</li>`).join('');
    if($('mmSrc')) $('mmSrc').textContent = tr(
      'FRED (ธนาคารกลางสหรัฐฯ สาขาเซนต์หลุยส์): ดอกเบี้ยเฟด, Core PCE, อัตราว่างงาน, การบริโภคจริง (PCEC96), ผลิตภาพ (OPHNFB), เงินเฟ้อคาดการณ์ 5y5y (T5YIFR), ยีลด์ 2/10 ปี, ยีลด์แท้จริง (DFII10), ส่วนต่างหุ้นกู้ high-yield (ICE BofA), งบดุลเฟด/TGA/Reverse Repo, หนี้รัฐบาล, WTI, Nasdaq-100 · Cboe: OVX, ยีลด์/ดัชนีระหว่างวัน · ECB (ผ่าน Frankfurter): สูตร DXY · Kalshi (KXFEDDECISION) และ Polymarket: โอกาสผลประชุมเฟด · Binance: BTC และ PAXG (ตัวแทนราคาทอง) อัปเดตทุก 1 นาที ข้อมูลอื่นทุก 10 นาที',
      'FRED (St. Louis Fed): fed funds, core PCE, unemployment, real spending (PCEC96), productivity (OPHNFB), 5y5y inflation expectations (T5YIFR), 2/10-year yields, real yield (DFII10), high-yield spread (ICE BofA), Fed balance sheet / TGA / reverse repo, federal debt, WTI, Nasdaq-100 · Cboe: OVX, intraday yields and indices · ECB (via Frankfurter): DXY formula · Kalshi (KXFEDDECISION) and Polymarket: FOMC odds · Binance: BTC and PAXG (gold proxy), refreshed every minute; everything else every 10 minutes.');
  }

  // ── fetching (only once the tab is opened) ─────────────────────────────────────────────────
  async function getJson(url, ms){
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const t = setTimeout(() => ctrl && ctrl.abort(), ms || 12000);
    try{ const r = await fetch(url, ctrl ? { signal: ctrl.signal } : {}); if(!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally{ clearTimeout(t); }
  }
  let lastSlow = 0, timer = null, started = false;
  async function refresh(force){
    const now = Date.now(); const jobs = [];
    if(force || now - lastSlow > 10 * 60 * 1000){
      lastSlow = now;
      jobs.push(getJson('/.netlify/functions/fred-data').then((j) => { D.fred = j; }).catch(() => {}));
      jobs.push(getJson('/.netlify/functions/markets').then((j) => { D.mk = j; }).catch(() => {}));
      jobs.push(getJson('/.netlify/functions/econ-extra').then((j) => { D.ex = j; }).catch(() => {}));
      jobs.push(getJson('/.netlify/functions/macro-map').then((j) => { D.mm = j; }).catch(() => {}));
    }
    jobs.push(getJson('/.netlify/functions/fed-odds', 10000).then((j) => { D.odds = j; }).catch(() => {}).then(() => { D.oddsTried = true; }));
    const k = (sym) => getJson('https://api.binance.com/api/v3/klines?symbol=' + sym + '&interval=1d&limit=31', 8000).then(klinePct);
    jobs.push(k('BTCUSDT').then((v) => { if(v) D.btc = v; }).catch(() => {}));
    jobs.push(k('PAXGUSDT').then((v) => { if(v) D.gold = v; }).catch(() => {}));
    await Promise.all(jobs);
    renderAll();
    const live = $('mmLive');
    if(live){
      const ok = D.fred || D.mk || D.mm;
      live.className = 'mm-live' + (ok ? '' : ' off');
      live.textContent = ok ? tr('อัปเดต ', 'Updated ') + new Date().toLocaleTimeString(window.GI_LOCALE || 'th-TH', { hour: '2-digit', minute: '2-digit' }) : tr('โหลดข้อมูลไม่ได้ จะลองใหม่', 'Could not load data, retrying');
    }
  }
  window.macroMapActivate = function(){
    if(!started){ started = true; renderAll(); refresh(true); }
    if(!timer) timer = setInterval(() => { if(!document.hidden && document.getElementById('macroTab') && /\bactive\b/.test(document.getElementById('macroTab').className || '')) refresh(false); }, 60 * 1000);
  };

  drawStatic();
  renderAll();
  window.MM = { NODES, EDGES, SCEN, ROWS, READ, D, chg30, riseFromLow, oddsSummary, klinePct, computeTilt, matchScore, actuals, renderAll, tiltLabel };
})();
