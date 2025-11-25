(async function(){
  console.clear();
  console.log('Diagnose + Repair: Collection Badges — startet');

  // --- Einstellungen ---
  const CARD_SELECTOR = '.cardScalable, .card, .item, [data-itemid], [data-id]';
  const BADGE_CLASS = 'collection-count-badge-js';
  const CACHE_TTL_MS = 5*60*1000;
  const SKIP_SECTION_KEYWORDS = [
    'continue', 'weiterschau', 'weiter', 'recent', 'kürzlich', 'kuerzlich', 'recently',
    'recommended', 'empfohlen', 'recommend', 'vorgeschlagen', 'als nächstes', 'als naechstes',
    'next up', 'continue watching', 'watch next', 'recently added', 'zuletzt', 'top picks'
  ];

  // --- kleine Utility-Funktionen ---
  const cache = new Map();
  function now(){ return Date.now(); }
  function log(...a){ console.log('[BadgeRepair]', ...a); }

  // --- ID Extraktion (robust, wie zuvor) ---
  function extractIdFromCard(card){
    if (!card) return null;
    try {
      const ds = card.dataset || {};
      if (ds.itemid || ds.id || ds.folderid) return ds.itemid || ds.id || ds.folderid;
      const a = card.querySelector('a[href*="details?id="]') || card.querySelector('a[href*="/details/"]') || card.querySelector('a[href*="Details/"]');
      if (a){
        const href = a.getAttribute('href') || '';
        const m1 = href.match(/details\/([0-9a-fA-F-]{8,})/);
        const m2 = href.match(/[?&]id=([0-9a-fA-F-]{8,})/);
        if (m1 && m1[1]) return m1[1];
        if (m2 && m2[1]) return m2[1];
        const q = href.split('?')[1] || href.split('#')[1] || '';
        return new URLSearchParams(q).get('id') || null;
      }
      const descendant = card.querySelector('[data-itemid], [data-id], [data-folderid]');
      if (descendant) return descendant.dataset.itemid || descendant.dataset.id || descendant.dataset.folderid || null;
    } catch(e){ /* ignore */ }
    return null;
  }

  // --- Nearest section title (um Ausschluss zu prüfen) ---
  function getNearestSectionTitle(card){
    let el = card;
    for (let i=0;i<8 && el; i++){
      const heading = el.querySelector && (el.querySelector('h1, h2, h3, h4, .sectionTitle, .panel-title, .carousel-title'));
      if (heading) {
        const t = heading.textContent && heading.textContent.trim();
        if (t) return t.toLowerCase();
      }
      if (el.previousElementSibling) {
        const prev = el.previousElementSibling;
        const pt = prev.textContent && prev.textContent.trim();
        if (pt && pt.length < 60) return pt.toLowerCase();
      }
      el = el.parentElement;
    }
    return null;
  }
  function isInSkippedSection(card){
    try {
      const title = getNearestSectionTitle(card);
      if (!title) return false;
      return SKIP_SECTION_KEYWORDS.some(k => title.includes(k));
    } catch(e){ return false; }
  }

  // --- Test-Fetch (kurz) ---
  async function testFetchForId(id){
    if (!id) return null;
    const SERVER_URL = (window.JellyfinClient && typeof window.JellyfinClient.apiBaseUrl==='function')
      ? (window.JellyfinClient.apiBaseUrl() || location.origin) : location.origin;
    const apiKey = (window.ApiClient?.accessToken?.() || (window.JellyfinClient?.accessToken?.() || null));
    try {
      const url = `${SERVER_URL.replace(/\/$/,'')}/Items/${encodeURIComponent(id)}`;
      log('Test-Fetch URL:', url, 'apiKey?', !!apiKey);
      const res = await fetch(url, { headers: apiKey ? {'X-Emby-Token': apiKey} : {}, credentials:'include' });
      log('Test-Fetch status', res.status);
      if (!res.ok) return {ok:false, status: res.status};
      const j = await res.json();
      return {ok:true, status: res.status, type: j.Type || '(no type)', name: j.Name || null};
    } catch(e){ log('Test-Fetch error', e); return {ok:false, error: String(e)}; }
  }

  // --- Attach left-top badge (sicher, dedupliziert per data-badge-for) ---
  function attachLeftTopBadge(card, id, count){
    if (!card || !id || count <= 0) return false;
    // Ziel: nächster stabiler container (fallback = card)
    let target = card.closest('.card, .cardScalable, .item') || card;
    if (!target) target = card;

    // entferne bestehende Badges für diese id, ausser wenn schon am target
    const existing = Array.from(document.querySelectorAll(`.${BADGE_CLASS}[data-badge-for="${id}"]`));
    existing.forEach(b => { if (b.parentElement !== target) b.remove(); });

    // entferne lokale alte
    const oldLocal = Array.from(target.querySelectorAll(`.${BADGE_CLASS}`));
    oldLocal.forEach(n => n.remove());

    try { if (getComputedStyle(target).position === 'static') target.style.position = 'relative'; } catch(e){}

    const b = document.createElement('div');
    b.className = BADGE_CLASS;
    b.setAttribute('data-badge-for', id);
    b.textContent = String(count);
    Object.assign(b.style, {
      position:'absolute', top:'8px', left:'8px',
      minWidth:'26px', height:'26px', lineHeight:'26px',
      borderRadius:'50%', background:'#ff3b30', color:'#fff',
      display:'flex', alignItems:'center', justifyContent:'center',
      fontWeight:'700', fontSize:'12px', zIndex:'99999', pointerEvents:'none',
      boxShadow:'0 2px 6px rgba(0,0,0,0.35)', transform:'translateZ(0)'
    });
    target.appendChild(b);
    return true;
  }

  // --- interne Fetch-Funktion für Count (falls nicht global vorhanden) ---
  async function fetchMovieCountForCollectionLocal(id){
    if (!id) return 0;
    const cached = cache.get(id);
    if (cached && (now() - cached.ts) < CACHE_TTL_MS) return cached.count;
    try {
      const SERVER_URL = (window.JellyfinClient && typeof window.JellyfinClient.apiBaseUrl==='function')
        ? (window.JellyfinClient.apiBaseUrl() || location.origin) : location.origin;
      const apiKey = (window.ApiClient?.accessToken?.() || (window.JellyfinClient?.accessToken?.() || null));
      const headers = apiKey ? {'X-Emby-Token': apiKey} : {};
      // Details
      const det = await fetch(`${SERVER_URL.replace(/\/$/,'')}/Items/${encodeURIComponent(id)}`, { headers, credentials:'include' });
      if (!det.ok) { cache.set(id,{count:0,ts:now()}); return 0; }
      const details = await det.json();
      const type = (details && details.Type) ? String(details.Type).toLowerCase() : '';
      const EXCLUDE_TYPES = ['movie','series','season','person','episode','trailer','musicvideo','audiobook','playlist','tvchannel'];
      if (EXCLUDE_TYPES.includes(type)){ cache.set(id,{count:0,ts:now()}); return 0; }
      const listRes = await fetch(`${SERVER_URL.replace(/\/$/,'')}/Items?ParentId=${encodeURIComponent(id)}&Recursive=false&IncludeItemTypes=Movie`, { headers, credentials:'include' });
      if (!listRes.ok){ cache.set(id,{count:0,ts:now()}); return 0; }
      const listData = await listRes.json();
      let movieCount = 0;
      if (listData && typeof listData.TotalRecordCount === 'number') movieCount = listData.TotalRecordCount;
      else if (listData && Array.isArray(listData.Items)) movieCount = listData.Items.length;
      movieCount = Number.isFinite(movieCount) ? Math.max(0, Math.floor(movieCount)) : 0;
      cache.set(id,{count:movieCount,ts:now()});
      return movieCount;
    } catch(e){ cache.set(id,{count:0,ts:now()}); log('fetch local error', e); return 0; }
  }

  // --- DIAGNOSE: count cards, show 3 examples ---
  const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
  log('Cards found total =', cards.length);
  for (let i=0; i<Math.min(3, cards.length); i++){
    try {
      log('Example outerHTML', i, ':', cards[i].outerHTML.slice(0,600));
      const id = extractIdFromCard(cards[i]);
      log(' -> extracted id:', id);
      if (id){
        const test = await testFetchForId(id);
        log(' -> testFetch result:', test);
      }
    } catch(e){ log('diag example error', e); }
  }

  // --- REPAIR: hänge Badges nur an Karten, die NICHT in Skip-Sections sind ---
  let attachedTotal = 0;
  for (let i=0;i<cards.length;i++){
    const c = cards[i];
    try {
      if (isInSkippedSection(c)) { continue; } // alten Ausschluss beibehalten
      const id = extractIdFromCard(c);
      if (!id) continue;
      const count = await fetchMovieCountForCollectionLocal(id);
      if (count > 0){
        const ok = attachLeftTopBadge(c, id, count);
        if (ok) attachedTotal++;
      }
    } catch(e){ /* ignore single errors */ }
    // kleiner Sleep alle 50 Iterationen, um den Server nicht zu überlasten
    if (i%50===0) await new Promise(r=>setTimeout(r, 120));
  }
  log('Repair: fertig, Badges attached =', attachedTotal);
  // Hinweis: falls nichts attached wurde, prüfe bitte die Test-Fetch-Ausgaben oben (401/403/CORS/etc).

  

  console.log('Diagnose+Repair beendet.');
})();
