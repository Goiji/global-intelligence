(function(){
  const el = id => document.getElementById(id);
  // ภาษา UI (ดูสคริปต์ใน <head>) — EN = โหมดอังกฤษ: ไม่แปลพาดหัวเป็นไทย แสดงต้นฉบับภาษาอังกฤษแทน
  const tr = window.tr || ((th) => th);
  const EN = window.GI_LANG === 'en';
  const LOCALE = window.GI_LOCALE || 'th-TH';

  // ---------- storage: window.storage (Claude artifact) with localStorage fallback ----------
  // window.storage only exists inside Claude's own artifact runtime, and even there it can be
  // unavailable in some preview contexts. Every save/load below goes through this so nothing
  // silently fails to persist (this was the root cause of the RSS/FRED key not sticking).
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

  const RSS_FEEDS = [
    { key:'geopolitical', label:tr('ภูมิรัฐศาสตร์', 'Geopolitics'), q:'geopolitics OR conflict OR war' },
    { key:'economic',     label:tr('เศรษฐกิจ', 'Economy'),     q:'federal reserve OR inflation OR interest rates' },
    { key:'energy',       label:tr('พลังงาน', 'Energy'),       q:'oil price OR energy crisis OR OPEC' },
    { key:'financial',    label:tr('การเงิน', 'Finance'),    q:'stock market OR wall street OR bonds' },
    { key:'techAi',       label:tr('เทคโนโลยี / AI', 'Tech / AI'),    q:'artificial intelligence OR tech industry' },
    // ข่าวภาษาไทย — แสดงในรายการข่าวล่าสุดเท่านั้น ไม่นำไปคิดคะแนนความเสี่ยง (คำสำคัญเป็นภาษาอังกฤษ) และไม่ต้องแปล
    { key:'thai',         label:tr('ข่าวไทย', 'Thai news'),         q:'เศรษฐกิจไทย OR ค่าเงินบาท OR ตลาดหุ้นไทย OR ราคาทอง OR แบงก์ชาติ', lang:'th', listOnly:true }
  ];

  // ป้ายหมวดตามภาษาปัจจุบัน — แคชข่าวเก่าเก็บป้ายเป็นภาษาที่ใช้ตอนบันทึก จึงต้องแปลงจาก key (หรือจากป้ายเดิมทั้งสองภาษา) ตอนแสดง
  const FEED_LABEL_PAIRS = { geopolitical:['ภูมิรัฐศาสตร์','Geopolitics'], economic:['เศรษฐกิจ','Economy'], energy:['พลังงาน','Energy'],
    financial:['การเงิน','Finance'], techAi:['เทคโนโลยี / AI','Tech / AI'], thai:['ข่าวไทย','Thai news'] };
  function feedLabel(key, stored){
    let pair = FEED_LABEL_PAIRS[key];
    if(!pair && stored){
      const s = String(stored).toLowerCase();
      pair = Object.values(FEED_LABEL_PAIRS).find(p => p[0].toLowerCase() === s || p[1].toLowerCase() === s) || null;
    }
    return pair ? tr(pair[0], pair[1]) : (stored || key || '');
  }

  async function fetchFeed(feed){
    // Goes through our own Netlify Function, which now reads Google News RSS server-side and
    // parses it there. rss2json is only a fallback inside that function, so there is no key to
    // configure here any more and no anonymous quota to run into.
    // cat = the feed's key, so the server can fall back to that topic's publisher RSS feeds when
    // Google News refuses its datacenter (Cloudflare gets HTTP 503 there).
    const url = '/.netlify/functions/news-feed?q=' + encodeURIComponent(feed.q) + (feed.lang ? '&lang=' + feed.lang : '') + '&cat=' + encodeURIComponent(feed.key);
    try{
      const r = await fetchWithTimeout(url, 10000);
      const j = await r.json();
      if(j.status !== 'ok') return { ...feed, titles: [], items: [] };
      // เก็บไว้ 10 ข่าวต่อหมวดสำหรับรายการ "ข่าวล่าสุด" — แต่คะแนนความเสี่ยงยังคิดจาก 5 ข่าวแรก
      // เหมือนเดิม (ไม่ให้คะแนนเปลี่ยนพฤติกรรมเพราะจำนวนข่าวที่โชว์)
      const items = (j.items || []).slice(0, 10).map(it => ({
        title: it.title,
        description: (it.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 220),
        link: it.link || '',
        source: it.source || '',
        pubDate: it.pubDate || '',
        onTopic: it.onTopic
      }));
      const titles = items.slice(0, 5).map(it => it.title);
      return { ...feed, titles, items };
    }catch(e){
      return { ...feed, titles: [], items: [] };
    }
  }

  // ---------- free translation (MyMemory API, no key needed) ----------
  // ปรับปรุง Sep 2026: แก้บั๊ก MyMemory หมดโควต้าแล้วส่ง "MYMEMORY WARNING: YOU USED ALL..."
  // กลับมาในฟิลด์ translatedText ทำให้ Top Events โชว์ข้อความเตือนแทนพาดหัวข่าว
  // วิธีแก้: ตรวจจับ warning, เพิ่ม email เพื่อขยายโควต้า (anonymous 1k → 50k words/day),
  // แคชคำแปลซ้ำ, และถ้าโดน limit ให้พักการเรียก API 4 ชม. แล้วโชว์ภาษาอังกฤษแทน
  //
  // ⚠️ TRANSLATE_EMAIL: MyMemory ให้โควต้าต่ออีเมล (ไม่ใส่ = โควต้าไม่ระบุตัวตน/day ไม่กี่พันคำ)
  // ค่านี้ "มองเห็นได้จากซอร์สของหน้าเว็บ" (และถูกส่งไปที่ mymemory.translated.net) — ถ้าไม่อยากให้
  // อีเมลตัวเองโผล่ต่อสาธารณะ ให้เปลี่ยนเป็นอีเมลกลางหรือเว้นเป็น '' ที่เดียวตรงนี้ (โควต้าจะลดลง)
  const TRANSLATE_EMAIL = 'global.intelligence.cache@gmail.com';

  const _translationCache = new Map();
  const TRANSLATION_CACHE_KEY = 'news-translation-cache-v1';
  const TRANSLATION_CACHE_MAX = 400;   // กันไม่ให้ localStorage บวม
  let _translationBlockedUntil = 0;
  let _translationSaveTimer = null;

  // แคชคำแปลเดิมอยู่ในหน่วยความจำอย่างเดียว — ทุกครั้งที่รีเฟรชหน้าจึงแปลซ้ำใหม่หมด (กินโควต้า
  // MyMemory ทิ้งเปล่าๆ) ตอนนี้เก็บลง localStorage ด้วย อายุ 7 วัน แล้วโหลดกลับตอนเปิดหน้า
  function persistTranslationCache(){
    clearTimeout(_translationSaveTimer);
    _translationSaveTimer = setTimeout(function(){
      try{
        const entries = Array.from(_translationCache.entries()).slice(-TRANSLATION_CACHE_MAX);
        localStorage.setItem(TRANSLATION_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries: entries }));
      }catch(e){ /* โควต้าเต็ม — ข้ามไป ไม่กระทบการแสดงผล */ }
    }, 1200);
  }
  (function loadTranslationCache(){
    try{
      const raw = localStorage.getItem(TRANSLATION_CACHE_KEY);
      if(!raw) return;
      const c = JSON.parse(raw);
      if(!c || !Array.isArray(c.entries)) return;
      if(c.ts && (Date.now() - c.ts) > 7 * 24 * 60 * 60 * 1000) return; // เก่าเกิน 7 วัน = ทิ้ง
      c.entries.slice(-TRANSLATION_CACHE_MAX).forEach(function(pair){
        if(Array.isArray(pair) && pair.length === 2) _translationCache.set(pair[0], pair[1]);
      });
    }catch(e){ /* ไม่มีแคชเก่า */ }
  })();
  function cacheTranslation(key, value){
    _translationCache.set(key, value);
    persistTranslationCache();
  }

  async function translateToThai(text){
    if(!text) return '';
    if(EN) return text;   // โหมดอังกฤษ: ใช้พาดหัวต้นฉบับ ไม่ยิง MyMemory
    if(_translationCache.has(text)) return _translationCache.get(text);
    if(Date.now() < _translationBlockedUntil){
      _translationCache.set(text, text);
      return text;
    }
    try{
      const r = await fetchWithTimeout('https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|th' + (TRANSLATE_EMAIL ? '&email=' + encodeURIComponent(TRANSLATE_EMAIL) : ''), 6000);
      const j = await r.json();
      const t = j && j.responseData && j.responseData.translatedText;
      if(!t){
        _translationCache.set(text, text);
        return text;
      }
      const upper = t.toUpperCase();
      if(upper.includes('MYMEMORY WARNING') || upper.includes('YOU USED ALL AVAILABLE') || upper.includes('TRANSLATED.NET/DOC/USAGELIMITS') || upper.includes('MYMEMORY')){
        // โดน limit แล้ว — พักการแปล 4 ชม. ไม่ให้ยิงซ้ำจนโควต้ากู้คืน
        _translationBlockedUntil = Date.now() + 4 * 60 * 60 * 1000;
        _translationCache.set(text, text);
        return text;
      }
      if(j.responseDetails && /MYMEMORY|LIMIT/i.test(j.responseDetails)){
        _translationBlockedUntil = Date.now() + 4 * 60 * 60 * 1000;
        _translationCache.set(text, text);
        return text;
      }
      if(j.responseStatus && j.responseStatus === 429){
        _translationBlockedUntil = Date.now() + 4 * 60 * 60 * 1000;
        _translationCache.set(text, text);
        return text;
      }
      // ถ้าแปลคืนมาเป็นภาษาอังกฤษพิมพ์ใหญ่เหมือนเดิม แสดงว่าไม่ได้แปลจริง
      if(t.trim() === text.trim()){
        _translationCache.set(text, text);
        return text;
      }
      cacheTranslation(text, t);  // คำแปลที่สำเร็จถูกเก็บลง localStorage ด้วย → รีเฟรชหน้าแล้วไม่ต้องแปลซ้ำ
      return t;
    }catch(e){
      _translationCache.set(text, text);
      return text;
    }
  }

  // ---------- FREE local scoring engine (no paid API calls at all) ----------
  // Keyword rules run entirely in the browser on the RSS headlines already fetched — no key, no quota.
  // ปรับปรุง Nov 2026 (ยังฟรีทั้งหมด):
  //  1) จับ "วลี" ก่อนคำเดี่ยว — "missile strike" / "trade war" ได้น้ำหนักเต็ม ส่วน "war" เดี่ยว ๆ ลดเหลือ 1
  //     และคำที่อยู่ในวลีที่จับแล้วจะไม่ถูกนับซ้ำ
  //  2) ตัดข่าวกีฬา/บันเทิง/ประวัติศาสตร์ทิ้งทั้งพาดหัว (เช่น ข่าวฟุตบอลที่มีคำว่า "War of 1812") และลบวลีที่
  //     ไม่ใช่ความเสี่ยงจริงออกก่อนจับคำ (heart attack, strike a deal, plane crash, price war, by default …)
  //  3) ปฏิเสธ = ไม่นับ: "no recession", "averts shutdown", "ends war"
  //  4) ข่าวใหม่มีน้ำหนักมากกว่า (ครึ่งหนึ่งทุก 24 ชม.) · ข่าวเดียวกันจากหลายสำนักนับครั้งเดียว
  // ลงท้ายด้วย * = จับเป็นรากคำ (escalat* → escalate/escalation/escalating)
  const HIGH_RISK_TERMS = {
    // phrases (checked first, longest first)
    'military strike*':2, 'air strike*':2, 'airstrike*':2, 'drone strike*':2, 'missile strike*':2, 'missile attack*':2,
    'missile launch*':1.5, 'declares war':2, 'war with':1.5, 'trade war':1.5, 'nuclear test*':2, 'nuclear threat*':2,
    'nuclear weapon*':2, 'troops':1.5, 'shelling':1.5, 'bombing':1.5, 'terror attack*':2, 'terrorist attack*':2,
    'cyberattack':1, 'cyber attack*':1, 'martial law':2, 'state of emergency':1.5, 'bank run':2, 'debt default':2,
    'market crash':2, 'stocks crash*':2, 'stock market crash':2, 'rate hike':1, 'hike rates':1, 'inflation surge':1,
    kill:1, 'casualties':1.5,
    // ภาษาข่าวตลาดจริง (Nov 2026: วันที่ S&P ลง 3.7% หมวดการเงินได้แค่ 60 เพราะไม่รู้จักคำเหล่านี้)
    'inflation soar*':1.5, 'inflation jump*':1, 'inflation spike*':1, 'prices soar*':1, 'high inflation':1, 'elevated inflation':1,
    'inflation worr*':1, 'inflation fear*':1, 'raise interest rates':1, 'raising interest rates':1, 'raise rates':1, 'raising rates':1, 'shares fall*':1, 'shares fell':1,
    'stocks fall*':1, 'stocks fell':1, 'sharply lower':1, 'losing run':1, 'losing streak':1, 'in correction':1.5,
    'into a correction':1.5, 'correction territory':1.5,
    wipeout:1.5, 'wiped out':1.5, rout:1.5, turmoil:1, fear:1, 'worries':1, sink:1, skid:1, falter:1, 'worsen*':1,
    losses:1, 'selling off':1, 'unravel*':1, 'violat*':1, outage:1, 'penaliz*':0.5,
    // single words
    war:1, invasion:2, invade:2, missile:1.5, nuclear:1, coup:2, crash:1.5, collapse:1.5, default:1.5,
    recession:1.5, conflict:1, crisis:1, attack:1, strike:1, sanction:1, tension:1, shutdown:1, emergency:1,
    threat:1, bankruptcy:1, layoff:1, selloff:1, 'sell-off':1, plunge:1, tumble:1, slump:1,
    'escalat*':1, unrest:1, protest:1, tariff:1, downgrade:1, 'mobiliz*':1.5 };
  const LOW_RISK_TERMS = { ceasefire:1.5, 'cease-fire':1.5, truce:1.5, 'peace deal':1.5, 'peace talks':1, peace:1,
    agreement:1, 'deal reached':1, growth:1, rally:1, recovery:1, rebound:1, stability:1, 'stabiliz*':1, ease:1, easing:1,
    'rate cut':1, 'cut rates':1, surplus:1, stimulus:1, breakthrough:1, cooperation:1, 'record high':1, 'optimis*':1, upgrade:1,
    'inflation cool*':1, 'inflation eas*':1, 'soft landing':1 };
  // ข่าวที่ไม่เกี่ยวกับความเสี่ยงโลก — ไม่นำมาคิดคะแนนเลย (ข้ามไปใช้พาดหัวถัดไปแทน)
  const OFF_TOPIC_RE = new RegExp('\\b(?:' + [
    'nfl', 'nba', 'mlb', 'nhl', 'mls', 'ufc', 'wwe', 'f1', 'formula (?:one|1)', 'premier league', 'champions league', 'la liga',
    'serie a', 'bundesliga', 'world cup', 'super bowl', 'world series', 'grand slam', 'wimbledon', 'olympics?', 'football',
    'soccer', 'basketball', 'baseball', 'hockey', 'tennis', 'golf', 'cricket', 'rugby', 'boxing', 'quarterback',
    'touchdowns?', 'playoffs?', 'halftime', 'head coach', 'coach', 'pregame', 'postgame', 'kickoff', 'season opener', '(?:win|winning) streak', 'box office', 'movies?', 'films?', 'trailer', 'sitcom',
    'tv series', 'season finale', 'episode', 'netflix series', 'album', 'concert', 'grammys?', 'oscars?', 'emmys?',
    'celebrity', 'red carpet', 'video games?', 'recipe', 'horoscope', 'museum', 'anniversary', 'reenactment',
    'historians?', 'on this day', 'obituary', 'dies at \\d+',
    // ไลฟ์สไตล์ / บทความแนะนำ / ลิสต์ — ไม่ใช่ข่าวความเสี่ยง (เช่น "bargains in a crash", "AI-powered gadgets")
    'gadgets?', 'home office', 'house rules', 'wildlife', 'divorce', 'showrunner', 'how to', 'should you', 'what to (?:buy|watch|know)',
    'best (?:\\w+ )?(?:bargains?|buys?|deals?|stocks to buy)', 'bargains? in a', 'could (?:be|make) (?:among )?(?:the |your )?(?:best|smarter)',
    '(?:\\d+|three|four|five|six|seven|eight|nine|ten) (?:[\\w-]+ ){0,2}(?:ways|things|tips|gadgets|stocks|investments)'
  ].join('|') + ')\\b', 'i');
  // วลีที่มีคำเสี่ยงแต่ไม่ใช่ความเสี่ยงจริง — ลบออกก่อนจับคำ
  const NEUTRAL_PHRASES_RE = new RegExp('\\b(?:' + [
    'war of \\d{4}', 'world war (?:i|ii|one|two|1|2)', 'civil war (?:era|history|battlefield)', 'cold war era', 'star wars',
    'price wars?', 'bidding wars?', 'culture wars?', 'console wars?', 'streaming wars?', 'talent wars?', 'war chest', 'war room',
    'heart attacks?', 'panic attacks?', 'shark attacks?', 'asthma attacks?', 'dog attacks?', 'strikes? (?:a|an) (?:deal|balance|chord|tone|pose)',
    'strikes? deals?', 'strike(?:s|d)? out', 'lightning strikes?', 'strike gold', '(?:car|plane|bus|train|helicopter) crash(?:es)?',
    'by default', 'default (?:settings?|option|browser|apps?|search(?: engine)?)', 'nuclear (?:power|energy|reactors?|plants?|fusion)',
    'peace prize', 'department of war', 'secretary of war', 'war department', 'study of war', 'love and war', 'war on (?:drugs|poverty|cancer)', '(?:campaign|political|protest|trump|harris) rall(?:y|ies)', 'fashion week', 'growth mindset'
  ].join('|') + ')\\b', 'gi');
  const NEGATION_RE = /\b(?:no|not|avoids?|avoided|averts?|averted|without|ends?|ended|ending|lifts?|lifted|eases?|eased)\s+(?:\w+\s+)?$/i;
  // คำฝั่งบวกที่ถูกปฏิเสธ = ไม่นับ: "didn't ease fears", "fails to rally", "truce unravels", "ceasefire collapses"
  const LOW_NEGATION_BEFORE_RE = /\b(?:no|not|never|didn't|did not|doesn't|does not|don't|won't|fails? to|failed to|without)\s+(?:\w+\s+)?$/i;
  const LOW_NEGATION_AFTER_RE = /^\s*(?:\w+\s+)?(?:unravel|collapse|fail|falter|stall|break(?:s|ing)? down|broke down|violat|shatter|in doubt|at risk)/i;
  // คำแปลไทยของคำบ่งชี้ — ใช้แสดงผลอย่างเดียว (ระบบยังจับคำจากพาดหัวภาษาอังกฤษตามเดิม)
  const RISK_TERM_TH = { war:'สงคราม', invasion:'การรุกราน', invade:'รุกราน', missile:'ขีปนาวุธ', nuclear:'นิวเคลียร์', coup:'รัฐประหาร',
    crash:'ร่วงหนัก', collapse:'ล่มสลาย', default:'ผิดนัดชำระหนี้', recession:'เศรษฐกิจถดถอย', conflict:'ความขัดแย้ง',
    crisis:'วิกฤต', attack:'การโจมตี', strike:'โจมตี/นัดหยุดงาน', sanction:'คว่ำบาตร', tension:'ความตึงเครียด',
    shutdown:'ปิดทำการ', emergency:'ภาวะฉุกเฉิน', threat:'ภัยคุกคาม', bankruptcy:'ล้มละลาย', layoff:'ปลดพนักงาน',
    selloff:'เทขาย', 'sell-off':'เทขาย', 'selling off':'เทขาย', plunge:'ดิ่งลง', tumble:'ร่วงลง', slump:'ทรุดตัว', 'rate hike':'ขึ้นดอกเบี้ย',
    'hike rates':'ขึ้นดอกเบี้ย', escalat:'ยกระดับความรุนแรง', unrest:'ความไม่สงบ', protest:'การประท้วง', tariff:'ภาษีนำเข้า',
    downgrade:'ลดอันดับ', 'inflation surge':'เงินเฟ้อพุ่ง', mobiliz:'ระดมพล', 'military strike':'โจมตีทางทหาร',
    'air strike':'โจมตีทางอากาศ', airstrike:'โจมตีทางอากาศ', 'drone strike':'โจมตีด้วยโดรน', 'missile strike':'โจมตีด้วยขีปนาวุธ',
    'missile attack':'โจมตีด้วยขีปนาวุธ', 'missile launch':'ยิงขีปนาวุธ', 'declares war':'ประกาศสงคราม', 'war with':'ทำสงครามกับ',
    'trade war':'สงครามการค้า', 'nuclear test':'ทดสอบนิวเคลียร์', 'nuclear threat':'ขู่ใช้นิวเคลียร์', 'nuclear weapon':'อาวุธนิวเคลียร์',
    troops:'กำลังทหาร', shelling:'ยิงถล่ม', bombing:'ทิ้งระเบิด', 'terror attack':'ก่อการร้าย', 'terrorist attack':'ก่อการร้าย',
    cyberattack:'โจมตีไซเบอร์', 'cyber attack':'โจมตีไซเบอร์', 'martial law':'กฎอัยการศึก', 'state of emergency':'ภาวะฉุกเฉิน',
    'bank run':'แห่ถอนเงิน', 'debt default':'ผิดนัดชำระหนี้', 'market crash':'ตลาดร่วงหนัก', 'stocks crash':'หุ้นร่วงหนัก',
    'stock market crash':'ตลาดหุ้นร่วงหนัก', kill:'มีผู้เสียชีวิต', casualties:'ผู้บาดเจ็บล้มตาย',
    ceasefire:'หยุดยิง', 'cease-fire':'หยุดยิง', truce:'สงบศึก', 'peace deal':'ข้อตกลงสันติภาพ', 'peace talks':'เจรจาสันติภาพ',
    peace:'สันติภาพ', agreement:'ข้อตกลง', 'deal reached':'บรรลุข้อตกลง', growth:'การเติบโต', rally:'ปรับขึ้นแรง',
    recovery:'ฟื้นตัว', rebound:'ดีดกลับ', stability:'เสถียรภาพ', stabiliz:'มีเสถียรภาพ', ease:'ผ่อนคลาย', easing:'ผ่อนคลาย',
    'rate cut':'ลดดอกเบี้ย', 'cut rates':'ลดดอกเบี้ย', surplus:'เกินดุล', stimulus:'มาตรการกระตุ้น', breakthrough:'ความคืบหน้าสำคัญ',
    cooperation:'ความร่วมมือ', 'record high':'สูงสุดเป็นประวัติการณ์', optimis:'มองบวก', upgrade:'เพิ่มอันดับ',
    'inflation soar':'เงินเฟ้อพุ่ง', 'inflation jump':'เงินเฟ้อพุ่ง', 'inflation spike':'เงินเฟ้อพุ่ง', 'prices soar':'ราคาพุ่ง',
    'high inflation':'เงินเฟ้อสูง', 'elevated inflation':'เงินเฟ้อสูง', 'inflation worr':'กังวลเงินเฟ้อ', 'inflation fear':'กังวลเงินเฟ้อ',
    'raise interest rates':'ขึ้นดอกเบี้ย', 'raising interest rates':'ขึ้นดอกเบี้ย', 'raise rates':'ขึ้นดอกเบี้ย', 'raising rates':'ขึ้นดอกเบี้ย', 'shares fall':'หุ้นร่วง', 'shares fell':'หุ้นร่วง',
    'stocks fall':'หุ้นร่วง', 'stocks fell':'หุ้นร่วง', 'sharply lower':'ปิดลบหนัก', 'losing run':'ลงติดต่อกัน', 'losing streak':'ลงติดต่อกัน',
    'in correction':'เข้าเขตปรับฐาน', 'into a correction':'เข้าเขตปรับฐาน', 'correction territory':'เข้าเขตปรับฐาน',
    wipeout:'มูลค่าหายวับ', 'wiped out':'มูลค่าหายวับ', rout:'เทขายหนัก', turmoil:'ปั่นป่วน', fear:'ความกังวล', worries:'ความกังวล',
    sink:'ดิ่งลง', skid:'ไถลลง', falter:'อ่อนแรง', worsen:'แย่ลง', losses:'ขาดทุน/ร่วงลง', unravel:'พังลง', violat:'ละเมิด',
    outage:'ระบบล่ม', penaliz:'ลงโทษ', 'inflation cool':'เงินเฟ้อชะลอ', 'inflation eas':'เงินเฟ้อชะลอ', 'soft landing':'ลงจอดนุ่มนวล' };
  function termRegex(term){
    const stem = term.endsWith('*');
    const body = (stem ? term.slice(0, -1) : term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + body + (stem ? '\\w*' : '(?:s|es|ed|d|ing)?\\b'), 'i');
  }
  // วลียาวก่อน → ถ้าวลีจับได้ คำย่อยข้างในจะไม่ถูกนับซ้ำ ("missile strike" ไม่นับ missile + strike เพิ่มอีก)
  const RISK_RULES = []
    .concat(Object.entries(HIGH_RISK_TERMS).map(([t, w]) => ({ term: t.replace('*', ''), re: termRegex(t), w })))
    .concat(Object.entries(LOW_RISK_TERMS).map(([t, w]) => ({ term: t.replace('*', ''), re: termRegex(t), w: -w })))
    .sort((a, b) => b.term.length - a.term.length);
  function isOffTopic(title){ return OFF_TOPIC_RE.test(title || ''); }
  // ตัดชื่อสำนักท้ายพาดหัว (" - Institute for the Study of War", " - The Hollywood Reporter") ไม่ให้ถูกนับเป็นคำเสี่ยง
  function stripSource(title, source){
    let t = String(title || '');
    if(source){
      const tail = ' - ' + source;
      if(t.endsWith(tail)) return t.slice(0, -tail.length);
    }
    return t;
  }
  // echo = คำค้นของหมวดนั้นเอง (เช่น "war" ในหมวดภูมิรัฐศาสตร์ที่ค้นด้วยคำว่า war) — ทุกพาดหัวมีคำนี้เพราะเราค้นหามันเอง
  // ถ้านับเต็มจะดันคะแนนหมวดขึ้นเสมอโดยไม่เกี่ยวกับว่าโลกตึงเครียดแค่ไหน จึงนับครึ่งเดียว
  function scoreHeadline(title, echo){
    if(isOffTopic(title)) return { net: 0, hits: [], offTopic: true };
    let text = ' ' + String(title || '').replace(/[\u2018\u2019]/g, "'").replace(NEUTRAL_PHRASES_RE, ' ~ ') + ' ';
    const orig = text;
    const hits = [];
    RISK_RULES.forEach(r => {
      const m = r.re.exec(text);
      if(!m) return;
      const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
      text = before + ' ~ ' + after;   // ไม่ให้คำย่อยถูกนับซ้ำ
      if(r.w > 0 && NEGATION_RE.test(before)) return;                                 // "no recession", "averts shutdown"
      if(r.w < 0){
        const om = r.re.exec(orig);   // ดูคำถัดไปจากพาดหัวเดิม — คำอย่าง "unravels" อาจถูกจับไปก่อนแล้ว
        if(LOW_NEGATION_BEFORE_RE.test(before) || LOW_NEGATION_AFTER_RE.test(om ? orig.slice(om.index + om[0].length) : after)) return;
      }
      const w = echo && echo.has(r.term) ? r.w / 2 : r.w;
      hits.push({ term: r.term, w });
    });
    const net = Math.max(-3, Math.min(3, hits.reduce((a, h) => a + h.w, 0)));
    return { net, hits };
  }
  // ข่าวเดียวกันจากหลายสำนัก: คำสำคัญซ้อนกันเกินครึ่ง = เรื่องเดียวกัน
  const DEDUPE_STOP = new Set(['the','and','for','with','from','that','this','after','over','into','amid','says','said','will','than','what','your','about','their','report','reports','live','updates','news']);
  function headlineTokens(title){
    return new Set(String(title || '').toLowerCase().replace(/\s[-–—|]\s[^-–—|]{2,40}$/, '')
      .replace(/[^a-z0-9ก-๙]+/g, ' ').split(' ').filter(w => w.length > 2 && !DEDUPE_STOP.has(w)));
  }
  function sameStory(a, b){
    if(!a.size || !b.size) return false;
    let inter = 0; a.forEach(w => { if(b.has(w)) inter++; });
    return inter / Math.min(a.size, b.size) >= 0.6;
  }
  const SCORE_HEADLINES = 5;
  const RECENCY_HALF_LIFE_H = 24;
  // รับได้ทั้ง array ของพาดหัว (string) หรือ array ของ item {title, pubDate} จาก news-feed
  // คะแนนหมวด = 50 ± ตามค่าเฉลี่ยถ่วงน้ำหนักความใหม่ (ใช้ tanh ให้กระจายตัวแต่ไม่ชน 0/100 ง่าย)
  const STALE_DAYS = 7;          // ข่าวเก่ากว่านี้ไม่นับ (Google News บางทีส่งข่าวเดือนก่อนมาปน)
  const SCORE_PRIOR = 0.5;       // เหมือนมีพาดหัวกลาง ๆ อีกครึ่งข่าว — ข่าวเดียวจะดันหมวดไป 90+ ไม่ได้
  function echoTerms(q){
    // ทุกคำในคำค้น ("energy crisis" → crisis ด้วย) — มีผลเฉพาะคำที่เป็นคำบ่งชี้ความเสี่ยงอยู่แล้ว
    return new Set(String(q || '').toLowerCase().split(/\s+or\s+|\s+/).map(t => t.trim()).filter(t => /^[a-z-]+$/.test(t) && t !== 'or'));
  }
  function scoreCategoryDetail(input, now, q){
    now = now || Date.now();
    const echo = echoTerms(q);
    let list = (input || []).map((x, i) => (typeof x === 'string' ? { title: x, pubDate: '', i }
        : { title: x && stripSource(x.title, x.source), pubDate: x && x.pubDate, onTopic: x && x.onTopic, i }))
      .filter(x => x.title && x.onTopic !== false && !isOffTopic(x.title));
    const fresh = list.filter(x => { const ts = Date.parse(x.pubDate); return !isFinite(ts) || now - ts <= STALE_DAYS * 86400000; });
    if(fresh.length) list = fresh;
    // เลือก 5 เรื่อง "ล่าสุด" ไม่ใช่ 5 อันแรกตามลำดับของ Google (ซึ่งเรียงตามความเกี่ยวข้อง — ข่าวขีปนาวุธตกในโปแลนด์
    // เมื่อ 3 ชม.ก่อนเคยอยู่อันดับ 9 เลยไม่ถูกนับ) ข่าวที่ไม่มีวันที่คงลำดับเดิม
    list = list.slice().sort((a, b) => ((Date.parse(b.pubDate) || 0) - (Date.parse(a.pubDate) || 0)) || (a.i - b.i));
    const kept = [];
    for(const it of list){
      const tok = headlineTokens(it.title);
      if(kept.some(k => sameStory(k.tok, tok))) continue;
      kept.push({ ...it, tok });
      if(kept.length >= SCORE_HEADLINES) break;
    }
    const rows = kept.map((it, pos) => {
      const ts = Date.parse(it.pubDate);
      const ageH = isFinite(ts) ? Math.max(0, (now - ts) / 3600000) : null;
      const weight = ageH != null ? Math.max(0.25, Math.pow(0.5, ageH / RECENCY_HALF_LIFE_H)) : 1 / (1 + 0.15 * pos);
      return { title: it.title, weight, ...scoreHeadline(it.title, echo) };
    });
    const wsum = rows.reduce((a, r) => a + r.weight, 0);
    const mean = wsum ? rows.reduce((a, r) => a + r.net * r.weight, 0) / (wsum + SCORE_PRIOR) : 0;
    const score = Math.max(0, Math.min(100, Math.round(50 + 50 * Math.tanh(mean * 0.8))));
    const drivers = rows.filter(r => r.hits.length).sort((a, b) => Math.abs(b.net * b.weight) - Math.abs(a.net * a.weight)).slice(0, 3)
      .map(r => ({ title: r.title, net: r.net, hits: r.hits }));
    return { score, drivers, used: rows.length };
  }
  function scoreCategory(titles){ return scoreCategoryDetail(titles).score; }

  function computeAnalysis(allFeeds){
    // หมวดที่ listOnly (ข่าวไทย) ไม่นับคะแนน — เอาไว้แสดงในรายการข่าวอย่างเดียว
    const feedResults = allFeeds.filter(f => !f.listOnly);
    const categories = {}, drivers = {};
    feedResults.forEach(f => { const r = scoreCategoryDetail(f.items && f.items.length ? f.items : f.titles, null, f.q); categories[f.key] = r.score; drivers[f.key] = r.drivers; });

    const vals = Object.values(categories);
    const worldRiskScore = Math.round(vals.reduce((a,b)=>a+b,0) / vals.length);

    let badge;
    if(worldRiskScore >= 75) badge = 'CRISIS';
    else if(worldRiskScore >= 60) badge = 'DEFENSIVE';
    else if(worldRiskScore >= 40) badge = 'NEUTRAL';
    else badge = 'RISK-ON';

    const totalHeadlines = feedResults.reduce((a,f)=>a+f.titles.length,0);
    const confidence = Math.min(100, totalHeadlines * 4);

    // Simple heuristic asset outlook derived from category scores (NOT live prices).
    const geo = categories.geopolitical, econ = categories.economic, energy = categories.energy;
    const assets = {
      gold:    Math.max(0, Math.min(100, Math.round(50 + (worldRiskScore-50)*0.6))),
      oil:     energy,
      usd:     Math.max(0, Math.min(100, Math.round(50 + (econ-50)*0.5))),
      bitcoin: Math.max(0, Math.min(100, Math.round(70 - (worldRiskScore-50)*0.5))),
      stocks:  Math.max(0, Math.min(100, Math.round(100 - worldRiskScore)))
    };

    // Top events: highest-scoring categories' first real headline (deterministic, no AI paraphrase).
    const sorted = [...feedResults].sort((a,b)=>categories[b.key]-categories[a.key]);
    const usedStories = new Set();
    const topEvents = sorted.filter(f=>f.titles.length>0).map(f => {
      const pick = (f.items || []).find(it => !usedStories.has(storyKey(it.title))) || null;
      if(pick) usedStories.add(storyKey(pick.title));
      return pick ? { f, pick } : null;
    }).filter(Boolean).slice(0,3).map(({ f, pick }, i)=>({
      rank: i+1, catKey: f.key, category: f.label.toUpperCase(), title: cleanHeadline(pick.title, pick.source),
      rawDescription: pick.description || '',
      description: 'พาดหัวข่าวล่าสุดจากหมวด ' + f.label + ' (คะแนนความเสี่ยงหมวดนี้ ' + categories[f.key] + '/100)',
      marketImpact: categories[f.key]
    }));


    return { worldRiskScore, badge, confidence, categories, drivers, assets, topEvents, headlines: totalHeadlines, news: buildNewsList(allFeeds) };
  }

  // "สรุปเช้านี้" — 3 บรรทัดที่หน้าเว็บไม่ได้สรุปไว้ที่อื่น (เดิมแค่เอาคะแนนรวม/รายหมวด/แถบสินทรัพย์มาเขียนซ้ำ):
  //   1) อะไรเปลี่ยนจากเมื่อวาน (คะแนนรวม + หมวดที่ขยับมากสุด จาก news-score-history)
  //   2) ตัวเลขเศรษฐกิจที่จะประกาศวันนี้/พรุ่งนี้ (จากปฏิทิน เวลาไทย)
  //   3) ราคาที่ขยับแรงสุด (จากการ์ดราคาตลาด)
  // แต่ละแหล่งโหลดไม่พร้อมกัน จึงเก็บไว้ใน BRIEF แล้ววาดใหม่ทุกครั้งที่มีข้อมูลเข้ามา
  const BRIEF = { score: null, cats: null, prev: null, events: null, prices: {} };
  const BRIEF_PRICE_LABELS = { lpGold: tr('ทองคำ', 'Gold'), lpOil: tr('น้ำมัน WTI', 'WTI oil'), lpUsdThb: 'USD/THB',
    lpUsdJpy: 'USD/JPY', lpJpyThb: 'JPY/THB', lpCnyThb: 'CNY/THB' };
  const BRIEF_CAT_LABELS = { geopolitical: tr('ภูมิรัฐศาสตร์', 'geopolitics'), economic: tr('เศรษฐกิจ', 'economy'),
    energy: tr('พลังงาน', 'energy'), financial: tr('การเงิน', 'finance'), techAi: tr('เทคโนโลยี/AI', 'tech/AI') };
  const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n);

  function briefChangeLine(b){
    if(!isFinite(b.score)) return null;
    const head = tr('ความเสี่ยงโลก ', 'World risk ') + b.score + '/100';
    if(!b.prev || !isFinite(b.prev.score)) return head + tr(' · ยังไม่มีคะแนนของเมื่อวานให้เทียบ', ' · no score from yesterday to compare yet');
    const diff = b.score - b.prev.score;
    let text = head + (diff === 0 ? tr(' เท่ากับเมื่อวาน', ', unchanged from yesterday')
      : diff > 0 ? tr(' เพิ่มขึ้น ' + diff + ' จุดจากเมื่อวาน', ', up ' + diff + ' from yesterday')
      : tr(' ลดลง ' + (-diff) + ' จุดจากเมื่อวาน', ', down ' + (-diff) + ' from yesterday'));
    const moves = Object.keys(b.cats || {}).filter(k => isFinite(b.cats[k]) && b.prev.cats && isFinite(b.prev.cats[k]))
      .map(k => [k, b.cats[k] - b.prev.cats[k]]).filter(([, d]) => d !== 0).sort((a, c) => Math.abs(c[1]) - Math.abs(a[1]));
    if(moves.length){
      const [k, d] = moves[0];
      text += tr(' · หมวดที่ขยับมากสุดคือ', '. Biggest mover: ') + (BRIEF_CAT_LABELS[k] || k) + ' ' + signed(d) + ' (' + b.cats[k] + '/100)';
    }
    return text;
  }

  const briefEventLabel = (e) => (CAL_LABELS[e.key] || [e.title || e.key])[0];
  function briefUpcoming(events, nowMs){
    return (Array.isArray(events) ? events : []).filter(e => e && Date.parse(e.at || e.date) > nowMs - 2 * 3600e3)
      .sort((a, c) => String(a.at || a.date).localeCompare(String(c.at || c.date)));
  }
  // ตัวเลขที่ประกาศวันนี้/พรุ่งนี้ (เวลาไทย) → [{ e, today, text }]
  function briefSoonEvents(events, nowMs){
    const dayKey = (ms) => { const p = bkk(new Date(ms).toISOString()); return p.year + '-' + p.month + '-' + p.day; };
    const today = dayKey(nowMs), tomorrow = dayKey(nowMs + 86400000);
    return briefUpcoming(events, nowMs).map(e => {
      const at = e.at || (e.date + 'T12:00:00Z');
      const k = dayKey(Date.parse(at));
      if(k !== today && k !== tomorrow) return null;
      const p = bkk(at);
      const text = (k === today ? tr('วันนี้', 'today') : tr('พรุ่งนี้', 'tomorrow')) + (e.at ? ' ' + p.hour + ':' + p.minute + TIME_SUFFIX : '') + ' ' + briefEventLabel(e);
      return { e, today: k === today, text };
    }).filter(Boolean);
  }

  // ---- ระดับเตือน + ผลต่อหุ้น/คริปโต ----
  // กติกาตายตัวจากตัวเลขบนหน้า (ไม่ใช่ AI): คะแนนความเสี่ยงโลก, คะแนนที่พุ่งจากเมื่อวาน, หมวดที่ร้อนแรง,
  // ตัวเลขเศรษฐกิจตัวใหญ่ (CPI / จ้างงาน / FOMC / PCE) ที่จะออกวันนี้–พรุ่งนี้ และราคาที่ขยับแรง
  function briefAlert(b, nowMs){
    const reasons = [];   // [severity 2=แดง 1=เหลือง, text]
    const add = (sev, text) => reasons.push([sev, text]);
    const cats = b.cats || {};
    if(isFinite(b.score)){
      if(b.score >= 75) add(2, tr('ความเสี่ยงโลกระดับวิกฤต ' + b.score + '/100', 'world risk at crisis level, ' + b.score + '/100'));
      else if(b.score >= 60) add(1, tr('ความเสี่ยงโลกสูง ' + b.score + '/100', 'world risk elevated, ' + b.score + '/100'));
      if(b.prev && isFinite(b.prev.score)){
        const diff = b.score - b.prev.score;
        if(diff >= 8) add(2, tr('ความเสี่ยงพุ่ง +' + diff + ' จุดในวันเดียว', 'risk jumped +' + diff + ' in a day'));
        else if(diff >= 4) add(1, tr('ความเสี่ยงเพิ่ม +' + diff + ' จุดจากเมื่อวาน', 'risk up +' + diff + ' from yesterday'));
      }
    }
    Object.keys(cats).forEach(k => {
      if(isFinite(cats[k]) && cats[k] >= 80) add(2, tr('ข่าว' + (BRIEF_CAT_LABELS[k] || k) + 'ร้อนแรง ' + cats[k] + '/100', (BRIEF_CAT_LABELS[k] || k) + ' news running hot, ' + cats[k] + '/100'));
    });
    let soon = [];
    try{ soon = briefSoonEvents(b.events, nowMs).filter(x => CAL_HIGH[x.e.key]); }catch(e){ soon = []; }
    soon.forEach(x => add(x.today ? 2 : 1, x.text + tr(' ตลาดผันผวนแรงได้', ': expect big swings')));
    const px = b.prices || {};
    Object.keys(px).forEach(k => {
      if(!BRIEF_PRICE_LABELS[k] || !isFinite(px[k])) return;
      const big = (k === 'lpGold' || k === 'lpOil') ? [3, 1.5] : [1.5, 0.8];   // ค่าเงินปกติขยับน้อยกว่าสินค้าโภคภัณฑ์
      const t = BRIEF_PRICE_LABELS[k] + ' ' + (px[k] > 0 ? '▲' : '▼') + ' ' + Math.abs(px[k]).toFixed(2) + '%';
      if(Math.abs(px[k]) >= big[0]) add(2, t);
      else if(Math.abs(px[k]) >= big[1]) add(1, t);
    });
    reasons.sort((a, c) => c[0] - a[0]);
    const level = reasons.length ? reasons[0][0] : 0;
    return { level, reasons: reasons.map(r => r[1]) };
  }

  // แรงกดดันจากข่าวต่อหุ้น/คริปโต: เริ่มจากคะแนนความเสี่ยงโลก แล้วบวกตามหมวดที่กระทบสินทรัพย์นั้นโดยตรง
  function briefMarketView(b, kind, nowMs){
    const cats = b.cats || {}, px = b.prices || {};
    if(!isFinite(b.score)) return null;
    let p = b.score;
    const why = [];
    const hot = (k, t) => isFinite(cats[k]) && cats[k] >= t;
    const crypto = kind === 'crypto';
    if(hot('geopolitical', 70)){ p += 5; why.push(crypto
      ? tr('ข่าวสงคราม/ภูมิรัฐศาสตร์ทำให้เงินออกจากสินทรัพย์เสี่ยง BTC มักร่วงตาม Nasdaq', 'geopolitical stress pushes money out of risk assets; BTC tends to fall with the Nasdaq')
      : tr('ข่าวสงคราม/ภูมิรัฐศาสตร์ทำให้นักลงทุนขายหุ้นหนีไปสินทรัพย์ปลอดภัย', 'geopolitical stress sends money from stocks into safe havens')); }
    if(hot('economic', 65)){ p += 5; why.push(crypto
      ? tr('ข่าวดอกเบี้ย/เงินเฟ้อ ถ้า Fed ไม่ลดดอกเบี้ย สภาพคล่องที่ไหลเข้าคริปโตจะน้อยลง', 'rate/inflation news: no Fed cuts means less liquidity for crypto')
      : tr('ข่าวดอกเบี้ย/เงินเฟ้อกดดัน valuation โดยเฉพาะหุ้นเทคและหุ้นเติบโต', 'rate/inflation news weighs on valuations, especially tech and growth')); }
    if(hot('energy', 65) || px.lpOil >= 2){ p += 3; why.push(tr('น้ำมันแพงดันเงินเฟ้อ ทำให้ดอกเบี้ยลดยาก', 'pricier oil feeds inflation and delays rate cuts')); }
    if(hot('financial', 65)){ p += 4; why.push(tr('ข่าวตลาดการเงินตึงเครียด เสี่ยงแรงขายเป็นวงกว้าง', 'financial-market stress raises the risk of broad selling')); }
    if(!crypto && hot('techAi', 70)){ p += 2; why.push(tr('ข่าวเทค/AI แรง กระทบหุ้น Big Tech ที่มีน้ำหนักมากในดัชนี', 'heavy tech/AI news hits the Big Tech names that dominate the index')); }
    let high = [];
    try{ high = briefSoonEvents(b.events, nowMs).filter(x => CAL_HIGH[x.e.key] && x.today); }catch(e){ high = []; }
    if(high.length){ p += 3; why.unshift(tr('ระวังช่วง ', 'Watch ') + high.map(x => x.text.replace(/^(วันนี้|today) /, '')).join(', ') + tr(' ราคาเหวี่ยงแรงได้ทั้งสองทาง', ': prices can swing hard either way')); }
    const level = p >= 70 ? 2 : p >= 55 ? 1 : 0;
    const head = level === 2 ? tr('🔴 แรงกดดันสูง', '🔴 Heavy pressure') : level === 1 ? tr('🟡 กดดันปานกลาง', '🟡 Some pressure') : tr('🟢 ข่าวไม่ค่อยกดดัน', '🟢 Little pressure from the news');
    if(!why.length) why.push(level === 0 ? tr('บรรยากาศข่าวเอื้อต่อสินทรัพย์เสี่ยง', 'the news backdrop favours risk assets')
      : tr('ความเสี่ยงโลกโดยรวมสูง นักลงทุนมักลดสินทรัพย์เสี่ยง', 'overall risk is high, so investors tend to cut risk'));
    return { level, text: head + ' · ' + why.slice(0, 2).join(' · ') };
  }

  function briefCalendarLine(events, nowMs){
    if(!Array.isArray(events)) return null;
    const upcoming = briefUpcoming(events, nowMs);
    const label = briefEventLabel;
    const soon = briefSoonEvents(events, nowMs).map(x => x.text);
    if(soon.length) return soon.join(' · ');
    const next = upcoming[0];
    if(!next) return tr('ช่วงนี้ยังไม่มีตัวเลขเศรษฐกิจสหรัฐฯ ที่ต้องรอ', 'No US data releases scheduled soon');
    const p = bkk(next.at || (next.date + 'T12:00:00Z'));
    return tr('วันนี้–พรุ่งนี้ไม่มีตัวเลขสำคัญ · ตัวถัดไป: ', 'Nothing due today or tomorrow · next: ') + label(next) + ' ' + (+p.day) + ' ' + TH_MONTHS[+p.month - 1];
  }

  function briefPriceLine(prices){
    const rows = Object.keys(prices || {}).filter(k => BRIEF_PRICE_LABELS[k] && isFinite(prices[k]))
      .sort((a, c) => Math.abs(prices[c]) - Math.abs(prices[a]));
    if(!rows.length) return null;
    if(Math.abs(prices[rows[0]]) < 0.5) return tr('ราคาค่อนข้างนิ่ง ไม่มีตัวไหนขยับเกิน 0.5%', 'Prices are quiet: nothing moved more than 0.5%');
    return rows.filter(k => Math.abs(prices[k]) >= 0.5).slice(0, 3)
      .map(k => BRIEF_PRICE_LABELS[k] + ' ' + (prices[k] > 0 ? '▲' : '▼') + ' ' + Math.abs(prices[k]).toFixed(2) + '%').join(' · ');
  }

  // คืน { alert, lines: [{label, text}] } — แยกเป็นฟังก์ชันล้วนเพื่อเทสได้
  function buildBrief(b, nowMs){
    const lines = [];
    const alert = briefAlert(b, nowMs);
    const stocks = briefMarketView(b, 'stocks', nowMs), crypto = briefMarketView(b, 'crypto', nowMs);
    if(stocks) lines.push({ label: tr('📈 หุ้น', '📈 Stocks'), text: stocks.text });
    if(crypto) lines.push({ label: tr('₿ คริปโต', '₿ Crypto'), text: crypto.text });
    const change = briefChangeLine(b);
    if(change) lines.push({ label: tr('อะไรเปลี่ยน', 'What changed'), text: change });
    let cal = null;
    try{ cal = briefCalendarLine(b.events, nowMs); }catch(e){ cal = null; }
    if(cal) lines.push({ label: tr('ตัวเลขที่รอ', 'Data due'), text: cal });
    const px = briefPriceLine(b.prices);
    if(px) lines.push({ label: tr('ราคาขยับแรงสุด', 'Biggest price moves'), text: px });
    return { alert, lines };
  }
  window.buildBrief = buildBrief;   // tests

  function renderBrief(){
    const box = el('aiBrief');
    if(!box) return;
    const { alert, lines } = buildBrief(BRIEF, Date.now());
    if(!lines.length) return;
    const A = [
      { icon: '🟢', cls: 'ok', title: tr('ปกติ', 'Calm'), none: tr('ไม่มีสัญญาณเตือนจากข่าว ตัวเลขเศรษฐกิจ หรือราคา', 'No warning signs from news, data or prices') },
      { icon: '🟡', cls: 'warn', title: tr('ระวัง', 'Caution') },
      { icon: '🔴', cls: 'alert', title: tr('เตือนแรง', 'Strong warning') }
    ][alert.level];
    box.innerHTML = '<div class="brief-alert ' + A.cls + '"><b>' + A.icon + ' ' + esc(A.title) + '</b> ' + esc(alert.reasons.slice(0, 3).join(' · ') || A.none || '') + '</div>'
      + lines.map(l => '<p style="margin-bottom:10px;"><b>' + esc(l.label) + ':</b> ' + esc(l.text) + '</p>').join('')
      + '<span class="muted">' + tr('— สรุปอัตโนมัติ ไม่ใช่คำแนะนำการลงทุน', '— Auto-generated. Not investment advice.') + '</span>';
  }
  async function loadBriefPrev(){
    try{
      const raw = await storageGet('news-score-history');
      const hist = raw ? JSON.parse(raw) : [];
      const today = new Date().toISOString().slice(0,10);   // same day key as recordScoreHistory
      BRIEF.prev = (Array.isArray(hist) ? hist : []).filter(h => h && h.date < today && isFinite(h.score)).pop() || null;
    }catch(e){ BRIEF.prev = null; }
    renderBrief();
  }

  // ---------- รายการ "ข่าวล่าสุด" ----------
  // Google News ใส่ " - ชื่อสำนักข่าว" ต่อท้ายพาดหัว — ตัดออกเพราะโชว์ชื่อสำนักข่าวแยกอยู่แล้ว
  function cleanHeadline(title, source){
    const t = String(title || '').trim();
    if(source && t.endsWith(' - ' + source)) return t.slice(0, -(source.length + 3)).trim();
    return t.replace(/\s+-\s+[^-]{2,60}$/, '').trim() || t;
  }
  // คีย์สำหรับตัดข่าวซ้ำ (ข่าวเดียวกันมักโผล่หลายหมวด)
  function storyKey(title){
    return cleanHeadline(title).toLowerCase().replace(/[^a-z0-9ก-๙]+/g, ' ').trim().slice(0, 80);
  }
  const NEWS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
  function buildNewsList(feedResults){
    const seen = new Set(), out = [];
    const now = Date.now();
    feedResults.forEach(f => (f.items || []).forEach(it => {
      const key = storyKey(it.title);
      if(!key || seen.has(key)) return;
      const ts = Date.parse(it.pubDate);
      if(isFinite(ts) && now - ts > NEWS_MAX_AGE_MS) return;   // ข่าวเก่าเกิน 48 ชม. ไม่เอา
      seen.add(key);
      out.push({
        cat: f.key, catLabel: f.label,
        title: cleanHeadline(it.title, it.source),
        source: it.source || '',
        link: /^https?:\/\//i.test(it.link || '') ? it.link : '',
        ts: isFinite(ts) ? ts : 0
      });
    }));
    return out.sort((a, b) => b.ts - a.ts).slice(0, 60);
  }
  function newsAgo(ts){
    if(!ts) return '';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if(mins < 60) return mins <= 1 ? tr('เมื่อสักครู่', 'just now') : mins + tr(' นาทีที่แล้ว', ' min ago');
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? hrs + tr(' ชม. ที่แล้ว', 'h ago') : Math.round(hrs / 24) + tr(' วันที่แล้ว', 'd ago');
  }

  // "คะแนนมาจากข่าวไหน" — พาดหัวที่ดันคะแนนแต่ละหมวด พร้อมคำที่ระบบจับได้ (แดง = เพิ่มความเสี่ยง, เขียว = ลด)
  function renderRiskWhy(d, labels){
    const box = el('riskWhy'), wrap = el('riskWhyBox');
    if(!box || !wrap) return;
    if(!d.drivers){ wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    box.innerHTML = labels.map(([k, l]) => {
      const rows = d.drivers[k] || [];
      const list = rows.length ? rows.map(r => {
        const en = cleanHeadline(r.title);
        const th = EN ? null : _translationCache.get(r.title);
        const hasTh = th && th !== r.title && !/MYMEMORY/i.test(th);
        return '<div class="why-row"><div>' + esc(hasTh ? th : en) + '</div>'
          + (hasTh ? '<div class="why-en">' + esc(en) + '</div>' : '')
          + '<div class="why-chips">'
          + r.hits.map(h => '<span class="chip ' + (h.w > 0 ? 'risk' : 'calm') + '" title="' + esc(h.term) + '">'
            + esc(EN ? h.term : (RISK_TERM_TH[h.term] || h.term)) + (h.w > 0 ? ' +' : ' −') + Math.abs(h.w) + '</span>').join('')
          + '</div></div>';
      }).join('') : '<div class="muted" style="font-size:12px;">' + tr('ไม่มีคำบ่งชี้ความเสี่ยงในพาดหัวรอบนี้ (คะแนนกลาง ๆ)', 'No risk keywords in this round of headlines (neutral score)') + '</div>';
      return '<div class="why-cat"><div class="why-head"><b>' + esc(l) + '</b><span>' + esc((d.categories || {})[k] ?? '–') + '/100</span></div>' + list + '</div>';
    }).join('')
      + '<div class="muted" style="font-size:11px; margin-top:8px;">' + tr('คะแนนคิดจาก 5 เรื่องล่าสุดของแต่ละหมวด (ข่าวซ้ำจากหลายสำนักนับครั้งเดียว ข่าวกีฬา/บันเทิงไม่นับ ข่าวใหม่มีน้ำหนักมากกว่า): คำบ่งชี้ความเสี่ยงยิ่งมาก คะแนนยิ่งสูง · 50 = กลาง ๆ', 'Each category is scored from its 5 latest distinct stories (duplicates across outlets count once, sports/entertainment are skipped, newer news weighs more): the more risk keywords, the higher the score · 50 = neutral') + '</div>';
    translateRiskWhy(d, labels);
  }
  // แปลพาดหัวในกล่อง "คะแนนมาจากข่าวไหน" (ไม่เกิน 15 ข่าว) — ใช้แคชคำแปลเดียวกับรายการข่าว จึงแปลซ้ำแค่พาดหัวใหม่
  let _riskWhyToken = 0;
  async function translateRiskWhy(d, labels){
    if(EN) return;
    const titles = [];
    labels.forEach(([k]) => (d.drivers[k] || []).forEach(r => {
      if(!/[\u0E00-\u0E7F]/.test(r.title) && !_translationCache.has(r.title) && !titles.includes(r.title)) titles.push(r.title);
    }));
    if(!titles.length) return;
    const token = ++_riskWhyToken;
    for(const t of titles){
      await translateToThai(t);
      if(token !== _riskWhyToken) return;   // มีข้อมูลรอบใหม่มาแล้ว — ปล่อยให้รอบใหม่แปลต่อ
    }
    renderRiskWhy(d, labels);
  }

  const NEWS_PAGE = 8;
  const newsView = { items: [], filter: 'all', shown: NEWS_PAGE, token: 0 };
  function renderNewsList(items){
    if(Array.isArray(items) && items !== newsView.items){ newsView.items = items; newsView.shown = NEWS_PAGE; }
    const list = el('newsList'), filters = el('newsFilters'), more = el('newsMoreBtn');
    if(!list) return;
    const all = newsView.items;
    if(filters){
      const counts = {};
      all.forEach(n => { counts[n.cat] = (counts[n.cat] || 0) + 1; });
      const chips = [['all', tr('ทั้งหมด', 'All'), all.length]].concat(RSS_FEEDS.filter(f => counts[f.key]).map(f => [f.key, f.label, counts[f.key]]));
      filters.innerHTML = chips.map(([k, l, c]) =>
        '<button type="button" data-cat="' + esc(k) + '" class="' + (newsView.filter === k ? 'on' : '') + '">' + esc(l) + '<span>' + c + '</span></button>'
      ).join('');
    }
    const pool = newsView.filter === 'all' ? all : all.filter(n => n.cat === newsView.filter);
    const visible = pool.slice(0, newsView.shown);
    if(!visible.length){
      list.innerHTML = '<div class="muted" style="font-size:12px;">' + tr('ยังไม่มีข่าวในช่วง 48 ชม. ที่ผ่านมา', 'No news in the past 48 hours') + '</div>';
    }else{
      list.innerHTML = visible.map(n => {
        const th = EN ? null : _translationCache.get(n.title);
        const hasTh = th && th !== n.title && !/MYMEMORY/i.test(th);
        const tag = n.link ? 'a' : 'div';
        const attrs = n.link ? ' href="' + esc(n.link) + '" target="_blank" rel="noopener noreferrer"' : '';
        return '<' + tag + ' class="news-item"' + attrs + '>'
          + '<div class="nt">' + esc(hasTh ? th : n.title) + '</div>'
          + (hasTh ? '<div class="ne">' + esc(n.title) + '</div>' : '')
          + '<div class="nm">' + (newsView.filter === 'all' ? '<span class="tag">' + esc(feedLabel(n.cat, n.catLabel)) + '</span>' : '')
          + (n.source ? '<span>' + esc(n.source) + '</span>' : '')
          + (n.ts ? '<span>' + esc(newsAgo(n.ts)) + '</span>' : '') + '</div>'
          + '</' + tag + '>';
      }).join('');
    }
    if(more){
      const left = pool.length - visible.length;
      more.style.display = left > 0 ? '' : 'none';
      more.textContent = tr('ดูข่าวเพิ่ม', 'More news') + ' (' + left + ')';
    }
    translateVisibleNews(visible);
  }
  // แปลเฉพาะพาดหัวที่อยู่บนจอ (ประหยัดโควต้าแปลฟรี) — คำแปลถูกแคชไว้ จึงแปลซ้ำแค่ข่าวใหม่
  async function translateVisibleNews(visible){
    if(EN) return;
    const todo = visible.filter(n => !/[\u0E00-\u0E7F]/.test(n.title) && !_translationCache.has(n.title));
    if(!todo.length) return;
    const token = ++newsView.token;
    for(const n of todo){
      await translateToThai(n.title);
      if(token !== newsView.token) return;   // ผู้ใช้เปลี่ยนหมวด/รายการใหม่มาแล้ว — หยุดรอบเก่า
    }
    renderNewsList();
  }
  (function initNewsControls(){
    const filters = el('newsFilters'), more = el('newsMoreBtn');
    if(filters) filters.addEventListener('click', function(ev){
      const b = ev.target && ev.target.closest ? ev.target.closest('button[data-cat]') : null;
      if(!b) return;
      newsView.filter = b.getAttribute('data-cat'); newsView.shown = NEWS_PAGE;
      renderNewsList();
    });
    if(more) more.addEventListener('click', function(){ newsView.shown += NEWS_PAGE; renderNewsList(); });
  })();

  const BADGE_TH = EN
    ? { 'CRISIS':'Crisis', 'DEFENSIVE':'Defensive', 'NEUTRAL':'Neutral', 'RISK-ON':'Risk-on' }
    : { 'CRISIS':'วิกฤต · Crisis', 'DEFENSIVE':'ระวัง · Defensive', 'NEUTRAL':'ปานกลาง · Neutral', 'RISK-ON':'ความเสี่ยงต่ำ · Risk-on' };
  function badgeColor(badge){
    if(badge === 'CRISIS') return { bg:'#ff657722', fg:'#ff8b98' };
    if(badge === 'DEFENSIVE') return { bg:'#ff657722', fg:'#ff8b98' };
    if(badge === 'RISK-ON') return { bg:'#45d48322', fg:'#45d483' };
    return { bg:'#ffca5822', fg:'#ffca58' };
  }

  function assetBarClass(v){
    if(v >= 70) return 'green';
    if(v >= 50) return 'blue';
    return 'yellow';
  }

  function renderData(d){
    el('riskScore').innerHTML = esc(d.worldRiskScore) + '<small>/100</small>';
    const pin = el('riskPin');
    if(pin && isFinite(d.worldRiskScore)){ pin.style.left = Math.max(0, Math.min(100, d.worldRiskScore)) + '%'; pin.style.display = 'block'; }
    el('riskBadge').textContent = (BADGE_TH[d.badge] || d.badge);
    const bc = badgeColor(d.badge);
    el('riskBadge').style.background = bc.bg;
    el('riskBadge').style.color = bc.fg;
    el('riskConfidence').textContent = tr('ความครอบคลุมของข่าว ', 'News coverage ') + d.confidence + '%';

    const cats = d.categories;
    const catBox = el('categoryMetrics');
    const labels = ['geopolitical','economic','energy','financial','techAi'].map(k => [k, feedLabel(k)]);
    catBox.innerHTML = labels.map(([k,l]) => `<div class="metric"><div class="name">${l}</div><div class="num">${cats[k] ?? '–'}</div></div>`).join('');
    renderRiskWhy(d, labels);

    const assets = d.assets;
    const assetDefs = [['gold',tr('🥇 ทองคำ','🥇 Gold')],['oil',tr('🛢 น้ำมัน','🛢 Oil')],['usd',tr('💵 ดอลลาร์','💵 Dollar')],['bitcoin','₿ Bitcoin'],['stocks',tr('📈 หุ้น','📈 Stocks')]];
    el('assetBars').innerHTML = assetDefs.map(([k,l]) => {
      const v = assets[k] ?? 0;
      return `<div class="barrow"><span>${l}</span><div class="track"><div class="fill ${assetBarClass(v)}" style="width:${v}%"></div></div><b>${v}</b></div>`;
    }).join('');

    // กันกรณีแคชเก่ายังมีข้อความ MYMEMORY WARNING ค้างอยู่ — ถ้า titleTh มีคำว่า MYMEMORY ให้ตกกลับไปใช้ title ภาษาอังกฤษแทน
    //
    // 🔒 ทุกฟิลด์ที่มาจากภายนอก (พาดหัวข่าว / คำอธิบาย / ผลแปล จาก RSS ของ Google News) ต้องผ่าน esc()
    // ก่อนใส่ innerHTML เสมอ — เดิมโค้ดนี้ต่อสตริงดิบ พาดหัวที่ฝัง markup หรือ onerror= มาได้จะรันทันที
    // (self-XSS/stored-XSS ผ่าน feed) esc() ถูกประกาศไว้ในสคริปต์เดียวกันอยู่แล้ว
    el('topEvents').innerHTML = (d.topEvents || []).map(ev => {
      const cat = feedLabel(ev.catKey, ev.category);
      const genericDesc = tr('พาดหัวข่าวล่าสุดจากหมวด ' + cat + ' (คะแนนความเสี่ยงหมวดนี้ ' + ev.marketImpact + '/100)',
                             'Latest headline in ' + cat + ' (category risk score ' + ev.marketImpact + '/100)');
      // โหมดอังกฤษ: พาดหัวต้นฉบับ ไม่ต้องมีบรรทัดภาษาอังกฤษซ้ำด้านล่าง
      const safeTitleTh = (!EN && ev.titleTh && !/MYMEMORY/i.test(ev.titleTh)) ? ev.titleTh : ev.title;
      const safeDescTh = (!EN && ev.descriptionTh && !/MYMEMORY/i.test(ev.descriptionTh)) ? ev.descriptionTh : genericDesc;
      return `<div class="event">
        <div class="rank">0${esc(ev.rank)} · ${esc(String(cat).toUpperCase())}</div>
        <h3>${esc(safeTitleTh)}</h3>
        ${EN ? '' : `<div class="muted" style="font-size:11px; margin-top:-6px; margin-bottom:8px;">${esc(ev.title)}</div>`}
        <p>${esc(safeDescTh)}</p>
        <div class="impact">${tr('ผลกระทบต่อตลาด', 'Market impact')} · ${esc(ev.marketImpact)}/100</div>
      </div>`;
    }).join('');

    BRIEF.score = d.worldRiskScore; BRIEF.cats = d.categories || null;
    renderBrief();

    if(Array.isArray(d.news)) renderNewsList(d.news);
  }

  // ---------- World Risk Score history + trend sparkline ----------
  // Every successful score computation gets appended (1 point/day, capped 30 days) so we
  // can show a trend line instead of just today's single number. Pure local storage, no API.
  async function recordScoreHistory(score, cats){
    const today = new Date().toISOString().slice(0,10);
    let hist = [];
    try{
      const raw = await storageGet('news-score-history');
      if(raw) hist = JSON.parse(raw);
    }catch(e){ hist = []; }

    if(hist.length && hist[hist.length-1].date === today){
      hist[hist.length-1].score = score; // update today's point instead of duplicating
      if(cats) hist[hist.length-1].cats = cats;
    }else{
      hist.push(cats ? { date: today, score, cats } : { date: today, score });
    }
    hist = hist.slice(-30); // keep last 30 days

    await storageSet('news-score-history', JSON.stringify(hist));
    renderSparkline(hist);
  }

  function renderSparkline(hist){
    const box = el('riskTrend');
    if(!box || hist.length < 2){
      if(box) box.innerHTML = '<div class="muted" style="font-size:11px;">' + tr('เก็บข้อมูลแนวโน้มไว้แล้ว — จะเห็นกราฟเมื่อมีข้อมูลตั้งแต่ 2 วันขึ้นไป', 'Trend tracking has started. The chart appears once there are 2 or more days of data.') + '</div>';
      return;
    }
    const w = 320, h = 48, pad = 4;
    const scores = hist.map(p => p.score);
    const min = Math.min(...scores), max = Math.max(...scores);
    const range = (max - min) || 1;
    const pts = hist.map((p,i) => {
      const x = pad + (i/(hist.length-1)) * (w - pad*2);
      const y = h - pad - ((p.score - min)/range) * (h - pad*2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const trendUp = scores[scores.length-1] >= scores[0];
    const color = trendUp ? '#ff6577' : '#45d483'; // risk score UP = worse (red), DOWN = better (green)
    box.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%; height:${h}px; display:block;">
        <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      </svg>
      <div class="muted" style="font-size:10px; margin-top:2px;">${tr('แนวโน้ม ' + hist.length + ' วันล่าสุด', 'Trend, last ' + hist.length + ' days')} (${hist[0].date} → ${hist[hist.length-1].date})</div>
    `;
  }

  // ---------- FOMC meeting countdown ----------
  // Pure date math, no network call — FOMC statement dates (2:00pm ET, day 2 of each 2-day
  // meeting) per federalreserve.gov. The Fed publishes roughly two years ahead, so 2027 is
  // already known; without it the card went blank on 2027-01-01 ("ยังไม่มีตารางปี 2027").
  // ต้องตรงกับ FOMC_STATEMENT_DATES ใน netlify/functions/fred-data.js (ใช้ตัดสิน TTL วันประกาศ)
  const FOMC_STATEMENT_DATES = [
    '2026-01-28','2026-03-18','2026-04-29','2026-06-17',
    '2026-07-29','2026-09-16','2026-10-28','2026-12-09',
    '2027-01-27','2027-03-17','2027-04-28','2027-06-09',
    '2027-07-28','2027-09-15','2027-10-27','2027-12-08'
  ];
  function renderFomcCountdown(){
    const now = new Date();
    const next = FOMC_STATEMENT_DATES
      .map(d => new Date(d + 'T19:00:00Z')) // ~2pm ET in UTC (19:00 UTC = 14:00 EST)
      .find(d => d > now);
    if(!next){
      el('fomcDays').textContent = '–';
      el('fomcDateLabel').textContent = tr('ยังไม่มีตารางปี 2028 — ต้องอัปเดตรายการวันที่', 'No 2028 schedule yet. The date list needs updating.');
      return;
    }
    const days = Math.ceil((next - now) / 86400000);
    el('fomcDays').textContent = days;
    el('fomcDateLabel').textContent = next.toLocaleDateString(LOCALE, { year:'numeric', month:'long', day:'numeric' });
  }

  // "จากเมื่อวาน" = เทียบกับคะแนน *สุดท้าย* ของวันก่อนหน้าใน news-score-history (บันทึกวันละ 1 จุด
  // โดย recordScoreHistory) — เดิมเทียบกับคะแนนแรกของวันก่อน (และวันแรกที่ไม่มีข้อมูลเลยก็ขึ้นว่า
  // "เท่ากับเมื่อวาน") จึงบอกการเปลี่ยนแปลงผิด · คืน null ถ้ายังไม่มีข้อมูลของวันก่อน
  async function computeChangeLabel(newScore){
    let hist = [];
    try{
      const raw = await storageGet('news-score-history');
      if(raw) hist = JSON.parse(raw);
    }catch(e){ hist = []; }
    const today = new Date().toISOString().slice(0,10);   // same day key as recordScoreHistory
    const prev = (Array.isArray(hist) ? hist : []).filter(h => h && h.date < today && isFinite(h.score)).pop();
    return prev ? newScore - prev.score : null;
  }

  async function refreshNews(){
    el('newsStatus').textContent = tr('กำลังดึงข่าวสด…', 'Fetching live news…');
    try{
      const feedResults = await Promise.all(RSS_FEEDS.map(fetchFeed));
      const gotAny = feedResults.some(f => f.titles.length > 0);
      if(!gotAny){
        console.warn('[news] every feed came back empty (news-feed function unreachable?)');
        el('newsStatus').textContent = tr('โหลดข่าวใหม่ไม่ได้ในขณะนี้ — แสดงข่าวล่าสุดที่มี', 'Can\'t load new headlines right now. Showing the latest available.');
        return;
      }
      el('newsStatus').textContent = tr('กำลังวิเคราะห์ข่าว…', 'Analysing news…');
      const d = computeAnalysis(feedResults);

      const diff = await computeChangeLabel(d.worldRiskScore);
      el('riskChange').textContent = diff == null ? tr('ยังไม่มีคะแนนของเมื่อวานให้เทียบ', 'No score from yesterday to compare yet')
        : diff > 0 ? '▲ +' + diff + tr(' จากเมื่อวาน', ' vs yesterday') : diff < 0 ? '▼ ' + diff + tr(' จากเมื่อวาน', ' vs yesterday') : tr('เท่ากับเมื่อวาน', 'Same as yesterday');
      el('riskChange').style.color = diff == null ? 'var(--muted)' : diff > 0 ? 'var(--bad)' : diff < 0 ? 'var(--good)' : 'var(--muted)';

      renderData(d); // render English-first immediately so the page isn't blank while translating

      if(!EN){   // โหมดอังกฤษไม่ต้องแปล (ไม่ใส่ titleTh ด้วย — แคชจะได้แปลให้ตอนกลับมาโหมดไทย)
        el('newsStatus').textContent = 'กำลังแปลพาดหัวข่าวเป็นไทย…';
        await Promise.all(d.topEvents.map(async ev => {
          ev.titleTh = await translateToThai(ev.title);
          if(ev.rawDescription) ev.descriptionTh = await translateToThai(ev.rawDescription);
        }));
        renderData(d); // re-render with Thai translations filled in
      }

      await recordScoreHistory(d.worldRiskScore, d.categories);
      await storageSet('news-dashboard-cache', JSON.stringify({ data: d, ts: Date.now() }));
      el('newsStatus').textContent = tr('อัปเดตข่าว ', 'News updated ') + new Date().toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
      if(window.setHeaderStamp) window.setHeaderStamp();
    }catch(e){
      console.warn('[news]', e);
      el('newsStatus').textContent = tr('โหลดข่าวไม่สำเร็จ — ลองกดรีเฟรชอีกครั้ง', 'Couldn\'t load news. Try refreshing again.');
    }
  }

  // Cache age is returned so the caller can decide whether a network refresh is worth it.
  // (Before this, every single page load re-fetched all 5 feeds, reload or not.)
  async function loadCache(){
    let ageMs = null;
    try{
      const raw = await storageGet('news-dashboard-cache');
      if(raw){
        const c = JSON.parse(raw);
        renderData(c.data);
        // แคชที่บันทึกตอนอยู่โหมดอังกฤษไม่มีคำแปลพาดหัว — กลับมาโหมดไทยแล้วแปลให้ (ส่วนใหญ่ได้จากแคชคำแปล)
        if(!EN && c.data && Array.isArray(c.data.topEvents) && c.data.topEvents.some(ev => ev && !ev.titleTh)){
          Promise.all(c.data.topEvents.map(async ev => { if(ev && !ev.titleTh) ev.titleTh = await translateToThai(ev.title); }))
            .then(() => renderData(c.data)).catch(() => {});
        }
        // แคชรุ่นก่อนยังไม่มีรายการข่าวล่าสุด — ถือว่าหมดอายุ ให้ดึงใหม่ทันที
        ageMs = Array.isArray(c.data && c.data.news) ? Date.now() - c.ts : Infinity;
        const mins = Math.round(ageMs / 60000);
        el('newsStatus').textContent = tr('อัปเดตข่าว ', 'News updated ') + new Date(c.ts).toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
      }
    }catch(e){ /* no cache yet */ }
    try{
      const hraw = await storageGet('news-score-history');
      if(hraw) renderSparkline(JSON.parse(hraw));
    }catch(e){ /* no history yet */ }
    return ageMs;
  }

  // ---------- Live US macro data: Fed funds, CPI (headline + core), unemployment, payrolls ----------
  // Everything comes from /.netlify/functions/fred-data, which no longer requires an API key: it
  // tries the keyed FRED API first (if FRED_API_KEY is configured), then FRED's public graph CSV,
  // then the BLS public API — so it works in production, deploy previews and branch deploys alike.
  // The server also tells us when the numbers could next change (`refreshAfter`): ~15 min on
  // CPI / jobs-report / FOMC days, ~3 h otherwise. We re-poll on that schedule, plus whenever the
  // tab becomes visible again. Nothing is hardcoded: until real data (fresh, or the last payload this
  // browser saved) arrives, the cards show "–" — a baked-in number could be mistaken for a live one.
  const FED_CACHE_KEY = 'fed-data-cache-v3';  // v3: TTL-based cache, adds nfp/coreCpi fields
  const FED_POLL_MS = 10 * 60 * 1000;         // safety-net poll; the server TTL usually decides
  const FED_TICK_MS = 60 * 1000;              // how often we check whether refreshAfter has passed
  let fedNextFetchAt = 0;

  function isValidNum(v){ return typeof v === 'number' && isFinite(v); }

  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
  }

  function hasAnyFedField(d){
    // coreCpi ต้องนับด้วย ไม่งั้น response ที่ได้แต่ core CPI จะถูกมองว่า "ไม่มีข้อมูลเลย" แล้วตกไป error
    return !!(d && (d.upper || d.lower || d.effr || d.cpi || d.coreCpi || d.ppi || d.unrate || d.nfp || d.claims || d.corePce));
  }

  // ชื่อเดือนย่อตามภาษา (ชื่อตัวแปรเดิมคงไว้ — ถูกใช้หลายที่)
  const TH_MONTHS = EN ? ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
                       : ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function thMonth(dateStr){
    const m = /^(\d{4})-(\d{2})/.exec(String(dateStr || ''));
    return m ? TH_MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(dateStr || '');
  }
  function thDay(dateStr){
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
    return m ? parseInt(m[3], 10) + ' ' + TH_MONTHS[parseInt(m[2], 10) - 1] + ' ' + m[1] : String(dateStr || '');
  }


  // Payrolls are a signed change in jobs — keep the sign and the thousands separators.
  function fmtJobs(v){
    const n = Math.round(v);
    return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US');
  }

  function fedStatusText(data){
    if(data && data.stale) return tr('⚠️ แสดงตัวเลขล่าสุดที่มี — ระบบจะอัปเดตให้อัตโนมัติ', '⚠️ Showing the latest numbers available. They will update automatically.');
    // วันประกาศตัวเลข: BLS ออกแล้วแต่แหล่งข้อมูลยังไม่อัปเดต — เซิร์ฟเวอร์จะเช็กใหม่ทุกไม่กี่นาที
    if(data && Array.isArray(data.awaiting) && data.awaiting.length) return tr('⏳ รอตัวเลขใหม่ที่เพิ่งประกาศ — ระบบเช็กซ้ำทุก ~3 นาที', '⏳ Waiting for the just-released numbers. Re-checking every ~3 min.');
    return '';
  }

  // เดือนที่ BLS ประกาศแต่ไม่มี YoY (ต.ค. 2026: ไม่มีข้อมูล ต.ค. 2025 เพราะรัฐบาลสหรัฐฯ ปิดชั่วคราว) —
  // ตัวเลขใหญ่บนการ์ดยังเป็น YoY ของเดือนก่อน เลยต้องบอกให้ชัดว่าเป็นของเดือนไหน และโชว์ MoM ของเดือนใหม่แทน
  // บรรทัดย่อยแบบเดียวกันทั้งการ์ด CPI และ PPI: "เดือน X · YoY a% · MoM b%" — ตัวเลขใหญ่ยังเป็นตัวที่ตลาด/ค่าคาดใช้
  // (CPI = YoY, PPI = MoM) แต่สองการ์ดอ่านเทียบกันได้ทันที
  function yoyMomLine(date, yoy, mom){
    const bits = [];
    if(date) bits.push(tr('เดือน ', '') + thMonth(date));
    if(isValidNum(yoy)) bits.push('YoY ' + Number(yoy).toFixed(1) + '%');
    if(isValidNum(mom)) bits.push('MoM ' + signedPct(mom, 1) + '%');
    return bits.join(' · ');
  }
  function cpiInfoHtml(cpi, coreCpi){
    if(!cpi || !isValidNum(cpi.value)) return '';
    let html = esc(yoyMomLine(cpi.date, cpi.value, cpi.mom));
    const n = cpi.latestNoYoy;
    if(n && n.date && cpi.date && n.date > cpi.date){
      let mom = isValidNum(n.mom) ? 'MoM <b>' + esc(signedPct(n.mom, 1)) + '%</b>' : '';
      const cn = coreCpi && coreCpi.latestNoYoy;
      if(mom && cn && cn.date === n.date && isValidNum(cn.mom)) mom += ' (Core ' + esc(signedPct(cn.mom, 1)) + '%)';
      html += '<br>' + tr('<b>' + esc(thMonth(n.date)) + '</b> ไม่มี YoY (ไม่มีข้อมูล ' + esc(thMonth(n.yearAgoDate)) + ')', '<b>' + esc(thMonth(n.date)) + '</b> has no YoY (no ' + esc(thMonth(n.yearAgoDate)) + ' data)')
        + (mom ? ' · ' + mom : '');
    }
    return html;
  }
  window.yoyMomLine = yoyMomLine;   // tests
  function cpiNoYoyHtml(cpi, coreCpi){
    const n = cpi && cpi.latestNoYoy;
    if(!n || !n.date || !cpi.date || !(n.date > cpi.date)) return '';
    let mom = isValidNum(n.mom) ? 'MoM <b>' + esc(signedPct(n.mom, 1)) + '%</b>' : '';
    const cn = coreCpi && coreCpi.latestNoYoy;
    if(mom && cn && cn.date === n.date && isValidNum(cn.mom)) mom += ' (Core ' + esc(signedPct(cn.mom, 1)) + '%)';
    return tr('ตัวเลข YoY ของ ', 'YoY is for ') + esc(thMonth(cpi.date)) + ' · '
      + tr('<b>' + esc(thMonth(n.date)) + '</b> ไม่มี YoY (ไม่มีข้อมูล ' + esc(thMonth(n.yearAgoDate)) + ')', '<b>' + esc(thMonth(n.date)) + '</b> has no YoY (no ' + esc(thMonth(n.yearAgoDate)) + ' data)')
      + (mom ? ' · ' + mom : '');
  }

  function applyFedData(data){
    // Each field is applied independently with validation — one bad value must never abort the
    // rest (that was the original CPI "." bug: one null took down every card after it).
    let applied = 0;
    try{
      const { upper, lower, effr, cpi, coreCpi, ppi, unrate, nfp, claims, pce, corePce } = data || {};
      if(claims && isValidNum(claims.value)) applied++;   // วาดโดย renderClaims() (รวมค่าคาดจาก /consensus)

      if(upper && lower && isValidNum(upper.value) && isValidNum(lower.value)){
        el('fedRange').textContent = lower.value.toFixed(2) + '–' + upper.value.toFixed(2) + '%';
        applied++;
      }
      if(effr && isValidNum(effr.value)){
        el('fedEffr').textContent = effr.value.toFixed(2) + '%';
        applied++;
      }
      if(cpi && isValidNum(cpi.value)){
        el('cpiYoy').textContent = cpi.value.toFixed(1) + '%';
        applied++;
      }
      try{ const ci = el('cpiInfo'); if(ci) ci.innerHTML = cpiInfoHtml(cpi, coreCpi); }catch(e){ /* best-effort */ }
      // Core PCE: เป้า 2% ของ Fed วัดจากตัวนี้ (BEA ประกาศปลายเดือน ช้ากว่า CPI ~2 สัปดาห์)
      if(corePce && isValidNum(corePce.value)){
        el('corePce').textContent = corePce.value.toFixed(1) + '%';
        const bits = [tr('เดือน ', '') + thMonth(corePce.date)];
        if(isValidNum(corePce.changePp)) bits.push(corePce.changePp > 0 ? tr('เร่งขึ้น ', 'up ') + corePce.changePp.toFixed(1) + ' pp' : corePce.changePp < 0 ? tr('ชะลอ ', 'down ') + Math.abs(corePce.changePp).toFixed(1) + ' pp' : tr('ทรงตัว', 'unchanged'));
        if(pce && isValidNum(pce.value) && pce.date === corePce.date) bits.push(tr('PCE ทั่วไป ', 'Headline PCE ') + pce.value.toFixed(1) + '%');
        bits.push(tr('เป้า Fed 2%', 'Fed target 2%'));
        const info = el('corePceInfo');
        if(info) info.textContent = bits.join(' · ');
        applied++;
      }
      if(ppi && isValidNum(ppi.value)){
        // ตัวเลขใหญ่ = YoY ให้เหมือนการ์ด CPI (เจ้าของเลือก พ.ย. 2026); MoM ที่ตลาด/ค่าคาดใช้อยู่บรรทัดย่อย
        // ถ้า YoY ยังไม่มา (ดัชนี NSA ของ FRED ตามหลังได้) โชว์ MoM แต่ติดป้ายให้ชัดว่าเป็น MoM
        el('ppiHead').textContent = isValidNum(ppi.yoy) ? ppi.yoy.toFixed(1) + '%' : signedPct(ppi.value, 1) + '% MoM';
        const yoyEl = el('ppiYoy');
        if(yoyEl) yoyEl.textContent = yoyMomLine(ppi.date, ppi.yoy, ppi.value);
        applied++;
      }
      if(unrate && isValidNum(unrate.value)){
        el('unrate').textContent = unrate.value.toFixed(1) + '%';
        applied++;
      }
      if(nfp && isValidNum(nfp.value)){
        const node = el('nfp');
        node.textContent = fmtJobs(nfp.value);
        node.style.color = '';   // สีมาจาก toneNum() ใน renderFedAnalysis (เทียบกับค่าคาด เหมือนกล่องวิเคราะห์)
        applied++;
      }

      // "as of" line — real dates and the real source, so freshness is visible at a glance.
      const bits = [];
      if(cpi && cpi.date && isValidNum(cpi.value)){
        bits.push('CPI ' + thMonth(cpi.date) + ' ' + cpi.value.toFixed(1) + '%'
          + (coreCpi && isValidNum(coreCpi.value) ? ' (core ' + coreCpi.value.toFixed(1) + '%)' : ''));
      }
      if(corePce && corePce.date && isValidNum(corePce.value)){
        bits.push('Core PCE ' + thMonth(corePce.date) + ' ' + corePce.value.toFixed(1) + '%');
      }
      if(ppi && ppi.date && isValidNum(ppi.value)){
        bits.push('PPI ' + thMonth(ppi.date) + ' ' + signedPct(ppi.value, 1) + '% MoM'
          + (isValidNum(ppi.yoy) ? ' (YoY ' + ppi.yoy.toFixed(1) + '%)' : ''));
      }
      if(unrate && unrate.date){
        bits.push(tr('ว่างงาน ', 'Unemployment ') + thMonth(unrate.date) + (isValidNum(unrate.value) ? ' ' + unrate.value.toFixed(1) + '%' : ''));
      }
      if(nfp && nfp.date){
        bits.push(tr('จ้างงาน ', 'Payrolls ') + thMonth(nfp.date) + (isValidNum(nfp.value) ? ' ' + fmtJobs(nfp.value) : ''));
      }
      if(effr && effr.date) bits.push('EFFR ' + thDay(effr.date));

      if(bits.length){
        const warnBits = [];
        if(cpi && cpi.warning) warnBits.push('CPI: ' + cpi.warning);
        if(data.stale) warnBits.push(tr('อาจยังไม่ใช่ตัวเลขล่าสุด', 'may not be the latest numbers'));
        el('fedAsOf').innerHTML = tr('ข้อมูลล่าสุด: ', 'Latest data: ') + esc(bits.join(' · '));
        // คำเตือนอยู่นอกปุ่ม ⓘ เพื่อให้เห็นได้โดยไม่ต้องกดขยาย
        el('fedAsOfWarn').textContent = warnBits.length ? '⚠️ ' + warnBits.join(' · ') : '';
      }
    }catch(e){ /* never let a render hiccup break the page */ }

    // สร้างบทวิเคราะห์ "ดี/แย่แค่ไหน" ใหม่จากค่าที่เพิ่งได้ (แยก try/catch ไม่ให้พังการ์ดหลัก)
    try{ renderFedAnalysis(data); }catch(e){ /* analysis is best-effort */ }
    try{ lastFedPayload = data; renderClaims(); }catch(e){ /* best-effort */ }
    try{ renderNextReleases(); }catch(e){ /* best-effort */ }
    try{ lastLiveFed = data; patchSparksFromLive(); }catch(e){ /* sparklines are best-effort */ }
    return applied;
  }

  // ---------- บทวิเคราะห์ "ออกมาดี/แย่แค่ไหน" แบบอัตโนมัติ ----------
  // เดิมส่วนนี้เป็นข้อความที่เขียนมือค้างไว้รอบ ก.ค. 2026 (ตัวเลข 3.4% / −23,000 ฝังอยู่ในเนื้อความ)
  // พอตัวเลขรอบใหม่เข้ามา เนื้อหาก็ไม่ตรงกับการ์ดทันที ตอนนี้สร้างใหม่จากค่าจริงทุกครั้งที่ดึงข้อมูล
  //
  // 🔸 CONSENSUS = "ตัวเลขที่ตลาดคาดไว้ก่อนประกาศ" (consensus / forecast)
  //    ค่าด้านล่างคัดจาก Investing.com (economic calendar) เมื่อ 12 ก.ย. 2026 และเป็น "คาดการณ์ของ
  //    รอบประกาศล่าสุด" ตรงกับตัวเลขที่การ์ดด้านบนแสดงอยู่:
  //      CPI 3.4% (คาด 3.4%) · Core 2.4% (คาด 2.4%) · NFP 162K (คาด 55K) · ว่างงาน 4.1% (คาด 4.1%) · Fed 3.75%
  //    - หน้าเว็บจะลองดึงค่าสดจาก /.netlify/functions/consensus ก่อน (อ่าน Investing.com เหมือนกัน
  //      แคชไว้ 3 ชม.) ถ้าดึงไม่ได้ (เช่น Netlify โดน Cloudflare บล็อก) จึงใช้ค่าที่ฝังไว้ตรงนี้
  //      — หมายเหตุท้ายการ์ดจะบอกเสมอว่ากำลังใช้ชุดไหน ณ วันที่เท่าไร
  //    - อยากแก้ตัวเลขเอง: แก้ค่าที่ฝังไว้ในไฟล์ตรงนี้ (ปุ่มแก้ค่าในหน้าเว็บถูกถอดออกแล้ว พ.ย. 2026)
  // ---------- Initial Jobless Claims (ผู้ขอรับสวัสดิการว่างงานครั้งแรก รายสัปดาห์) ----------
  // ตัวเลขจริงมาจาก FRED (ICSA, ปรับฤดูกาล, สัปดาห์สิ้นสุดวันเสาร์) ผ่าน /fred-data · ค่าคาด/ครั้งก่อนมาจาก
  // Investing.com ผ่าน /consensus (events.claims) · ถ้า FRED ยังไม่อัปเดตรอบที่เพิ่งประกาศ (หรือล่ม)
  // ใช้ "ตามจริง" ของ Investing.com แทน — DOL ประกาศทุกวันพฤหัสฯ 8:30 ET (19:30 น. ไทยช่วง DST / 20:30 น. ช่วงหน้าหนาว)
  var LIVE_CLAIMS = null;   // { actual, forecast, previous, releaseDate }
  function fmtClaims(v){ return isValidNum(v) ? Math.round(v / 1000).toLocaleString('en-US') + 'K' : '–'; }
  function fmtClaimsDelta(v){ return (v >= 0 ? '+' : '−') + Math.round(Math.abs(v) / 1000).toLocaleString('en-US') + 'K'; }
  function addDaysIso(date, n){ const t = Date.parse(String(date) + 'T00:00:00Z'); return isFinite(t) ? new Date(t + n * 86400000).toISOString().slice(0, 10) : null; }
  function claimsView(){
    const f = (lastFedPayload && lastFedPayload.claims) || null;
    const L = LIVE_CLAIMS;
    const fredOk = !!(f && isValidNum(f.value) && /^\d{4}-\d{2}-\d{2}$/.test(String(f.date || '')));
    const liveOk = !!(L && isValidNum(L.actual) && /^\d{4}-\d{2}-\d{2}$/.test(String(L.releaseDate || '')));
    // สัปดาห์สิ้นสุดวันเสาร์ → ประกาศวันพฤหัสฯ ถัดไป (+5 วัน; สัปดาห์ที่มีวันหยุดเลื่อนเป็นวันพุธ)
    const fredRelease = fredOk ? addDaysIso(f.date, 5) : null;
    if(liveOk && (!fredOk || dayDiff(L.releaseDate, fredRelease) > 2)){
      return { value: L.actual, prev: isValidNum(L.previous) ? L.previous : null, weekEnd: null, releaseDate: L.releaseDate,
               forecast: isValidNum(L.forecast) ? L.forecast : null, source: 'Investing.com' };
    }
    if(!fredOk) return null;
    const sameRound = liveOk && Math.abs(dayDiff(L.releaseDate, fredRelease)) <= 2;
    // FRED มักอัปเดตก่อน Investing.com (แคช) — ช่วงนั้นรอบนี้ยังอยู่ในแถว "ยังไม่ประกาศ" (upcoming)
    // ถ้าวันที่ตรงกับรอบของตัวเลข FRED ก็ใช้ค่าคาดจากแถวนั้น ให้การ์ดตรงกับปฏิทิน
    const U = (!sameRound && LIVE_UPCOMING && LIVE_UPCOMING.claims) || null;
    const upRound = !!(U && isValidNum(U.forecast) && /^\d{4}-\d{2}-\d{2}$/.test(String(U.releaseDate || '')) && Math.abs(dayDiff(U.releaseDate, fredRelease)) <= 2);
    const fc = sameRound ? (isValidNum(L.forecast) ? L.forecast : null) : upRound ? U.forecast : null;
    const pv = sameRound ? (isValidNum(L.previous) ? L.previous : null) : upRound && isValidNum(U.previous) ? U.previous : null;
    return { value: f.value, prev: f.prev && isValidNum(f.prev.value) ? f.prev.value : pv,
             weekEnd: f.date, releaseDate: fredRelease, avg4: f.avg4, prevAvg4: f.prevAvg4,
             forecast: fc,
             mismatch: sameRound && Math.abs(L.actual - f.value) > 1500 ? L.actual : null, source: 'FRED' };
  }
  function renderClaims(){
    const v = claimsView();
    const num = el('claims'), info = el('claimsInfo');
    if(!num || !v) return;
    num.textContent = fmtClaims(v.value);
    // ต่ำกว่าคาด = ตลาดแรงงานดีกว่าคาด (เขียว) · สูงกว่าคาด = แย่กว่าคาด (แดง)
    if(info){
      const bits = [];
      bits.push(v.weekEnd ? tr('สัปดาห์สิ้นสุด ', 'Week ending ') + esc(thDay(v.weekEnd)) : tr('ประกาศ ', 'Released ') + esc(thDay(v.releaseDate)));
      bits.push(isValidNum(v.forecast) ? tr('คาด ', 'Forecast ') + '<b>' + esc(fmtClaims(v.forecast)) + '</b>' : tr('ยังไม่มีค่าคาด', 'No forecast yet'));
      if(isValidNum(v.prev)) bits.push(tr('ครั้งก่อน ', 'Previous ') + esc(fmtClaims(v.prev)));
      info.innerHTML = bits.join(' · ');
    }
  }

  const CONSENSUS = {
    asOf: '2026-09-12',
    source: 'Investing.com',
    cpi: 3.4,        // CPI YoY ที่ตลาดคาด (%)
    coreCpi: 2.4,    // Core CPI YoY ที่คาด (%)
    unrate: 4.1,     // อัตราว่างงานที่คาด (%)
    nfp: 55000,      // ตำแหน่งงานใหม่ที่คาด (ตำแหน่ง) — Investing.com รายงาน "55.00 พัน"
    ppi: 0.4,        // PPI MoM ที่คาด (%) — รอบประกาศ 10 ก.ย. 2026 (ตัวเลข ส.ค.)
    fed: { lo: 3.50, hi: 3.75 },  // กรอบดอกเบี้ยที่ตลาดคาด
    links: {
      cpi: 'https://th.investing.com/economic-calendar/%E0%B8%94%E0%B8%B1%E0%B8%8A%E0%B8%99%E0%B8%B5%E0%B8%A3%E0%B8%B2%E0%B8%84%E0%B8%B2%E0%B8%9C%E0%B8%B9%E0%B9%89%E0%B8%9A%E0%B8%A3%E0%B8%B4%E0%B9%82%E0%B8%A0%E0%B8%84-(cpi)-733',
      coreCpi: 'https://www.investing.com/economic-calendar/united-states-core-consumer-price-index-(cpi)-yoy-736',
      unrate: 'https://th.investing.com/economic-calendar/unemployment-rate-300',
      nfp: 'https://th.investing.com/economic-calendar/nonfarm-payrolls-227',
      fed: 'https://th.investing.com/economic-calendar/interest-rate-decision-168',
      ppi: 'https://th.investing.com/economic-calendar/ppi-238'
    }
  };

  function signedPct(v, digits){
    const n = Number(v), d = (digits == null ? 1 : digits);
    // round half away from zero like BLS; the tiny nudge stops binary floats (0.35 = 0.34999…) from rounding down
    const f = Math.pow(10, d), r = Math.round(Math.abs(n) * f + 1e-7) / f;
    return (n >= 0 ? '+' : '−') + r.toFixed(d);
  }
  function ppDelta(v){ return signedPct(v, 2) + 'pp'; }
  window.signedPct = signedPct;   // tests/index-html.test.js
  function daysSince(dateStr){
    const t = Date.parse(String(dateStr || '') + (String(dateStr || '').length === 10 ? 'T00:00:00Z' : ''));
    return isFinite(t) ? Math.round((Date.now() - t) / 86400000) : null;
  }
  // ระบายสีตัวเลขบนการ์ดด้วยสีเดียวกับกล่องวิเคราะห์ (เขียว = ดีกว่าคาด · แดง = แย่กว่าคาด · เหลือง = ใกล้เคียง · ไม่มีค่าคาด = สีปกติ)
  const TONE_CLASS = { 'var(--good)': 'tone-good', 'var(--bad)': 'tone-bad', 'var(--warn)': 'tone-warn', 'var(--cool)': 'tone-cool' };
  function toneNum(id, accent){
    const n = el(id);
    if(!n) return;
    const base = String(n.className || '').split(/\s+/).filter(c => c && !/^tone-/.test(c));
    if(TONE_CLASS[accent]) base.push(TONE_CLASS[accent]);
    n.className = base.join(' ');
  }
  window.toneNum = toneNum;
  function analysisCard(accent, title, body){
    return '<div style="padding:10px 12px; background:var(--panel2); border-radius:8px; border-left:3px solid ' + accent + ';">'
      + '<b style="font-size:12.5px;">' + title + '</b>'
      + '<div class="muted" style="font-size:11.5px; margin-top:4px; line-height:1.6;">' + body + '</div>'
      + '</div>';
  }

  // ── consensus สดจากเซิร์ฟเวอร์ (อ่าน Investing.com, แคช 3 ชม.) ─────────────────────────────
  let LIVE_CONSENSUS = null;
  let consensusFetchedAt = 0;
  let consensusTtlMs = 0;   // ตามที่เซิร์ฟเวอร์บอก (สั้นลงในวันประกาศ) — 0 = ใช้ CONSENSUS_TTL_MS
  let lastFedPayload = null;
  let LIVE_UPCOMING = {};   // ค่าคาดของรอบที่ยังไม่ประกาศ จาก /consensus → { cpi: { releaseDate, forecast, previous }, ... }
  const CONSENSUS_TTL_MS = 3 * 60 * 60 * 1000;

  // รวมค่าที่จะใช้จริง — ทีละฟิลด์ (ค่าสด  >  ค่าที่ฝังไว้)
  function activeConsensus(){
    const live = LIVE_CONSENSUS || {};
    const num = (v, fb) => (isValidNum(v) ? v : fb);
    const liveFedHi = live.fed && isValidNum(live.fed.hi) ? live.fed.hi : null;
    const liveFedLo = live.fed && isValidNum(live.fed.lo) ? live.fed.lo : null;
    return {
      live: !!LIVE_CONSENSUS,
      source: live.source || CONSENSUS.source,
      asOf: live.asOf || CONSENSUS.asOf,
      cpi: num(live.cpi, CONSENSUS.cpi),
      coreCpi: num(live.coreCpi, CONSENSUS.coreCpi),
      ppi: num(live.ppi, CONSENSUS.ppi),
      unrate: num(live.unrate, CONSENSUS.unrate),
      nfp: num(live.nfp, CONSENSUS.nfp),
      fedHi: num(liveFedHi, CONSENSUS.fed.hi),
      fedLo: num(liveFedLo, CONSENSUS.fed.lo),
      // ค่า "ตามจริง" ของรอบล่าสุดจาก Investing.com — ใช้ตรวจว่า consensus ตรงรอบกับตัวเลขบนการ์ด
      actuals: live.actuals || null,
      // แต่ละช่องมาจากไหน — 'baked' = ค่าสำรองที่ฝังไว้ (เป็นของรอบประกาศ ณ CONSENSUS.asOf เท่านั้น)
      from: ['cpi','coreCpi','ppi','unrate','nfp'].reduce((o, k) => {
        o[k] = isValidNum(live[k]) ? 'live' : 'baked';
        return o;
      }, { fed: isValidNum(liveFedHi) ? 'live' : 'baked' })
    };
  }
  const OVERRIDE_LABELS = { cpi:'CPI', coreCpi:'Core CPI', ppi:'PPI', unrate:tr('ว่างงาน', 'Unemployment'), nfp:'NFP', fedLo:tr('Fed ขอบล่าง', 'Fed lower'), fedHi:tr('Fed ขอบบน', 'Fed upper') };

  async function loadConsensus(){
    if(LIVE_CONSENSUS && (Date.now() - consensusFetchedAt) < (consensusTtlMs || CONSENSUS_TTL_MS)) return;
    consensusFetchedAt = Date.now();
    try{
      const r = await fetchWithTimeout('/.netlify/functions/consensus', 10000, { cache: 'no-cache' });
      const j = await r.json();
      consensusTtlMs = (j && isValidNum(j.ttl) && j.ttl > 0) ? Math.min(j.ttl * 1000, CONSENSUS_TTL_MS) : 0;
      const ev = j && j.events;
      if(!ev) return;
      const numOf = (k, field) => (ev[k] && isValidNum(ev[k][field])) ? ev[k][field] : null;
      // ค่าคาดของ "รอบถัดไป" (ยังไม่ประกาศ) — ใช้แสดงก่อนตัวเลขจริงออก ไม่ขึ้นกับเงื่อนไข 3 ตัวด้านล่าง
      const upcoming = {};
      Object.keys(ev).forEach(k => {
        const u = ev[k] && ev[k].upcoming;
        if(u && /^\d{4}-\d{2}-\d{2}$/.test(String(u.releaseDate || '')) && isValidNum(u.forecast)) upcoming[k] = { releaseDate: u.releaseDate, forecast: u.forecast, previous: isValidNum(u.previous) ? u.previous : null };
      });
      LIVE_UPCOMING = upcoming;
      const c = ev.claims;
      if(c && isValidNum(c.actual) && /^\d{4}-\d{2}-\d{2}$/.test(String(c.releaseDate || ''))){
        LIVE_CLAIMS = { actual: c.actual, forecast: isValidNum(c.forecast) ? c.forecast : null, previous: isValidNum(c.previous) ? c.previous : null, releaseDate: c.releaseDate };
      }
      // ยอดค้าปลีก · ยอดขายบ้าน · ISM — ตามจริง/ค่าคาดของรอบล่าสุด (สำรองให้ /econ-extra)
      const lx = {};
      ['retail', 'homeSales', 'ismMfg', 'ismSvc'].forEach(k => {
        const e = ev[k];
        if(e && isValidNum(e.actual) && /^\d{4}-\d{2}-\d{2}$/.test(String(e.releaseDate || ''))) lx[k] = { actual: e.actual, forecast: isValidNum(e.forecast) ? e.forecast : null, previous: isValidNum(e.previous) ? e.previous : null, releaseDate: e.releaseDate };
      });
      LIVE_EXTRA = lx;
      try{ renderExtraCards(); }catch(e){ /* best-effort */ }
      try{
        renderClaims();
        renderNextReleases();
        if(CAL_EVENTS && CAL_EVENTS.length) renderCalendar(CAL_EVENTS);
        if(lastFedPayload) renderFedAnalysis(lastFedPayload);
      }catch(e){ /* best-effort */ }
      const next = {
        source: j.sourceLabel || 'Investing.com',
        asOf: (ev.cpi && ev.cpi.releaseDate) || CONSENSUS.asOf,
        cpi: numOf('cpi','forecast'),
        coreCpi: numOf('coreCpi','forecast'),
        unrate: numOf('unrate','forecast'),
        nfp: numOf('nfp','forecast'),
        ppi: numOf('ppi','forecast'),
        fed: (ev.fed && isValidNum(ev.fed.actual)) ? { lo: null, hi: ev.fed.actual } : null,
        actuals: {
          cpi: numOf('cpi','actual'), coreCpi: numOf('coreCpi','actual'),
          unrate: numOf('unrate','actual'), nfp: numOf('nfp','actual'),
          ppi: numOf('ppi','actual')
        }
      };
      // ต้องได้อย่างน้อย 3 ตัวถึงจะใช้ (กันหน้าเว็บที่อ่านได้ครึ่งเดียวแล้วทำให้บทวิเคราะห์เพี้ยน)
      const got = [next.cpi, next.coreCpi, next.unrate, next.nfp].filter(v => isValidNum(v)).length;
      if(got < 3 || !next.fed) return;
      LIVE_CONSENSUS = next;
      if(lastFedPayload) renderFedAnalysis(lastFedPayload);   // สร้างบทวิเคราะห์ใหม่ทันที
    }catch(e){ /* เงียบไว้ — ใช้ค่าที่ฝังใน CONSENSUS */ }
  }

  // การ์ด US Macro — ป้ายสถานะ = "ระดับนี้หมายถึงอะไรต่อตลาด" (แบบเดียวกับการ์ด Real Yield / ชุดบ้าน-ค้าปลีก)
  // สีตัวเลขใหญ่ จุดสถานะ และหัวกล่องวิเคราะห์ใช้ verdict เดียวกัน · ผลเทียบค่าคาดเป็นข้อความในกล่องวิเคราะห์
  // เกณฑ์ของแต่ละสีเขียนไว้ในปุ่ม (i) ของการ์ด
  function macroV(dot, th, en){
    return { accent: dot === '🟢' ? 'var(--good)' : dot === '🔴' ? 'var(--bad)' : 'var(--warn)', dot: dot, label: tr(th, en) };
  }
  const macroVerdicts = {
    fed: (changePp, fresh) => (fresh && isValidNum(changePp) && changePp > 0) ? macroV('🔴', 'เพิ่งขึ้นดอกเบี้ย กดดันหุ้น/คริปโต', 'Just hiked: pressure on stocks/crypto')
      : (fresh && isValidNum(changePp) && changePp < 0) ? macroV('🟢', 'เพิ่งลดดอกเบี้ย หนุนหุ้น/คริปโต', 'Just cut: supports stocks/crypto')
      : macroV('🟡', 'คงดอกเบี้ย เป็นกลาง', 'On hold: neutral'),
    inflation: (v) => v < 2.5 ? macroV('🟢', 'ใกล้เป้า 2% เปิดทาง Fed ลดดอกเบี้ย หนุนหุ้น/บอนด์', 'Near the 2% target: room for Fed cuts, supports stocks/bonds')
      : v < 3 ? macroV('🟡', 'สูงกว่าเป้า 2% เล็กน้อย', 'A bit above the 2% target')
      : macroV('🔴', 'สูงกว่าเป้า 2% มาก Fed ลดดอกเบี้ยยาก กดดันหุ้น/บอนด์', 'Well above the 2% target: hard for the Fed to cut, pressure on stocks/bonds'),
    ppi: (yoy, mom) => isValidNum(yoy)
      ? (yoy < 2.5 ? macroV('🟢', 'ต้นทุนผู้ผลิตนิ่ง', 'Producer costs steady')
        : yoy < 4 ? macroV('🟡', 'ต้นทุนเร่งขึ้น จับตาส่งต่อไป CPI', 'Costs picking up: watch pass-through to CPI')
        : macroV('🔴', 'ต้นทุนสูง เสี่ยงดัน CPI ขึ้น กดดันหุ้น/บอนด์', 'High costs: risk of pushing CPI up, pressure on stocks/bonds'))
      : (Math.round(mom * 10) / 10 <= 0.2 ? macroV('🟢', 'ต้นทุนผู้ผลิตนิ่ง', 'Producer costs steady')
        : Math.round(mom * 10) / 10 <= 0.4 ? macroV('🟡', 'ต้นทุนเร่งขึ้น จับตาส่งต่อไป CPI', 'Costs picking up: watch pass-through to CPI')
        : macroV('🔴', 'ต้นทุนสูง เสี่ยงดัน CPI ขึ้น กดดันหุ้น/บอนด์', 'High costs: risk of pushing CPI up, pressure on stocks/bonds')),
    unrate: (v, ch3m) => (v >= 5 || (isValidNum(ch3m) && ch3m >= 0.5)) ? macroV('🔴', 'ว่างงานสูง/พุ่งเร็ว สัญญาณถดถอย กดดันหุ้น', 'High or jumping: recession signal, pressure on stocks')
      : (v >= 4.5 || (isValidNum(ch3m) && ch3m >= 0.3)) ? macroV('🟡', 'ตลาดแรงงานเริ่มอ่อน Fed มีเหตุลดดอกเบี้ย', 'Labour market softening: a reason for Fed cuts')
      : macroV('🟢', 'ตลาดแรงงานยังแข็ง เศรษฐกิจไม่ถดถอย', 'Labour market solid: no recession'),
    nfp: (n) => n >= 150000 ? macroV('🟢', 'จ้างงานแข็ง เศรษฐกิจยังโต', 'Strong hiring: economy growing')
      : n >= 50000 ? macroV('🟡', 'จ้างงานชะลอ', 'Hiring slowing')
      : macroV('🔴', 'จ้างงานอ่อน เสี่ยงเศรษฐกิจชะลอ', 'Weak hiring: slowdown risk'),
    claims: (v) => v < 230000 ? macroV('🟢', 'ต่ำ ตลาดแรงงานยังแน่น', 'Low: labour market still tight')
      : v < 300000 ? macroV('🟡', 'ปานกลาง ตลาดแรงงานเริ่มผ่อน', 'Moderate: labour market loosening')
      : macroV('🔴', 'สูง ตลาดแรงงานอ่อนแรง', 'High: weak labour market')
  };
  window.macroVerdicts = macroVerdicts;   // tests
  function setMacroZone(id, v){
    toneNum(id, v ? v.accent : null);
    const z = el(id + 'Zone');
    if(z) z.textContent = v ? v.dot + ' ' + v.label : '';
  }

  function renderFedAnalysis(data, failReason){
    const box = el('fedAnalysis');
    if(!box) return;
    if(data) lastFedPayload = data;
    const d = data || {};
    if(!hasAnyFedField(d)){
      box.innerHTML = failReason
        ? '<div class="muted" style="font-size:11.5px;">' + tr('⚠️ วิเคราะห์อัตโนมัติยังทำไม่ได้ในขณะนี้ — จะแสดงทันทีที่ได้ตัวเลข', '⚠️ The automatic analysis isn\'t available right now. It will appear as soon as the numbers arrive.') + '</div>'
        : '<div class="muted" style="font-size:11.5px;">' + tr('⏳ กำลังรอตัวเลขจริงเพื่อวิเคราะห์…', '⏳ Waiting for the actual numbers to analyse…') + '</div>';
      return;
    }

    const C = activeConsensus();
    // Investing.com รายงาน "ระดับที่ตลาดคาด" (ขอบบนของกรอบเป้า) จึงเทียบกับขอบบนของกรอบจริง
    const consFedText = isValidNum(C.fedLo) ? (C.fedLo.toFixed(2) + '–' + C.fedHi.toFixed(2) + '%') : (C.fedHi.toFixed(2) + '%');
    const cards = [];
    const GREEN = 'var(--good)', RED = 'var(--bad)', AMBER = 'var(--warn)', GREY = 'var(--muted)';
    // ค่าสำรองที่ฝังไว้เป็น "ค่าคาดของรอบที่ประกาศ ณ CONSENSUS.asOf" (= ตัวเลขของเดือนก่อนหน้านั้น)
    // ถ้าตัวเลขบนการ์ดเป็นเดือนที่ใหม่กว่า ค่านั้นไม่ใช่ค่าคาดของรอบนี้ → ไม่ตัดสินว่าดี/แย่กว่าคาด
    // (ต.ค. 2026: CPI ก.ย. 3.7% ถูกเทียบกับค่าคาดรอบ ส.ค. 3.4% แล้วขึ้นว่า "สูงกว่าที่คาด" ทั้งที่ตลาดคาด 3.6%)
    const bakedMonth = (function(){ const m = /^(\d{4})-(\d{2})/.exec(String(CONSENSUS.asOf)); if(!m) return ''; const dt = new Date(Date.UTC(+m[1], +m[2] - 2, 1)); return dt.toISOString().slice(0, 7); })();
    const consFor = (key, printDate) => (C.from[key] === 'baked' && bakedMonth && String(printDate || '').slice(0, 7) > bakedMonth) ? null : C[key];
    const NOCONS = tr('⚪ ยังไม่มีค่าคาดของรอบนี้', '⚪ No forecast for this release yet');
    const noConsText = tr(' · ยังไม่มีค่าคาดของรอบนี้ให้เทียบ (ค่าสำรองที่ฝังไว้เป็นของรอบ ', ' · no forecast for this release to compare against (the built-in fallback is for the ') + esc(thMonth(bakedMonth)) + tr(')', ' release)');
    // ส่วนท้ายของ verdict (ตัดอีโมจิออก) ใช้ต่อท้าย "ตลาดคาด … →" — โหมดอังกฤษทำเป็นตัวพิมพ์เล็ก
    const verdictTail = v => { const t = v.replace(/^[^\s]+\s/, ''); return EN ? t.charAt(0).toLowerCase() + t.slice(1) : t; };
    // หัวกล่อง = สถานะ (สีเดียวกับการ์ด) + ผลเทียบค่าคาดต่อท้าย
    const vsCons = (verdict, has) => ' · ' + (has ? tr('เทียบคาด: ', 'vs forecast: ') + verdictTail(verdict) : verdictTail(NOCONS));

    // ── 1) Fed Funds Rate ────────────────────────────────────────────────────────────────────
    if(d.upper && d.lower && isValidNum(d.upper.value) && isValidNum(d.lower.value)){
      const lo = d.lower.value, hi = d.upper.value, mid = (lo + hi) / 2;
      const consHi = C.fedHi;
      const since = d.upper.sinceDate || null;
      const age = since ? daysSince(since) : null;
      const fresh = age != null && age <= 45;      // ขึ้น/ลงครั้งล่าสุดภายใน FOMC รอบล่าสุด
      const meetings = d.upper.meetingsSinceChange;

      let accent = AMBER, verdict = tr('🟡 คงที่', '🟡 Unchanged');
      let body = tr('เป้าดอกเบี้ยล่าสุด ', 'Current target range ') + '<b>' + lo.toFixed(2) + '–' + hi.toFixed(2) + '%</b>';
      if(fresh && isValidNum(d.upper.changePp) && d.upper.changePp !== 0){
        const up = d.upper.changePp > 0;
        const dir = up ? 'ขึ้น' : 'ลด';
        accent = up ? RED : GREEN;
        verdict = (up ? '🔴 ' : '🟢 ') + tr(dir + 'ดอกเบี้ย ', up ? 'Rate hike ' : 'Rate cut ') + Math.abs(d.upper.changePp).toFixed(2) + 'pp';
        body += tr(' — FOMC ' + dir + 'เมื่อ ' + esc(thMonth(since)) + ' (มีผลมาระยะหนึ่งแล้ว)', ' — the FOMC ' + (up ? 'raised' : 'cut') + ' rates in ' + esc(thMonth(since)) + ' (already in effect for a while)');
      }else{
        body += since ? tr(' — ยังไม่ขยับตั้งแต่ ', ' — unchanged since ') + esc(thMonth(since)) : '';
        if(meetings != null) body += tr(' (ผ่านการประชุม FOMC มาแล้ว ' + meetings + ' ครั้ง)', ' (' + meetings + ' FOMC meeting' + (meetings === 1 ? '' : 's') + ' since)');
        if(isValidNum(d.upper.prevValue)) body += tr(' · ก่อนหน้านั้น ', ' · before that ') + d.upper.prevValue.toFixed(2) + '%';
      }
      // ค่าที่ฝังไว้เป็นค่าคาดของ FOMC ก่อน CONSENSUS.asOf — ถ้ากรอบดอกเบี้ยเปลี่ยนหลังวันนั้น ห้ามเอามาเทียบ
      if(C.from.fed === 'baked' && since && since > CONSENSUS.asOf) body += tr(' · ยังไม่มีค่าคาดของรอบนี้ให้เทียบ', ' · no forecast for this meeting to compare against');
      else if(consHi < hi - 0.001) body += tr(' · เข้มงวดกว่าที่ตลาดคาดไว้ (', ' · tighter than the market expected (') + consFedText + tr(') → กดดันสินทรัพย์เสี่ยง', ') → pressure on risk assets');
      else if(consHi > hi + 0.001) body += tr(' · ผ่อนคลายกว่าที่ตลาดคาดไว้ (', ' · looser than the market expected (') + consFedText + tr(') → หนุนสินทรัพย์เสี่ยง', ') → supports risk assets');
      else body += tr(' · ตรงกับที่ตลาดคาดไว้ (', ' · in line with market expectations (') + consFedText + ')';
      const nextFomc = el('fomcDateLabel');
      if(nextFomc && nextFomc.textContent) body += tr(' · รอบถัดไป ', ' · next meeting ') + esc(nextFomc.textContent);
      body += nextReleaseLine('fed');
      body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (fresh ? (d.upper.changePp > 0 ? tr('การขึ้นดอกเบี้ยกดดันหุ้น/คริปโตและหนุนดอลลาร์', 'a hike pressures stocks/crypto and supports the dollar') : tr('การลดดอกเบี้ยหนุนหุ้น/คริปโตและกดดันดอลลาร์', 'a cut supports stocks/crypto and weighs on the dollar')) : tr('การยืนดอกเบี้ยนิ่ง = เป็นกลาง ไม่มีเซอร์ไพรส์จากฝั่งนโยบาย', 'holding rates steady = neutral, no policy surprise'));
      const mv = macroVerdicts.fed(d.upper.changePp, fresh);
      setMacroZone('fedRange', mv);
      setMacroZone('fedEffr', mv);
      cards.push(analysisCard(mv.accent, 'Fed Funds Rate — ' + mv.dot + ' ' + mv.label + (fresh && isValidNum(d.upper.changePp) && d.upper.changePp !== 0 ? ' (' + verdict.replace(/^[^\s]+\s/, '') + ')' : ''), body));
    }

    // ── 2) CPI (headline + core) ─────────────────────────────────────────────────────────────
    if(d.cpi && isValidNum(d.cpi.value)){
      const cpi = d.cpi.value;
      const cons = consFor('cpi', d.cpi.date);
      const dev = isValidNum(cons) ? cpi - cons : null;
      const chg = isValidNum(d.cpi.changePp) ? d.cpi.changePp : null;
      let accent = dev == null ? GREY : Math.abs(dev) <= 0.1 ? AMBER : (dev > 0 ? RED : GREEN);
      const verdict = dev == null ? NOCONS : Math.abs(dev) <= 0.1 ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : (dev > 0 ? tr('🔴 สูงกว่าที่คาด', '🔴 Above forecast') : tr('🟢 ต่ำกว่าที่คาด', '🟢 Below forecast'));

      let body = tr('CPI เดือน ' + esc(thMonth(d.cpi.date)) + ' อยู่ที่ ', esc(thMonth(d.cpi.date)) + ' CPI came in at ') + '<b>' + cpi.toFixed(1) + '% YoY</b>';
      if(d.coreCpi && isValidNum(d.coreCpi.value)) body += ' (Core ' + d.coreCpi.value.toFixed(1) + '%)';
      if(dev == null) body += noConsText;
      else body += tr(' · ตลาดคาด ', ' · forecast ') + cons.toFixed(1) + '% → ' + verdictTail(verdict);
      if(dev != null && Math.abs(dev) > 0.05) body += tr(' ', ' by ') + Math.abs(dev).toFixed(1) + 'pp';
      if(chg != null) body += tr('<br>เทียบเดือนก่อน (', '<br>vs previous month (') + esc(thMonth(d.cpi.prev ? d.cpi.prev.date : '')) + ' ' + (d.cpi.prev ? d.cpi.prev.value.toFixed(1) : '–') + '%) = ' + (chg <= -0.05 ? tr('ชะลอลง ', 'slowed ') + Math.abs(chg).toFixed(1) + 'pp' : chg >= 0.05 ? tr('เร่งขึ้น ', 'accelerated ') + chg.toFixed(1) + 'pp' : tr('ทรงตัว', 'unchanged'));
      const consCore = d.coreCpi ? consFor('coreCpi', d.coreCpi.date) : null;
      if(d.coreCpi && isValidNum(d.coreCpi.value) && isValidNum(consCore)) body += ' · Core ' + (d.coreCpi.value > consCore + 0.1 ? tr('ยังสูงกว่าที่คาด (แรงกดดันเงินเฟ้อพื้นฐานยังไม่คลาย)', 'still above forecast (underlying inflation pressure hasn\'t eased)') : d.coreCpi.value < consCore - 0.1 ? tr('ต่ำกว่าที่คาด', 'below forecast') : tr('ตามคาด', 'as expected'));
      body += cpi > 2 ? tr('<br>ยัง<b>สูงกว่าเป้าหมาย 2% ของ Fed</b> → เป็นเหตุผลให้ Fed ยังไม่รีบลดดอกเบี้ย', '<br>Still <b>above the Fed\'s 2% target</b> → a reason for the Fed not to rush rate cuts') : tr('<br>อยู่ในกรอบเป้าหมาย 2% ของ Fed แล้ว', '<br>Now within the Fed\'s 2% target');
      try{ const nh = cpiNoYoyHtml(d.cpi, d.coreCpi); if(nh) body += '<br>⚠️ ' + nh; }catch(e){ /* best-effort */ }
      body += nextReleaseLine('cpi');
      if(dev != null) body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (dev > 0.1 ? tr('เงินเฟ้อสูงกว่าคาด = กดดันหุ้น/พันธบัตร (Fed ลดดอกเบี้ยช้าลง)', 'hotter inflation = pressure on stocks/bonds (slower Fed cuts)') : dev < -0.1 ? tr('เงินเฟ้อต่ำกว่าคาด = หนุนหุ้น (Fed มีทางลดดอกเบี้ยเร็วขึ้น)', 'cooler inflation = supports stocks (room for faster Fed cuts)') : tr('ตรงคาด = ตลาดมักไม่ตอบสนองรุนแรงเพราะไม่มีเซอร์ไพรส์', 'in line = markets usually don\'t react much, no surprise'));
      const mv = macroVerdicts.inflation(cpi);
      setMacroZone('cpiYoy', mv);
      cards.push(analysisCard(mv.accent, tr('CPI เงินเฟ้อ — ', 'CPI inflation — ') + mv.dot + ' ' + mv.label + vsCons(verdict, dev != null), body));
    }

    // ── 2a) Core PCE (เงินเฟ้อที่ Fed ใช้ตั้งเป้า 2%) ────────────────────────────────────────
    if(d.corePce && isValidNum(d.corePce.value)){
      const v = d.corePce.value;
      const mv = macroVerdicts.inflation(v);
      setMacroZone('corePce', mv);
      let body = tr('Core PCE เดือน ' + esc(thMonth(d.corePce.date)) + ' อยู่ที่ ', esc(thMonth(d.corePce.date)) + ' Core PCE: ') + '<b>' + v.toFixed(1) + '% YoY</b>';
      if(isValidNum(d.corePce.changePp)) body += tr(' · เทียบเดือนก่อน ', ' · vs previous month ') + (d.corePce.changePp >= 0.05 ? tr('เร่งขึ้น ', 'up ') + d.corePce.changePp.toFixed(1) + 'pp' : d.corePce.changePp <= -0.05 ? tr('ชะลอลง ', 'down ') + Math.abs(d.corePce.changePp).toFixed(1) + 'pp' : tr('ทรงตัว', 'unchanged'));
      body += tr('<br>เป็นตัวเลขที่ Fed ใช้ตั้งเป้า 2% โดยตรง ', '<br>This is the gauge the Fed targets at 2%: ') + (v > 2 ? tr('ห่างเป้า ', 'it is ') + (v - 2).toFixed(1) + tr('pp → ยิ่งห่าง Fed ยิ่งไม่รีบลดดอกเบี้ย', 'pp above → the further above, the slower the Fed cuts') : tr('อยู่ในเป้าแล้ว', 'within target'));
      body += nextReleaseLine('pce');
      cards.push(analysisCard(mv.accent, 'Core PCE — ' + mv.dot + ' ' + mv.label, body));
    }

    // ── 2b) PPI ราคาผู้ผลิต (final demand, MoM) ─────────────────────────────────────────────
    // ตัวเลขหลักที่ตลาดดูคือ % เปลี่ยนจากเดือนก่อน (ปรับฤดูกาล) — ค่าคาดของ Investing.com ก็เป็น MoM
    if(d.ppi && isValidNum(d.ppi.value)){
      const p = Math.round(d.ppi.value * 10) / 10;   // เทียบที่ความละเอียดเดียวกับที่ประกาศ/ที่คาด
      const cons = consFor('ppi', d.ppi.date);
      const dev = isValidNum(cons) ? p - cons : null;
      const near = dev != null && Math.abs(dev) < 0.05;   // MoM รายงานทศนิยม 1 ตำแหน่ง: ต่าง 0.1 = พลาดคาดแล้ว
      const accent = dev == null ? GREY : near ? AMBER : (dev > 0 ? RED : GREEN);
      const verdict = dev == null ? NOCONS : near ? tr('🟡 ตรงตามคาด', '🟡 In line') : (dev > 0 ? tr('🔴 สูงกว่าที่คาด', '🔴 Above forecast') : tr('🟢 ต่ำกว่าที่คาด', '🟢 Below forecast'));

      let body = tr('PPI เดือน ' + esc(thMonth(d.ppi.date)), esc(thMonth(d.ppi.date)) + ' PPI') + ' <b>' + signedPct(p, 1) + '% MoM</b>';
      if(isValidNum(d.ppi.yoy)) body += ' (YoY ' + d.ppi.yoy.toFixed(1) + '%)';
      if(dev == null) body += noConsText;
      else body += tr(' · ตลาดคาด ', ' · forecast ') + signedPct(cons, 1) + '% → ' + verdictTail(verdict);
      if(dev != null && !near) body += tr(' ', ' by ') + Math.abs(dev).toFixed(1) + 'pp';
      if(d.ppi.prev && isValidNum(d.ppi.prev.value)){
        const chg = p - d.ppi.prev.value;
        body += tr('<br>เทียบเดือนก่อน (', '<br>vs previous month (') + esc(thMonth(d.ppi.prev.date)) + ' ' + signedPct(d.ppi.prev.value, 1) + '%) = ' + (chg <= -0.05 ? tr('ชะลอลง', 'slowed') : chg >= 0.05 ? tr('เร่งขึ้น', 'accelerated') : tr('ทรงตัว', 'unchanged'));
      }
      body += nextReleaseLine('ppi');
      if(dev != null) body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (dev >= 0.05 ? tr('ต้นทุนผู้ผลิตสูงกว่าคาด = มักส่งต่อไปที่ CPI ในเดือนถัด ๆ ไป → กดดันหุ้น/พันธบัตร (Fed ลดดอกเบี้ยช้าลง)', 'producer costs above forecast = often pass through to CPI in the following months → pressure on stocks/bonds (slower Fed cuts)') : dev <= -0.05 ? tr('ต้นทุนผู้ผลิตต่ำกว่าคาด = แรงกดดันเงินเฟ้อข้างหน้าเบาลง → หนุนหุ้น', 'producer costs below forecast = less inflation pressure ahead → supports stocks') : tr('ตรงคาด = ตลาดมักไม่ตอบสนองแรง', 'in line = markets usually don\'t react much'));
      const mv = macroVerdicts.ppi(d.ppi.yoy, p);
      setMacroZone('ppiHead', mv);
      cards.push(analysisCard(mv.accent, tr('PPI ราคาผู้ผลิต — ', 'PPI producer prices — ') + mv.dot + ' ' + mv.label + vsCons(verdict, dev != null), body));
    }

    // ── 3) Unemployment ──────────────────────────────────────────────────────────────────────
    if(d.unrate && isValidNum(d.unrate.value)){
      const u = d.unrate.value;
      const cons = consFor('unrate', d.unrate.date);
      const dev = isValidNum(cons) ? u - cons : null;   // ต่ำกว่าคาด = ตลาดแรงงานแข็งแรง
      const mom = isValidNum(d.unrate.changeMoM) ? d.unrate.changeMoM : null;
      let accent = dev == null ? GREY : Math.abs(dev) <= 0.1 ? AMBER : (dev < 0 ? GREEN : RED);
      const verdict = dev == null ? NOCONS : Math.abs(dev) <= 0.1 ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : (dev < 0 ? tr('🟢 ดีกว่าที่คาด', '🟢 Better than forecast') : tr('🔴 แย่กว่าที่คาด', '🔴 Worse than forecast'));

      let body = tr('อัตราว่างงานเดือน ' + esc(thMonth(d.unrate.date)) + ' อยู่ที่ ', esc(thMonth(d.unrate.date)) + ' unemployment rate: ') + '<b>' + u.toFixed(1) + '%</b>'
        + (dev == null ? noConsText : tr(' · ตลาดคาด ', ' · forecast ') + cons.toFixed(1) + '% → ' + verdictTail(verdict));
      if(dev != null && Math.abs(dev) > 0.05) body += tr(' ', ' by ') + Math.abs(dev).toFixed(1) + 'pp';
      if(mom != null) body += tr('<br>เทียบเดือนก่อน = ', '<br>vs previous month = ') + (mom > 0 ? tr('เพิ่มขึ้น ', 'up ') + mom.toFixed(1) + tr('pp (ตลาดแรงงานอ่อนลง)', 'pp (labour market softening)') : mom < 0 ? tr('ลดลง ', 'down ') + Math.abs(mom).toFixed(1) + 'pp' : tr('ทรงตัว', 'unchanged'));
      if(isValidNum(d.unrate.change3m)) body += tr(' · เทียบ 3 เดือนก่อน = ', ' · vs 3 months ago = ') + ppDelta(d.unrate.change3m);
      body += nextReleaseLine('unrate');
      body += tr('<br><b>ข้อควรระวัง:</b> ตัวเลขว่างงานต่ำลงอาจมาจาก "คนออกจากตลาดแรงงาน" ไม่ใช่มีคนได้งานเพิ่ม (ดู participation rate ประกอบ) และตัวเลขนี้เป็นรายเดือน อาจถูก revise ได้',
                 '<br><b>Caveat:</b> a lower unemployment rate can come from people leaving the labour force rather than more people finding jobs (check the participation rate too), and this monthly figure can be revised');
      if(dev != null) body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (dev < -0.1 ? tr('ดีกว่าคาด = หนุนความเชื่อมั่น แต่ลดโอกาสที่ Fed จะรีบลดดอกเบี้ย', 'better than forecast = supports confidence, but lowers the odds of quick Fed cuts') : dev > 0.1 ? tr('แย่กว่าคาด = เพิ่มโอกาส Fed ลดดอกเบี้ย (bad news is good news ระยะสั้น) แต่น่ากังวลเรื่องเศรษฐกิจถดถอย', 'worse than forecast = raises the odds of Fed cuts (bad news is good news short term) but adds recession worries') : tr('ตรงคาด = เป็นกลาง', 'in line = neutral'));
      const mv = macroVerdicts.unrate(u, d.unrate.change3m);
      setMacroZone('unrate', mv);
      cards.push(analysisCard(mv.accent, 'Unemployment Rate — ' + mv.dot + ' ' + mv.label + vsCons(verdict, dev != null), body));
    }

    // ── 4) Nonfarm Payrolls ──────────────────────────────────────────────────────────────────
    if(d.nfp && isValidNum(d.nfp.value)){
      const n = d.nfp.value;
      const cons = consFor('nfp', d.nfp.date);
      const dev = isValidNum(cons) ? n - cons : null;
      let accent = dev == null ? GREY : Math.abs(dev) < 30000 ? AMBER : (dev > 0 ? GREEN : RED);
      const verdict = dev == null ? NOCONS : Math.abs(dev) < 30000 ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : (dev > 0 ? tr('🟢 ดีกว่าที่คาด', '🟢 Better than forecast') : tr('🔴 แย่กว่าที่คาด', '🔴 Worse than forecast'));

      let body = tr('จ้างงานเดือน ' + esc(thMonth(d.nfp.date)) + ' = ', esc(thMonth(d.nfp.date)) + ' payrolls = ') + '<b>' + esc(fmtJobs(n)) + tr(' ตำแหน่ง', ' jobs') + '</b>'
        + (dev == null ? noConsText : tr(' · ตลาดคาด ', ' · forecast ') + esc(fmtJobs(cons)) + ' → ' + verdictTail(verdict));
      if(dev != null && Math.abs(dev) >= 1000) body += tr(' ', ' by ') + Math.abs(dev).toLocaleString('en-US') + tr(' ตำแหน่ง', ' jobs');
      if(isValidNum(d.nfp.avg3Change)) body += tr('<br>ค่าเฉลี่ย 3 เดือนล่าสุด = ', '<br>3-month average = ') + esc(fmtJobs(d.nfp.avg3Change)) + tr(' ตำแหน่ง/เดือน', ' jobs/month') + (isValidNum(d.nfp.prevChange) ? tr(' · เดือนก่อนหน้า = ', ' · previous month = ') + esc(fmtJobs(d.nfp.prevChange)) : '');
      if(isValidNum(d.nfp.avg3Change)){
        body += n < d.nfp.avg3Change
          ? tr(' → รอบนี้อ่อนกว่าค่าเฉลี่ยล่าสุด (ตลาดแรงงานชะลอ)', ' → weaker than the recent average (labour market slowing)')
          : tr(' → รอบนี้แข็งกว่าค่าเฉลี่ยล่าสุด', ' → stronger than the recent average');
      }
      body += nextReleaseLine('nfp');
      if(dev != null || n < 0) body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (n < 0 ? tr('ตัวเลขติดลบ = ข่าวร้ายของเศรษฐกิจ แต่ระยะสั้นตลาดอาจตีความว่า Fed จะรีบลดดอกเบี้ย (bad news is good news) — ถ้าติดลบต่อเนื่องหลายเดือนจะกลายเป็นสัญญาณถดถอยจริงจัง', 'a negative print = bad news for the economy, but short term markets may read it as the Fed cutting sooner (bad news is good news). Several negative months in a row would be a serious recession signal') : dev < -30000 ? tr('อ่อนกว่าคาด = เพิ่มโอกาส Fed ลดดอกเบี้ย แต่กดดันความเชื่อมั่นเศรษฐกิจ', 'weaker than forecast = higher odds of Fed cuts, but weighs on economic confidence') : dev > 30000 ? tr('แข็งกว่าคาด = เศรษฐกิจยังดี แต่ลดโอกาส Fed ลดดอกเบี้ยเร็ว ๆ นี้', 'stronger than forecast = the economy is still solid, but lowers the odds of a Fed cut soon') : tr('ใกล้เคียงคาด = เป็นกลาง', 'close to forecast = neutral'));
      body += '<br><span style="opacity:.75;">' + tr('ℹ️ รวมการปรับปรุงตัวเลขย้อนหลังแล้ว จึงอาจต่างจากที่ข่าวรายงานครั้งแรกเล็กน้อย', 'ℹ️ Includes revisions to earlier months, so it can differ slightly from the first reported headline') + '</span>';
      const mv = macroVerdicts.nfp(n);
      setMacroZone('nfp', mv);
      cards.push(analysisCard(mv.accent, 'Nonfarm Payrolls — ' + mv.dot + ' ' + mv.label + vsCons(verdict, dev != null), body));
    }

    // ── 5) Initial Jobless Claims (รายสัปดาห์) ───────────────────────────────────────────────
    const cl = claimsView();
    if(cl){
      const dev = isValidNum(cl.forecast) ? cl.value - cl.forecast : null;
      // ต่ำกว่าคาด = ดี (คนตกงานใหม่น้อยกว่าคาด) · ±3K ถือว่าตามคาด
      const accent = dev == null ? GREY : Math.abs(dev) < 3000 ? AMBER : (dev < 0 ? GREEN : RED);
      const verdict = dev == null ? NOCONS : Math.abs(dev) < 3000 ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : (dev < 0 ? tr('🟢 ต่ำกว่าคาด (ดี)', '🟢 Below forecast (good)') : tr('🔴 สูงกว่าคาด (แย่)', '🔴 Above forecast (bad)'));
      let body = tr('ผู้ขอรับสวัสดิการว่างงานครั้งแรก', 'Initial jobless claims') + (cl.weekEnd ? tr(' สัปดาห์สิ้นสุด ', ', week ending ') + esc(thDay(cl.weekEnd)) : tr(' (ประกาศ ', ' (released ') + esc(thDay(cl.releaseDate)) + ')')
        + ' = <b>' + esc(fmtClaims(cl.value)) + '</b>'
        + (dev == null ? '' : tr(' · ตลาดคาด ', ' · forecast ') + esc(fmtClaims(cl.forecast)) + (Math.abs(dev) >= 1000 ? ' (' + (dev < 0 ? tr('ต่ำกว่า', '') : tr('สูงกว่า', '')) + tr('คาด ', '') + esc(fmtClaims(Math.abs(dev))) + tr('', dev < 0 ? ' below' : ' above') + ')' : ''));
      if(isValidNum(cl.prev)) body += tr('<br>สัปดาห์ก่อน = ', '<br>previous week = ') + esc(fmtClaims(cl.prev)) + ' (' + esc(fmtClaimsDelta(cl.value - cl.prev)) + ')';
      if(isValidNum(cl.avg4)) body += (isValidNum(cl.prev) ? ' · ' : '<br>') + tr('ค่าเฉลี่ย 4 สัปดาห์ = ', '4-week average = ') + esc(fmtClaims(cl.avg4))
        + (isValidNum(cl.prevAvg4) ? ' (' + (cl.avg4 > cl.prevAvg4 ? tr('เพิ่มขึ้น', 'rising') : cl.avg4 < cl.prevAvg4 ? tr('ลดลง', 'falling') : tr('ทรงตัว', 'flat')) + ')' : '');
      body += tr('<br>ระดับ: ', '<br>Level: ') + (cl.value < 230000 ? tr('ต่ำ = ตลาดแรงงานยังแน่น', 'low = labour market still tight') : cl.value < 300000 ? tr('ปานกลาง = ตลาดแรงงานเริ่มผ่อนคลาย', 'moderate = labour market loosening') : tr('สูง = สัญญาณตลาดแรงงานอ่อนแรง', 'high = sign of a weak labour market'));
      if(cl.mismatch) body += '<br><span style="color:var(--warn);">' + tr('⚠️ Investing.com รายงานรอบนี้ ', '⚠️ Investing.com reports ') + esc(fmtClaims(cl.mismatch)) + tr(' (ต่างจาก FRED — อาจเป็นการปรับตัวเลข)', ' for this release (differs from FRED, possibly a revision)') + '</span>';
      body += nextReleaseLine('claims');
      if(dev != null && Math.abs(dev) >= 3000) body += '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + (dev < 0
        ? tr('ตลาดแรงงานแข็งกว่าคาด = ลดแรงกดดันให้ Fed ต้องรีบลดดอกเบี้ย (มักหนุนดอลลาร์/บอนด์ยีลด์ และกดทองคำระยะสั้น)', 'labour market stronger than forecast = less pressure on the Fed to cut quickly (tends to lift the dollar/bond yields and weigh on gold short term)')
        : tr('คนตกงานใหม่มากกว่าคาด = ตลาดแรงงานเริ่มอ่อน เพิ่มโอกาส Fed ลดดอกเบี้ย (มักกดดอลลาร์/บอนด์ยีลด์)', 'more new jobless claims than forecast = labour market softening, higher odds of Fed cuts (tends to weigh on the dollar/bond yields)'));
      body += '<br><span style="opacity:.75;">' + tr('ℹ️ ตัวเลขรายสัปดาห์ผันผวนสูง ดูค่าเฉลี่ย 4 สัปดาห์ประกอบ · แหล่ง: ', 'ℹ️ Weekly data is noisy, check the 4-week average too · source: ') + esc(cl.source === 'FRED' ? 'FRED (ICSA) / DOL' : 'Investing.com') + '</span>';
      const mv = macroVerdicts.claims(cl.value);
      setMacroZone('claims', mv);
      cards.push(analysisCard(mv.accent, 'Initial Jobless Claims — ' + mv.dot + ' ' + mv.label + vsCons(verdict, dev != null), body));
    }

    // ── 6) ค้าปลีก · ISM · บ้าน · ดอกเบี้ยบ้าน (การ์ดชุดเพิ่มเติม) ───────────────────────────
    try{ extraAnalysisCards().forEach(c => cards.push(c)); }catch(e){ /* best-effort */ }

    // ── footnote + สถานะ ────────────────────────────────────────────────────────────────────
    const when = new Date().toLocaleTimeString(LOCALE, { hour:'2-digit', minute:'2-digit' });
    const missing = d.errors ? Object.keys(d.errors) : [];

    // ตรวจว่าค่า consensus ของ Investing.com เป็นของ "รอบเดียวกับตัวเลขบนการ์ด" หรือไม่
    // (FRED อาจตามหลังอยู่หนึ่งรอบ — ถ้าเป็นอย่างนั้นต้องบอก ไม่ใช่เทียบข้ามรอบเงียบๆ)
    let consensusNote = '';
    if(C.actuals){
      const pairs = [['CPI', d.cpi, C.actuals.cpi], ['Core CPI', d.coreCpi, C.actuals.coreCpi], ['PPI', d.ppi, C.actuals.ppi], [tr('ว่างงาน', 'Unemployment'), d.unrate, C.actuals.unrate]];
      const checked = pairs.filter(pr => pr[1] && isValidNum(pr[1].value) && isValidNum(pr[2]));
      // เทียบที่ทศนิยม 1 ตำแหน่ง (ความละเอียดที่ประกาศจริง) — PPI MoM ที่คำนวณจากดัชนีอาจเป็น 0.26 ขณะที่ประกาศ 0.3
      const mismatched = checked.filter(pr => Math.abs(Math.round(pr[1].value * 10) / 10 - pr[2]) > 0.05);
      if(checked.length && mismatched.length){
        consensusNote = tr(' · ⚠️ ค่าจาก Investing.com เป็นของรอบที่ใหม่/เก่ากว่าตัวเลขบนการ์ด (', ' · ⚠️ Investing.com values are for a newer/older release than the cards (') + mismatched.map(pr => pr[0]).join(', ') + tr(') — ใช้เทียบเป็นแนวทางเท่านั้น', '), use them as a rough guide only');
      }else if(checked.length){
        consensusNote = tr(' · ✅ ตรวจแล้วว่าค่าคาดตรงรอบเดียวกับตัวเลขบนการ์ด', ' · ✅ checked: forecasts match the same release as the cards');
      }
    }

    const link = (href, text) => '<a class="metric-link" style="color:var(--accent); border-bottom:1px dotted var(--accent);" target="_blank" rel="noopener" href="' + esc(href) + '">' + text + '</a>';
    const autoLine = C.live
      ? esc(C.source) + tr(' (ดึงสด · ', ' (live · ') + esc(thDay(C.asOf)) + ')'
      : esc(C.source) + tr(' (ค่าที่ฝังไว้ ณ ', ' (built-in values as of ') + esc(thDay(C.asOf)) + ')';
    const srcLine = tr('ที่คาด: ', 'Forecasts: ') + autoLine;
    const linkLine = tr('ดูต้นทาง: ', 'Sources: ') + [
      link(CONSENSUS.links.cpi, 'CPI'), link(CONSENSUS.links.coreCpi, 'Core CPI'), link(CONSENSUS.links.ppi, 'PPI'),
      link(CONSENSUS.links.nfp, tr('การจ้างงาน', 'Payrolls')), link(CONSENSUS.links.unrate, tr('ว่างงาน', 'Unemployment')),
      link(CONSENSUS.links.fed, 'Fed')
    ].join(' · ');

    const notes = [];
    if(d.stale) notes.push(tr('⚠️ ตัวเลขที่ใช้คือค่าล่าสุดที่เคยดึงได้', '⚠️ Using the last numbers that were fetched successfully'));
    if(missing.length) notes.push(tr('⚠️ วิเคราะห์จากตัวเลขที่มีเท่านั้น (ที่ดึงไม่ได้: ', '⚠️ Analysis uses only the available numbers (missing: ') + esc(missing.map(k => OVERRIDE_LABELS[k] || k).join(', ')) + ')');
    const details = tr('ค่าที่ตลาดคาด: Fed ', 'Market forecasts: Fed ') + consFedText
      + ' · CPI ' + C.cpi.toFixed(1) + '% · Core ' + C.coreCpi.toFixed(1) + '% · PPI ' + signedPct(C.ppi, 1) + '% · ' + tr('ว่างงาน ', 'Unemployment ') + C.unrate.toFixed(1)
      + '% · NFP +' + C.nfp.toLocaleString('en-US')
      + '<br>' + srcLine + esc(consensusNote)
      + '<br>' + linkLine;
    const foot = (notes.length ? notes.join('<br>') + '<br>' : '')
      + '<details class="src-note"><summary>' + tr('ⓘ ที่มาของค่าที่คาด · อัปเดต ', 'ⓘ Where the forecasts come from · updated ') + esc(when) + '</summary>'
      + '<div style="margin-top:6px;">' + details + '</div></details>';

    box.innerHTML = cards.join('') + '<div class="muted" style="font-size:10px; line-height:1.6; opacity:.8;">' + foot + '</div>';

    // แจ้งเตือนในหน้าเฉพาะเมื่อตัวเลขขยับจากการ์ดครั้งก่อน (ผู้ใช้ที่เปิดหน้านานๆ จะรู้ว่าเลขใหม่มา)
    if(lastFedSignature && lastFedSignature !== fedSignature(d)){
      const statusEl2 = el('fredFetchStatus');
      if(statusEl2) statusEl2.textContent = tr('🔔 มีตัวเลขใหม่ — อัปเดตบทวิเคราะห์แล้ว', '🔔 New numbers are in. The analysis has been updated.');
    }
    lastFedSignature = fedSignature(d);
  }
  function fedSignature(d){
    return ['upper','effr','cpi','coreCpi','ppi','unrate','nfp']
      .map(k => (d && d[k] && isValidNum(d[k].value)) ? k + ':' + d[k].value : k + ':-')
      .join('|');
  }
  let lastFedSignature = null;

  async function refreshFedData(opts){
    const force = !!(opts && opts.force);
    const statusEl = el('fredFetchStatus');
    const now = Date.now();
    // ค่าคาดสดต้องโหลดทุกครั้ง (TTL กันเองใน loadConsensus) — เดิมเรียกหลังเช็คแคช Fed เลยไม่เคยโหลด
    // ตอนที่ตัวเลข Fed ยังอยู่ในแคช (ได้ถึง 3 ชม.) หน้าเว็บจึงค้างที่ค่าคาดที่ฝังไว้
    loadConsensus();

    // 1) Local cache — but only while the server says the numbers can't have changed yet.
    let cached = null;
    try{
      const raw = await storageGet(FED_CACHE_KEY);
      if(raw) cached = JSON.parse(raw);
    }catch(e){ cached = null; }

    if(cached && cached.data && !force){
      const n = applyFedData(cached.data);
      if(n > 0 && cached.refreshAfter > now){
        fedNextFetchAt = cached.refreshAfter;
        if(statusEl) statusEl.textContent = fedStatusText(cached.data);
        return;
      }
    }

    // 2) Throttle — don't re-hit the network until the TTL says it's worth it.
    if(!force && now < fedNextFetchAt) return;
    fedNextFetchAt = now + FED_POLL_MS;

    try{
      // no-cache: our own localStorage cache + `refreshAfter` already throttle this call, so the
      // browser's HTTP cache would only add a second, longer delay on top after a release.
      const r = await fetchWithTimeout('/.netlify/functions/fred-data', 15000, { cache: 'no-cache' });
      let data;
      try{
        data = await r.json();
      }catch(parseErr){
        throw new Error(tr('เซิร์ฟเวอร์ตอบกลับมาไม่ใช่ JSON (HTTP ' + r.status + ') — หน้านี้ต้องรันบน Netlify จึงจะใช้ Functions ได้ (เปิด index.html ตรงๆ จากดิสก์จะดึงสดไม่ได้)', 'The server did not return JSON (HTTP ' + r.status + '). This page must run on Netlify to use Functions (opening index.html straight from disk cannot fetch live data).'));
      }
      if(data && data.error && !hasAnyFedField(data)) throw new Error(data.error);
      if(!r.ok && !hasAnyFedField(data)) throw new Error('HTTP ' + r.status);

      const n = applyFedData(data);
      fedNextFetchAt = (isValidNum(data.refreshAfter) && data.refreshAfter > now) ? data.refreshAfter : now + FED_POLL_MS;
      try{ await storageSet(FED_CACHE_KEY, JSON.stringify({ data: data, refreshAfter: fedNextFetchAt, savedAt: now })); }catch(e){}

      if(statusEl) statusEl.textContent = fedStatusText(data);
      if(data.errors && Object.keys(data.errors).length) console.warn('[fred-data] some fields failed', data.errors);
    }catch(e){
      fedNextFetchAt = now + FED_POLL_MS;
      const reason = (e && e.message) ? e.message : String(e);
      console.warn('[fred-data]', reason);
      if(statusEl) statusEl.textContent = tr('⚠️ อัปเดตตัวเลขล่าสุดไม่ได้ในขณะนี้ — ระบบจะลองใหม่อัตโนมัติ', '⚠️ Can\'t update the latest numbers right now. Retrying automatically.');
      // Fall back to the last payload we actually saved; with none, the cards stay at "–".
      if(cached && cached.data) applyFedData(cached.data);
      // ให้บทวิเคราะห์บอกด้วยว่ายังสร้างไม่ได้ เพราะอะไร (ไม่ปล่อยให้ค้างข้อความ "กำลังรอ" เงียบๆ)
      try{ renderFedAnalysis(null, reason); }catch(e){ /* best-effort */ }
    }
  }

  refreshFedData();

  // Keep the cards honest while the tab stays open, and re-check the moment the user comes back
  // to a backgrounded tab — that's usually right after a release landed.
  // เช็กทุกนาที แต่ refreshFedData() จะยิงเน็ตจริงก็ต่อเมื่อถึง `refreshAfter` ของเซิร์ฟเวอร์ — เดิมรอบละ 10 นาที
  // ทำให้ช่วงรอตัวเลขใหม่ (เซิร์ฟเวอร์ให้ TTL 3 นาที) หน้าเว็บเพิ่งไปเช็กอีกทีหลังผ่านไปถึง 10 นาที
  let fedLastTickRun = Date.now();
  setInterval(function(){
    const t = Date.now();
    if(t >= fedNextFetchAt || t - fedLastTickRun >= FED_POLL_MS){ fedLastTickRun = t; refreshFedData(); }
  }, FED_TICK_MS);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden) refreshFedData(); });


  el('newsRefreshBtn').addEventListener('click', refreshNews);

  // ---------- Real live asset prices (not sentiment-derived) ----------
  // Gold: no free/no-key/CORS-friendly spot gold API found, so we use PAXG (Pax Gold, a token
  // backed 1:1 by a troy ounce of physical gold) traded on Binance as a live proxy — Binance's
  // API is already confirmed CORS-friendly elsewhere in this app.
  // USD/THB & JPY/THB: both from one frankfurter.app call (free ECB rates, no key), with one
  // retry since a single transient failure shouldn't leave the numbers blank.
  // ราคา + % เปลี่ยนแปลง (▲ เขียว / ▼ แดง) — pct เป็น null ได้ถ้าแหล่งนั้นไม่มีค่าอ้างอิงเทียบ
  function chgHtml(pct){
    if(pct == null || !isFinite(pct)) return '';
    const cls = pct > 0.005 ? 'up' : pct < -0.005 ? 'down' : 'flat';
    const arrow = cls === 'up' ? '▲' : cls === 'down' ? '▼' : '•';
    return '<span class="chg ' + cls + '">' + arrow + ' ' + Math.abs(pct).toFixed(2) + '%</span>';
  }
  function setPrice(id, text, pct){
    const node = el(id); if(!node) return;
    node.innerHTML = esc(text) + chgHtml(pct);
    if(BRIEF_PRICE_LABELS[id] && pct != null && isFinite(pct)){ BRIEF.prices[id] = pct; renderBrief(); }
  }
  const pctChange = (now, ref) => (isFinite(now) && isFinite(ref) && ref) ? (now - ref) / ref * 100 : null;

  // เลือกวันล่าสุด + วันทำการก่อนหน้าจากชุดเดียวกัน: เดิมเอา "วันรองสุดท้าย" ของช่วง 10 วันมาเทียบ
  // กับ latest — ถ้า latest ค้างเป็นวันเก่า (เช่น 16 ต.ค.) แต่ช่วงวันมีถึง 19 ต.ค. แล้ว วันรองสุดท้าย
  // ก็คือ 16 ต.ค. วันเดียวกัน % จึงขึ้น 0.00% ทั้งสามแถว ตอนนี้ใช้วันที่ใหม่กว่าเสมอ แล้วเทียบกับวันก่อนหน้ามัน
  function pickFxPair(latest, series){
    const ok = (x) => x && x.THB && x.JPY && x.CNY;
    const days = Object.keys(series || {}).filter(d => ok(series[d])).sort();
    let date = latest && ok(latest.rates) ? latest.date : null;
    let now = date ? latest.rates : null;
    const last = days[days.length - 1];
    if(last && (!date || last >= date)){ date = last; now = series[last]; }
    if(!now) return null;
    const prevDate = days.filter(d => d < date).pop() || null;
    return { date, now, prevDate, prev: prevDate ? series[prevDate] : null };
  }
  window.pickFxPair = pickFxPair;   // tests/index-html.test.js
  const LIVE_NOTE_BASE = tr('ราคาทองอ้างอิง PAXG (โทเคนที่หนุนด้วยทองคำจริง)', 'Gold price tracks PAXG (a token backed by physical gold)');
  const livePx = { gold: null, usdThb: null };
  async function fetchLivePrices(){
    try{
      const r = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT', 6000);
      const j = await r.json();
      const price = parseFloat(j.lastPrice);
      if(isNaN(price)) throw new Error('no PAXG price');
      setPrice('lpGold', '$' + price.toLocaleString('en-US',{maximumFractionDigits:2}), parseFloat(j.priceChangePercent));
      livePx.gold = price;
    }catch(e){ el('lpGold').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); console.warn('[gold]', e); }

    // frankfurter.app moved to frankfurter.dev as its official domain — the old .app host
    // still resolves but seems to have gotten flaky. Try the new domain first, old one as
    // fallback, and try both param styles (v1 "base/symbols" and legacy "from/to").
    // cache:'no-store' — the "latest" URL never changes, so the browser's HTTP cache could hand
    // back an older day's rates while the dated range call below (its URL changes daily) was fresh.
    // frankfurter.dev (ECB) ล่มทั้งโดเมนได้ (พ.ย. 2026 ตอบ error ทุก URL → 3 แถวค่าเงินบาท + ทองไทยแบบประมาณ
    // ว่างพร้อมกัน) จึงมีแหล่งสำรองที่ไม่ต้องใช้ key และเปิด CORS: currency-api (jsDelivr + mirror) → open.er-api.com
    const FX_ALT = [
      { name: 'currency-api', url: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
        parse: (j) => j && j.usd && { date: j.date, rates: { THB: j.usd.thb, JPY: j.usd.jpy, CNY: j.usd.cny } } },
      { name: 'currency-api', url: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json',
        parse: (j) => j && j.usd && { date: j.date, rates: { THB: j.usd.thb, JPY: j.usd.jpy, CNY: j.usd.cny } } },
      { name: 'open.er-api.com', url: 'https://open.er-api.com/v6/latest/USD',
        parse: (j) => j && j.result === 'success' && j.rates && { date: new Date((j.time_last_update_unix || 0) * 1000).toISOString().slice(0, 10), rates: { THB: j.rates.THB, JPY: j.rates.JPY, CNY: j.rates.CNY } } }
    ];
    async function getFxRates(){
      const urls = [
        'https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB,JPY,CNY',
        'https://api.frankfurter.app/latest?from=USD&to=THB,JPY,CNY'
      ];
      let lastErr = 'unknown error';
      for(const url of urls){
        try{
          const r = await fetchWithTimeout(url, 6000, { cache: 'no-store' });
          if(!r.ok){ lastErr = url + ': HTTP ' + r.status; continue; }
          const j = await r.json();
          if(j.rates && j.rates.THB && j.rates.JPY && j.rates.CNY) return { date: j.date, rates: j.rates, source: 'ecb' };
          lastErr = url + ': response missing THB/JPY/CNY — ' + JSON.stringify(j).slice(0,150);
        }catch(e){ lastErr = url + ': ' + e.message; }
      }
      for(const alt of FX_ALT){
        try{
          const r = await fetchWithTimeout(alt.url, 6000, { cache: 'no-store' });
          if(!r.ok){ lastErr = alt.url + ': HTTP ' + r.status; continue; }
          const out = alt.parse(await r.json());
          if(out && isValidNum(out.rates.THB) && isValidNum(out.rates.JPY) && isValidNum(out.rates.CNY)) return Object.assign(out, { source: alt.name });
          lastErr = alt.url + ': response missing THB/JPY/CNY';
        }catch(e){ lastErr = alt.url + ': ' + e.message; }
      }
      throw new Error(lastErr);
    }
    window.getFxRates = getFxRates;   // tests
    // อัตรา 10 วันล่าสุด (ไว้คิด % เปลี่ยนแปลงเทียบวันทำการก่อนหน้า) — ไม่สำเร็จก็ไม่เป็นไร แค่ไม่โชว์ %
    async function getFxSeries(){
      try{
        const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
        const r = await fetchWithTimeout('https://api.frankfurter.dev/v1/' + start + '..?base=USD&symbols=THB,JPY,CNY', 6000, { cache: 'no-store' });
        if(!r.ok) return null;
        const j = await r.json();
        return (j && j.rates) || null;
      }catch(e){ return null; }
    }
    try{
      const [latestRes, seriesRes] = await Promise.allSettled([getFxRates(), getFxSeries()]);
      const pair = pickFxPair(latestRes.status === 'fulfilled' ? latestRes.value : null,
                              seriesRes.status === 'fulfilled' ? seriesRes.value : null);
      if(!pair) throw (latestRes.reason || new Error('no FX data'));
      const fxSource = latestRes.status === 'fulfilled' && pair.now === latestRes.value.rates ? latestRes.value.source : 'ecb';
      const fx = (x) => ({ usd: x.THB, jpy: (x.THB / x.JPY) * 100, cny: x.THB / x.CNY });
      const now = fx(pair.now);
      livePx.usdThb = pair.now.THB;
      const ref = pair.prev ? fx(pair.prev) : {};
      setPrice('lpUsdThb', now.usd.toFixed(2) + tr(' บาท', ' THB'), pctChange(now.usd, ref.usd));
      setPrice('lpJpyThb', now.jpy.toFixed(3) + tr(' บาท', ' THB'), pctChange(now.jpy, ref.jpy));
      setPrice('lpCnyThb', now.cny.toFixed(3) + tr(' บาท', ' THB'), pctChange(now.cny, ref.cny));
      el('livePricesNote').textContent = LIVE_NOTE_BASE + (fxSource === 'ecb'
        ? tr(' · ค่าเงินบาทเป็นอัตรากลาง ECB ณ ', ' · THB rates are ECB reference rates as of ') + thDay(pair.date)
          + tr(' (ออกวันละครั้งราว 21:00 น. เวลาไทย ไม่ใช่ real-time)', ' (published once a day around 21:00 Bangkok time, not real-time)')
        : tr(' · ค่าเงินบาทจาก ', ' · THB rates from ') + fxSource + tr(' ณ ', ' as of ') + thDay(pair.date) + tr(' (แหล่งสำรอง อัปเดตวันละครั้ง)', ' (backup source, updated daily)'))
        + (pair.prevDate ? tr(' · % เทียบ ', ' · % vs ') + thDay(pair.prevDate) : '');
    }catch(e){
      el('lpUsdThb').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
      el('lpJpyThb').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
      el('lpCnyThb').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
      console.warn('[fx]', e);
    }
  }
  const livePricesReady = fetchLivePrices();

  // ---------- USD/JPY (สด ช้าไม่กี่นาที) ----------
  // แถวค่าเงินอื่นเป็นอัตรากลาง ECB วันละครั้ง แต่ USD/JPY อ่านคู่กับส่วนต่างยีลด์ US − ญี่ปุ่น ซึ่งเยนขยับ 1–2%
  // ในชั่วโมงเดียวได้ จึงดึงราคาตลาดผ่าน /.netlify/functions/usdjpy (Yahoo → CNBC → Stooq) · ล่มค่อยใช้ ECB
  async function fetchUsdJpy(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/usdjpy', 8000, { cache: 'no-cache' });
      const j = await r.json();
      if(!r.ok || !isValidNum(j.price)) throw new Error(j.error || 'HTTP ' + r.status);
      setPrice('lpUsdJpy', j.price.toFixed(2) + tr(' เยน', ' JPY'), j.pct);
      const t = j.asOf ? new Date(j.asOf) : null;
      const when = t && !isNaN(t) ? t.toLocaleString(LOCALE, { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Bangkok' }) + tr(' น.', ' (Bangkok)') : '';
      el('lpUsdJpySub').textContent = tr('ราคาตลาด ช้าไม่กี่นาที', 'Market quote, a few minutes delayed') + (when ? ' · ' + when : '')
        + (j.prevClose ? tr(' · % เทียบราคาปิดวันก่อน', ' · % vs previous close') : '') + (j.stale ? tr(' · (ข้อมูลค้าง)', ' · (stale)') : '');
    }catch(e){
      console.warn('[usdjpy]', e);
      // สำรอง: อัตรากลาง ECB (ตัวเดียวกับแถวค่าเงินบาท)
      try{
        const r = await fetchWithTimeout('https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY', 6000, { cache: 'no-store' });
        const j = await r.json();
        if(!j || !j.rates || !isValidNum(j.rates.JPY)) throw new Error('no ECB JPY');
        setPrice('lpUsdJpy', j.rates.JPY.toFixed(2) + tr(' เยน', ' JPY'), null);
        el('lpUsdJpySub').textContent = tr('ราคาสดดึงไม่ได้ · ใช้อัตรากลาง ECB ณ ', 'Live quote unavailable · ECB reference rate as of ') + thDay(j.date);
      }catch(e2){ el('lpUsdJpy').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable'); }
    }
  }
  // บรรทัดเชื่อมไปการ์ดส่วนต่างยีลด์ (ตัวเลขมาจาก /markets เมื่อโหลดเสร็จ)
  function renderUsdJpyLink(){
    const box = el('lpUsdJpyLink'); if(!box) return;
    const S = lastMarketSeries || {};
    const v = (s) => (s && isValidNum(s.latest)) ? s.latest.toFixed(2) + '%' : '–';
    box.innerHTML = '<a href="#usjpCards">' + esc(tr('ส่วนต่างยีลด์ สหรัฐ−ญี่ปุ่น', 'US − Japan yield spread')) + '</a> 2Y ' + esc(v(S.usjp2y)) + ' · 10Y ' + esc(v(S.usjp10y))
      + esc(tr(' · ส่วนต่างแคบลงเร็ว = เยนมักแข็ง (USD/JPY ลง)', ' · a fast narrowing usually means a stronger yen (USD/JPY down)'));
  }
  renderUsdJpyLink();
  fetchUsdJpy();
  setInterval(fetchUsdJpy, 2 * 60 * 1000);

  // ---------- ทองไทย (สมาคมค้าทองคำ) — ถ้าดึงไม่ได้ ประมาณจากราคาโลก × ค่าเงินบาท ----------
  const fmtBaht = (v) => Math.round(v).toLocaleString('en-US');
  async function fetchThaiGold(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/gold-th', 9000);
      const j = await r.json();
      if(!r.ok || !j.barSell) throw new Error(j.error || 'HTTP ' + r.status);
      el('lpGoldTh').textContent = fmtBaht(j.barSell) + tr(' บาท', ' THB');
      // j.updated มาจากเว็บสมาคมค้าทองคำเป็นภาษาไทย (เช่น "10/11/2569 เวลา 09:30") — แสดงตามต้นทาง
      el('lpGoldThSub').textContent = tr('ทองแท่งรับซื้อ ', 'Bar buy ') + fmtBaht(j.barBuy)
        + (j.ornamentSell ? tr(' · รูปพรรณขายออก ', ' · Jewellery sell ') + fmtBaht(j.ornamentSell) : '')
        + tr(' · สมาคมค้าทองคำ', ' · Gold Traders Association') + (j.updated ? ' ' + j.updated : '');
      return;
    }catch(e){ console.warn('[gold-th]', e); }
    // ประมาณการ: ทอง 96.5% น้ำหนัก 1 บาท = 15.244 กรัม (1 ทรอยออนซ์ = 31.1035 กรัม)
    await livePricesReady;
    if(livePx.gold && livePx.usdThb){
      const est = livePx.gold * livePx.usdThb * (15.244 / 31.1035) * 0.965;
      el('lpGoldTh').textContent = '≈ ' + fmtBaht(Math.round(est / 50) * 50) + tr(' บาท', ' THB');
      el('lpGoldThSub').textContent = tr('ประมาณจากราคาโลก × ค่าเงินบาท (ยังไม่รวมค่าพรีเมียมในประเทศ)', 'Estimated from world price × USD/THB (excludes the local premium)');
    }else{
      el('lpGoldTh').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
    }
  }
  fetchThaiGold();

  // ---------- sparkline (ย้อนหลัง 12 เดือน) ----------
  function sparkSvg(hist, opts){
    const pts = (hist || []).filter(p => isFinite(p[1]));
    if(pts.length < 2) return '';
    const W = 120, H = 30, P = 2;
    const vals = pts.map(p => p[1]);
    const min = Math.min.apply(null, vals), max = Math.max.apply(null, vals), range = (max - min) || 1;
    const xy = pts.map((p, i) => [P + i / (pts.length - 1) * (W - 2 * P), H - P - (p[1] - min) / range * (H - 2 * P)]);
    const up = vals[vals.length - 1] >= vals[0];
    const color = (opts && opts.color) || (((opts && opts.upIsBad) ? !up : up) ? 'var(--good)' : 'var(--bad)');
    const line = xy.map(q => q[0].toFixed(1) + ',' + q[1].toFixed(1)).join(' ');
    const last = xy[xy.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">'
      + '<polyline fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" points="' + line + '"/>'
      + '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.2" fill="' + color + '"/></svg>';
  }
  // VIX bands (S&P 500 12-month forward returns, 1990–2026): <20 hold · 20–30 caution · 30–40 buy in steps · ≥40 crisis.
  // pastPeak: VIX still ≥25 but below where it was a month ago (fear easing, not a confirmed bottom).
  function vixZone(v, monthAgo){
    const label = v >= 40 ? tr('🔴 ตื่นตระหนก · ผันผวนสูงมาก', '🔴 Panic · very high volatility')
      : v >= 30 ? tr('🟠 กลัวหนัก', '🟠 Heavy fear')
      : v >= 20 ? tr('🟡 เริ่มกังวล', '🟡 Nervous')
      : tr('🟢 ตลาดนิ่ง', '🟢 Calm');
    return { label, pastPeak: v >= 25 && isValidNum(monthAgo) && v < monthAgo };
  }
  // the close about one month (30 calendar days) before `date`, from [[date, value], ...] oldest first
  function vixMonthAgo(hist, date){
    if(!Array.isArray(hist) || !date) return null;
    const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 30);
    const cut = d.toISOString().slice(0, 10);
    let out = null;
    for(const p of hist){ if(p[0] <= cut) out = p[1]; else break; }
    return out;
  }
  window.vixZone = vixZone; window.vixMonthAgo = vixMonthAgo;   // tests
  // HY OAS (%): โซนสีเดียวกับคำอธิบายใน tooltip ของการ์ด
  function hyZone(v){
    if(v >= 7) return tr('🔴 วิกฤตสินเชื่อ', '🔴 Credit stress');
    if(v >= 5) return tr('🟠 ตึงตัว', '🟠 Tight');
    if(v >= 3.5) return tr('🟡 ปกติ', '🟡 Normal');
    if(v < 3) return tr('🟢 แคบมาก · ตลาดอาจประมาท', '🟢 Very tight · possibly complacent');
    return tr('🟢 สบาย', '🟢 Easy');
  }
  // ส่วนต่างเปลี่ยนไปเท่าไรใน ~1 เดือน (หน่วย %) จากจุดในกราฟที่ห่างจากวันล่าสุดราว 30 วัน
  function hyChange1m(s){
    if(!s || !s.hist || !s.hist.length || !s.date) return null;
    const cut = new Date(new Date(s.date + 'T00:00:00Z').getTime() - 30 * 86400000).toISOString().slice(0, 10);
    let ref = null;
    for(const p of s.hist){ if(p[0] <= cut) ref = p; else break; }
    return ref && isValidNum(ref[1]) ? s.latest - ref[1] : null;
  }
  function setSpark(id, series, opts){
    const box = el(id);
    if(!box || !series || !series.hist) return;
    const svg = sparkSvg(series.hist, opts);
    if(!svg){ box.innerHTML = ''; return; }
    const first = series.hist[0][1], last = series.hist[series.hist.length - 1][1];
    const dec = (opts && opts.dec != null) ? opts.dec : 2;
    // -0.02 ปัดแล้วไม่ควรขึ้น "-0.0"
    const fx = (v) => { const t = v.toFixed(dec); return /^-0(\.0+)?$/.test(t) ? t.slice(1) : t; };
    box.innerHTML = svg + '<div class="spark-cap"><span>' + ((opts && opts.cap) || tr('12 เดือน', '12 months')) + '</span><span>' + fx(first) + ' → ' + fx(last) + '</span></div>';
  }
  window.giSetSpark = setSpark;   // แท็บ BTC (สคริปต์แยก) ใช้วาดกราฟเล็กของ DVOL

  // ---------- ตลาดสหรัฐฯ + กราฟย้อนหลังในการ์ด Fed ----------
  // var (not let): applyFedData() runs before this point in the script and touches both.
  var lastMarketSeries, lastLiveFed;

  // หลังวันประกาศ ตัวเลขบนการ์ด (fred-data) อาจมาก่อนกราฟเล็ก (markets) — ต่อจุดล่าสุดให้กราฟเอง
  // เพื่อไม่ให้กราฟกับการ์ดบอกคนละเดือน จนกว่า markets จะรีเฟรชรอบถัดไป
  function patchSparksFromLive(){
    const S = lastMarketSeries, d = lastLiveFed;
    if(!S || !d) return;
    [['cpi', d.cpi, 'spCpi', { upIsBad:true, dec:1 }], ['unrate', d.unrate, 'spUnrate', { upIsBad:true, dec:1 }],
     ['fedUpper', d.upper, 'spFed', { color:'var(--accent)', dec:2 }]].forEach(function(row){
      const s = S[row[0]], live = row[1];
      if(!s || !s.hist || !live || !isValidNum(live.value) || !live.date || !(live.date > s.date)) return;
      s.hist = s.hist.concat([[live.date, live.value]]);
      s.latest = live.value; s.date = live.date;
      setSpark(row[2], s, row[3]);
    });
  }

  // โซนของ short บอนด์ฟิวเจอร์ส: หดเร็ว = คลายเลเวอเรจ · ใกล้/ทำสถิติ = ตัวคูณสูง · ถ้า MOVE สูงด้วย = ย้อนแย้ง
  function levShortZone(L, move){
    const v = L.latest, rec = L.record;
    const wk = (isValidNum(L.change) && isValidNum(L.prev) && L.prev > 0) ? L.change / L.prev : 0;
    const pct = (isValidNum(rec) && rec > 0) ? v / rec : null;
    let z;
    if(wk <= -0.05) z = tr('🟠 หดเร็ว ', '🟠 Shrinking fast ') + Math.round(wk * 100) + tr('% ใน 1 สัปดาห์ · เริ่มคลายเลเวอเรจ', '% in a week · deleveraging');
    else if(pct != null && pct >= 0.999) z = tr('🔴 สถิติใหม่ (ตั้งแต่ 2016)', '🔴 Record (since 2016)');
    else if(pct != null && pct >= 0.9) z = tr('🟠 ใกล้สถิติ (', '🟠 Near record (') + Math.round(pct * 100) + tr('% ของสถิติ)', '% of record)');
    else z = (pct != null ? tr('🟡 ', '🟡 ') + Math.round(pct * 100) + tr('% ของสถิติ', '% of record') : tr('🟡 ปกติ', '🟡 Normal'));
    if(move && isValidNum(move.latest) && move.latest >= 110 && pct != null && pct >= 0.9 && wk > -0.05)
      z += tr(' · ⚠️ ย้อนแย้ง: MOVE สูงแต่ short ยังสูง', ' · ⚠️ Paradox: MOVE high, short still high');
    return z;
  }

  // โซนสีของส่วนต่างยีลด์ US − ญี่ปุ่น จากการเปลี่ยนแปลงใน 1 เดือน (หน่วย % point)
  function signedPp(x){ return (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2); }
  function usJpZone(chg1m){
    if(!isValidNum(chg1m)) return '';
    const tail = tr(' (1 เดือน ', ' (1 month ') + signedPp(chg1m) + ')';
    if(chg1m <= -0.5) return tr('🔴 แคบลงเร็ว · เสี่ยง unwind สูง', '🔴 Narrowing fast · high unwind risk') + tail;
    if(chg1m <= -0.25) return tr('🟠 แคบลง · เริ่มเสี่ยง unwind', '🟠 Narrowing · unwind risk building') + tail;
    if(chg1m >= 0.25) return tr('🟢 กว้างขึ้น · carry ได้เปรียบ เยนมักอ่อน', '🟢 Widening · carry favoured, yen tends to weaken') + tail;
    return tr('🟡 ทรงตัว', '🟡 Steady') + tail;
  }
  window.usJpZone = usJpZone;   // tests

  // ความกว้างตลาด (SPXEW − S&P 500 ใน 1 เดือน, หน่วย % point) — เกณฑ์เดียว ใช้ทั้งสีและบรรทัดความหมายบนการ์ด
  const BREADTH_BROAD = 0.5, BREADTH_NARROW = -1.5;
  function breadthVerdict(rel1m){
    if(!isValidNum(rel1m)) return null;
    if(rel1m >= BREADTH_BROAD) return { key:'broad', accent:'var(--good)', dot:'🟢', label:tr('ตลาดกว้าง', 'Broad market') };
    if(rel1m <= BREADTH_NARROW) return { key:'narrow', accent:'var(--bad)', dot:'🔴', label:tr('ตลาดแคบ', 'Narrow market') };
    return { key:'even', accent:'var(--warn)', dot:'🟡', label:tr('ใกล้เคียงกัน', 'Roughly even') };
  }
  window.breadthVerdict = breadthVerdict;   // tests
  const signedPctTxt = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2) + '%';
  function renderBreadth(s){
    const meaning = el('mkSpxewMeaning');
    if(!s || !isValidNum(s.latest)){ if(meaning) meaning.innerHTML = ''; return; }
    const pct = (isValidNum(s.change) && isValidNum(s.prev) && s.prev) ? s.change / s.prev * 100 : null;
    el('mkSpxew').innerHTML = esc(s.latest.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }))
      + (pct == null ? '' : '<span class="delta ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat') + '">' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</span>');
    const v = breadthVerdict(s.rel1m);
    // ตัวเลขใหญ่ = ระดับดัชนี สีปกติ · สีเขียว/เหลือง/แดงอยู่ที่บรรทัดผลเทียบด้านล่างเท่านั้น
    toneNum('mkSpxewZone', v ? v.accent : null);
    el('mkSpxewZone').textContent = v
      ? v.dot + ' ' + v.label + tr(' (1 เดือน ', ' (1 month ') + signedPctTxt(s.rel1m) + tr(' เทียบ S&P)', ' vs S&P)')
      : tr('⚪ ยังเทียบกับ S&P 500 ไม่ได้ · จะลองดึงใหม่อัตโนมัติ', '⚪ Can\'t compare with the S&P 500 yet · retrying automatically');
    const ewName = s.breadthBy === 'RSP' ? 'RSP' : 'EW';
    el('mkSpxewInfo').textContent = (isValidNum(s.ew1m) && isValidNum(s.spx1m)
      ? tr('1 เดือน: ', '1 month: ') + ewName + ' ' + signedPctTxt(s.ew1m) + ' · S&P ' + signedPctTxt(s.spx1m) : '')
      + tr(' · ราคาปิด ', ' · close ') + thDay(s.breadthDate || s.date)
      + (s.breadthBy === 'RSP' ? tr(' · ใช้ ETF RSP แทน (ข้อมูลดัชนี SPXEW ผิดปกติ)', ' · using the RSP ETF (SPXEW index feed looked wrong)') : '');
    // กราฟเล็ก = อัตราส่วน EW ÷ S&P (100 = 12 เดือนก่อน) สีกลาง ไม่ใช่สีเขียว/แดง เพื่อไม่ให้สับสนกับผลเทียบ 1 เดือน
    if(s.relHist && s.relHist.length > 1) setSpark('spSpxew', { hist: s.relHist }, { dec:1, color:'var(--accent)' });
    else setSpark('spSpxew', s, { dec:0, color:'var(--accent)' });
    if(!meaning) return;
    if(!v){ meaning.innerHTML = ''; return; }
    // ความหมายของผลเทียบ อยู่ในการ์ดเลย (การ์ดตลาดใบอื่นก็แสดงทุกอย่างในการ์ด ไม่มีกล่องวิเคราะห์แยก)
    const up = s.spx1m >= 0;
    meaning.innerHTML = '<b>' + tr('ความหมาย:', 'What it means:') + '</b> ' + (v.key === 'narrow'
      ? (up ? tr('ดัชนีขึ้นเพราะหุ้นยักษ์ไม่กี่ตัว หุ้นส่วนใหญ่ไม่ได้ขึ้นตาม = ขาขึ้นที่เปราะ ถ้าหุ้นกลุ่มนั้นสะดุด ดัชนีร่วงได้แรง', 'the index is rising on a few mega-caps while most stocks lag = a fragile rally; if those names stumble the index can fall hard')
            : tr('หุ้นส่วนใหญ่ร่วงหนักกว่าดัชนี แรงขายกระจายทั่วตลาด มีแค่หุ้นยักษ์ที่ยังพยุงดัชนีไว้', 'most stocks are falling harder than the index; selling is widespread and only the giants are holding it up'))
      : v.key === 'broad'
      ? (up ? tr('หุ้นส่วนใหญ่ขึ้นไปด้วยกัน ไม่ได้พึ่งแค่หุ้นยักษ์ = ขาขึ้นที่แข็งแรงกว่า', 'most stocks are rising together rather than leaning on the giants = a healthier rally')
            : tr('ดัชนีลงเพราะหุ้นยักษ์เป็นหลัก หุ้นส่วนใหญ่ยังยืนได้ดีกว่า = แรงขายกระจุกตัว ยังไม่ลามทั้งตลาด', 'the index is falling mainly on the giants while most stocks hold up better = selling is concentrated, not market-wide'))
      : tr('หุ้นส่วนใหญ่กับหุ้นยักษ์วิ่งไปทางเดียวกันพอๆ กัน ยังไม่มีสัญญาณว่าตลาดแคบหรือกว้างผิดปกติ', 'the average stock and the giants are moving about the same; no sign of an unusually narrow or broad market'));
  }
  window.renderBreadth = renderBreadth;   // tests
  // Shiller PE (CAPE) — เกณฑ์เดียว ใช้ทั้งสีตัวเลขใหญ่ บรรทัดสถานะ และบรรทัดความหมาย (เกณฑ์เขียนไว้ใน (i) ของการ์ด)
  const CAPE_FAIR = 20, CAPE_HIGH = 30;
  function capeVerdict(v){
    if(!isValidNum(v)) return null;
    if(v >= CAPE_HIGH) return { key:'high', accent:'var(--bad)', dot:'🔴', label:tr('แพงมาก', 'Very expensive') };
    if(v >= CAPE_FAIR) return { key:'above', accent:'var(--warn)', dot:'🟡', label:tr('แพงกว่าค่าเฉลี่ย', 'Above average') };
    return { key:'fair', accent:'var(--good)', dot:'🟢', label:tr('ใกล้ค่าเฉลี่ย/ถูก', 'Near average or cheap') };
  }
  window.capeVerdict = capeVerdict;   // tests
  function renderCape(s){
    const meaning = el('mkCapeMeaning');
    if(!s || !isValidNum(s.latest)){
      if(el('mkCapeZone')) el('mkCapeZone').textContent = tr('⚪ ดึงค่า Shiller PE ไม่ได้ตอนนี้ · จะลองใหม่อัตโนมัติ', '⚪ Can\'t load the Shiller PE right now · retrying automatically');
      if(meaning) meaning.innerHTML = '';
      return;
    }
    const v = capeVerdict(s.latest);
    el('mkCape').textContent = s.latest.toFixed(2);
    toneNum('mkCape', v.accent);
    toneNum('mkCapeZone', v.accent);
    el('mkCapeZone').textContent = v.dot + ' ' + v.label;
    // "🔴 แพงมาก · 2.1 เท่าของค่าเฉลี่ย 17.46 (ตั้งแต่ 1871)"
    if(isValidNum(s.mean)){
      const since = String(s.since || '').slice(0, 4);
      el('mkCapeZone').textContent = v.dot + ' ' + v.label + ' · '
        + (isValidNum(s.timesMean) ? s.timesMean.toFixed(1) + tr(' เท่าของค่าเฉลี่ย ', '× the average of ') : tr('ค่าเฉลี่ย ', 'average ')) + s.mean.toFixed(2)
        + (since ? tr(' (ตั้งแต่ ', ' (since ') + since + ')' : '');
    }
    const bits = [];
    if(isValidNum(s.prev) && s.prevDate) bits.push(tr('ต้นเดือน ', 'month start ') + s.prev.toFixed(2));
    if(isValidNum(s.peak) && s.peakDate) bits.push(tr('สูงสุด ', 'peak ') + s.peak.toFixed(2) + ' (' + thMonth(s.peakDate) + ')');
    bits.push(tr('ณ ', 'as of ') + thDay(s.date));
    el('mkCapeInfo').textContent = bits.join(' · ');
    setSpark('spCape', s, { dec:1, color:'var(--accent)', cap:tr('10 ปี', '10 years') });
    if(!meaning) return;
    const pct = isValidNum(s.pctile) ? Math.min(99, Math.floor(s.pctile)) : null;
    const text = v.key === 'high'
      ? (pct != null ? tr('แพงกว่า ' + pct + '% ของทุกเดือนในอดีต', 'pricier than ' + pct + '% of all past months') : tr('แพงมากเทียบกับกำไรระยะยาว', 'very expensive against long-run earnings'))
        + tr(' ผลตอบแทน 10 ปีข้างหน้ามักต่ำ แต่บอกจังหวะไม่ได้ ตลาดแพงอยู่ได้อีกนาน', '; 10-year returns ahead tend to be low, but it can\'t time the market')
      : v.key === 'above'
      ? tr('แพงกว่าค่าเฉลี่ยในอดีต ผลตอบแทนระยะยาวมักต่ำกว่าปกติ แต่ยังไม่ถึงโซนฟองสบู่', 'above the long-run average; long-run returns tend to be below normal, but not bubble territory')
      : tr('ใกล้หรือต่ำกว่าค่าเฉลี่ยในอดีต ในอดีตมักตามมาด้วยผลตอบแทน 10 ปีที่ดี', 'near or below the long-run average; usually followed by good 10-year returns');
    meaning.innerHTML = '<b>' + tr('ความหมาย:', 'What it means:') + '</b> ' + esc(text);
  }
  window.renderCape = renderCape;   // tests
  // Buffett Indicator (มูลค่าตลาดหุ้น ÷ GDP, %) — เกณฑ์เดียว ใช้ทั้งสีตัวเลขใหญ่ บรรทัดสถานะ และบรรทัดความหมาย
  const BUFFETT_FAIR = 100, BUFFETT_HIGH = 150;
  function buffettVerdict(v){
    if(!isValidNum(v)) return null;
    if(v >= BUFFETT_HIGH) return { key:'high', accent:'var(--bad)', dot:'🔴', label:tr('แพงมาก', 'Very expensive') };
    if(v >= BUFFETT_FAIR) return { key:'above', accent:'var(--warn)', dot:'🟡', label:tr('เริ่มแพง', 'Getting expensive') };
    return { key:'fair', accent:'var(--good)', dot:'🟢', label:tr('ถูก/สมเหตุสมผล', 'Cheap or fair') };
  }
  window.buffettVerdict = buffettVerdict;   // tests
  function renderBuffett(s){
    const meaning = el('mkBuffettMeaning');
    if(!s || !isValidNum(s.latest)){
      if(el('mkBuffettZone')) el('mkBuffettZone').textContent = tr('⚪ ดึงค่า Buffett Indicator ไม่ได้ตอนนี้ · จะลองใหม่อัตโนมัติ', '⚪ Can\'t load the Buffett Indicator right now · retrying automatically');
      if(meaning) meaning.innerHTML = '';
      return;
    }
    const v = buffettVerdict(s.latest);
    el('mkBuffett').textContent = Math.round(s.latest) + '%';
    toneNum('mkBuffett', v.accent);
    toneNum('mkBuffettZone', v.accent);
    const since = String(s.since || '').slice(0, 4);
    el('mkBuffettZone').textContent = v.dot + ' ' + v.label
      + (isValidNum(s.mean) ? ' · ' + tr('ค่าเฉลี่ย ', 'average ') + Math.round(s.mean) + '%' + (since ? tr(' (ตั้งแต่ ', ' (since ') + since + ')' : '') : '');
    const bits = [];
    if(isValidNum(s.quarterValue) && s.quarterEnd) bits.push(tr('ไตรมาส ', 'quarter to ') + thMonth(s.quarterEnd) + ' ' + Math.round(s.quarterValue) + '%');
    if(isValidNum(s.peak) && s.peakDate) bits.push(tr('สูงสุด ', 'peak ') + Math.round(s.peak) + '% (' + thMonth(s.peakDate) + ')');
    bits.push((s.estimated ? tr('ประมาณการ ณ ', 'estimate as of ') : tr('ณ ', 'as of ')) + thDay(s.date));
    el('mkBuffettInfo').textContent = bits.join(' · ');
    setSpark('spBuffett', s, { dec:0, color:'var(--accent)', cap:tr('10 ปี', '10 years') });
    if(!meaning) return;
    const pct = isValidNum(s.pctile) ? Math.min(99, Math.floor(s.pctile)) : null;
    const text = v.key === 'high'
      ? (pct != null ? tr('หุ้นแพงกว่า ' + pct + '% ของทุกไตรมาสในอดีตเมื่อเทียบกับขนาดเศรษฐกิจ', 'stocks are pricier against the economy than in ' + pct + '% of past quarters') : tr('หุ้นแพงมากเมื่อเทียบกับขนาดเศรษฐกิจ', 'stocks are very expensive against the economy'))
        + tr(' ผลตอบแทนระยะยาวข้างหน้ามักต่ำ แต่ส่วนหนึ่งสูงเพราะบริษัทสหรัฐฯ มีรายได้จากต่างประเทศ', '; long-run returns ahead tend to be low, though part of it is US firms earning abroad')
      : v.key === 'above'
      ? tr('หุ้นเริ่มแพงกว่าขนาดเศรษฐกิจ ผลตอบแทนระยะยาวอาจต่ำกว่าปกติ แต่ยังไม่ถึงโซนฟองสบู่', 'stocks are getting pricey against the economy; long-run returns may be below normal, but not bubble territory')
      : tr('มูลค่าหุ้นยังไม่เกินขนาดเศรษฐกิจ ในอดีตมักตามมาด้วยผลตอบแทนระยะยาวที่ดี', 'stock market value is below the size of the economy; usually followed by good long-run returns');
    meaning.innerHTML = '<b>' + tr('ความหมาย:', 'What it means:') + '</b> ' + esc(text);
  }
  window.renderBuffett = renderBuffett;   // tests
  // ถ้าเซิร์ฟเวอร์ไม่ได้ส่ง chg1m มา คิดเองจากกราฟ (จุดล่าสุด เทียบจุดที่เก่ากว่า 30 วัน) — ไม่ให้แถบสีหายเงียบๆ
  function usJpChg1m(s){
    if(isValidNum(s.chg1m)) return s.chg1m;
    const h = (s.hist || []).filter(function(p){ return isValidNum(p[1]); });
    if(h.length < 2) return null;
    const last = h[h.length - 1];
    const cutoff = new Date(Date.parse(last[0] + 'T00:00:00Z') - 30 * 86400000).toISOString().slice(0, 10);
    const base = h.filter(function(p){ return p[0] <= cutoff; }).pop();
    return base ? Math.round((last[1] - base[1]) * 1000) / 1000 : null;
  }
  window.usJpChg1m = usJpChg1m;   // tests

  // ---------- 🧭 ภาวะตลาดวันนี้ (Market Pulse) ----------
  // อ่านจากราคาตลาดจริง 4 ตัว (VIX หุ้น · MOVE บอนด์ · HY สินเชื่อ · OVX น้ำมัน) แทนการนับคำในพาดหัวข่าว
  // แต่ละตัวมี 4 ระดับตามเกณฑ์เดียวกับการ์ดของมัน: 0 สงบ · 1 ปกติ · 2 กังวล · 3 ตึงเครียด
  const PULSE_GAUGES = [
    { key: 'vix', name: 'VIX', what: tr('หุ้น', 'stocks'), cuts: [20, 30, 40], fmt: v => v.toFixed(1) },
    { key: 'move', name: 'MOVE', what: tr('บอนด์', 'bonds'), cuts: [80, 110, 140], fmt: v => v.toFixed(0) },
    { key: 'hyOas', name: 'HY', what: tr('หุ้นกู้', 'credit'), cuts: [3.5, 5, 7], fmt: v => v.toFixed(2) + '%' },
    { key: 'ovx', name: 'OVX', what: tr('น้ำมัน', 'oil'), cuts: [25, 40, 60], fmt: v => v.toFixed(0) }
  ];
  const PULSE_COLORS = ['var(--good)', 'var(--accent)', '#e8894a', 'var(--bad)'];
  function pulseLevel(v, cuts){ let l = 0; cuts.forEach(c => { if(v >= c) l++; }); return l; }
  function pulseState(levels){
    if(!levels.length) return null;
    const avg = levels.reduce((a, b) => a + b, 0) / levels.length;
    const i = avg < 0.75 ? 0 : avg < 1.5 ? 1 : avg < 2.25 ? 2 : 3;
    return { i, avg, label: [tr('สงบ', 'Calm'), tr('ปกติ', 'Normal'), tr('ตึงตัว', 'Tense'), tr('ตึงเครียด', 'Stressed')][i] };
  }
  // ตัวที่ขยับแรงผิดปกติในวันล่าสุด (เกณฑ์ราว ๆ 1–2 เท่าของการขยับรายวันทั่วไป)
  function pulseMoves(S){
    const out = [];
    const pct = s => s && isValidNum(s.change) && isValidNum(s.latest) && (s.latest - s.change) ? s.change / (s.latest - s.change) * 100 : null;
    const push = (cond, txt, bad) => { if(cond) out.push({ txt, bad }); };
    const sp = pct(S.sp500), nd = pct(S.nasdaq100), vx = pct(S.vix), dx = pct(S.dollar);
    push(isValidNum(sp) && Math.abs(sp) >= 1, 'S&P 500 ' + (sp > 0 ? '+' : '') + (sp || 0).toFixed(1) + '%', sp < 0);
    push(isValidNum(nd) && Math.abs(nd) >= 1.5, 'Nasdaq 100 ' + (nd > 0 ? '+' : '') + (nd || 0).toFixed(1) + '%', nd < 0);
    push(isValidNum(vx) && Math.abs(vx) >= 10, 'VIX ' + (vx > 0 ? '+' : '') + (vx || 0).toFixed(0) + '%', vx > 0);
    [['us10y', tr('บอนด์ 10 ปี', '10Y yield')], ['us2y', tr('บอนด์ 2 ปี', '2Y yield')]].forEach(([k, n]) => {
      const c = S[k] && S[k].change; if(isValidNum(c) && Math.abs(c) >= 0.08) push(true, n + ' ' + (c > 0 ? '+' : '') + Math.round(c * 100) + ' bp', c > 0);
    });
    const hc = S.hyOas && S.hyOas.change; push(isValidNum(hc) && Math.abs(hc) >= 0.15, 'HY spread ' + (hc > 0 ? '+' : '') + Math.round((hc || 0) * 100) + ' bp', hc > 0);
    push(isValidNum(dx) && Math.abs(dx) >= 0.5, tr('ดอลลาร์ ', 'Dollar ') + (dx > 0 ? '+' : '') + (dx || 0).toFixed(1) + '%', null);
    return out;
  }
  function renderPulse(S){
    const box = el('pulseGauges'); if(!box) return;
    const rows = PULSE_GAUGES.map(g => { const s = S[g.key]; return s && isValidNum(s.latest) ? Object.assign({ v: s.latest, l: pulseLevel(s.latest, g.cuts) }, g) : null; }).filter(Boolean);
    const st = pulseState(rows.map(r => r.l));
    if(!st) return;
    const hot = rows.filter(r => r.l >= 2);
    el('pulseState').innerHTML = '<i style="background:' + PULSE_COLORS[st.i] + '"></i><b style="color:' + PULSE_COLORS[st.i] + '">' + esc(st.label) + '</b>';
    el('pulseState').dataset.level = String(st.i);
    el('pulseWhy').textContent = hot.length
      ? tr('อยู่ในโซนกังวลขึ้นไป: ', 'In the worried zone or worse: ') + hot.map(r => r.name + ' (' + r.what + ')').join(', ')
      : tr('ทั้ง ' + rows.length + ' มาตรวัดยังอยู่ในโซนสงบหรือปกติ', 'All ' + rows.length + ' gauges are calm or normal');
    box.innerHTML = rows.map(r => '<div class="pg" data-level="' + r.l + '"><span class="k">' + r.name + ' <small>' + esc(r.what) + '</small></span>'
      + '<b>' + esc(r.fmt(r.v)) + '</b><span class="lv">' + [0, 1, 2, 3].map(i => '<i' + (i <= r.l ? ' style="background:' + PULSE_COLORS[r.l] + '"' : '') + '></i>').join('') + '</span></div>').join('');
    const mv = pulseMoves(S);
    el('pulseMoves').innerHTML = '<span class="k">' + esc(tr('ขยับแรงในวันล่าสุด', 'Big moves, latest day')) + '</span>'
      + (mv.length ? mv.map(m => '<span class="mv' + (m.bad === true ? ' bad' : m.bad === false ? ' good' : '') + '">' + esc(m.txt) + '</span>').join('')
        : '<span class="mv none">' + esc(tr('ไม่มีตัวไหนขยับผิดปกติ', 'Nothing unusual')) + '</span>');
  }
  window.__pulseTest = { pulseLevel, pulseState, pulseMoves, renderPulse };

  async function fetchMarkets(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/markets', 12000, { cache: 'no-cache' });
      const j = await r.json();
      if(!j || !j.series) throw new Error(j && j.error || 'HTTP ' + r.status);
      const S = j.series;
      lastMarketSeries = S;
      const nextIn = (isValidNum(j.ttl) && j.ttl > 0) ? Math.min(j.ttl * 1000, MARKETS_POLL_MS) : MARKETS_POLL_MS;
      const bp = (c) => (c == null ? '' : '<span class="delta ' + (c > 0 ? 'up' : c < 0 ? 'down' : 'flat') + '">' + (c > 0 ? '+' : '') + Math.round(c * 100) + ' bp</span>');
      if(S.us10y){ el('mkUs10y').innerHTML = esc(S.us10y.latest.toFixed(2)) + '%' + bp(S.us10y.change); setSpark('spUs10y', S.us10y, { color:'var(--accent)' }); }
      if(S.us2y){ el('mkUs2y').innerHTML = esc(S.us2y.latest.toFixed(2)) + '%' + bp(S.us2y.change); setSpark('spUs2y', S.us2y, { color:'var(--accent)' }); }
      // ดัชนีหุ้น: ระดับดัชนี + % เปลี่ยนจากวันทำการก่อน · ใต้กราฟบอกเวลาราคา (Cboe ช้า ~15 นาที หรือราคาปิดจาก FRED)
      [['sp500', 'mkSp500', 'spSp500', 'mkSp500Zone'], ['nasdaq100', 'mkNdx', 'spNdx', 'mkNdxZone']].forEach(function(row){
        const s = S[row[0]];
        if(!s || !isValidNum(s.latest)) return;
        const pct = (isValidNum(s.change) && isValidNum(s.prev) && s.prev) ? s.change / s.prev * 100 : null;
        el(row[1]).innerHTML = esc(s.latest.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 }))
          + (pct == null ? '' : '<span class="delta ' + (pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat') + '">' + (pct > 0 ? '+' : '') + pct.toFixed(2) + '%</span>');
        setSpark(row[2], s, { dec:0 });
        el(row[3]).textContent = (s.source === 'cboe' || s.source === 'yahoo') && s.time
          ? (s.source === 'yahoo' ? 'Yahoo ' : 'Cboe ') + thDay(s.date).replace(/ \d{4}$/, '') + ' ' + s.time.slice(11, 16) + tr(' NY (ช้า ~15 นาที)', ' NY (~15 min delay)')
          : tr('ราคาปิด ', 'Close ') + thDay(s.date);
      });
      try{ renderPulse(S); }catch(e){ console.warn('[pulse]', e); }
      try{ renderBreadth(S.spxew); }catch(e){ console.warn('[breadth]', e); }
      try{ renderCape(S.cape); }catch(e){ console.warn('[cape]', e); }
      try{ renderBuffett(S.buffett); }catch(e){ console.warn('[buffett]', e); }
      if(S.vix){
        const v = S.vix.latest;
        const vc = S.vix.change, vp = (isValidNum(vc) && isValidNum(S.vix.prev) && S.vix.prev) ? vc / S.vix.prev * 100 : null;
        el('mkVix').innerHTML = esc(v.toFixed(2)) + (vp == null ? '' : '<span class="delta ' + (vp > 0 ? 'down' : vp < 0 ? 'up' : 'flat') + '">' + (vp > 0 ? '+' : '') + vp.toFixed(1) + '%</span>');
        const z = vixZone(v, isValidNum(S.vix.monthAgo) ? S.vix.monthAgo : vixMonthAgo(S.vix.hist, S.vix.date));
        const when = S.vix.time ? thDay(S.vix.date).replace(/ \d{4}$/, '') + ' ' + S.vix.time.slice(11, 16) + ' NY' : tr('ปิด ', 'close ') + thDay(S.vix.date);
        el('mkVixZone').innerHTML = esc(z.label) + (z.pastPeak ? '<br>' + esc(tr('📉 VIX เริ่มลงจากจุดพีค', '📉 VIX easing off its high')) : '') + '<br>' + esc(when);
        setSpark('spVix', S.vix, { upIsBad:true });
      }
      // MOVE: ความผันผวนบอนด์ (ตัวนำของ haircut ในตลาด repo)
      if(S.move && isValidNum(S.move.latest)){
        const m = S.move.latest;
        el('mkMove').innerHTML = esc(m.toFixed(2)) + (isValidNum(S.move.change) ? '<span class="delta ' + (S.move.change > 0 ? 'down' : S.move.change < 0 ? 'up' : 'flat') + '">' + (S.move.change > 0 ? '+' : '') + S.move.change.toFixed(2) + '</span>' : '');
        el('mkMoveZone').textContent = (m >= 140 ? tr('🔴 บอนด์ตึงเครียด', '🔴 Bond stress') : m >= 110 ? tr('🟠 กังวล', '🟠 Worried') : m >= 80 ? tr('🟡 ปกติ', '🟡 Normal') : tr('🟢 สงบ', '🟢 Calm')) + tr(' · ปิด ', ' · close ') + thDay(S.move.date);
        setSpark('spMove', S.move, { upIsBad:true, dec:0 });
      }
      // HY OAS: ส่วนต่างหุ้นกู้ขยะเหนือบอนด์รัฐบาล (ราคาความเสี่ยงผิดนัดชำระหนี้)
      if(S.hyOas && isValidNum(S.hyOas.latest)){
        const h = S.hyOas, z = hyZone(h.latest), m1 = hyChange1m(h);
        el('mkHy').innerHTML = esc(h.latest.toFixed(2)) + '%' + (isValidNum(h.change) ? '<span class="delta ' + (h.change > 0 ? 'down' : h.change < 0 ? 'up' : 'flat') + '">' + (h.change > 0 ? '+' : '') + Math.round(h.change * 100) + ' bp</span>' : '');
        el('mkHyZone').innerHTML = esc(z)
          + (m1 == null ? '' : '<br>' + esc(tr('1 เดือน ', '1 month ') + (m1 > 0 ? '+' : '') + Math.round(m1 * 100) + ' bp' + (m1 >= 1 ? tr(' ⚠️ ถ่างเร็ว', ' ⚠️ widening fast') : '')))
          + '<br>' + esc(tr('ปิด ', 'close ') + thDay(h.date));
        setSpark('spHy', h, { upIsBad:true, dec:2 });
      }
      // OVX: ความผันผวนน้ำมัน (VIX ของน้ำมันดิบ WTI)
      if(S.ovx && isValidNum(S.ovx.latest)){
        const o = S.ovx.latest;
        el('mkOvx').innerHTML = esc(o.toFixed(2)) + (isValidNum(S.ovx.change) ? '<span class="delta ' + (S.ovx.change > 0 ? 'down' : S.ovx.change < 0 ? 'up' : 'flat') + '">' + (S.ovx.change > 0 ? '+' : '') + S.ovx.change.toFixed(2) + '</span>' : '');
        el('mkOvxZone').textContent = (o >= 60 ? tr('🔴 น้ำมันตื่นตระหนก', '🔴 Oil panic') : o >= 40 ? tr('🟠 กังวล', '🟠 Worried') : o >= 25 ? tr('🟡 ปกติ', '🟡 Normal') : tr('🟢 สงบ', '🟢 Calm'))
          + (S.ovx.time ? ' · ' + thDay(S.ovx.date).replace(/ \d{4}$/, '') + ' ' + S.ovx.time.slice(11, 16) + ' NY' : tr(' · ปิด ', ' · close ') + thDay(S.ovx.date));
        setSpark('spOvx', S.ovx, { upIsBad:true, dec:0 });
      }
      // SOFR − IORB (bp): บวกและถ่างขึ้น = เงินสดขาด ตลาด repo ตึง
      if(S.sofrSpread && isValidNum(S.sofrSpread.latest)){
        const sp = S.sofrSpread.latest, r = Math.round(sp);
        const ch = S.sofrSpread.change;
        el('mkSofr').innerHTML = (r > 0 ? '+' : '') + esc(r) + ' bp'
          + (isValidNum(ch) && Math.round(ch) !== 0 ? '<span class="delta ' + (ch > 0 ? 'down' : 'up') + '">' + (ch > 0 ? '+' : '') + Math.round(ch) + ' bp</span>' : '');
        el('mkSofrZone').textContent = (sp > 15 ? tr('🔴 repo ตึงหนัก', '🔴 Severe repo strain') : sp > 5 ? tr('🟠 repo ตึงตัว', '🟠 Repo tight') : sp >= 0 ? tr('🟡 เริ่มตึง', '🟡 Tightening') : tr('🟢 เงินสดล้นระบบ', '🟢 Cash plentiful'))
          + (isValidNum(S.sofrSpread.sofr) && isValidNum(S.sofrSpread.iorb) ? ' · SOFR ' + S.sofrSpread.sofr.toFixed(2) + '% · IORB ' + S.sofrSpread.iorb.toFixed(2) + '%' : '')
          + ' · ' + thDay(S.sofrSpread.date);
        setSpark('spSofr', S.sofrSpread, { upIsBad:true, dec:0 });
      }
      // Leveraged funds net short UST futures ($bn, weekly CFTC): ขนาด basis trade · อ่านคู่กับ MOVE
      if(S.levShort && isValidNum(S.levShort.latest)){
        const L = S.levShort, v = L.latest, ch = L.change;
        const fmtBn = (x) => '$' + Math.round(x).toLocaleString('en-US') + ' bn';
        el('mkLevShort').innerHTML = esc(fmtBn(v))
          + (isValidNum(ch) && Math.round(ch) !== 0 ? '<span class="delta ' + (ch > 0 ? 'down' : 'up') + '">' + (ch > 0 ? '+' : '') + Math.round(ch) + '</span>' : '');
        el('mkLevShortZone').textContent = levShortZone(L, S.move) + tr(' · ณ ', ' · as of ') + thDay(L.date);
        setSpark('spLevShort', L, { upIsBad:true, dec:0 });
      }
      if(S.dollar) el('mkDollarName').textContent = S.dollar.source === 'ecb-dxy' ? tr('ดัชนีดอลลาร์ (DXY)', 'Dollar index (DXY)') : tr('ดัชนีดอลลาร์ (Broad)', 'Dollar index (Broad)');
      if(S.dollar){ el('mkDollar').innerHTML = esc(S.dollar.latest.toFixed(2)) + (S.dollar.change != null ? '<span class="delta ' + (S.dollar.change >= 0 ? 'up' : 'down') + '">' + (S.dollar.change >= 0 ? '+' : '') + S.dollar.change.toFixed(2) + '</span>' : ''); setSpark('spDollar', S.dollar, { color:'var(--accent)' }); }
      // ส่วนต่างยีลด์ US − ญี่ปุ่น (carry trade): สีตามการเปลี่ยนแปลง 1 เดือน — แคบลงเร็ว = เสี่ยง unwind
      [['usjp2y', 'UsJp2y', '2'], ['usjp10y', 'UsJp10y', '10']].forEach(function(row){
        const s = S[row[0]];
        if(!s || !isValidNum(s.latest)) return;
        el('mk' + row[1]).innerHTML = esc(s.latest.toFixed(2)) + '%' + bp(s.change);
        el('mk' + row[1] + 'Zone').textContent = usJpZone(usJpChg1m(s)) || tr('⚪ ยังไม่มีข้อมูลย้อนหลังครบ 1 เดือน · จะลองดึงใหม่อัตโนมัติ', '⚪ Less than a month of history so far · retrying automatically');
        el('mk' + row[1] + 'Info').textContent = 'US ' + s.us.toFixed(2) + '% − JP ' + s.jp.toFixed(2) + '%'
          + (isValidNum(s.chg1w) ? tr(' · 1 สัปดาห์ ', ' · 1 wk ') + signedPp(s.chg1w) : '')
          + tr(' · ณ ', ' · as of ') + thDay(s.date);
        setSpark('sp' + row[1], s, { dec:2 });
      });
      renderUsdJpyLink();
      if(S.fedUpper) setSpark('spFed', S.fedUpper, { color:'var(--accent)', dec:2 });
      if(S.cpi) setSpark('spCpi', S.cpi, { upIsBad:true, dec:1 });
      if(S.unrate) setSpark('spUnrate', S.unrate, { upIsBad:true, dec:1 });
      patchSparksFromLive();
      marketsNextAt = Date.now() + Math.max(nextIn, 60 * 1000);
      const yieldNote = (name, s) => !s ? '' : (s.source === 'cboe' || s.source === 'yahoo') && s.time
        ? name + (s.source === 'yahoo' ? tr(' จาก Yahoo ', ' from Yahoo ') : tr(' จาก Cboe ', ' from Cboe ')) + thDay(s.date).replace(/ \d{4}$/, '') + ' ' + s.time.slice(11, 16) + tr(' NY (ช้า ~15 นาที)', ' NY (~15 min delay)')
        : s.source === 'treasury' ? name + tr(' ราคาปิด ', ' close ') + thDay(s.date) + tr(' (กระทรวงการคลังสหรัฐ)', ' (US Treasury)')
        : name + tr(' ราคาปิด ', ' close ') + thDay(s.date) + tr(' (FRED ช้ากว่าตลาดประมาณ 1 วันทำการ)', ' (FRED, about 1 business day behind the market)');
      el('mktWarn').textContent = '';
      el('mktNote').textContent = [yieldNote(tr('บอนด์ 10 ปี', '10Y yield'), S.us10y), yieldNote(tr('2 ปี', '2Y'), S.us2y)].filter(Boolean).join(' · ')
        + tr(' · DXY จากอัตรา ECB ', ' · DXY from ECB rates ') + (S.dollar && S.dollar.date ? thDay(S.dollar.date) : '–')
        + tr(' · VIX/OVX ราคาจาก Cboe หรือ Yahoo (ใช้อันที่ใหม่กว่า) ช้า ~15 นาที · MOVE ราคาปิด (ICE ผ่าน Yahoo) · SPXEW จาก Yahoo · Shiller PE จาก multpl.com (ข้อมูลของ Robert Shiller) · Buffett Indicator จาก FRED (มูลค่าหุ้น Z.1 ของ Fed รายไตรมาส ขยับตาม S&P 500 ถึงวันนี้ ÷ GDP) · SOFR/IORB จาก FRED · short บอนด์ฟิวเจอร์สจาก CFTC รายสัปดาห์ · ยีลด์ญี่ปุ่นจาก MOF ญี่ปุ่น · อัปเดตทุกชั่วโมง · กราฟเล็ก = ย้อนหลัง 12 เดือน',
             ' · VIX/OVX from Cboe or Yahoo (whichever is newer), ~15 min delay · MOVE daily close (ICE via Yahoo) · SPXEW from Yahoo · Shiller PE from multpl.com (Robert Shiller data) · Buffett Indicator from FRED (Fed Z.1 equity value, quarterly, moved with the S&P 500 to today, ÷ GDP) · SOFR/IORB from FRED · UST futures short from CFTC, weekly · JGB yields from Japan MOF · updated hourly · mini charts = last 12 months');
    }catch(e){
      console.warn('[markets]', e);
      el('mktWarn').textContent = tr('⚠️ ดึงข้อมูลตลาดไม่ได้ในขณะนี้ — จะลองใหม่อัตโนมัติ', '⚠️ Can\'t load market data right now. Retrying automatically.');
      marketsNextAt = Date.now() + 10 * 60 * 1000;
    }
  }
  // Re-poll when the server says this copy expires (15 min on release days, 1 h otherwise):
  // a cheap once-a-minute check instead of a fixed 1 h interval.
  const MARKETS_POLL_MS = 60 * 60 * 1000;
  var marketsNextAt = 0;
  fetchMarkets();
  setInterval(function(){ if(Date.now() >= marketsNextAt) fetchMarkets(); }, 60 * 1000);

  // ---------- ขนาดตลาดทุนโลก (กราฟแท่งแนวนอน) ----------
  // ข้อมูลทั้งหมดมาจาก /.netlify/functions/capital-markets (หน่วย ล้านล้านดอลลาร์) ไม่มีตัวเลขพิมพ์เอง:
  // หุ้นรายประเทศ = companiesmarketcap (สด) · ตราสารหนี้ = BIS (รายไตรมาส) · ทอง = ราคาสด × ปริมาณทองโลก (WGC) · คริปโต = CoinGecko (สด)
  // ดึงใหม่ทุก 15 นาทีตอนแท็บเปิดอยู่ (เท่ากับอายุแคชของเซิร์ฟเวอร์) และทันทีเมื่อกลับมาที่แท็บถ้าเกินเวลาแล้ว
  const CM_POLL_MS = 15 * 60 * 1000;
  let cmNextAt = 0;
  const CM_PARTS = {
    bonds:    { icon:'🏦', th:'ตราสารหนี้ทั่วโลก', en:'Global bonds', color:'var(--cm-bonds)' },
    equities: { icon:'📈', th:'หุ้นทั่วโลก', en:'Global stocks', color:'var(--cm-equities)' },
    gold:     { icon:'🥇', th:'ทองคำ', en:'Gold', color:'var(--cm-gold)' },
    crypto:   { icon:'₿',  th:'คริปโต', en:'Crypto', color:'var(--cm-crypto)' }
  };
  const CM_SUBS = {
    US:['🇺🇸','สหรัฐฯ','United States'], CN:['🇨🇳','จีน','China'], JP:['🇯🇵','ญี่ปุ่น','Japan'], GB:['🇬🇧','อังกฤษ','United Kingdom'],
    U2:['🇪🇺','ยูโรโซน','Euro area'], EU:['🇪🇺','ยุโรป','Europe'], IN:['🇮🇳','อินเดีย','India'],
    CA:['🇨🇦','แคนาดา','Canada'], TW:['🇹🇼','ไต้หวัน','Taiwan'], KR:['🇰🇷','เกาหลีใต้','South Korea'], TH:['🇹🇭','ไทย','Thailand'],
    BR:['🇧🇷','บราซิล','Brazil'], AU:['🇦🇺','ออสเตรเลีย','Australia'], CH:['🇨🇭','สวิตเซอร์แลนด์','Switzerland'], MX:['🇲🇽','เม็กซิโก','Mexico'],
    SE:['🇸🇪','สวีเดน','Sweden'], SG:['🇸🇬','สิงคโปร์','Singapore'], DK:['🇩🇰','เดนมาร์ก','Denmark'], NO:['🇳🇴','นอร์เวย์','Norway'],
    SA:['🇸🇦','ซาอุดีอาระเบีย','Saudi Arabia'], HK:['🇭🇰','ฮ่องกง','Hong Kong'], AE:['🇦🇪','ยูเออี','UAE'],
    BTC:['₿','Bitcoin','Bitcoin'], STABLE:['💵','Stablecoin','Stablecoins'], OTHER:['·','อื่นๆ','Others']
  };
  const CM_MAX_SUBS = 16;
  // ประเทศที่ไม่มีใน CM_SUBS: ธงจากรหัส ISO 2 ตัว + ชื่อจาก Intl.DisplayNames (ไทย/อังกฤษ) · ใช้ไม่ได้ก็แสดงรหัส
  function cmRegionName(code, lang){
    try{ return new Intl.DisplayNames([lang], { type:'region' }).of(code) || code; }catch(e){ return code; }
  }
  function cmSubLabel(k){
    if(CM_SUBS[k]) return CM_SUBS[k];
    const flag = /^[A-Z]{2}$/.test(k) ? String.fromCodePoint(0x1F1E6 + k.charCodeAt(0) - 65, 0x1F1E6 + k.charCodeAt(1) - 65) : '·';
    return [flag, cmRegionName(k, 'th'), cmRegionName(k, 'en')];
  }
  // ล้านล้านดอลลาร์ → "$62.2 ล้านล้าน" / "$62.2T" · ต่ำกว่า 1 ล้านล้าน → "$430 พันล้าน" / "$430B"
  function fmtCapT(t){
    if(!isValidNum(t)) return '–';
    if(t >= 1) return '$' + (t >= 100 ? t.toFixed(0) : t.toFixed(1)) + tr(' ล้านล้าน', 'T');
    return '$' + Math.round(t * 1000) + tr(' พันล้าน', 'B');
  }
  function cmDate(iso, withTime){
    const d = new Date(iso);
    if(isNaN(d)) return '';
    const o = withTime ? { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' } : { day:'numeric', month:'short', year:'numeric' };
    try{ return d.toLocaleString(window.GI_LOCALE || 'th-TH', o); }catch(e){ return iso.slice(0, 10); }
  }
  // parts จากเซิร์ฟเวอร์ → แถวที่จะวาด เรียงใหญ่ไปเล็ก ("อื่นๆ" อยู่ท้ายกลุ่มเสมอ) · width เทียบกับแถวที่ใหญ่ที่สุดทั้งกราฟ
  function capMarketRows(parts){
    const mains = Object.keys(CM_PARTS).filter(function(k){ return parts && parts[k] && isValidNum(parts[k].total) && parts[k].total > 0; })
      .map(function(k){ return { key:k, total:parts[k].total, part:parts[k] }; })
      .sort(function(a, b){ return b.total - a.total; });
    const grand = mains.reduce(function(a, m){ return a + m.total; }, 0);
    const max = mains.length ? mains[0].total : 1;
    const rows = [];
    mains.forEach(function(m){
      const meta = CM_PARTS[m.key];
      rows.push({ kind:'main', key:m.key, label:meta.icon + ' ' + tr(meta.th, meta.en), value:m.total, pct:grand ? m.total / grand * 100 : null,
        width:m.total / max * 100, color:meta.color, part:m.part });
      // แสดงประเทศใหญ่สุด CM_MAX_SUBS แถวต่อกล่อง (ไทยแสดงเสมอ) ที่เหลือรวมเป็น "ประเทศอื่น" · กล่องหุ้นกับตราสารหนี้จึงสูงเท่ากัน
      const by = Object.assign({}, (m.part && m.part.byKey) || {});
      const keys = Object.keys(by).filter(function(k){ return k !== 'OTHER' && isValidNum(by[k]) && by[k] > 0; })
        .sort(function(a, b){ return by[b] - by[a]; });
      const keep = keys.slice(0, CM_MAX_SUBS);
      if(keys.indexOf('TH') >= CM_MAX_SUBS) keep.push('TH');
      let other = isValidNum(by.OTHER) ? by.OTHER : 0;
      keys.forEach(function(k){ if(keep.indexOf(k) < 0) other += by[k]; });
      keep.sort(function(a, b){ return by[b] - by[a]; });
      if(other > 0.0005){ keep.push('OTHER'); by.OTHER = other; }
      keep.forEach(function(k){
        // "อื่นๆ" บอกให้ชัดว่าอื่นอะไร: คริปโต = เหรียญอื่นนอกจาก Bitcoin · หุ้น/ตราสารหนี้ = ประเทศที่ไม่ได้แยกแท่ง
        const s = k === 'OTHER' ? (m.key === 'crypto' ? ['🪙','เหรียญอื่น','Other coins'] : ['🌍','ประเทศอื่น','Other countries']) : cmSubLabel(k);
        rows.push({ kind:'sub', key:m.key + ':' + k, label:s[0] + ' ' + tr(s[1], s[2]), value:by[k], share:by[k] / m.total * 100,
          width:by[k] / max * 100, color:meta.color });
      });
    });
    return { rows:rows, grand:grand };
  }
  // ข้อความเมื่อชี้เมาส์ที่แถวคริปโต: บอกว่าในก้อนนั้นมีเหรียญอะไร (ตัวเลขสดจาก CoinGecko ถ้ามี)
  // ปุ่ม i ของแต่ละประเทศในกล่องหุ้น: ข้อมูลสดจาก /.netlify/functions/country-profiles (companiesmarketcap, World Bank, ILO)
  // อัปเดตเองเมื่อแหล่งข้อมูลออกตัวเลขใหม่ · ตารางข้างล่างเป็นค่าสำรองตอนยังโหลดไม่เสร็จหรือดึงไม่ได้เท่านั้น
  let cmProfiles = null;
  const CM_CHAMPS_FALLBACK = {
    US:['Apple','Microsoft','Alphabet (Google)','NVIDIA'], EU:['ASML','HSBC','Roche','SAP'], CN:['China Construction Bank','Tencent','Agricultural Bank of China','Bank of China'],
    JP:['Toyota','Mitsubishi UFJ Financial','Sony','Fast Retailing'], IN:['Reliance Industries','Bharti Airtel','HDFC Bank','ICICI Bank'], CA:['Royal Bank Of Canada','Toronto Dominion Bank','Shopify','Bank of Montreal'],
    TW:['TSMC','MediaTek','Foxconn','Delta Electronics'], KR:['Samsung','SK Hynix','SK Square','LG Energy Solution'], SA:['Saudi Aramco','Al Rajhi Bank','The Saudi National Bank','Ma\'aden'],
    AU:['Commonwealth Bank','BHP Group','Westpac Banking','ANZ Bank'], HK:['AIA','Bank of China (Hong Kong)','Hong Kong Exchanges & Clearing','Swire Pacific'], AE:['International Holding Company','TAQA','ADNOC Gas','First Abu Dhabi Bank'],
    BR:['Petrobras','Itaú Unibanco','Nu Holdings','Vale'], SG:['DBS Group','OCBC Bank','Singtel','UOB'], MX:['Grupo México','America Movil','Walmex','FEMSA'],
    IL:['Teva Pharmaceutical Industries','Bank Leumi','Elbit Systems','Bank Hapoalim'], ZA:['AngloGold Ashanti','Capitec Bank','Gold Fields','FirstRand'], ID:['Bank Central Asia','Bank Rakyat Indonesia','Bank Mandiri','PT DCI Indonesia'],
    MY:['Maybank','Public Bank','CIMB Group','Tenaga Nasional'], TH:['Delta Electronics (Thailand)','PTT PCL','Advanced Info Service (AIS)','Gulf Development'], VN:['Vingroup','Vinhomes','BIDV','VPBank']
  };
  // ค่าสำรอง (ประมาณ): สัดส่วนคนอายุ 65+ (%), ดัชนีทุนมนุษย์ World Bank, ผลผลิตต่อชั่วโมง ILO ($ PPP), ระดับราคาเทียบสหรัฐฯ
  const CM_PEOPLE_FALLBACK = {
    US:[18,0.70,97,1], EU:[22,0.76,75,0.75], CN:[15,0.65,16,0.55], JP:[30,0.80,50,0.65], IN:[7,0.49,9,0.25], CA:[20,0.80,68,0.85], TW:[19,null,70,0.45], KR:[20,0.80,50,0.65],
    SA:[3,0.58,62,0.5], AU:[17,0.77,72,0.9], HK:[23,0.81,62,0.71], AE:[2,0.67,58,0.6], BR:[11,0.55,20,0.45], SG:[18,0.88,80,0.65], MX:[9,0.61,22,0.55], IL:[12,0.73,60,0.95],
    ZA:[6,0.43,25,0.4], ID:[7,0.54,14,0.3], MY:[8,0.61,30,0.35], TH:[16,0.61,18,0.31], VN:[9,0.69,10,0.3]
  };
  // ธุรกิจของบริษัท: จับจากชื่อ (บริษัทที่ไม่รู้จักจะแสดงแค่ชื่อ)
  const CM_BIZ = [
    [/apple/i,'iPhone','iPhone'], [/microsoft/i,'Windows, คลาวด์ Azure','Windows, Azure cloud'], [/alphabet|google/i,'Google, YouTube','Google, YouTube'],
    [/nvidia/i,'ชิป AI','AI chips'], [/amazon/i,'อีคอมเมิร์ซ, คลาวด์ AWS','e-commerce, AWS cloud'], [/^meta/i,'Facebook, Instagram','Facebook, Instagram'],
    [/broadcom/i,'ชิปเครือข่าย','networking chips'], [/tesla/i,'รถ EV','EVs'], [/berkshire/i,'บริษัทลงทุนของ Warren Buffett','Warren Buffett\'s holding company'],
    [/tsmc/i,'รับผลิตชิปให้ Apple, Nvidia','makes chips for Apple, Nvidia'], [/sk hynix/i,'หน่วยความจำ HBM สำหรับ AI','HBM memory for AI'], [/samsung/i,'ชิปหน่วยความจำ, มือถือ','memory chips, phones'],
    [/sk square/i,'บริษัทลงทุน (ถือ SK Hynix)','holding company (owns SK Hynix)'], [/lg energy/i,'แบตเตอรี่รถ EV','EV batteries'], [/hyundai/i,'รถยนต์','cars'],
    [/asml/i,'เครื่องผลิตชิป','chip-making machines'], [/^sap$/i,'ซอฟต์แวร์องค์กร','business software'], [/lvmh/i,'แบรนด์หรู Louis Vuitton','luxury, Louis Vuitton'],
    [/or[ée]al/i,'เครื่องสำอาง','cosmetics'], [/siemens/i,'เครื่องจักร, ระบบอัตโนมัติ','industrial automation'], [/astrazeneca|novartis|roche|novo nordisk|teva|sanofi/i,'ยา','pharmaceuticals'],
    [/shell|petrobras|aramco|^ptt|adnoc|reliance/i,'น้ำมัน, ก๊าซ','oil & gas'], [/nestl/i,'อาหาร','food'], [/linde/i,'ก๊าซอุตสาหกรรม','industrial gases'], [/^arm/i,'ออกแบบชิป','chip designs'],
    [/toyota/i,'รถยนต์','cars'], [/sony/i,'เกม PlayStation, เซนเซอร์กล้อง','PlayStation, camera sensors'], [/fast retailing/i,'เสื้อผ้า Uniqlo','Uniqlo clothing'], [/recruit/i,'เว็บหางาน Indeed','Indeed job site'],
    [/tencent/i,'WeChat, เกม','WeChat, games'], [/naspers/i,'ถือหุ้น Tencent','owns a Tencent stake'], [/cxmt/i,'ชิปหน่วยความจำ','memory chips'], [/moutai/i,'เหล้าเหมาไถ','Moutai liquor'], [/catl/i,'แบตเตอรี่รถ EV','EV batteries'],
    [/airtel|singtel|telecom|telkom|movil|advanced info|\bais\b/i,'มือถือ, อินเทอร์เน็ต','mobile, internet'], [/ma'aden|bhp|vale|grupo m[ée]xico|anglo/i,'เหมืองแร่','mining'],
    [/gold fields|anglogold/i,'เหมืองทอง','gold mining'], [/nu holdings/i,'ธนาคารดิจิทัล','digital bank'], [/ambev/i,'เบียร์','beer'], [/shopify/i,'ระบบร้านค้าออนไลน์','online store platform'],
    [/walmex/i,'Walmart เม็กซิโก','Walmart Mexico'], [/femsa/i,'ร้าน OXXO, เครื่องดื่ม','OXXO stores, drinks'], [/delta electronics/i,'อุปกรณ์ไฟฟ้าสำหรับศูนย์ข้อมูล','power gear for data centres'],
    [/gulf/i,'โรงไฟฟ้า, ถือหุ้น AIS','power plants, AIS stake'], [/airports/i,'สนามบิน','airports'], [/^aia$/i,'ประกันชีวิต','life insurance'], [/chubb/i,'ประกันภัย','insurance'],
    [/exchanges/i,'ตลาดหลักทรัพย์','stock exchange'], [/international holding/i,'บริษัทลงทุนของอาบูดาบี','Abu Dhabi holding company'], [/taqa|tenaga/i,'ไฟฟ้า, น้ำ','power & water'],
    [/sea limited/i,'Shopee, เกม Garena','Shopee, Garena games'], [/vingroup/i,'อสังหาฯ, รถ VinFast','property, VinFast cars'], [/vinhomes/i,'อสังหาริมทรัพย์','property'], [/hoa phat/i,'เหล็ก','steel'],
    [/elbit/i,'อาวุธ, กลาโหม','defence'], [/mediatek/i,'ชิปมือถือ','phone chips'], [/foxconn|hon hai/i,'ประกอบ iPhone, เซิร์ฟเวอร์ AI','assembles iPhones, AI servers'], [/ase group/i,'ประกอบและทดสอบชิป','chip packaging'],
    [/dci indonesia/i,'ศูนย์ข้อมูล','data centres'], [/bayan/i,'ถ่านหิน','coal'], [/ihh/i,'โรงพยาบาล','hospitals'], [/abb/i,'ระบบไฟฟ้า, หุ่นยนต์','electrification, robotics'], [/swire|jardine/i,'กลุ่มธุรกิจหลายประเภท','conglomerate'],
    [/bank|banco|hsbc|ufj|\bdbs\b|ocbc|\buob\b|cimb|banorte|firstrand|itaú|itau|bidv|vpbank|mizrahi|hapoalim|capitec/i,'ธนาคาร','banking']
  ];
  function cmBiz(name){
    for(let i = 0; i < CM_BIZ.length; i++) if(CM_BIZ[i][0].test(name)) return tr(CM_BIZ[i][1], CM_BIZ[i][2]);
    return '';
  }
  function cmShortName(name){
    let n = String(name).replace(/\s+(PCL|Public Company|Company|Tbk|PJSC)\b.*$/i, '').replace(/\s{2,}/g, ' ').trim();
    // ชื่อยาว: ตัดวงเล็บท้ายชื่อทิ้ง ยกเว้นเป็นชื่อย่อ เช่น (AIS)
    if(n.length > 24) n = n.replace(/\s*\(([^)]*)\)\s*$/, function(m, inner){ return /^[A-Z0-9&.\- ]{2,6}$/.test(inner) ? m : ''; });
    return n;
  }
  function cmPeople(code){
    const live = cmProfiles && cmProfiles.people && cmProfiles.people[code] || {};
    const f = CM_PEOPLE_FALLBACK[code] || [];
    const pick = function(k, i){ return isValidNum(live[k]) ? live[k] : (f[i] == null ? null : f[i]); };
    return { old65:pick('old65', 0), old65Year:live.old65Year, hci:pick('hci', 1), hciYear:live.hciYear, perHour:pick('perHour', 2), perHourYear:live.perHourYear,
      priceLevel:pick('priceLevel', 3), priceYear:live.priceYear };
  }
  const cmYr = function(y){ return y ? tr(' (ปี ' + y + ')', ' (' + y + ')') : ''; };
  // แต่ละหัวข้อใน tooltip = [หัวข้อ, เนื้อหา (ขึ้นบรรทัดใหม่ด้วย \n)]
  function cmPeopleHint(code){
    if(!CM_PEOPLE_FALLBACK[code] && !(cmProfiles && cmProfiles.people && cmProfiles.people[code])) return [];
    const p = cmPeople(code);
    const grade = function(v, hi, mid){ return v >= hi ? tr('สูง', 'High') : v >= mid ? tr('กลาง', 'Medium') : tr('ต่ำ', 'Low'); };
    const out = [];
    if(p.old65 != null){
      const tag = p.old65 >= 20 ? tr(' · สังคมสูงวัยเต็มขั้น', ' · super-aged') : p.old65 >= 14 ? tr(' · สังคมสูงวัย', ' · aged society') : p.old65 <= 8 ? tr(' · คนหนุ่มสาวเยอะ', ' · young') : '';
      out.push([tr('👥 ประชากร', '👥 People'), tr('คนอายุ 65 ปีขึ้นไป ' + p.old65.toFixed(0) + '%', 'Aged 65+: ' + p.old65.toFixed(0) + '%') + tag + cmYr(p.old65Year)]);
    }
    out.push([tr('🎓 ทักษะแรงงาน', '🎓 Workforce skills') + (p.hci == null ? '' : ': ' + grade(p.hci, 0.75, 0.6)),
      p.hci == null ? tr('ไม่มีในข้อมูล World Bank\nคะแนนสอบนักเรียน (PISA) ติดกลุ่มท็อปของโลก', 'Not in World Bank data\nStudents rank near the top in PISA tests')
        : tr('ดัชนีทุนมนุษย์ World Bank ' + p.hci.toFixed(2) + ' จาก 1', 'World Bank Human Capital Index ' + p.hci.toFixed(2) + ' of 1') + cmYr(p.hciYear)]);
    if(p.perHour != null){
      const us = cmPeople('US').perHour, th = cmPeople('TH').perHour;
      let body = tr('ทำงาน 1 ชม. ได้ของเท่ากับเงิน ~$' + Math.round(p.perHour) + ' ที่อเมริกา', '1 hour of work buys what ~$' + Math.round(p.perHour) + ' buys in the US') + cmYr(p.perHourYear)
        + '\n' + tr('เทียบ: สหรัฐฯ ~$' + Math.round(us) + ' · ไทย ~$' + Math.round(th), 'Compare: US ~$' + Math.round(us) + ' · Thailand ~$' + Math.round(th));
      if(p.priceLevel != null){
        const cost = p.priceLevel >= 0.85 ? tr('แพง', 'expensive') : p.priceLevel >= 0.55 ? tr('ปานกลาง', 'moderate') : tr('ถูก', 'cheap');
        body += '\n' + (code === 'US' ? tr('ค่าครองชีพ: ' + cost + ' (ฐานเทียบ)', 'Cost of living: ' + cost + ' (baseline)')
          : tr('ค่าครองชีพ: ' + cost + ' (ของราคาราว ' + Math.round(p.priceLevel * 100) + '% ของสหรัฐฯ)', 'Cost of living: ' + cost + ' (prices ~' + Math.round(p.priceLevel * 100) + '% of the US)'));
      }
      out.push([tr('💵 รายได้ต่อชั่วโมง เทียบค่าครองชีพ: ', '💵 Earnings per hour vs cost of living: ') + grade(p.perHour, 60, 25), body]);
    }
    return out;
  }
  function cmRowHint(group, code, part){
    if(group === 'equities'){
      const live = cmProfiles && cmProfiles.champs && cmProfiles.champs[code];
      const names = Array.isArray(live) && live.length ? live.map(function(c){ return c[0]; }) : CM_CHAMPS_FALLBACK[code];
      const out = [];
      if(code === 'EU') out.push([tr('🗺️ รวมประเทศ', '🗺️ Includes'), tr('ยูโรโซน อังกฤษ สวิส และนอร์ดิก', 'Euro area, UK, Switzerland and the Nordics')]);
      if(names) out.push([tr('🏆 บริษัทเด่น (ใหญ่สุดตามมูลค่าตลาด)', '🏆 Champion stocks (largest by market cap)'), names.map(function(n){ const b = cmBiz(n); return '• ' + cmShortName(n) + (b ? ' · ' + b : ''); }).join('\n')]);
      return out.concat(cmPeopleHint(code));
    }
    if(group !== 'crypto') return '';
    if(code === 'STABLE') return tr('เหรียญที่ผูกค่ากับดอลลาร์ ก้อนใหญ่สุดคือ USDT (Tether) รองลงมาคือ USDC แล้วก็ USDe, DAI และอื่นๆ เป็นเงินที่จอดรอในโลกคริปโต',
      'Coins pegged to the dollar: USDT (Tether) is the biggest, then USDC, USDe, DAI and others. Cash parked inside crypto');
    if(code !== 'OTHER') return '';
    const top = (part && Array.isArray(part.top) ? part.top : []).filter(function(t){ return t && isValidNum(t[1]); });
    const NAMES = { ETH:'Ethereum', XRP:'XRP', BNB:'BNB', SOL:'Solana', DOGE:'Dogecoin', TRX:'TRON', ADA:'Cardano', STETH:'Lido stETH' };
    const list = top.length ? top.map(function(t){ return (NAMES[t[0]] || t[0]) + ' ' + fmtCapT(t[1]); }).join(', ') : 'Ethereum, XRP, BNB, Solana';
    return tr('ก้อนใหญ่สุดคือ ' + list + ' และเหรียญเล็กอีกหลายพันตัว (ไม่รวม Bitcoin และ stablecoin)',
      'Biggest: ' + list + ', plus thousands of smaller coins (excluding Bitcoin and stablecoins)');
  }
  function cmAsOf(key, p){
    if(!p) return '';
    const stale = p.stale ? tr(' (ข้อมูลเก่า)', ' (stale)') : '';
    if(key === 'bonds') return tr('ข้อมูล ณ สิ้นไตรมาส ', 'As of quarter end ') + cmDate(p.asOf) + tr(' · BIS อัปเดตรายไตรมาส', ' · BIS updates quarterly') + stale;
    if(key === 'gold') return tr('ราคาทอง $', 'Gold $') + (isValidNum(p.price) ? p.price.toLocaleString('en-US', { maximumFractionDigits:0 }) : '–') + tr('/ออนซ์ × ทองที่ขุดขึ้นมาแล้ว ~', '/oz × ~') + (isValidNum(p.tonnes) ? p.tonnes.toLocaleString('en-US') : '–') + tr(' ตัน', ' tonnes mined to date') + ' · ' + cmDate(p.asOf, true) + stale;
    return tr('สด · ', 'Live · ') + cmDate(p.asOf, true) + stale;
  }
  function renderCapMarkets(j){
    const parts = (j && j.parts) || {};
    (j && j.staleParts || []).forEach(function(k){ if(parts[k]) parts[k].stale = true; });
    if(j && j.stale) Object.keys(parts).forEach(function(k){ if(parts[k]) parts[k].stale = true; });
    const r = capMarketRows(parts);
    if(!r.rows.length) throw new Error('no parts');
    el('cmTotal').innerHTML = '<b>' + esc(fmtCapT(r.grand)) + '</b><span>' + tr('มูลค่ารวม (ดอลลาร์สหรัฐ) · เรียงจากใหญ่ไปเล็ก', 'in total (US$) · largest to smallest') + '</span>';
    const mains = r.rows.filter(function(x){ return x.kind === 'main'; });
    const cv = function(k){ return 'var(--cm-' + k + ')'; };
    el('cmStack').innerHTML = mains.map(function(m){
      return '<span style="flex:' + m.value.toFixed(3) + ' 1 0;background:linear-gradient(90deg,' + cv(m.key) + ',var(--cm-' + m.key + '2))" title="' + esc(m.label + ' ' + (m.pct || 0).toFixed(1) + '%') + '"></span>';
    }).join('');
    el('cmLegend').innerHTML = mains.map(function(m){
      return '<span><i style="background:' + cv(m.key) + '"></i>' + esc(tr(CM_PARTS[m.key].th, CM_PARTS[m.key].en)) + ' <b>' + (m.pct || 0).toFixed(0) + '%</b></span>';
    }).join('');
    el('cmRows').innerHTML = mains.map(function(m){
      const subs = r.rows.filter(function(x){ return x.kind === 'sub' && x.key.indexOf(m.key + ':') === 0; });
      const top = subs.length ? Math.max.apply(null, subs.map(function(x){ return x.value; })) : 1;
      const rows = subs.map(function(x){
        const code = x.key.split(':')[1];
        // แถวที่มีคำอธิบาย (เหรียญอื่น / Stablecoin) ใช้ปุ่ม i แบบเดียวกับการ์ดอื่น ชี้หรือแตะแล้วขึ้น (มือถือแตะได้)
        const hint0 = cmRowHint(m.key, code, m.part);
        const hint = Array.isArray(hint0) && !hint0.length ? '' : hint0;
        const tip = hint ? ' <span class="tip"><button type="button" class="tip-btn" aria-expanded="false" aria-label="' + esc(tr('รายละเอียด ', 'About ') + x.label) + '">i</button><span class="tip-pop" role="tooltip">' + (Array.isArray(hint) ? hint.map(function(h){ return '<span class="cm-tip-sec"><b>' + esc(h[0]) + '</b>' + esc(h[1]) + '</span>'; }).join('') : esc(hint)) + '</span></span>' : '';
        return '<div class="cm-row' + (code === 'OTHER' ? ' other' : '') + (code === 'TH' ? ' th' : '') + '"' + (hint ? '' : ' title="' + esc(x.label + ' · ' + x.share.toFixed(1) + tr('% ของกลุ่มนี้', '% of this group')) + '"') + '>'
          + '<span class="cm-name">' + esc(x.label) + tip + '</span>'
          + '<div class="cm-track"><div class="cm-fill" style="width:' + Math.max(0.6, x.value / top * 100).toFixed(2) + '%"></div></div>'
          + '<span class="cm-val">' + esc(fmtCapT(x.value)) + '<small>' + (x.share < 1 ? x.share.toFixed(1) : x.share.toFixed(0)) + '%</small></span></div>';
      }).join('');
      return '<div class="cm-group' + (subs.length ? '' : ' solo') + '" style="--c1:' + cv(m.key) + ';--c2:var(--cm-' + m.key + '2)">'
        + '<div class="cm-head"><div><div class="cm-title">' + esc(m.label) + '</div><div class="cm-asof">' + esc(cmAsOf(m.key, m.part)) + '</div></div>'
        + '<div class="cm-big"><b>' + esc(fmtCapT(m.value)) + '</b><small>' + (m.pct || 0).toFixed(0) + tr('% ของทั้งหมด', '% of total') + '</small></div></div>'
        + (rows ? '<div class="cm-subs">' + rows + '</div>' : '') + '</div>';
    }).join('');
    const missing = Object.keys(CM_PARTS).filter(function(k){ return !parts[k]; });
    el('cmWarn').textContent = missing.length ? tr('⚠️ ยังดึงไม่ได้: ', '⚠️ Not loaded yet: ') + missing.map(function(k){ return tr(CM_PARTS[k].th, CM_PARTS[k].en); }).join(', ') + tr(' · จะลองใหม่อัตโนมัติ', ' · retrying automatically') : '';
    const b = parts.bonds, e = parts.equities;
    el('cmNote').textContent = tr(
      'หุ้น: มูลค่าตลาดรวมของบริษัทจดทะเบียนที่ companiesmarketcap.com ติดตาม' + (e && e.countries ? ' (' + e.countries + ' ประเทศ)' : '') + ' นับตามประเทศที่ตั้งบริษัท ราคาช้าไม่กี่นาทีถึงไม่กี่ชั่วโมง จีนนับเฉพาะบริษัทใหญ่ จึงต่ำกว่าตัวเลขรวมของตลาดหลักทรัพย์จีน'
        + ' · ตราสารหนี้: พันธบัตรรัฐบาลและหุ้นกู้ทุกประเภทที่ยังไม่ครบกำหนด มูลค่าที่ตราไว้ จาก BIS Debt securities statistics' + (b && b.countries ? ' (' + b.countries + ' ประเทศ' + (b.period ? ' ไตรมาส ' + b.period : '') + ')' : '') + ' ยูโรโซนคือรวมประเทศสมาชิก'
        + ' · ทองคำ: ราคาทองฟิวเจอร์ส (Yahoo GC=F, สำรอง PAXG จาก CoinGecko) × ปริมาณทองที่ขุดขึ้นมาแล้วทั้งโลก (World Gold Council สิ้นปี 2024 ราว 216,265 ตัน บวกการขุดปีละราว 3,661 ตัน)'
        + ' · คริปโต: มูลค่าตลาดรวมจาก CoinGecko (สำรอง CoinPaprika) แยก stablecoin ออกด้วยยอดรวมจาก DefiLlama · ไม่รวมอสังหาริมทรัพย์ เงินฝาก และอนุพันธ์ · อัปเดตทุก 15 นาที'
        + ' · ปุ่ม i ของประเทศ: อัปเดตเองเมื่อแหล่งข้อมูลออกตัวเลขใหม่ (เช็กทุก 6 ชม.) บริษัทเด่นคือ 4 บริษัทมูลค่าตลาดสูงสุดจาก companiesmarketcap.com, ประชากรคือสัดส่วนคนอายุ 65+ จาก World Bank, ทักษะแรงงานคือดัชนีทุนมนุษย์ (Human Capital Index) ของ World Bank วัดจากจำนวนปีและคุณภาพการศึกษา (คะแนนสอบ) กับสุขภาพ ไม่ใช่วัดความฉลาดของคน, รายได้ต่อชั่วโมงคือผลผลิตต่อชั่วโมงทำงาน (ILO modelled estimates) เป็นดอลลาร์แบบปรับค่าครองชีพ (PPP) แล้ว จึงบอกได้ว่าทำงาน 1 ชม. ซื้อของได้เท่าไหร่ ใช้แทนค่าแรงเฉลี่ยเพราะเทียบข้ามประเทศได้, ค่าครองชีพคือ GDP ต่อหัวตามอัตราแลกเปลี่ยน ÷ แบบ PPP จาก World Bank (สหรัฐฯ = 100%), ยุโรปคือค่าเฉลี่ยของเศรษฐกิจใหญ่ในยุโรป',
      'Stocks: total market cap of the listed companies companiesmarketcap.com tracks' + (e && e.countries ? ' (' + e.countries + ' countries)' : '') + ', by the country of the company\'s headquarters, prices delayed minutes to hours. China counts large companies only, so it reads below the exchanges\' own totals'
        + ' · Bonds: all government and corporate debt securities outstanding at face value, BIS debt securities statistics' + (b && b.countries ? ' (' + b.countries + ' countries' + (b.period ? ', ' + b.period : '') + ')' : '') + '. The euro area is the sum of its members'
        + ' · Gold: gold futures price (Yahoo GC=F, fallback PAXG from CoinGecko) × all gold ever mined (World Gold Council, ~216,265 t at end-2024 plus ~3,661 t of mine output a year)'
        + ' · Crypto: total market cap from CoinGecko (fallback CoinPaprika), stablecoins split out with the DefiLlama total · excludes real estate, deposits and derivatives · refreshed every 15 minutes'
        + ' · Country i buttons: refreshed automatically when sources publish new figures (checked every 6 h); champion stocks are the 4 largest by market cap on companiesmarketcap.com; people is the World Bank share aged 65+; workforce skills are the World Bank Human Capital Index, built from years and quality (test scores) of schooling plus health, not a measure of intelligence; earnings per hour is output per hour worked (ILO modelled estimates) in cost-of-living-adjusted (PPP) dollars, i.e. what an hour of work buys, a cross-country proxy for pay; cost of living is GDP per head at market rates ÷ at PPP from the World Bank (US = 100%); Europe is the average of its big economies');
  }
  let cmLastJ = null, cmProfNextAt = 0;
  async function fetchCountryProfiles(){
    cmProfNextAt = Date.now() + 6 * 3600 * 1000;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/country-profiles', 20000);
      const j = await r.json();
      if(!j || !j.parts) throw new Error(j && j.error || 'HTTP ' + r.status);
      cmProfiles = j.parts;
      if(cmLastJ) renderCapMarkets(cmLastJ);
    }catch(e){
      console.warn('[country-profiles]', e);
      cmProfNextAt = Date.now() + 15 * 60 * 1000;
    }
  }
  async function fetchCapMarkets(){
    cmNextAt = Date.now() + CM_POLL_MS;
    try{
      const r = await fetchWithTimeout('/.netlify/functions/capital-markets', 15000);
      const j = await r.json();
      if(!j || !j.parts) throw new Error(j && j.error || 'HTTP ' + r.status);
      cmLastJ = j;
      renderCapMarkets(j);
      if(isValidNum(j.ttl) && j.ttl > 0) cmNextAt = Date.now() + Math.min(j.ttl * 1000, CM_POLL_MS);
    }catch(e){
      console.warn('[capital-markets]', e);
      if(!el('cmRows').innerHTML) el('cmTotal').textContent = tr('ดึงข้อมูลไม่สำเร็จ จะลองใหม่อัตโนมัติ', 'Unavailable right now. Retrying automatically.');
      cmNextAt = Date.now() + 5 * 60 * 1000;
    }
  }
  window.__capTest = { capMarketRows, fmtCapT, renderCapMarkets };
  fetchCapMarkets();
  fetchCountryProfiles();
  setInterval(function(){
    if(document.hidden) return;
    if(Date.now() >= cmNextAt) fetchCapMarkets();
    if(Date.now() >= cmProfNextAt) fetchCountryProfiles();
  }, 60 * 1000);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && Date.now() >= cmNextAt) fetchCapMarkets(); });

  // ---------- หุ้นสหรัฐบวกแรงสุด 20 อันดับ (แท็บตลาดทุนโลก) ----------
  // /.netlify/functions/us-gainers ส่ง % เปลี่ยนของทุกช่วงเวลามาในคำตอบเดียว หน้าเว็บจัดอันดับเองตามปุ่มที่เลือก
  var ugData = null, ugPeriod = '1d', ugNextAt = 0;
  const UG_POLL_MS = 15 * 60 * 1000;
  const UG_LABEL = { '1d': tr('วันทำการล่าสุด', 'latest session'), '1w': tr('1 สัปดาห์', '1 week'), '1m': tr('1 เดือน', '1 month'), '3m': tr('3 เดือน', '3 months'), 'ytd': tr('ตั้งแต่ต้นปี', 'year to date') };
  try{ const saved = localStorage.getItem('gi-ug-period'); if(saved && UG_LABEL[saved]) ugPeriod = saved; }catch(e){}

  // แถวที่บวกมากสุด n ตัวของช่วงเวลา p (ข้ามหุ้นที่ยังเข้าตลาดไม่ถึงช่วงนั้น)
  function usGainersTop(rows, p, n){
    return (rows || []).filter((r) => r && r.r && isValidNum(r.r[p])).sort((a, b) => b.r[p] - a.r[p]).slice(0, n || 20);
  }
  // กราฟ TradingView ของหุ้นตัวนั้น (TradingView หาตลาดเอง · BRK-B ของ Yahoo = BRK.B)
  function ugTvUrl(sym){ return 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(String(sym).replace(/-/g, '.')); }
  function fmtUgPct(v){
    const a = Math.abs(v), t = a >= 100 ? a.toFixed(0) : a.toFixed(1);
    return (v > 0 ? '+' : v < 0 ? '−' : '') + t + '%';
  }
  // ⓘ one line on what the company does (descriptions come with the data: netlify/lib/us-stock-desc.js)
  function ugDescTip(r){
    const d = Array.isArray(r.d) ? tr(r.d[0], r.d[1] || r.d[0]) : '';
    if(!d) return '';
    const lbl = tr(r.s + ' ทำธุรกิจอะไร', 'What ' + r.s + ' does');
    return '<span class="tip"><button type="button" class="tip-btn" aria-label="' + esc(lbl) + '" aria-expanded="false">i</button>'
      + '<span class="tip-pop" role="tooltip"><b>' + esc(r.n) + '</b> · ' + esc(d) + '</span></span>';
  }
  function renderUsGainers(){
    const j = ugData;
    document.querySelectorAll('#ugSeg button').forEach(function(b){ b.setAttribute('aria-pressed', String(b.getAttribute('data-p') === ugPeriod)); });
    if(!j || !j.rows) return;
    const top = usGainersTop(j.rows, ugPeriod, 20);
    const max = Math.max.apply(null, top.map((r) => r.r[ugPeriod]).concat([0.0001]));
    el('ugList').innerHTML = top.map(function(r, i){
      const v = r.r[ugPeriod], w = v > 0 ? Math.max(1.5, v / max * 100) : 0;
      return '<li class="ug-row' + (i < 3 ? ' ug-top' : '') + '"><span class="ug-rank">' + (i + 1) + '</span>'
        + '<span class="ug-idw"><a class="ug-id" href="' + ugTvUrl(r.s) + '" target="_blank" rel="noopener noreferrer" title="' + esc(tr('เปิด ' + r.s + ' ใน TradingView', 'Open ' + r.s + ' in TradingView')) + '"><b>' + esc(r.s) + '<span class="tv-arrow" aria-hidden="true">↗</span></b><small>' + esc(r.n) + '</small></a>'
        + ugDescTip(r) + '</span>'
        + '<span class="ug-track" aria-hidden="true"><span class="ug-fill" style="display:block;width:' + w.toFixed(1) + '%"></span></span>'
        + '<span class="ug-pct' + (v < 0 ? ' neg' : '') + '">' + fmtUgPct(v) + (isValidNum(r.p) ? '<span class="ug-px">$' + esc(r.p.toLocaleString('en-US', { maximumFractionDigits: 2 })) + '</span>' : '') + '</span></li>';
    }).join('');
    const ranked = j.rows.filter((r) => r && r.r && isValidNum(r.r[ugPeriod])).length;
    el('ugSub').textContent = tr('ผลตอบแทน', 'Return over ') + UG_LABEL[ugPeriod] + tr(' · ราคาถึง ', ' · prices to ') + thDay(j.asOf) + tr(' · จัดอันดับจาก ', ' · ranked from ') + ranked + tr(' หุ้น', ' stocks');
    el('ugWarn').textContent = j.stale ? tr('⚠️ ดึงข้อมูลใหม่ไม่สำเร็จ แสดงข้อมูลล่าสุดที่มี', '⚠️ Could not refresh; showing the last data we have') : '';
    el('ugNote').innerHTML = esc(tr(
      'ราคาจาก Yahoo Finance (ราคาปิดรายวัน และราคาระหว่างวันช่วงตลาดเปิด ช้าราว 15 นาที) จัดอันดับจากหุ้นใหญ่และหุ้นยอดนิยมที่ซื้อขายในตลาดสหรัฐฯ ราว ' + (j.universe || 260) + ' ตัว (หุ้นใหญ่ใน S&P 500, Nasdaq, หุ้น AI/ชิป/คริปโต และหุ้นต่างชาติที่จดทะเบียนในสหรัฐฯ เช่น TSM) ไม่ใช่ทุกหุ้นในตลาด หุ้นเล็กที่ขึ้นแรงจึงไม่อยู่ในอันดับ · จุดเริ่มของแต่ละช่วง = ราคาปิดวันทำการสุดท้ายก่อนหรือตรงกับ 7 / 30 / 91 วันก่อน และวันทำการสุดท้ายของปีก่อนสำหรับ "ต้นปี" · หุ้นที่เพิ่งเข้าตลาดไม่ครบช่วงจะไม่ถูกนับในช่วงนั้น',
      'Prices from Yahoo Finance (daily closes, plus the intraday price while the market is open, about 15 minutes delayed). Ranked from about ' + (j.universe || 260) + ' large and widely followed US-listed stocks (S&P 500 heavyweights, big Nasdaq names, AI, chip and crypto stocks, and foreign companies listed in the US such as TSM), not every stock in the market, so small caps that jump are not included. Each period starts at the last close on or before 7 / 30 / 91 days ago, and at the last trading day of last year for YTD. A stock listed after the start of a period is left out of that period.'));
  }
  async function fetchUsGainers(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/us-gainers', 15000);
      const j = await r.json();
      if(!j || !j.rows) throw new Error(j && j.error || 'HTTP ' + r.status);
      ugData = j;
      renderUsGainers();
      ugNextAt = Date.now() + (isValidNum(j.ttl) && j.ttl > 0 ? Math.min(j.ttl * 1000, UG_POLL_MS) : UG_POLL_MS);
    }catch(e){
      console.warn('[us-gainers]', e);
      if(!el('ugList').innerHTML) el('ugSub').textContent = tr('ดึงข้อมูลไม่สำเร็จ จะลองใหม่อัตโนมัติ', 'Unavailable right now. Retrying automatically.');
      ugNextAt = Date.now() + 5 * 60 * 1000;
    }
  }
  // สคริปต์นี้รันก่อนที่ markup ของแท็บตลาดทุนโลกจะมี จึงดักคลิกที่ document แทนการผูกกับปุ่มตรง ๆ
  document.addEventListener('click', function(ev){
    const b = ev.target && ev.target.closest ? ev.target.closest('#ugSeg button[data-p]') : null;
    if(!b) return;
    ugPeriod = b.getAttribute('data-p') || '1d';
    try{ localStorage.setItem('gi-ug-period', ugPeriod); }catch(e){}
    renderUsGainers();
  });
  window.__ugTest = { usGainersTop, fmtUgPct, ugTvUrl, renderUsGainers, setData: function(j, p){ ugData = j; if(p) ugPeriod = p; } };
  renderUsGainers();
  fetchUsGainers();
  setInterval(function(){ if(!document.hidden && Date.now() >= ugNextAt) fetchUsGainers(); }, 60 * 1000);

  // ---------- ตัวเลขเศรษฐกิจเพิ่มเติม: บ้าน · ดอกเบี้ยบ้าน · ค้าปลีก · ISM · Breakeven ----------
  // ตัวเลขจริง + กราฟ 12 เดือนมาจาก /.netlify/functions/econ-extra (FRED + Investing.com + ISM)
  // ค่าคาดของรอบล่าสุด: econ-extra (ข้อมูลกราฟของ Investing.com) ก่อน แล้วค่อย /consensus (LIVE_EXTRA)
  // ค่าคาดของรอบถัดไป: /consensus → LIVE_UPCOMING เหมือนการ์ดอื่น
  // var (ไม่ใช่ let): loadConsensus()/renderFedAnalysis() อาจเรียกก่อนบรรทัดนี้จะรัน
  var EXTRA = null;        // { homeSales, mort30, mort15, retail, ismMfg, ismSvc, be5, be10, ry10 }
  var LIVE_EXTRA = {};     // จาก /consensus: { retail: { actual, forecast, previous, releaseDate }, ... }
  var extraNextAt = 0;
  const EXTRA_POLL_MS = 60 * 60 * 1000;
  // ความต่างที่ถือว่า "ตรงคาด" (ตามความละเอียดที่ประกาศจริง)
  var EXTRA_NEAR = { retail: 0.05, homeSales: 25000, ismMfg: 0.25, ismSvc: 0.25 };

  function fmtHomes(v){ return isValidNum(v) ? (v / 1e6).toFixed(2) + 'M' : '–'; }
  function fmtExtra(key, v){
    if(!isValidNum(v)) return '–';
    if(key === 'retail') return signedPct(v, 1) + '%';
    if(key === 'homeSales') return fmtHomes(v);
    if(key === 'ismMfg' || key === 'ismSvc') return v.toFixed(1);
    return v.toFixed(2) + '%';
  }
  function bpDelta(chPct){
    if(!isValidNum(chPct)) return '';
    const bp = Math.round(chPct * 100);
    return '<span class="delta ' + (bp > 0 ? 'down' : bp < 0 ? 'up' : 'flat') + '">' + (bp > 0 ? '+' : bp < 0 ? '−' : '±') + Math.abs(bp) + ' bp</span>';
  }

  // ตัวเลขที่ใช้จริงของแต่ละการ์ด: econ-extra ก่อน · ถ้าไม่มี (หรือ Investing.com มีรอบที่ใหม่กว่า) ใช้ "ตามจริง" จาก /consensus
  function extraView(key){
    const it = (EXTRA && EXTRA[key]) || null;
    const L = (LIVE_EXTRA || {})[key] || null;
    const refOf = (rel) => refMonthFor(rel);
    let v = it && isValidNum(it.value) ? { value: it.value, date: it.date, prev: it.prev && isValidNum(it.prev.value) ? it.prev.value : null, prevDate: it.prev ? it.prev.date : null,
      forecast: isValidNum(it.forecast) ? it.forecast : null, hist: it.hist, yoy: it.yoy, source: it.source, releaseDate: it.releaseDate || null } : null;
    if(L && isValidNum(L.actual) && L.releaseDate){
      const ref = refOf(L.releaseDate);
      if(!v || (ref && ref > v.date)){
        v = { value: L.actual, date: ref, prev: isValidNum(L.previous) ? L.previous : (v ? v.value : null), prevDate: v ? v.date : null,
              forecast: isValidNum(L.forecast) ? L.forecast : null, hist: v ? v.hist : null, source: 'investing.com', releaseDate: L.releaseDate };
      }else if(v && ref === v.date && !isValidNum(v.forecast) && isValidNum(L.forecast)){
        v.forecast = L.forecast;
      }
    }
    return v;
  }

  // ป้ายสถานะของการ์ด = "ระดับนี้หมายถึงอะไรต่อเศรษฐกิจ/ตลาด" (แบบเดียวกับการ์ด Real Yield)
  // สีตัวเลขใหญ่ จุดสี และกล่องวิเคราะห์ใช้ verdict เดียวกันนี้ทั้งหมด · ผลเทียบค่าคาด (สูง/ต่ำกว่าคาด) เป็นแค่ข้อความในวงเล็บ
  // ความหมายของแต่ละสีเขียนไว้ในปุ่ม (i) ของการ์ด
  function extraVerdict(dot, th, en){
    return { accent: dot === '🟢' ? 'var(--good)' : dot === '🔴' ? 'var(--bad)' : dot === '🔵' ? 'var(--cool)' : 'var(--warn)', dot: dot, label: tr(th, en) };
  }
  function homeSalesVerdict(v){
    return v >= 4.8e6 ? extraVerdict('🟢', 'ปกติ/คึกคัก หนุนหุ้นอสังหาฯ', 'Normal to busy: supports housing stocks')
      : v >= 4e6 ? extraVerdict('🟡', 'ต่ำกว่าปกติ ตลาดบ้านยังฝืด', 'Below normal: housing still sluggish')
      : extraVerdict('🔴', 'ซบเซามาก (ต่ำกว่า 4 ล้าน) กดดันหุ้นอสังหาฯ', 'Very weak (under 4M): weighs on housing stocks');
  }
  function mortgageVerdict(key, v){
    const o = key === 'mort15' ? 0.7 : 0;   // แบบ 15 ปีปกติต่ำกว่าแบบ 30 ปีราว 0.7%
    return v < 5.5 - o ? extraVerdict('🟢', 'ผ่อนไหว หนุนตลาดบ้าน', 'Affordable: supports housing')
      : v < 6.5 - o ? extraVerdict('🟡', 'ปานกลาง', 'Moderate')
      : v < 7.5 - o ? extraVerdict('🔴', 'แพง กดดันตลาดบ้าน/ผู้บริโภค', 'Expensive: weighs on housing and consumers')
      : extraVerdict('🔴', 'แพงมาก กดดันตลาดบ้านหนัก', 'Very expensive: heavy pressure on housing');
  }
  function retailVerdict(v){
    const p = Math.round(v * 10) / 10;
    return p >= 0.5 ? extraVerdict('🟢', 'ใช้จ่ายแข็ง เศรษฐกิจยังดี', 'Strong spending: economy solid')
      : p >= 0 ? extraVerdict('🟡', 'ใช้จ่ายทรงตัว', 'Steady spending')
      : extraVerdict('🔴', 'ยอดขายหด ผู้บริโภครัดเข็มขัด', 'Sales fell: consumers cutting back');
  }
  function ismVerdict(v){
    return v >= 52 ? extraVerdict('🟢', 'ขยายตัวดี เศรษฐกิจยังโต', 'Solid expansion: economy growing')
      : v >= 50 ? extraVerdict('🟡', 'ขยายตัวเล็กน้อย (เส้นแบ่ง 50)', 'Barely expanding (50 = dividing line)')
      : extraVerdict('🔴', 'หดตัว (ต่ำกว่า 50) สัญญาณเศรษฐกิจชะลอ', 'Contracting (below 50): slowdown signal');
  }
  function breakevenVerdict(v){
    return v >= 2.5 ? extraVerdict('🔴', 'สูง ตลาดไม่เชื่อว่าเงินเฟ้อจะกลับไป 2% Fed อาจตึงนาน กดดันหุ้น/บอนด์', 'High: market doubts inflation returns to 2%, Fed may stay tight, pressure on stocks/bonds')
      : v >= 2.3 ? extraVerdict('🟡', 'ค่อนข้างสูงกว่าเป้า ต้องจับตา', 'A bit above target: worth watching')
      : v >= 1.8 ? extraVerdict('🟢', 'สอดคล้องกับเป้า 2% ของ Fed ไม่ต้องตึงเพิ่ม', 'Consistent with the Fed\'s 2% goal: no need to tighten')
      : extraVerdict('🔵', 'ต่ำ ตลาดกังวลเศรษฐกิจชะลอ', 'Low: market worried about a slowdown');
  }
  // ผลเทียบค่าคาด เป็นข้อความเท่านั้น (ไม่กำหนดสี)
  function surpriseWord(dev, near){
    return near ? tr('ตรงคาด', 'in line') : dev > 0 ? tr('สูงกว่าคาด', 'above forecast') : tr('ต่ำกว่าคาด', 'below forecast');
  }
  window.extraVerdicts = { homeSales: homeSalesVerdict, mortgage: mortgageVerdict, retail: retailVerdict, ism: ismVerdict, breakeven: breakevenVerdict };   // tests

  // Real Yield 10 ปี (DFII10) — เกณฑ์เดียว ใช้ทั้งสีการ์ดและกล่องวิเคราะห์ · ทิศทาง 1 เดือนสำคัญกว่าระดับ
  var RY_FAST = 0.25, RY_HIGH = 2, RY_LOW = 1;   // จุด % (0.25 = 25 bp)
  function realYieldVerdict(value, change1m){
    if(!isValidNum(value)) return null;
    const ch = isValidNum(change1m) ? change1m : null;
    if(ch != null && ch >= RY_FAST) return { key:'rising', accent:'var(--bad)', dot:'🔴', label:tr('พุ่งขึ้นเร็ว กดดันสินทรัพย์เสี่ยง', 'Rising fast: pressure on risk assets') };
    if(ch != null && ch <= -RY_FAST) return { key:'falling', accent:'var(--good)', dot:'🟢', label:tr('ลดลงเร็ว หนุนสินทรัพย์เสี่ยง', 'Falling fast: supportive for risk assets') };
    if(value >= RY_HIGH) return { key:'high', accent:'var(--bad)', dot:'🔴', label:tr('สูง (ตึง) กดดันทอง/BTC/หุ้นเทค', 'High (tight): weighs on gold/BTC/tech') };
    if(value < RY_LOW) return { key:'low', accent:'var(--good)', dot:'🟢', label:tr('ต่ำ หนุนสินทรัพย์เสี่ยง', 'Low: supportive for risk assets') };
    return { key:'normal', accent:'var(--warn)', dot:'🟡', label:tr('ปกติ', 'Normal') };
  }
  window.realYieldVerdict = realYieldVerdict;   // tests
  function ppTxt(x){ return (x > 0 ? '+' : x < 0 ? '−' : '±') + Math.abs(x).toFixed(2);}

  function setExtraNum(id, html, cls){
    const n = el(id);
    if(!n) return;
    n.innerHTML = html;
    n.className = 'num' + (cls ? ' ' + cls : '');
  }

  function renderExtraCards(){
    const months = (d) => esc(thMonth(d));
    // ── ยอดขายบ้านมือสอง ──
    const hs = extraView('homeSales');
    if(hs){
      const hv = homeSalesVerdict(hs.value);
      setExtraNum('homeSales', esc(fmtHomes(hs.value)));
      toneNum('homeSales', hv.accent);
      const bits = [hv.dot + ' ' + hv.label, tr('เดือน ', '') + months(hs.date)];
      if(isValidNum(hs.forecast)){
        const dev = hs.value - hs.forecast;
        bits.push(tr('คาด ', 'forecast ') + '<b>' + esc(fmtHomes(hs.forecast)) + '</b> (' + surpriseWord(dev, Math.abs(dev) < EXTRA_NEAR.homeSales) + ')');
      }
      if(isValidNum(hs.prev) && hs.prev) bits.push(tr('เดือนก่อน ', 'prev ') + esc(fmtHomes(hs.prev)) + ' (' + signedPct((hs.value - hs.prev) / hs.prev * 100, 1) + '%)');
      el('homeSalesInfo').innerHTML = bits.join(' · ');
      if(hs.hist) setSpark('spHome', { hist: hs.hist.map(p => [p[0], p[1] / 1e6]) }, { dec:2 });
    }
    // ── ดอกเบี้ยบ้าน 30 / 15 ปี (รายสัปดาห์) ──
    [['mort30', 'mort30', 'spMort30', 'mort30Info'], ['mort15', 'mort15', 'spMort15', 'mort15Info']].forEach(function(row){
      const m = EXTRA && EXTRA[row[0]];
      if(!m || !isValidNum(m.value)) return;
      const mv = mortgageVerdict(row[0], m.value);
      setExtraNum(row[1], esc(m.value.toFixed(2)) + '%' + bpDelta(m.change));
      toneNum(row[1], mv.accent);
      const bits = [mv.dot + ' ' + mv.label, tr('สัปดาห์ ', 'week of ') + esc(thDay(m.date))];
      if(isValidNum(m.spread10y)) bits.push(tr('ห่างบอนด์ 10 ปี ', 'vs 10Y ') + '<b>' + (m.spread10y >= 0 ? '+' : '−') + Math.abs(m.spread10y).toFixed(2) + tr(' จุด', ' pts') + '</b>');
      el(row[3]).innerHTML = bits.join(' · ');
      setSpark(row[2], m, { upIsBad:true, dec:2 });
    });
    // ── ยอดค้าปลีก (MoM) ──
    const rs = extraView('retail');
    if(rs){
      const dev = isValidNum(rs.forecast) ? Math.round(rs.value * 10) / 10 - rs.forecast : null;
      const rv = retailVerdict(rs.value);
      setExtraNum('retailSales', esc(signedPct(rs.value, 1)) + '%');
      toneNum('retailSales', rv.accent);
      const bits = [rv.dot + ' ' + rv.label, tr('เดือน ', '') + months(rs.date)];
      bits.push(isValidNum(rs.forecast) ? tr('คาด ', 'forecast ') + '<b>' + esc(signedPct(rs.forecast, 1)) + '%</b> (' + surpriseWord(dev, Math.abs(dev) < EXTRA_NEAR.retail) + ')' : tr('ยังไม่มีค่าคาด', 'no forecast'));
      if(isValidNum(rs.prev)) bits.push(tr('เดือนก่อน ', 'prev ') + esc(signedPct(rs.prev, 1)) + '%');
      if(isValidNum(rs.yoy)) bits.push('YoY ' + esc(signedPct(rs.yoy, 1)) + '%');
      el('retailInfo').innerHTML = bits.join(' · ');
      if(rs.hist) setSpark('spRetail', { hist: rs.hist }, { dec:1 });
    }
    // ── ISM ภาคการผลิต / ภาคบริการ ──
    [['ismMfg', 'spIsmMfg', 'ismMfgInfo'], ['ismSvc', 'spIsmSvc', 'ismSvcInfo']].forEach(function(row){
      const v = extraView(row[0]);
      if(!v) return;
      const iv = ismVerdict(v.value);
      setExtraNum(row[0], esc(v.value.toFixed(1)));
      toneNum(row[0], iv.accent);
      const bits = [iv.dot + ' ' + iv.label, tr('เดือน ', '') + months(v.date)];
      const idev = isValidNum(v.forecast) ? v.value - v.forecast : null;
      bits.push(idev != null ? tr('คาด ', 'forecast ') + '<b>' + esc(v.forecast.toFixed(1)) + '</b> (' + surpriseWord(idev, Math.abs(idev) < EXTRA_NEAR[row[0]]) + ')' : tr('ยังไม่มีค่าคาด', 'no forecast'));
      if(isValidNum(v.prev)) bits.push(tr('เดือนก่อน ', 'prev ') + esc(v.prev.toFixed(1)));
      el(row[2]).innerHTML = bits.join(' · ');
      if(v.hist && v.hist.length >= 2) setSpark(row[1], { hist: v.hist }, { dec:1 });
    });
    // ── Breakeven 5 / 10 ปี (รายวัน) ──
    [['be5', 'spBe5', 'be5Info'], ['be10', 'spBe10', 'be10Info']].forEach(function(row){
      const b = EXTRA && EXTRA[row[0]];
      if(!b || !isValidNum(b.value)) return;
      const bv = breakevenVerdict(b.value);
      setExtraNum(row[0], esc(b.value.toFixed(2)) + '%' + bpDelta(b.change));
      toneNum(row[0], bv.accent);
      el(row[2]).innerHTML = bv.dot + ' ' + bv.label + tr(' · ปิด ', ' · close ') + esc(thDay(b.date));
      setSpark(row[1], b, { upIsBad:true, dec:2 });
    });
    // ── Real Yield 10 ปี (รายวัน) · สีจาก realYieldVerdict() ตัวเดียวกับกล่องวิเคราะห์ ──
    const ry = EXTRA && EXTRA.ry10;
    if(ry && isValidNum(ry.value)){
      const v = realYieldVerdict(ry.value, ry.change1m);
      setExtraNum('ry10', esc(ry.value.toFixed(2)) + '%' + bpDelta(ry.change));
      toneNum('ry10', v.accent);
      const bits = [v.dot + ' ' + v.label];
      if(isValidNum(ry.change1m)) bits.push(tr('1 เดือน ', '1 month ') + '<b>' + ppTxt(ry.change1m) + tr(' จุด', ' pts') + '</b>');
      bits.push(tr('ปิด ', 'close ') + esc(thDay(ry.date)));
      el('ry10Info').innerHTML = bits.join(' · ');
      setSpark('spRy10', ry, { upIsBad:true, dec:2 });
    }
    const note = el('econExtraNote');
    if(note && EXTRA){
      const errs = EXTRA.__errors ? Object.keys(EXTRA.__errors) : [];
      note.textContent = tr('ที่มา: ยอดขายบ้าน NAR · ดอกเบี้ยบ้าน Freddie Mac · ค้าปลีก Census · Breakeven และ Real Yield ผ่าน FRED · ISM และค่าคาดจาก Investing.com · กราฟเล็ก = ย้อนหลัง 12 เดือน',
        'Sources: home sales NAR · mortgage rates Freddie Mac · retail sales Census · breakevens and real yield via FRED · ISM and forecasts from Investing.com · mini charts = last 12 months');
      const warn = el('econExtraWarn');
      if(warn) warn.textContent = errs.length ? tr('⚠️ ยังดึงไม่ได้: ', '⚠️ Not available right now: ') + errs.join(', ') : '';
    }
    try{ renderNextReleases(); }catch(e){ /* best-effort */ }
  }

  async function fetchEconExtra(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/econ-extra', 12000, { cache: 'no-cache' });
      const j = await r.json();
      if(!j || !j.items) throw new Error((j && j.error) || 'HTTP ' + r.status);
      EXTRA = Object.assign({}, j.items, { __errors: j.errors || null });
      const nextIn = (isValidNum(j.ttl) && j.ttl > 0) ? Math.min(j.ttl * 1000, EXTRA_POLL_MS) : EXTRA_POLL_MS;
      extraNextAt = Date.now() + Math.max(nextIn, 60 * 1000);
    }catch(e){
      console.warn('[econ-extra]', e);
      extraNextAt = Date.now() + 10 * 60 * 1000;
      const warn = el('econExtraWarn');
      if(warn && !EXTRA) warn.textContent = tr('⚠️ ดึงข้อมูลชุดนี้ไม่ได้ในขณะนี้ — จะลองใหม่อัตโนมัติ', '⚠️ Can\'t load these numbers right now. Retrying automatically.');
    }
    try{ renderExtraCards(); }catch(e){ console.warn('[econ-extra render]', e); }
    try{ if(lastFedPayload) renderFedAnalysis(lastFedPayload); }catch(e){ /* best-effort */ }
  }
  fetchEconExtra();
  setInterval(function(){ if(Date.now() >= extraNextAt) fetchEconExtra(); }, 60 * 1000);

  // การ์ดวิเคราะห์ "ดี/แย่แค่ไหน" ของชุดนี้ — เรียกจาก renderFedAnalysis()
  function extraAnalysisCards(){
    const out = [];
    const NOCONS = tr('⚪ ยังไม่มีค่าคาดของรอบนี้', '⚪ No forecast for this release yet');
    const tail = v => { const t = v.replace(/^[^\s]+\s/, ''); return EN ? t.charAt(0).toLowerCase() + t.slice(1) : t; };
    const impact = (txt) => '<br><b>' + tr('ผลต่อตลาด:', 'Market impact:') + '</b> ' + txt;

    // ── Retail Sales ──
    const rs = extraView('retail');
    if(rs){
      const p = Math.round(rs.value * 10) / 10;
      const dev = isValidNum(rs.forecast) ? p - rs.forecast : null;
      const near = dev != null && Math.abs(dev) < EXTRA_NEAR.retail;
      // สี/หัวข้อ = ระดับ (verdict เดียวกับการ์ด) · ผลเทียบค่าคาดอยู่ในเนื้อความ
      const rv = retailVerdict(rs.value), accent = rv.accent;
      const verdict = dev == null ? NOCONS : near ? tr('🟡 ตรงตามคาด', '🟡 In line') : dev > 0 ? tr('🟢 แรงกว่าที่คาด', '🟢 Stronger than forecast') : tr('🔴 อ่อนกว่าที่คาด', '🔴 Weaker than forecast');
      let body = tr('ยอดค้าปลีกเดือน ' + esc(thMonth(rs.date)) + ' ', esc(thMonth(rs.date)) + ' retail sales ') + '<b>' + signedPct(p, 1) + '% MoM</b>';
      body += dev == null ? tr(' · ยังไม่มีค่าคาดของรอบนี้ให้เทียบ', ' · no forecast for this release to compare against') : tr(' · ตลาดคาด ', ' · forecast ') + signedPct(rs.forecast, 1) + '% → ' + tail(verdict) + (near ? '' : tr(' ', ' by ') + Math.abs(dev).toFixed(1) + 'pp');
      if(isValidNum(rs.prev)) body += tr('<br>เดือนก่อน ', '<br>previous month ') + signedPct(rs.prev, 1) + '%' + (p > rs.prev + 0.05 ? tr(' → เร่งขึ้น', ' → picked up') : p < rs.prev - 0.05 ? tr(' → ชะลอลง', ' → slowed') : tr(' → ทรงตัว', ' → steady'));
      if(isValidNum(rs.yoy)) body += tr(' · เทียบปีก่อน ', ' · vs a year ago ') + signedPct(rs.yoy, 1) + '%';
      // หักเงินเฟ้อคร่าว ๆ: เทียบกับ CPI MoM ของเดือนเดียวกัน (ถ้ามี)
      const cpi = lastFedPayload && lastFedPayload.cpi;
      if(cpi && isValidNum(cpi.mom) && cpi.date === rs.date){
        const real = p - Math.round(cpi.mom * 10) / 10;
        body += tr('<br>หักเงินเฟ้อคร่าว ๆ (CPI เดือนเดียวกัน ', '<br>Roughly inflation-adjusted (same-month CPI ') + signedPct(cpi.mom, 1) + '%) ≈ <b>' + signedPct(real, 1) + '%</b>'
          + (real > 0.05 ? tr(' → คนซื้อของได้มากขึ้นจริง', ' → people really bought more') : real < -0.05 ? tr(' → ปริมาณที่ซื้อจริงลดลง', ' → real volumes fell') : tr(' → แทบไม่โตจริง ส่วนใหญ่เป็นผลจากราคา', ' → little real growth, mostly higher prices'));
      }else{
        body += tr('<br>ℹ️ ตัวเลขนี้ยังไม่หักเงินเฟ้อ ถ้า CPI ขึ้นพอ ๆ กัน แปลว่าปริมาณซื้อจริงแทบไม่โต', '<br>ℹ️ Not adjusted for inflation: if CPI rose about as much, real spending barely grew');
      }
      body += nextReleaseLine('retail');
      if(dev != null) body += impact(near ? tr('ตรงคาด = ตลาดมักไม่ตอบสนองแรง', 'in line = markets usually don\'t react much')
        : dev > 0 ? tr('ผู้บริโภคใช้จ่ายแรงกว่าคาด = เศรษฐกิจแข็ง → Fed ลดดอกเบี้ยยากขึ้น บอนด์ยีลด์ขึ้น ดอลลาร์แข็ง (มักกดดันทองและหุ้นกลุ่มเติบโตระยะสั้น)', 'consumers spent more than expected = solid economy → harder for the Fed to cut, bond yields up, dollar stronger (often weighs on gold and growth stocks short term)')
        : tr('ผู้บริโภคใช้จ่ายอ่อนกว่าคาด = เศรษฐกิจเริ่มชะลอ → เพิ่มโอกาส Fed ลดดอกเบี้ย บอนด์ยีลด์ลง ดอลลาร์อ่อน', 'consumers spent less than expected = economy slowing → higher odds of Fed cuts, bond yields down, weaker dollar'));
      toneNum('retailSales', accent);
      out.push(analysisCard(accent, tr('ยอดค้าปลีก — ', 'Retail Sales — ') + rv.dot + ' ' + rv.label, body));
    }

    // ── ISM ภาคการผลิต / บริการ ──
    [['ismMfg', tr('ISM ภาคการผลิต', 'ISM Manufacturing')], ['ismSvc', tr('ISM ภาคบริการ', 'ISM Services')]].forEach(function(row){
      const key = row[0], v = extraView(key);
      if(!v) return;
      const dev = isValidNum(v.forecast) ? v.value - v.forecast : null;
      const near = dev != null && Math.abs(dev) < EXTRA_NEAR[key];
      const iv = ismVerdict(v.value), accent = iv.accent;
      const verdict = dev == null ? NOCONS : near ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : dev > 0 ? tr('🟢 ดีกว่าที่คาด', '🟢 Better than forecast') : tr('🔴 แย่กว่าที่คาด', '🔴 Worse than forecast');
      let body = row[1] + tr(' เดือน ' + esc(thMonth(v.date)) + ' = ', ', ' + esc(thMonth(v.date)) + ' = ') + '<b>' + v.value.toFixed(1) + '</b> (' + (v.value >= 50 ? tr('ขยายตัว', 'expanding') : tr('หดตัว', 'contracting')) + ')';
      body += dev == null ? tr(' · ยังไม่มีค่าคาดของรอบนี้ให้เทียบ', ' · no forecast for this release to compare against') : tr(' · ตลาดคาด ', ' · forecast ') + v.forecast.toFixed(1) + ' → ' + tail(verdict) + (near ? '' : tr(' ', ' by ') + Math.abs(dev).toFixed(1) + tr(' จุด', ' pts'));
      if(isValidNum(v.prev)){
        const crossedUp = v.prev < 50 && v.value >= 50, crossedDown = v.prev >= 50 && v.value < 50;
        body += tr('<br>เดือนก่อน ', '<br>previous month ') + v.prev.toFixed(1)
          + (crossedUp ? tr(' → <b>กลับมาขยายตัว</b> (ข้ามเส้น 50 ขึ้นมา)', ' → <b>back to expansion</b> (crossed above 50)')
            : crossedDown ? tr(' → <b>หลุดเข้าโซนหดตัว</b> (ต่ำกว่า 50)', ' → <b>slipped into contraction</b> (below 50)')
            : v.value > v.prev + 0.05 ? tr(' → ดีขึ้น', ' → improved') : v.value < v.prev - 0.05 ? tr(' → แย่ลง', ' → worsened') : tr(' → ทรงตัว', ' → steady'));
      }
      body += nextReleaseLine(key);
      if(dev != null && !near) body += impact(dev > 0
        ? tr('ภาคธุรกิจแข็งกว่าคาด = เศรษฐกิจยังดี → Fed ไม่รีบลดดอกเบี้ย บอนด์ยีลด์และดอลลาร์มักขึ้น', 'businesses stronger than expected = economy holding up → no rush for Fed cuts; yields and the dollar tend to rise')
        : tr('ภาคธุรกิจอ่อนกว่าคาด = สัญญาณเศรษฐกิจชะลอ → เพิ่มโอกาส Fed ลดดอกเบี้ย บอนด์ยีลด์และดอลลาร์มักลง', 'businesses weaker than expected = slowdown signal → higher odds of Fed cuts; yields and the dollar tend to fall'));
      else if(near) body += impact(tr('ตรงคาด = ตลาดมักไม่ตอบสนองแรง', 'in line = markets usually don\'t react much'));
      toneNum(key, accent);
      out.push(analysisCard(accent, row[1] + ' — ' + iv.dot + ' ' + iv.label, body));
    });

    // ── Existing Home Sales ──
    const hs = extraView('homeSales');
    if(hs){
      const dev = isValidNum(hs.forecast) ? hs.value - hs.forecast : null;
      const near = dev != null && Math.abs(dev) < EXTRA_NEAR.homeSales;
      const hv = homeSalesVerdict(hs.value), accent = hv.accent;
      const verdict = dev == null ? NOCONS : near ? tr('🟡 ใกล้เคียงที่คาด', '🟡 Close to forecast') : dev > 0 ? tr('🟢 ดีกว่าที่คาด', '🟢 Better than forecast') : tr('🔴 แย่กว่าที่คาด', '🔴 Worse than forecast');
      let body = tr('ยอดขายบ้านมือสองเดือน ' + esc(thMonth(hs.date)) + ' ', esc(thMonth(hs.date)) + ' existing home sales ') + '<b>' + esc(fmtHomes(hs.value)) + tr(' หลัง/ปี', ' a year') + '</b>';
      body += dev == null ? tr(' · ยังไม่มีค่าคาดของรอบนี้ให้เทียบ', ' · no forecast for this release to compare against') : tr(' · ตลาดคาด ', ' · forecast ') + esc(fmtHomes(hs.forecast)) + ' → ' + tail(verdict);
      if(isValidNum(hs.prev) && hs.prev) body += tr('<br>เทียบเดือนก่อน (', '<br>vs previous month (') + esc(fmtHomes(hs.prev)) + ') ' + signedPct((hs.value - hs.prev) / hs.prev * 100, 1) + '%';
      body += tr('<br>ระดับ: ', '<br>Level: ') + (hs.value < 4e6 ? tr('ต่ำกว่า 4 ล้าน = ตลาดบ้านซบเซามาก', 'below 4 million = a very weak housing market') : hs.value < 5e6 ? tr('ต่ำกว่าระดับปกติ (~5 ล้าน)', 'below a normal year (~5 million)') : tr('ระดับปกติถึงคึกคัก', 'normal to busy'));
      const m30 = EXTRA && EXTRA.mort30;
      if(m30 && isValidNum(m30.value)) body += tr(' · ดอกเบี้ยบ้าน 30 ปีตอนนี้ ', ' · 30-year mortgage now ') + m30.value.toFixed(2) + '%';
      body += nextReleaseLine('homeSales');
      if(dev != null) body += impact(near ? tr('ตรงคาด = เป็นกลาง', 'in line = neutral')
        : dev > 0 ? tr('ตลาดบ้านฟื้นดีกว่าคาด = หนุนหุ้นกลุ่มอสังหาฯ/ก่อสร้าง และสะท้อนว่าผู้บริโภคยังมีกำลังซื้อ', 'housing better than expected = supports homebuilder/real-estate stocks and shows buyers still have purchasing power')
        : tr('ตลาดบ้านแย่กว่าคาด = ดอกเบี้ยบ้านสูงยังกดดันผู้ซื้อ เป็นอีกเหตุผลให้ Fed ผ่อนคลาย', 'housing worse than expected = high mortgage rates still squeezing buyers, another reason for the Fed to ease'));
      toneNum('homeSales', accent);
      out.push(analysisCard(accent, tr('ยอดขายบ้านมือสอง — ', 'Existing Home Sales — ') + hv.dot + ' ' + hv.label, body));
    }

    // ── ดอกเบี้ยบ้าน 30/15 ปี (ไม่มีค่าคาด → ดูการเปลี่ยนแปลงรายสัปดาห์ + ส่วนต่างกับบอนด์ 10 ปี) ──
    const m30 = EXTRA && EXTRA.mort30, m15 = EXTRA && EXTRA.mort15;
    if(m30 && isValidNum(m30.value)){
      const ch = isValidNum(m30.change) ? m30.change : null;
      const bp = ch == null ? null : Math.round(ch * 100);
      const mv = mortgageVerdict('mort30', m30.value), accent = mv.accent;
      const verdict = mv.dot + ' ' + mv.label;
      let body = tr('30 ปี ', '30-year ') + '<b>' + m30.value.toFixed(2) + '%</b>' + (bp == null ? '' : ' (' + (bp > 0 ? '+' : bp < 0 ? '−' : '±') + Math.abs(bp) + tr(' bp จากสัปดาห์ก่อน ', ' bp vs last week ') + m30.prev.value.toFixed(2) + '%)');
      if(m15 && isValidNum(m15.value)) body += tr(' · 15 ปี ', ' · 15-year ') + '<b>' + m15.value.toFixed(2) + '%</b>' + (isValidNum(m15.change) ? ' (' + (m15.change > 0 ? '+' : m15.change < 0 ? '−' : '±') + Math.abs(Math.round(m15.change * 100)) + ' bp)' : '');
      body += tr(' · สัปดาห์ ', ' · week of ') + esc(thDay(m30.date));
      if(bp != null) body += tr('<br>ทิศทาง: ', '<br>Direction: ') + (bp <= -3 ? tr('ลดลงจากสัปดาห์ก่อน', 'down from last week') : bp >= 3 ? tr('สูงขึ้นจากสัปดาห์ก่อน', 'up from last week') : tr('ทรงตัว', 'about the same'));
      if(isValidNum(m30.spread10y)){
        const sp = m30.spread10y;
        body += tr('<br>ห่างจากบอนด์ 10 ปี (', '<br>Gap over the 10-year Treasury (') + (m30.us10y ? m30.us10y.value.toFixed(2) + '%' : '') + ') = <b>' + sp.toFixed(2) + tr(' จุด</b>', ' pts</b>')
          + (isValidNum(m30.prevSpread10y) ? tr(' (สัปดาห์ก่อน ', ' (last week ') + m30.prevSpread10y.toFixed(2) + ')' : '')
          + ' → ' + (sp > 2.3 ? tr('ห่างกว่าปกติ (ปกติ ~1.5–2) ธนาคารยังคิดดอกเบี้ยบ้านแพงเมื่อเทียบกับบอนด์', 'wider than normal (~1.5–2): lenders still charge a lot relative to bonds')
            : sp >= 1.4 ? tr('อยู่ในช่วงปกติ ดอกเบี้ยบ้านเคลื่อนตามบอนด์ 10 ปี', 'in the normal range: mortgage rates are tracking the 10-year yield')
            : tr('แคบกว่าปกติ', 'narrower than normal'));
      }
      body += tr('<br>ℹ️ ดอกเบี้ยบ้านไม่มีค่าคาดจากตลาด จึงดูการเปลี่ยนแปลงรายสัปดาห์และส่วนต่างกับบอนด์แทน', '<br>ℹ️ There is no market forecast for mortgage rates, so this looks at the weekly change and the gap over Treasuries instead');
      body += nextReleaseLine('mort30');
      if(bp != null && Math.abs(bp) >= 3) body += impact(bp < 0 ? tr('ค่าผ่อนบ้านถูกลง = หนุนยอดขาย/รีไฟแนนซ์ และหุ้นกลุ่มอสังหาฯ', 'cheaper mortgages = supports home sales, refinancing and housing stocks') : tr('ค่าผ่อนบ้านแพงขึ้น = กดดันตลาดบ้านและหุ้นกลุ่มอสังหาฯ', 'pricier mortgages = pressure on housing activity and housing stocks'));
      out.push(analysisCard(accent, tr('ดอกเบี้ยบ้าน — ', 'Mortgage rates — ') + verdict, body));
    }
    // ── Real Yield 10 ปี — verdict ตัวเดียวกับสีการ์ด ──
    const ry = EXTRA && EXTRA.ry10;
    const ryV = ry ? realYieldVerdict(ry.value, ry.change1m) : null;
    if(ryV){
      let body = tr('Real Yield 10 ปี ', '10-year real yield ') + '<b>' + ry.value.toFixed(2) + '%</b>'
        + (isValidNum(ry.change1m) ? tr(' · 1 เดือน ', ' · 1 month ') + '<b>' + ppTxt(ry.change1m) + tr(' จุด</b>', ' pts</b>') + (ry.change1mFrom ? tr(' (จาก ', ' (from ') + esc(thDay(ry.change1mFrom)) + ')' : '') : '')
        + tr(' · ปิด ', ' · close ') + esc(thDay(ry.date));
      const be = EXTRA && EXTRA.be10;
      if(be && isValidNum(be.value)) body += tr(' · Breakeven 10 ปี ', ' · 10Y breakeven ') + be.value.toFixed(2) + '% ' + tr('→ บอนด์ 10 ปีราว ', '→ 10Y Treasury about ') + (ry.value + be.value).toFixed(2) + '%';
      body += '<br><b>' + tr('ความหมาย:', 'What it means:') + '</b> ' + (
        ryV.key === 'rising' ? tr('ดอกเบี้ยจริงขึ้นเร็ว เงินปลอดภัยได้ผลตอบแทนดีขึ้นทันที การถือทองและ BTC ที่ไม่มีดอกเบี้ยเสียโอกาสมากขึ้น', 'real rates are climbing fast: safe money suddenly pays more, so holding gold and BTC (which pay nothing) costs more')
        : ryV.key === 'falling' ? tr('ดอกเบี้ยจริงลดลงเร็ว ผลตอบแทนเงินปลอดภัยหลังหักเงินเฟ้อน้อยลง เงินมักไหลกลับไปหาทอง BTC และหุ้นเติบโต', 'real rates are falling fast: safe money earns less after inflation, and money tends to flow back to gold, BTC and growth stocks')
        : ryV.key === 'high' ? tr('ดอกเบี้ยจริงอยู่ระดับตึง (2% ขึ้นไป) ถือบอนด์ก็ได้ผลตอบแทนดีโดยไม่ต้องเสี่ยง เป็นแรงกดดันต่อเนื่องต่อทอง BTC และหุ้นเทค', 'real rates are tight (2% or more): bonds pay well with no risk, a steady headwind for gold, BTC and tech')
        : ryV.key === 'low' ? tr('ดอกเบี้ยจริงต่ำ ถือเงินสด/บอนด์แทบไม่ได้อะไรหลังหักเงินเฟ้อ เป็นบวกต่อทอง BTC และหุ้นเติบโต', 'real rates are low: cash and bonds earn little after inflation, supportive for gold, BTC and growth stocks')
        : tr('ดอกเบี้ยจริงอยู่ช่วงปกติ (1–2%) และไม่ได้เคลื่อนแรงใน 1 เดือน ยังไม่ใช่แรงกดดันหรือแรงหนุนพิเศษ', 'real rates are in the normal 1–2% range with no big move over the month: neither a special headwind nor a tailwind'));
      body += impact(ryV.accent === 'var(--bad)' ? tr('ลบต่อทองคำ BTC และหุ้นเทค (ทองมักวิ่งสวนเส้นนี้ชัดที่สุด)', 'negative for gold, BTC and tech (gold usually moves opposite this line most clearly)')
        : ryV.accent === 'var(--good)' ? tr('บวกต่อทองคำ BTC และหุ้นเทค', 'positive for gold, BTC and tech')
        : tr('กลาง ๆ ให้ดูทิศทางในสัปดาห์ถัดไป', 'neutral; watch the direction over the coming weeks'));
      body += '<span style="opacity:.75;display:block;margin-top:4px;">' + legendLines(tr('ℹ️ เกณฑ์ (ดูทิศทาง 1 เดือนก่อน แล้วค่อยดูระดับ) · 🟢 ลงเร็ว 0.25 จุดขึ้นไปใน 1 เดือน หรือต่ำกว่า 1% · 🟡 1–2% และไม่เคลื่อนแรง · 🔴 ขึ้นเร็ว +0.25 จุดขึ้นไปใน 1 เดือน หรือตั้งแต่ 2% · ข้อมูล FRED DFII10', 'ℹ️ Thresholds (1-month direction first, then level) · 🟢 down 0.25 pts or more in 1 month, or below 1% · 🟡 1–2% with no big move · 🔴 up 0.25 pts or more in 1 month, or 2% and up · data FRED DFII10')) + '</span>';
      out.push(analysisCard(ryV.accent, tr('Real Yield 10 ปี — ', '10-year real yield — ') + ryV.dot + ' ' + ryV.label, body));
    }
    return out;
  }

  // อ่านสี / Colours: แตกคำอธิบายสีให้ขึ้นบรรทัดละสี (เขียว บรรทัดถัดไปเหลือง แดง ...) ทั้งเว็บ
  // แยกที่ " · " ที่ไม่ได้อยู่ในวงเล็บ ใช้เมื่อมีจุดสีอย่างน้อย 2 สี · การ์ดใหม่แค่เขียน <p><b>อ่านสี:</b> 🟢 … · 🟡 … · 🔴 …</p> ใน .tip-pop ก็ได้อัตโนมัติ
  const LEGEND_DOT = /^(?:🟢|🟡|🟠|🔴|🔵|🟣|🟤|⚪|⚫)/u;
  function splitLegendParts(html){
    const parts = []; let depth = 0, cur = '';
    for(let i = 0; i < html.length; i++){
      const c = html[i];
      if(c === '(') depth++; else if(c === ')') depth = Math.max(0, depth - 1);
      if(depth === 0 && html.startsWith(' · ', i)){ parts.push(cur.trim()); cur = ''; i += 2; continue; }
      cur += c;
    }
    parts.push(cur.trim());
    return parts.filter(Boolean);
  }
  function legendLines(html){
    const parts = splitLegendParts(String(html || ''));
    const dots = parts.filter(function(x){ return LEGEND_DOT.test(x); }).length;
    if(dots < 2) return null;
    return parts.map(function(x){ return '<span class="legend-line">' + x + '</span>'; }).join('');
  }
  // <p><b>ป้ายชื่อ:</b> 🟢 … · 🟡 …</p> → ป้ายชื่อบรรทัดแรก แล้วบรรทัดละสี · คืน null ถ้าไม่ใช่คำอธิบายสี
  function colorLegendHtml(inner){
    if(String(inner).indexOf('legend-line') !== -1) return null;
    const m = /^\s*(<b>[\s\S]*?<\/b>)\s*([\s\S]*)$/.exec(String(inner || ''));
    if(!m) return null;
    const lines = legendLines(m[2]);
    return lines ? '<span class="legend-head">' + m[1] + '</span>' + lines : null;
  }
  function formatColorLegends(root){
    const scope = root || document;
    if(!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('.tip-pop p').forEach(function(p){
      const out = colorLegendHtml(p.innerHTML);
      if(out){ p.innerHTML = out; p.classList.add('color-legend'); }
    });
  }
  window.colorLegendHtml = colorLegendHtml; window.legendLines = legendLines;   // tests + การ์ดที่สร้างด้วย JS
  // ปุ่ม (i) บางส่วนอยู่ใต้ script นี้ จึงรอให้หน้าโหลดครบก่อน
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function(){ formatColorLegends(document); });
  else formatColorLegends(document);

  // ⓘ คำอธิบายในการ์ดตลาด: บนคอมแค่ชี้ก็ขึ้น (CSS :hover) · บนมือถือแตะเพื่อเปิด/ปิด, แตะที่อื่นหรือกด Esc เพื่อปิด
  function closeTips(except){
    document.querySelectorAll('.tip.open').forEach(function(t){
      if(t === except) return;
      t.classList.remove('open');
      const b = t.querySelector('.tip-btn'); if(b) b.setAttribute('aria-expanded', 'false');
    });
  }
  document.addEventListener('click', function(ev){
    const btn = ev.target && ev.target.closest ? ev.target.closest('.tip-btn') : null;
    if(!btn){ if(!(ev.target && ev.target.closest && ev.target.closest('.tip-pop'))) closeTips(null); return; }
    const tip = btn.parentNode;
    closeTips(tip);
    const open = !tip.classList.contains('open');
    tip.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  document.addEventListener('keydown', function(ev){ if(ev.key === 'Escape') closeTips(null); });

  // ---------- ปฏิทินเศรษฐกิจ ----------
  const CAL_LABELS = EN ? {
    cpi:   ['US CPI inflation', 'Consumer Price Index'],
    jobs:  ['Jobs report (Non-farm Payrolls)', 'Employment Situation · unemployment rate'],
    ppi:   ['PPI producer prices', 'Producer Price Index'],
    jolts: ['Job openings (JOLTS)', 'Job Openings & Labor Turnover'],
    claims: ['Jobless claims (weekly)', 'Initial Jobless Claims'],
    gdp:   ['US GDP', 'Gross Domestic Product'],
    pce:   ['PCE, the Fed\'s inflation gauge', 'Personal Income & Outlays'],
    fomc:  ['FOMC meeting: rate decision', 'Fed statement + press conference'],
    retail: ['US Retail Sales', 'Advance Retail Sales (Census)'],
    ismMfg: ['ISM Manufacturing PMI', 'above 50 = expanding'],
    ismSvc: ['ISM Services PMI', 'above 50 = expanding']
  } : {
    cpi:   ['CPI เงินเฟ้อสหรัฐฯ', 'Consumer Price Index'],
    jobs:  ['ตัวเลขจ้างงาน (Non-farm Payrolls)', 'Employment Situation · อัตราว่างงาน'],
    ppi:   ['PPI ราคาผู้ผลิต', 'Producer Price Index'],
    jolts: ['ตำแหน่งงานว่าง (JOLTS)', 'Job Openings & Labor Turnover'],
    claims: ['ผู้ขอรับสวัสดิการว่างงาน (รายสัปดาห์)', 'Initial Jobless Claims'],
    gdp:   ['GDP สหรัฐฯ', 'Gross Domestic Product'],
    pce:   ['PCE เงินเฟ้อที่ Fed ใช้', 'Personal Income & Outlays'],
    fomc:  ['ประชุม FOMC — ประกาศดอกเบี้ย', 'Fed statement + แถลงข่าว'],
    retail: ['ยอดค้าปลีกสหรัฐฯ', 'Retail Sales (Census)'],
    ismMfg: ['ISM ภาคการผลิต', 'เกิน 50 = ขยายตัว'],
    ismSvc: ['ISM ภาคบริการ', 'เกิน 50 = ขยายตัว']
  };
  const CAL_HIGH = { cpi:1, jobs:1, fomc:1, pce:1 };
  const TH_DOW = EN ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'] : ['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'];
  const TIME_SUFFIX = tr(' น.', '');   // "19:30 น." ↔ "19:30" 
  function bkk(iso){
    const d = new Date(iso);
    const parts = {};
    new Intl.DateTimeFormat('en-GB', { timeZone:'Asia/Bangkok', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23', weekday:'short' })
      .formatToParts(d).forEach(p => { parts[p.type] = p.value; });
    return parts;
  }
  // ค่าคาดของรอบนั้น (ถ้า Investing.com มีแล้ว) ต่อท้ายรายการในปฏิทิน — วันที่ต้องตรงกัน ±1 วัน
  const CAL_FORECAST_KEYS = { cpi:[['cpi','CPI YoY'], ['coreCpi','Core']], ppi:[['ppi','MoM']], jobs:[['nfp','NFP'], ['unrate',tr('ว่างงาน','Unemployment')]], fomc:[['fed',tr('ดอกเบี้ย','Rate')]], claims:[['claims','Claims']],
    retail:[['retail','MoM']], ismMfg:[['ismMfg','PMI']], ismSvc:[['ismSvc','PMI']] };
  function calForecast(e){
    try{
      const parts = (CAL_FORECAST_KEYS[e.key] || []).map(([k, label]) => {
        const u = LIVE_UPCOMING[k];
        if(!u || !isValidNum(u.forecast) || Math.abs(dayDiff(u.releaseDate, e.date)) > 1) return null;
        return label + ' ' + esc(fmtForecast(k, u.forecast));
      }).filter(Boolean);
      return parts.length ? '<br><span class="cal-fc">' + tr('ตลาดคาด: ', 'Forecast: ') + parts.join(' · ') + '</span>' : '';
    }catch(err){ return ''; }
  }
  function renderCalendar(events){
    const box = el('calList');
    if(!box) return;
    const now = Date.now();
    const today = bkk(new Date(now).toISOString());
    const items = (events || []).filter(e => Date.parse(e.at || e.date) > now - 2 * 3600e3).slice(0, 7);
    if(!items.length){ box.innerHTML = '<div class="muted" style="font-size:12px;">' + tr('ยังไม่มีกำหนดการในช่วงนี้', 'Nothing scheduled in this period') + '</div>'; return; }
    box.innerHTML = items.map(e => {
      const L = CAL_LABELS[e.key] || [e.title || e.key, ''];
      const at = e.at || (e.date + 'T12:00:00Z');
      const p = bkk(at);
      const dayTh = new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay();
      const diffDays = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(+today.year, +today.month - 1, +today.day)) / 86400000);
      const when = diffDays <= 0 ? tr('วันนี้', 'Today') : diffDays === 1 ? tr('พรุ่งนี้', 'Tomorrow') : tr('อีก ' + diffDays + ' วัน', 'In ' + diffDays + ' days');
      return '<div class="cal-item' + (CAL_HIGH[e.key] ? ' hi' : '') + '">'
        + '<div class="cal-date"><b>' + esc(+p.day) + '</b><span>' + esc(TH_MONTHS[+p.month - 1]) + '</span></div>'
        + '<div class="cal-name">' + esc(L[0]) + '<small>' + esc(TH_DOW[dayTh] + ' ' + (e.at ? p.hour + ':' + p.minute + TIME_SUFFIX : '') + (L[1] ? ' · ' + L[1] : '')) + calForecast(e) + '</small></div>'
        + '<div class="cal-when' + (diffDays <= 1 ? ' soon' : '') + '">' + esc(when) + '</div>'
        + '</div>';
    }).join('');
  }
  // วันพฤหัสฯ ถัดไป 2 รอบ เวลา 8:30 น. นิวยอร์ก (สัปดาห์ที่พฤหัสฯ เป็นวันหยุด เช่น Thanksgiving → วันพุธ)
  // ตรงกับ claimsReleaseDate() ใน netlify/functions/fred-data.js
  function localClaimsEvents(){
    const out = [];
    const now = Date.now();
    for(let w = 0; w < 4 && out.length < 2; w++){
      const base = new Date(now + w * 7 * 86400000);
      const thu = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + (4 - base.getUTCDay())));
      const m = thu.getUTCMonth() + 1, d = thu.getUTCDate();
      const holiday = (m === 11 && d >= 22 && d <= 28) || (m === 1 && d === 1) || (m === 6 && d === 19) || (m === 7 && d === 4) || (m === 12 && d === 25);
      const day = holiday ? new Date(thu.getTime() - 86400000) : thu;
      const date = day.toISOString().slice(0, 10);
      // 8:30 ET = 12:30 UTC ช่วง DST (นิวยอร์กเป็น 8 โมงตอน 12:00 UTC) / 13:30 UTC ช่วงหน้าหนาว
      const probe = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12));
      const nyHour = +new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour:'2-digit', hourCycle:'h23' }).format(probe);
      const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), nyHour === 8 ? 12 : 13, 30)).toISOString();
      if(Date.parse(at) > now - 2 * 3600e3 && !out.some(e => e.date === date)) out.push({ key:'claims', date, at, source:'local' });
    }
    return out;
  }
  async function fetchCalendar(){
    try{
      const r = await fetchWithTimeout('/.netlify/functions/calendar', 12000);
      const j = await r.json();
      if(!j || !Array.isArray(j.events)) throw new Error('bad calendar payload');
      CAL_EVENTS = j.events;
    }catch(e){
      console.warn('[calendar]', e);
      // ดึงไม่ได้ — อย่างน้อยโชว์ FOMC จากรายการที่หน้าเว็บมีอยู่แล้ว (14:00 น. เวลานิวยอร์ก ≈ 01:00–02:00 น. ไทย)
      CAL_EVENTS = FOMC_STATEMENT_DATES.map(d => ({ key:'fomc', date:d, at:null })).filter(e => e.date >= new Date().toISOString().slice(0, 10));
    }
    // Jobless claims ประกาศทุกพฤหัสฯ — ถ้าปฏิทินจากเซิร์ฟเวอร์ไม่มี (ฟังก์ชันล่ม/เวอร์ชันเก่า) คำนวณเองจากตารางประจำ
    try{
      if(!CAL_EVENTS.some(e => e && e.key === 'claims')){
        CAL_EVENTS = CAL_EVENTS.concat(localClaimsEvents()).sort((a, b) => String(a.at || a.date).localeCompare(String(b.at || b.date)));
      }
    }catch(e){ /* best-effort */ }
    renderCalendar(CAL_EVENTS);
    BRIEF.events = CAL_EVENTS;
    try{ renderBrief(); }catch(e){ /* best-effort */ }
    try{ renderNextReleases(); }catch(e){ /* best-effort */ }
    try{ if(lastFedPayload) renderFedAnalysis(lastFedPayload); }catch(e){ /* best-effort */ }
  }

  // ---------- "ประกาศครั้งถัดไป · ตลาดคาด …" — ค่าคาดการณ์ก่อนตัวเลขจริงออก ----------
  // วัน/เวลาประกาศมาจากปฏิทิน (BLS/FOMC — เวลาแน่นอน แปลงเป็นเวลาไทย) ส่วนค่าคาดมาจากแถวที่ยังไม่ประกาศ
  // ในตารางของ Investing.com (/.netlify/functions/consensus → events[key].upcoming)
  // ค่าคาดจะแสดงก็ต่อเมื่อวันที่ของสองแหล่งตรงกัน (±1 วัน) — กันเอาค่าคาดของรอบที่ประกาศไปแล้ว
  // มาแปะกับรอบถัดไป · พอตัวเลขจริงออก รายการนี้จะเลื่อนไปรอบหน้าเอง และการ์ดวิเคราะห์จะเทียบ "จริง vs คาด" ให้
  var CAL_EVENTS = [];
  const NEXT_CAL_KEY = { cpi:'cpi', coreCpi:'cpi', ppi:'ppi', unrate:'jobs', nfp:'jobs', fed:'fomc', claims:'claims', pce:'pce',
    retail:'retail', homeSales:'homeSales', ismMfg:'ismMfg', ismSvc:'ismSvc', mort30:'mort', mort15:'mort' };
  // เวลาประกาศปกติ (นิวยอร์ก) — ใช้เมื่อมีแค่วันที่จาก Investing.com ไม่มีในปฏิทิน
  const NEXT_DEFAULT_ET = { retail:[8, 30], homeSales:[10, 0], ismMfg:[10, 0], ismSvc:[10, 0], mort30:[12, 0], mort15:[12, 0] };
  // ตัวที่ตลาดไม่มีค่าคาด → ไม่ต้องเขียน "ยังไม่มีค่าคาด"
  const NO_FORECAST_KEYS = { mort30:1, mort15:1 };
  // วันที่จาก Investing.com เชื่อได้กว่าวันที่ที่คำนวณจากกฎ (ISM) ถ้าสองแหล่งไม่ตรงกัน
  const PREFER_UPCOMING_DATE = { ismMfg:1, ismSvc:1 };
  // เวลานิวยอร์ก hh:mm ของวันที่ date → ISO UTC (EDT = UTC−4 / EST = UTC−5)
  function nyTimeIso(date, hh, mm){
    const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
    if(!p) return null;
    const probe = new Date(Date.UTC(+p[1], +p[2] - 1, +p[3], 12));
    const nyHour = +new Intl.DateTimeFormat('en-US', { timeZone:'America/New_York', hour:'2-digit', hourCycle:'h23' }).format(probe);
    const off = 12 - nyHour;   // 4 หรือ 5
    return new Date(Date.UTC(+p[1], +p[2] - 1, +p[3], hh + off, mm)).toISOString();
  }
  // ดอกเบี้ยบ้าน Freddie Mac: ทุกวันพฤหัสฯ 12:00 น. นิวยอร์ก (สัปดาห์ที่พฤหัสฯ เป็นวันหยุด → วันพุธ)
  function mortgageEvents(){
    const out = [];
    const now = Date.now();
    for(let w = 0; w < 3 && out.length < 2; w++){
      const base = new Date(now + w * 7 * 86400000);
      const thu = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + (4 - base.getUTCDay())));
      const m = thu.getUTCMonth() + 1, d = thu.getUTCDate();
      const holiday = (m === 11 && d >= 22 && d <= 28) || (m === 1 && d === 1) || (m === 6 && d === 19) || (m === 7 && d === 4) || (m === 12 && d === 25);
      const date = (holiday ? new Date(thu.getTime() - 86400000) : thu).toISOString().slice(0, 10);
      const at = nyTimeIso(date, 12, 0);
      if(at && Date.parse(at) > now && !out.some(e => e.date === date)) out.push({ key:'mort', date, at, source:'local' });
    }
    return out;
  }
  function dayDiff(a, b){ return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000); }
  // ตัวเลขรายเดือนที่ประกาศในเดือน M เป็นของเดือน M−1 (CPI/PPI/จ้างงาน/PCE) — ใช้เช็กว่าข้อมูลที่หน้าเว็บมี
  // ตามรอบที่เพิ่งประกาศทันหรือยัง
  const MONTHLY_REF_KEYS = { cpi:1, coreCpi:1, ppi:1, unrate:1, nfp:1, pce:1 };
  const PENDING_GRACE_MS = 36 * 3600e3;
  function refMonthFor(releaseDate){
    const m = /^(\d{4})-(\d{2})/.exec(String(releaseDate || ''));
    if(!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 2, 1));
    return d.toISOString().slice(0, 10);
  }
  // รอบที่เวลาประกาศผ่านไปแล้ว (ไม่เกิน 36 ชม.) แต่ตัวเลขในการ์ดยังเป็นของเดือนก่อนหน้า = ยัง "รอตัวเลข"
  // เดิมพอเลย 20:30 น. บรรทัดนี้ข้ามไปรอบเดือนหน้าทันที ทั้งที่ FRED ยังไม่อัปเดต การ์ดเลยดูเหมือนอัปเดตแล้ว
  function pendingRelease(key, calKey, now){
    if(!MONTHLY_REF_KEYS[key]) return null;
    const field = lastFedPayload && lastFedPayload[key];
    if(!field || !/^\d{4}-\d{2}-\d{2}$/.test(String(field.date || ''))) return null;
    // เดือนที่ประกาศแบบไม่มี YoY ถือว่าเข้าระบบแล้ว (ไม่ต้องรอตัวเลขที่จะไม่มีวันมา)
    const month = (field.latestNoYoy && field.latestNoYoy.date > field.date) ? field.latestNoYoy.date : field.date;
    return (CAL_EVENTS || [])
      .filter(e => e && e.key === calKey && e.at && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')))
      .filter(e => { const t = Date.parse(e.at); return t <= now && t > now - PENDING_GRACE_MS; })
      .filter(e => { const ref = refMonthFor(e.date); return ref && month < ref; })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
  }
  function nextRelease(key){
    const calKey = NEXT_CAL_KEY[key];
    const now = Date.now();
    const todayUtc = new Date(now).toISOString().slice(0, 10);
    const pend = pendingRelease(key, calKey, now);
    if(pend){
      let pu = LIVE_UPCOMING[key] || null;
      if(pu && Math.abs(dayDiff(pu.releaseDate, pend.date)) > 1) pu = null;
      return { date: pend.date, at: pend.at, pending: true, forecast: pu ? pu.forecast : null, previous: pu ? pu.previous : null };
    }
    // เหตุการณ์ที่ยังไม่ถึงเวลา (ไม่มีเวลา = ถือว่ายังไม่ผ่านจนจบวันนั้น)
    let ev = (calKey === 'mort' ? mortgageEvents() : (CAL_EVENTS || []))
      .filter(e => e && e.key === calKey && /^\d{4}-\d{2}-\d{2}$/.test(String(e.date || '')))
      .filter(e => (e.at ? Date.parse(e.at) : Date.parse(e.date + 'T23:59:59Z')) > now)
      .sort((a, b) => String(a.at || a.date).localeCompare(String(b.at || b.date)))[0] || null;
    let up = LIVE_UPCOMING[key] || null;
    if(up && ev && Math.abs(dayDiff(up.releaseDate, ev.date)) > 1 && PREFER_UPCOMING_DATE[key] && up.releaseDate >= todayUtc) ev = null;
    if(up && ev && Math.abs(dayDiff(up.releaseDate, ev.date)) > 1) up = null;
    if(up && !ev && up.releaseDate < todayUtc) up = null;
    if(!ev && !up) return null;
    const dt = NEXT_DEFAULT_ET[key];
    const at = ev ? ev.at : (dt ? nyTimeIso(up.releaseDate, dt[0], dt[1]) : null);
    return { date: ev ? ev.date : up.releaseDate, at: at, forecast: up ? up.forecast : null, previous: up ? up.previous : null };
  }
  function fmtForecast(key, v){
    if(!isValidNum(v)) return '';
    if(key === 'nfp') return fmtJobs(v) + tr(' ตำแหน่ง', ' jobs');
    if(key === 'claims') return fmtClaims(v);
    if(key === 'ppi') return signedPct(v, 1) + '%';
    if(key === 'fed') return v.toFixed(2) + '%';
    if(key === 'retail') return signedPct(v, 1) + '%';
    if(key === 'homeSales') return (v / 1e6).toFixed(2) + 'M';
    if(key === 'ismMfg' || key === 'ismSvc') return v.toFixed(1);
    return v.toFixed(1) + '%';
  }
  // "พฤ. 13 พ.ย. 19:30 น." (เวลาไทย) · วันนี้/พรุ่งนี้ใช้คำแทนวันที่
  function fmtReleaseWhen(n){
    const iso = n.at || (n.date + 'T12:00:00Z');
    const p = bkk(iso);
    const t = bkk(new Date().toISOString());
    const diff = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day) - Date.UTC(+t.year, +t.month - 1, +t.day)) / 86400000);
    const dow = TH_DOW[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
    const day = diff === 0 ? tr('วันนี้', 'today') : diff === 1 ? tr('พรุ่งนี้', 'tomorrow') : dow + ' ' + (+p.day) + ' ' + TH_MONTHS[+p.month - 1];
    return { text: day + (n.at ? ' ' + p.hour + ':' + p.minute + TIME_SUFFIX : ''), today: diff === 0 };
  }
  // HTML หนึ่งบรรทัดสำหรับใต้ตัวเลขในการ์ด (ไม่มีข้อมูลเลย = คืนค่าว่าง)
  function nextReleaseHtml(key, opts){
    const n = nextRelease(key);
    if(!n) return '';
    const w = fmtReleaseWhen(n);
    let fc = NO_FORECAST_KEYS[key] ? '' : isValidNum(n.forecast) ? (key === 'fed' ? tr('ตลาดคาดดอกเบี้ย ', 'Rate forecast ') : tr('ตลาดคาด ', 'Forecast ')) + '<b>' + esc(fmtForecast(key, n.forecast)) + '</b>' : tr('ยังไม่มีค่าคาด', 'No forecast yet');
    if(key === 'cpi' && isValidNum(n.forecast)){
      const core = nextRelease('coreCpi');
      if(core && isValidNum(core.forecast) && core.date === n.date) fc += ' (Core ' + esc(fmtForecast('coreCpi', core.forecast)) + ')';
    }
    if(opts && opts.withPrev && isValidNum(n.previous)) fc += tr(' · ครั้งก่อน ', ' · previous ') + esc(fmtForecast(key, n.previous));
    if(n.pending){
      // ประกาศไปแล้วแต่แหล่งข้อมูล (FRED/BLS) ยังไม่มีตัวเลขใหม่ — บอกตรงๆ แทนการโชว์รอบหน้า
      if(!isValidNum(n.forecast)) fc = '';
      return tr('⏳ ประกาศแล้ว ', '⏳ Released ') + esc(w.text) + tr(' · รอตัวเลขใหม่เข้าระบบ', ' · waiting for the new figure') + (fc ? ' · ' + fc : '');
    }
    return (w.today ? tr('⏰ ประกาศ', '⏰ Release ') : tr('📅 ครั้งถัดไป ', '📅 Next ')) + esc(w.text) + (fc ? ' · ' + fc : '');
  }
  function nextReleaseLine(key){
    try{
      const h = nextReleaseHtml(key, { withPrev: true });
      return h ? '<br>' + h : '';
    }catch(e){ return ''; }
  }
  function renderNextReleases(){
    [['nextFed','fed'], ['nextCpi','cpi'], ['nextPpi','ppi'], ['nextUnrate','unrate'], ['nextNfp','nfp'], ['nextClaims','claims'], ['nextPce','pce'],
     ['nextHomeSales','homeSales'], ['nextMort30','mort30'], ['nextMort15','mort15'], ['nextRetail','retail'], ['nextIsmMfg','ismMfg'], ['nextIsmSvc','ismSvc']].forEach(([id, key]) => {
      const node = el(id);
      if(!node) return;
      const h = nextReleaseHtml(key);
      node.innerHTML = h;
      node.className = 'next' + (h.indexOf('⏰') === 0 || h.indexOf('⏳') === 0 ? ' today' : '');
    });
  }
  fetchCalendar();

  // ---------- WTI Oil ----------
  // ราคาหลักคือ WTI จริงจาก NYMEX (สัญญา CL เดือนใกล้สุด) ผ่าน /.netlify/functions/wti — หน่วง ~10 นาที
  // ถ้าฟังก์ชันล่ม ค่อยใช้สัญญา perpetual บนกระดานคริปโตด้านล่าง (วิ่งตาม CL แต่ไม่เท่ากันเป๊ะ) และบอกไว้ใต้ราคา
  async function tryNymexOil(){
    const r = await fetchWithTimeout('/.netlify/functions/wti', 8000);
    const j = await r.json();
    if(!r.ok || !isValidNum(j.price)) throw new Error(j.error || 'HTTP ' + r.status);
    return { price: j.price, pct: j.pct, source: 'NYMEX', status: tr('NYMEX · สัญญาเดือนใกล้สุด (หน่วง ~10 นาที)', 'NYMEX · front-month contract (~10 min delay)') };
  }
  // Alpha Vantage does not send CORS headers at all, so this always goes through a CORS proxy,
  // same as the FRED and calendar fixes elsewhere in this app.
  // Hyperliquid is a DEX that launched real WTI oil perpetual futures (via their HIP-3
  // framework) — their public "info" API is designed for direct web/bot access and is
  // CORS-friendly, so this needs no key at all. We scan the returned price list for any
  // symbol that looks like an oil contract, since the exact ticker naming isn't fully
  // documented. Falls back to Alpha Vantage (needs a free key) only if this doesn't find one.
  // Multiple exchanges now list the same underlying WTI perpetual under different tickers
  // (per market research: Binance/Bybit use CLUSDT, OKX uses CL-USDT-SWAP, Kraken uses
  // PF_WTIOILUSD, Hyperliquid uses XYZ:CL-USD). Binance and OKX public market-data endpoints
  // are already confirmed CORS-friendly elsewhere in this app, so try those first — no proxy
  // needed at all if either works.
  async function tryBinanceOil(){
    const r = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr?symbol=CLUSDT', 6000);
    if(!r.ok) throw new Error('Binance HTTP ' + r.status);
    const j = await r.json();
    const price = parseFloat(j.lastPrice);
    if(isNaN(price)) throw new Error('Binance: no CLUSDT price in response');
    return { price, pct: parseFloat(j.priceChangePercent), source: 'Binance (CLUSDT)' };
  }

  async function tryOkxOil(){
    const r = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=CL-USDT-SWAP', 6000);
    if(!r.ok) throw new Error('OKX HTTP ' + r.status);
    const j = await r.json();
    const last = j.data && j.data[0] && parseFloat(j.data[0].last);
    if(!last || isNaN(last)) throw new Error('OKX: no CL-USDT-SWAP price in response');
    return { price: last, pct: pctChange(last, parseFloat(j.data[0].open24h)), source: 'OKX (CL-USDT-SWAP)' };
  }

  async function tryHyperliquidOil(){
    // The oil perp is a HIP-3 deployer-namespaced market (symbol "XYZ:CL-USD"), which only
    // shows up in allMids when explicitly querying dex="xyz" — the default (empty) dex only
    // returns Hyperliquid's own main perp market. We try both, main dex first.
    let lastErr = 'no oil symbol found';
    for(const dex of ['', 'xyz']){
      try{
        const r = await fetchWithTimeout('https://api.hyperliquid.xyz/info', 7000, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'allMids', dex })
        });
        if(!r.ok){ lastErr = 'Hyperliquid HTTP ' + r.status + ' (dex="' + dex + '")'; continue; }
        const mids = await r.json();
        const oilKey = Object.keys(mids).find(k => /WTI|CL-USD|^OIL|OILUSD/i.test(k));
        if(!oilKey){ lastErr = 'no WTI/CL-USD symbol in dex="' + dex + '" (' + Object.keys(mids).length + ' symbols checked)'; continue; }
        const price = parseFloat(mids[oilKey]);
        if(isNaN(price)){ lastErr = 'bad price value for ' + oilKey; continue; }
        return { price, source: 'Hyperliquid (' + oilKey + ')' };
      }catch(e){ lastErr = e.message + ' (dex="' + dex + '")'; }
    }
    throw new Error('Hyperliquid: ' + lastErr);
  }

  function setOilStatus(msg){
    const b = el('avFetchStatusVisible'); if(b) b.textContent = msg;
  }

  // เดิมแคชราคาน้ำมันไว้ทั้งวัน (ราคาแรกของวันค้างจนเที่ยงคืน UTC) — ตอนนี้แคชแค่ 5 นาที
  const OIL_CACHE_MS = 5 * 60 * 1000;
  async function fetchOilPrice(){
    const today = new Date().toISOString().slice(0,10);
    try{
      const raw = await storageGet('oil-price-cache');
      if(raw){
        const c = JSON.parse(raw);
        // c.lang: ข้อความสถานะในแคชเป็นภาษาตอนบันทึก — เปลี่ยนภาษาแล้วดึงใหม่
        if(isValidNum(c.at) && Date.now() - c.at < OIL_CACHE_MS && isValidNum(c.price) && c.status && (c.lang || 'th') === (EN ? 'en' : 'th')){
          setPrice('lpOil', '$' + c.price.toFixed(2), c.pct);
          setOilStatus(c.status || '');
          return;
        }
      }
    }catch(e){}

    const trail = [];

    // NYMEX first; the crypto perpetuals only as a labelled stand-in.
    const freeAttempts = [
      ['NYMEX', tryNymexOil],
      ['Binance', tryBinanceOil],
      ['OKX', tryOkxOil],
      ['Hyperliquid', tryHyperliquidOil]
    ];
    for(const [name, fn] of freeAttempts){
            try{
        const res = await fn();
        const status = res.status || tr('NYMEX ดึงไม่ได้ ใช้ ' + res.source + ' แทน (ใกล้เคียง แต่ไม่ใช่ราคา NYMEX)', 'NYMEX unavailable, using ' + res.source + ' instead (close, but not the NYMEX price)');
        setPrice('lpOil', '$' + res.price.toFixed(2), res.pct);
        setOilStatus(status);
        try{ await storageSet('oil-price-cache', JSON.stringify({ date: today, at: Date.now(), price: res.price, pct: res.pct, source: res.source, status, lang: EN ? 'en' : 'th' })); }catch(e){}
        return;
      }catch(e){ trail.push(name + ': ' + e.message); }
    }

    // All free sources failed — fall back to our Netlify Function, which holds the Alpha
    // Vantage key server-side (never visible to visitors).
    try{
      const r = await fetchWithTimeout('/.netlify/functions/oil-price', 10000);
      const j = await r.json();
      if(j.price){
        const status = tr('ราคาปิดรายวันจาก Alpha Vantage', 'Daily close from Alpha Vantage') + (j.asOf ? ' (' + thDay(j.asOf) + ')' : '');
        setPrice('lpOil', '$' + j.price.toFixed(2), null);
        setOilStatus(status);
        try{ await storageSet('oil-price-cache', JSON.stringify({ date: today, at: Date.now(), price: j.price, source: 'Alpha Vantage (server)', status, lang: EN ? 'en' : 'th' })); }catch(e){}
        return;
      }
      trail.push('server function: ' + (j.error || 'unknown error'));
    }catch(e){ trail.push('server function: ' + e.message); }

    el('lpOil').textContent = tr('ดึงไม่สำเร็จ', 'Unavailable');
    setOilStatus('');
    console.warn('[oil] every source failed:', trail.join(' · '));
  }

  fetchOilPrice();

  // ราคาสด (ทองโลก ค่าเงิน น้ำมัน ทองไทย) เดิมดึงครั้งเดียวตอนเปิดหน้า เปิดค้างไว้ตัวเลขก็ไม่ขยับ
  // ตอนนี้รีเฟรชทุก 5 นาทีขณะเปิดดูอยู่ และทันทีที่กลับมาเปิดแท็บ (ถ้าห่างเกิน 1 นาที)
  const PRICES_POLL_MS = 5 * 60 * 1000;
  let pricesAt = Date.now();
  function refreshPrices(){
    if(document.hidden) return;
    pricesAt = Date.now();
    fetchLivePrices().then(fetchThaiGold);
    fetchOilPrice();
  }
  setInterval(function(){ if(Date.now() - pricesAt >= PRICES_POLL_MS) refreshPrices(); }, 60 * 1000);
  document.addEventListener('visibilitychange', function(){ if(!document.hidden && Date.now() - pricesAt >= 60 * 1000) refreshPrices(); });

  renderFomcCountdown(); // instant, pure date math, no network needed
  // Cache-first: the news cache is good for 30 minutes, and the 🇹🇭 button / the "รีเฟรชข่าว"
  // button always force a live pull. Re-fetching 5 feeds on every reload was pure waste — and it
  // burned through the (then rss2json) quota for visitors who just refreshed the page a few times.
  const NEWS_CACHE_TTL_MS = 30 * 60 * 1000;
  loadBriefPrev();
  loadCache().then(function(ageMs){
    if(ageMs != null && ageMs < NEWS_CACHE_TTL_MS){
      return;
    }
    return refreshNews();
  });
})();
