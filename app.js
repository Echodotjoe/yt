/* Tubelight – YouTube search + player using the official YouTube Data API
   and the official IFrame Player API. Persistent state lives in localStorage. */
(() => {
  'use strict';

  /* ---------- persistent storage ---------- */
  const K = {
    key: 'tl_api_key',
    region: 'tl_region',
    history: 'tl_history',   // watched videos with channel + tags
    queries: 'tl_queries',   // past searches
    recs: 'tl_recs_cache',   // cached recommendations
    autoplay: 'tl_autoplay',
    inst: 'tl_good_instance', // last backup server that worked
    custom: 'tl_custom_instances',
  };
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  /* ---------- helpers ---------- */
  const $ = (s, r = document) => r.querySelector(s);
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const decode = s => { const t = document.createElement('textarea'); t.innerHTML = s ?? ''; return t.value; };

  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2200);
  }
  function fmtDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
    if (!m) return '';
    const [h, mi, s] = [+m[1] || 0, +m[2] || 0, +m[3] || 0];
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(mi)}:${pad(s)}` : `${mi}:${pad(s)}`;
  }
  function fmtCount(n) {
    n = +n; if (isNaN(n)) return '';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }
  function ago(iso) {
    const s = (Date.now() - new Date(iso)) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    for (const [n, v] of units) if (s >= v) { const c = Math.floor(s / v); return `${c} ${n}${c > 1 ? 's' : ''} ago`; }
    return 'just now';
  }

  /* ---------- data layer ----------
     With an API key  -> official YouTube Data API v3.
     Without one (or if the key fails / quota runs out) -> public Invidious servers. */
  const API = 'https://www.googleapis.com/youtube/v3/';
  class NeedsKey extends Error {}

  function fmtSeconds(sec) {
    sec = +sec; if (!sec) return '';
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  /* --- official API --- */
  async function ytApi(endpoint, params) {
    const key = store.get(K.key, '');
    const url = new URL(API + endpoint);
    Object.entries({ ...params, key }).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Request failed (${res.status})`);
      err.reason = data?.error?.errors?.[0]?.reason; throw err;
    }
    return data;
  }
  const shapeYT = v => ({
    id: v.id,
    title: decode(v.snippet.title),
    channelId: v.snippet.channelId,
    channelTitle: decode(v.snippet.channelTitle),
    published: v.snippet.publishedAt,
    thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.high?.url || '',
    duration: fmtDuration(v.contentDetails?.duration),
    views: v.statistics?.viewCount,
    tags: v.snippet.tags || [],
    description: v.snippet.description || '',
  });
  async function ytDetails(ids) {
    const d = await ytApi('videos', { part: 'snippet,contentDetails,statistics', id: ids.join(',') });
    return d.items.map(shapeYT);
  }
  async function ytSearch(p) {
    const d = await ytApi('search', { part: 'snippet', type: 'video', maxResults: 24, safeSearch: 'moderate', ...p });
    return ytDetails(d.items.map(i => i.id.videoId).filter(Boolean));
  }
  async function ytTrending() {
    const d = await ytApi('videos', {
      part: 'snippet,contentDetails,statistics', chart: 'mostPopular',
      regionCode: (store.get(K.region, 'US') || 'US').toUpperCase(), maxResults: 24,
    });
    return d.items.map(shapeYT);
  }

  /* --- public Invidious servers (no key) --- */
  const FALLBACK_INSTANCES = [
    'https://yewtu.be', 'https://inv.nadeko.net', 'https://invidious.nerdvpn.de', 'https://invidious.privacyredirect.com',
  ];
  let instances = null;

  async function getInstances() {
    if (instances) return instances;
    const clean = u => u.replace(/\/+$/, '');
    const custom = store.get(K.custom, '').split(/[\s,]+/).filter(Boolean).map(clean);
    let found = [];
    try { // community-maintained list of servers that allow API + cross-site requests
      const res = await fetch('https://api.invidious.io/instances.json?sort_by=health');
      const list = await res.json();
      found = list.filter(([, i]) => i.api && i.cors && i.type === 'https').map(([, i]) => clean(i.uri));
    } catch { /* use built-in list */ }
    const good = store.get(K.inst, null);
    instances = [...new Set([...custom, ...(good ? [good] : []), ...found.slice(0, 6), ...FALLBACK_INSTANCES])];
    return instances;
  }

  async function inv(path) {
    for (const base of (await getInstances()).slice(0, 6)) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const res = await fetch(base + path, { signal: ctrl.signal });
        if (!res.ok) continue;
        const data = await res.json();
        store.set(K.inst, base);
        return data;
      } catch { /* try the next server */ } finally { clearTimeout(timer); }
    }
    throw new Error('No public search server is responding right now. Try again in a minute, add a server in Settings, or use an API key.');
  }
  const shapeInv = v => ({
    id: v.videoId,
    title: v.title,
    channelId: v.authorId,
    channelTitle: v.author,
    published: v.published ? new Date(v.published * 1000).toISOString() : '',
    thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    duration: fmtSeconds(v.lengthSeconds),
    views: v.viewCount,
    tags: v.keywords || [],
    description: v.description || '',
  });
  async function invSearch(p) {
    const limit = p.maxResults || 24;
    if (p.channelId) {
      const d = await inv(`/api/v1/channels/${encodeURIComponent(p.channelId)}/videos`);
      return (Array.isArray(d) ? d : d.videos || []).filter(v => v.videoId).slice(0, limit).map(shapeInv);
    }
    const qs = new URLSearchParams({ q: p.q, type: 'video' });
    if (p.order === 'date') qs.set('sort_by', 'upload_date');
    const d = await inv('/api/v1/search?' + qs);
    return d.filter(v => v.type === 'video' && v.videoId).slice(0, limit).map(shapeInv);
  }
  const invDetails = ids => Promise.all(ids.map(async id => shapeInv(await inv(`/api/v1/videos/${encodeURIComponent(id)}`))));
  async function invTrending() {
    const region = (store.get(K.region, 'US') || 'US').toUpperCase();
    const d = await inv(`/api/v1/trending?region=${region}`);
    return d.filter(v => v.videoId).slice(0, 24).map(shapeInv);
  }

  /* --- public functions used by the UI: key first, backup servers otherwise --- */
  async function withFallback(official, backup) {
    if (store.get(K.key, '')) {
      try { return await official(); }
      catch (e) { toast('API key failed, using backup servers'); }
    }
    return backup();
  }
  const details = ids => ids.length ? withFallback(() => ytDetails(ids), () => invDetails(ids)) : Promise.resolve([]);
  const searchVideos = p => withFallback(() => ytSearch(p), () => invSearch(p));
  const trending = () => withFallback(ytTrending, invTrending);

  /* ---------- watch history + interests ---------- */
  function recordWatch(v) {
    let h = store.get(K.history, []).filter(x => x.id !== v.id);
    h.unshift({
      id: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle,
      thumb: v.thumb, duration: v.duration, tags: (v.tags || []).slice(0, 10), ts: Date.now(),
    });
    store.set(K.history, h.slice(0, 200));
    store.del(K.recs); // interests changed -> rebuild recommendations
  }
  function recordQuery(q) {
    let list = store.get(K.queries, []).filter(x => x.q.toLowerCase() !== q.toLowerCase());
    list.unshift({ q, ts: Date.now() });
    store.set(K.queries, list.slice(0, 50));
    store.del(K.recs);
  }

  // Score channels and topics, recent activity counts more (14-day half-life-ish decay)
  function interests() {
    const now = Date.now(), decay = t => Math.exp(-(now - t) / (14 * 864e5));
    const channels = {}, topics = {};
    for (const h of store.get(K.history, [])) {
      const w = decay(h.ts);
      channels[h.channelId] ||= { id: h.channelId, name: h.channelTitle, score: 0 };
      channels[h.channelId].score += w;
      for (const t of h.tags || []) { const k = t.toLowerCase(); topics[k] = (topics[k] || 0) + w; }
    }
    for (const q of store.get(K.queries, [])) {
      const k = q.q.toLowerCase(); topics[k] = (topics[k] || 0) + decay(q.ts) * 2;
    }
    const top = o => Object.entries(o).sort((a, b) => b[1].score - a[1].score || b[1] - a[1]);
    return {
      channels: Object.values(channels).sort((a, b) => b.score - a.score).slice(0, 2),
      topics: Object.entries(topics).sort((a, b) => b[1] - a[1]).slice(0, 3).map(e => e[0]),
    };
  }

  async function recommendations() {
    const hist = store.get(K.history, []);
    const { channels, topics } = interests();
    if (!hist.length && !topics.length) return null;

    const sig = JSON.stringify([channels.map(c => c.id), topics]);
    const cache = store.get(K.recs, null);
    if (cache && cache.sig === sig && Date.now() - cache.ts < 30 * 60 * 1000) return cache;

    const jobs = [];
    topics.forEach(t => jobs.push(searchVideos({ q: t, maxResults: 12, order: 'relevance' }).then(r => ({ r, why: `Because you like “${t}”` }))));
    channels.slice(0, 1).forEach(c => jobs.push(searchVideos({ channelId: c.id, maxResults: 12, order: 'date' }).then(r => ({ r, why: `New from ${c.name}` }))));
    const settled = (await Promise.allSettled(jobs)).filter(s => s.status === 'fulfilled').map(s => s.value);

    const seen = new Set(hist.map(h => h.id)), items = [];
    // round-robin so no single interest dominates
    for (let i = 0; i < 12; i++) for (const s of settled) {
      const v = s.r[i]; if (v && !seen.has(v.id)) { seen.add(v.id); items.push({ ...v, why: s.why }); }
    }
    const out = { sig, ts: Date.now(), items: items.slice(0, 24) };
    store.set(K.recs, out);
    return out;
  }

  /* ---------- rendering ---------- */
  function card(v, extraMeta = '') {
    const meta = [v.channelTitle, v.views ? fmtCount(v.views) + ' views' : '', v.published ? ago(v.published) : ''].filter(Boolean).join(' • ');
    return `<a class="card" href="#/watch?v=${esc(v.id)}">
      <div class="thumb"><img loading="lazy" src="${esc(v.thumb)}" alt="">${v.duration ? `<span class="dur">${esc(v.duration)}</span>` : ''}</div>
      <div><h3>${esc(v.title)}</h3><div class="meta">${esc(extraMeta || meta)}</div></div>
    </a>`;
  }
  const skeleton = (n = 8) => `<div class="grid skeleton">${Array.from({ length: n }, () => `<div class="card"><div class="thumb"></div><h3>&nbsp;</h3></div>`).join('')}</div>`;

  function showError(err) {
    if (err instanceof NeedsKey) {
      app.innerHTML = `<div class="empty"><h1>Add your API key to start</h1>
        <p class="muted">Tubelight uses the YouTube Data API v3 for search. Create a free key in Google Cloud Console, then paste it in Settings.</p>
        <button class="btn" id="openSettings" style="margin-top:12px">Open settings</button></div>`;
      $('#openSettings').onclick = openSettings;
      return;
    }
    const quota = err.reason === 'quotaExceeded' || err.reason === 'rateLimitExceeded';
    app.innerHTML = `<div class="error"><h1>${quota ? 'Daily quota used up' : 'Something went wrong'}</h1>
      <p class="muted">${quota ? 'The free API quota resets at midnight Pacific time. Try again then, or use another key in Settings.' : esc(err.message)}</p></div>`;
  }

  async function renderHome() {
    document.title = 'Tubelight – search and watch';
    app.innerHTML = skeleton();
    try {
      const [rec, trend] = await Promise.all([recommendations().catch(() => null), trending().catch(() => [])]);
      const hist = store.get(K.history, []);
      let html = '';

      const pool = rec?.items?.length ? rec.items : null;
      if (pool) {
        const f = pool[0];
        html += `<section class="feature">
          <a class="thumb" href="#/watch?v=${esc(f.id)}"><img src="${esc(f.thumb)}" alt=""></a>
          <div class="info"><span class="why">${esc(f.why)}</span>
            <h1>${esc(f.title)}</h1><div class="muted">${esc(f.channelTitle)}</div>
            <a class="btn" href="#/watch?v=${esc(f.id)}">Watch now</a></div></section>`;
      }
      if (hist.length) {
        html += `<section class="section"><div class="section-head"><h2>Continue watching</h2><span class="muted">Your recent videos</span></div>
          <div class="grid">${hist.slice(0, 6).map(h => card(h, h.channelTitle)).join('')}</div></section>`;
      }
      if (pool && pool.length > 1) {
        html += `<section class="section"><div class="section-head"><h2>Recommended for you</h2><span class="muted">Built from what you watch and search</span></div>
          <div class="grid">${pool.slice(1).map(v => card(v)).join('')}</div></section>`;
      } else if (!hist.length) {
        html += `<section class="section"><div class="section-head"><h2>Recommended for you</h2></div>
          <p class="muted">Watch a few videos and this row fills with picks based on your taste. Until then, here is what is trending.</p></section>`;
      }
      if (trend.length) html += `<section class="section"><div class="section-head"><h2>Trending</h2></div><div class="grid">${trend.map(v => card(v)).join('')}</div></section>`;
      if (!html.includes('<section')) html = `<div class="empty"><h1>Search for anything</h1><p class="muted">Use the search bar above. Videos you watch and search for will shape the recommendations here.</p></div>`;
      app.innerHTML = html;
    } catch (e) { showError(e); }
  }

  async function renderSearch(q) {
    document.title = `${q} – Tubelight`;
    $('#searchInput').value = q;
    app.innerHTML = `<div class="section-head" style="margin-bottom:16px"><h2>Results for “${esc(q)}”</h2></div>${skeleton()}`;
    try {
      const results = await searchVideos({ q });
      app.innerHTML = `<div class="section-head" style="margin-bottom:16px"><h2>Results for “${esc(q)}”</h2></div>` +
        (results.length ? `<div class="grid">${results.map(v => card(v)).join('')}</div>` :
          `<div class="empty"><h1>No videos found</h1><p class="muted">Try different keywords or check the spelling.</p></div>`);
    } catch (e) { showError(e); }
  }

  /* ---------- watch page + player (official IFrame Player API) ---------- */
  let ytReady, player, relatedList = [], currentId = null;
  function loadYT() {
    if (ytReady) return ytReady;
    ytReady = new Promise(res => {
      if (window.YT?.Player) return res();
      window.onYouTubeIframeAPIReady = res;
      const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; document.head.appendChild(s);
    });
    return ytReady;
  }

  async function renderWatch(id) {
    app.innerHTML = `<div class="watch"><div><div class="player-wrap"><div id="player"></div></div><div id="info"></div></div><aside class="side" id="side"></aside></div>`;
    currentId = id; player = null;
    try {
      await loadYT();
      if (currentId !== id) return;
      player = new YT.Player('player', {
        videoId: id,
        playerVars: { autoplay: 1, rel: 0, playsinline: 1, modestbranding: 1 },
        events: { onStateChange: e => { if (e.data === YT.PlayerState.ENDED && store.get(K.autoplay, true) && relatedList[0]) location.hash = `#/watch?v=${relatedList[0].id}`; } },
      });
    } catch { toast('Could not load the video player'); }

    let v;
    try {
      [v] = await details([id]);
      if (currentId !== id) return;
      if (!v) { $('#info').innerHTML = `<h1>Video unavailable</h1>`; return; }
    } catch (e) {
      $('#info').innerHTML = `<h1>Couldn’t load video details</h1><p class="muted">${esc(e.message)}</p>`;
      return;
    }
    document.title = `${v.title} – Tubelight`;
    recordWatch(v);
    $('#info').innerHTML = `<h1>${esc(v.title)}</h1>
      <div class="channel">${esc(v.channelTitle)}</div>
      <div class="stats">${[v.views ? fmtCount(v.views) + ' views' : '', v.published ? ago(v.published) : ''].filter(Boolean).join(' • ')}</div>
      <div class="actions"><label><input type="checkbox" id="autoplay" ${store.get(K.autoplay, true) ? 'checked' : ''}> Play next video automatically</label></div>
      <div class="desc">${esc(v.description) || '<span class="muted">No description.</span>'}</div>`;
    $('#autoplay').onchange = e => store.set(K.autoplay, e.target.checked);

    $('#side').innerHTML = skeleton(4);
    try {
      const q = (v.tags && v.tags.slice(0, 3).join(' ')) || v.title;
      relatedList = (await searchVideos({ q, maxResults: 16 })).filter(x => x.id !== id);
      if (currentId !== id) return;
      $('#side').innerHTML = relatedList.map(x => card(x)).join('');
    } catch (e) {
      $('#side').innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  }

  /* ---------- routing ---------- */
  function route() {
    if (player?.destroy) { try { player.destroy(); } catch { /* ignore */ } player = null; }
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, qs = ''] = raw.split('?');
    const p = new URLSearchParams(qs);
    window.scrollTo(0, 0);
    if (path === '/watch' && p.get('v')) return renderWatch(p.get('v'));
    if (path === '/search' && p.get('q')) return renderSearch(p.get('q'));
    $('#searchInput').value = '';
    return renderHome();
  }

  /* ---------- events ---------- */
  $('#searchForm').addEventListener('submit', e => {
    e.preventDefault();
    const q = $('#searchInput').value.trim();
    if (!q) return;
    recordQuery(q);
    location.hash = `#/search?q=${encodeURIComponent(q)}`;
  });

  const dlg = $('#settings');
  function openSettings() {
    $('#keyInput').value = store.get(K.key, '');
    $('#regionInput').value = store.get(K.region, 'US');
    $('#instInput').value = store.get(K.custom, '');
    dlg.showModal();
  }
  $('#settingsBtn').onclick = openSettings;
  $('#closeSettings').onclick = () => dlg.close();
  $('#settingsForm').addEventListener('submit', () => {
    store.set(K.key, $('#keyInput').value.trim());
    store.set(K.region, ($('#regionInput').value.trim() || 'US').toUpperCase());
    store.set(K.custom, $('#instInput').value.trim());
    instances = null; store.del(K.recs); toast('Settings saved'); route();
  });
  $('#clearHistory').onclick = () => {
    store.del(K.history); store.del(K.queries); store.del(K.recs);
    toast('History cleared'); dlg.close(); route();
  };

  window.addEventListener('hashchange', route);
  route();
})();
