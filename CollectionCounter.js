// == Jellyfin Film-Collection Badge Script (Series/Person/Episode etc. ignoriert; Collections erlaubt) ==
(async function(){
  console.clear();
  console.log('Film-Collection Badge (Series ausgeschlossen) startet...');

  const SERVER_URL = 'http://xxx.xxx.xxx.xxx:8096'; // Jellyfin-Server-Adresse
  const CARD_SELECTOR = '.cardScalable';
  const BADGE_CLASS = 'collection-count-badge-js';
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // --- Badge CSS ---
  if (!document.getElementById('collection-count-badge-js-style')) {
    const s = document.createElement('style');
    s.id = 'collection-count-badge-js-style';
    s.textContent = `
      .${BADGE_CLASS}{
        position:absolute;
        top:6px;
        left:6px;
        min-width:30px;
        height:30px;
        border-radius:50%;
        background:#ff3b30;
        color:#fff;
        display:flex;
        align-items:center;
        justify-content:center;
        font-weight:700;
        font-size:13px;
        z-index:99999;
        pointer-events:none;
      }
    `;
    document.head.appendChild(s);
  }

  const cache = new Map();
  const loggedTypes = new Set(); // verhindert wiederholte Debug-Logs

  // --- ID aus Karte extrahieren ---
  function extractIdFromCard(card){
    if (!card) return null;
    try {
      if (card.dataset && (card.dataset.itemid || card.dataset.id || card.dataset.folderid))
        return card.dataset.itemid || card.dataset.id || card.dataset.folderid;
      const a = card.querySelector('a[href*="details?id="]') || card.querySelector('a[href*="details"]');
      if (a){
        const href = a.getAttribute('href')||'';
        const q = href.split('?')[1] || href.split('#')[1] || '';
        return new URLSearchParams(q).get('id') || null;
      }
    } catch(e){}
    return null;
  }

  // --- Abschnitts- / Home-Widget-Check ---
  const SKIP_SECTION_KEYWORDS = [
    'continue', 'weiterschau', 'weiter', 'recent', 'kürzlich', 'kuerzlich', 'recently',
    'recommended', 'empfohlen', 'recommend', 'vorgeschlagen', 'als nächstes', 'als naechstes',
    'next up', 'continue watching', 'watch next', 'recently added', 'zuletzt', 'top picks'
  ];

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

  // --- Prüfen, ob Item Collection ist und wie viele Movies sie enthält ---
  async function fetchMovieCountForCollection(id, apiKey){
    if (!id) return 0;
    const cached = cache.get(id);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.count;

    try {
      // Details holen (Type prüfen)
      const detailsUrl = `${SERVER_URL}/Items/${encodeURIComponent(id)}`;
      const detRes = await fetch(detailsUrl, { headers: {'X-Emby-Token': apiKey} });
      if (!detRes.ok) { cache.set(id, {count:0, ts:Date.now()}); return 0; }
      const details = await detRes.json();

      // Ausschlussliste: Typen, die definitiv KEINE Collections sind
      const type = details && details.Type ? details.Type.toLowerCase() : '';
      const EXCLUDE_TYPES = [
        'movie','series','season','person','episode',
        'trailer','musicvideo','audiobook','playlist','tvchannel'
      ];

      if (EXCLUDE_TYPES.includes(type)) {
        cache.set(id, {count:0, ts:Date.now()});
        return 0;
      }

      // Debug: einmalig loggen, wenn wir eine Kandidaten-Type sehen (hilft beim Tuning)
      if (type && !loggedTypes.has(type)) {
        loggedTypes.add(type);
        console.log('Badge-Kandidat Type (weiter geprüft):', details.Type, 'id=', id);
      }

      // Movie-Children zählen (Collection-Fall)
      const listUrl = `${SERVER_URL}/Items?ParentId=${encodeURIComponent(id)}&Recursive=false&IncludeItemTypes=Movie`;
      const listRes = await fetch(listUrl, { headers: {'X-Emby-Token': apiKey} });
      if (!listRes.ok) { cache.set(id, {count:0, ts:Date.now()}); return 0; }
      const listData = await listRes.json();

      let movieCount = 0;
      if (listData && typeof listData.TotalRecordCount === 'number') movieCount = listData.TotalRecordCount;
      else if (listData && Array.isArray(listData.Items)) movieCount = listData.Items.length;

      movieCount = Number.isFinite(movieCount) ? Math.max(0, Math.floor(movieCount)) : 0;
      cache.set(id, {count: movieCount, ts: Date.now()});
      // Debug: logge kurz, wenn eine Collection tatsächlich movieCount > 0 hat
      if (movieCount > 0) console.log('Collection mit Filmen:', details.Type, 'id=', id, 'count=', movieCount);
      return movieCount;
    } catch (e) {
      console.error('fetchMovieCountForCollection error', e);
      cache.set(id, {count:0, ts:Date.now()});
      return 0;
    }
  }

  // --- Badge an Karte anhängen ---
  function attachBadge(card, count){
    if (!card || count <= 0) return;
    if (card.querySelector(`.${BADGE_CLASS}`)) return;
    if (isInSkippedSection(card)) return;
    if (getComputedStyle(card).position === 'static') card.style.position = 'relative';
    const b = document.createElement('div');
    b.className = BADGE_CLASS;
    b.textContent = String(count);
    card.appendChild(b);
  }

  // --- Karte annotieren ---
  async function annotateCard(card, apiKey){
    if (!card || card.dataset.__ct_annotated === '1') return;
    card.dataset.__ct_annotated = '1';

    if (isInSkippedSection(card)) return;

    const id = extractIdFromCard(card);
    if (!id) return;

    const movieCount = await fetchMovieCountForCollection(id, apiKey);
    if (movieCount > 0) attachBadge(card, movieCount);
  }

  // --- Initial annotieren ---
  async function annotateAll(apiKey){
    const cards = Array.from(document.querySelectorAll(CARD_SELECTOR));
    console.log('Film-Collection Annotator — Cards gefunden:', cards.length);
    cards.forEach((c, i) => setTimeout(() => annotateCard(c, apiKey).catch(err => console.error(err)), i * 60));
  }

  // --- MutationObserver für nachgeladene Karten ---
  function observeMutations(apiKey){
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.matches && n.matches(CARD_SELECTOR)) annotateCard(n, apiKey);
          else if (n.querySelectorAll) {
            const found = n.querySelectorAll(CARD_SELECTOR);
            if (found && found.length) found.forEach(c => annotateCard(c, apiKey));
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  // --- Script starten (robuster Key-Wait) ---
  const apiKey = await (async function waitForKey(timeout = 15000, interval = 200) {
    const start = Date.now();
    let key = null;
    while (!key && (Date.now() - start) < timeout) {
      try { key = (window.ApiClient?.accessToken?.() || window.JellyfinClient?.accessToken?.()); } catch(e){}
      if (!key) await new Promise(r => setTimeout(r, interval));
    }
    return key;
  })();

  if (!apiKey) {
    console.error('Kein Browser-Key gefunden – Badge kann nicht angezeigt werden.');
    return;
  }

  console.log('Browser-Key gefunden:', apiKey);

  annotateAll(apiKey);
  observeMutations(apiKey);

})();
