/* HK どのバスでも行ける? — core logic */
(function () {
  'use strict';
  const D = window.BUSDATA; // {stops:[[id,lat,lng,zh,en]], routes:[...]}
  const $ = (s) => document.querySelector(s);
  const CO_NAME = { kmb: '九巴', ctb: '城巴', nlb: '嶼巴' };
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };

  // ---------- geometry ----------
  function dist(a, b, c, d) {
    const R = 6371000, toR = Math.PI / 180;
    const x = (d - b) * toR * Math.cos(((a + c) / 2) * toR), y = (c - a) * toR;
    return Math.sqrt(x * x + y * y) * R;
  }
  const CELL = 0.005;
  const grid = new Map();
  D.stops.forEach((s, i) => {
    const k = Math.floor(s[1] / CELL) + ':' + Math.floor(s[2] / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  function stopsNear(lat, lng, r) {
    const out = new Map();
    const n = Math.ceil(r / 500) + 1;
    const ci = Math.floor(lat / CELL), cj = Math.floor(lng / CELL);
    for (let i = ci - n; i <= ci + n; i++) for (let j = cj - n; j <= cj + n; j++) {
      const arr = grid.get(i + ':' + j); if (!arr) continue;
      for (const si of arr) { const s = D.stops[si]; const dd = dist(lat, lng, s[1], s[2]); if (dd <= r) out.set(si, dd); }
    }
    return out;
  }

  // ---------- route matching ----------
  function findRoutes(o, dst, r1, r2) {
    const near1 = stopsNear(o.lat, o.lng, r1), near2 = stopsNear(dst.lat, dst.lng, r2);
    const res = [];
    if (!near1.size || !near2.size) return { res, near1, near2 };
    for (const rt of D.routes) {
      const seq = rt.s[rt.p];
      let best = null;
      for (let i = 0; i < seq.length; i++) {
        const w1 = near1.get(seq[i]); if (w1 === undefined) continue;
        for (let j = i + 1; j < seq.length; j++) {
          const w2 = near2.get(seq[j]); if (w2 === undefined) continue;
          const score = w1 + w2 + (j - i) * 60; // walking + ~stops penalty
          if (!best || score < best.score) best = { i, j, w1, w2, score };
        }
      }
      if (best) res.push(Object.assign({ rt }, best));
    }
    // same route number+operator, keep best per (route, direction)
    const m = new Map();
    for (const x of res) {
      const k = x.rt.c.join('/') + x.rt.r + x.rt.o + x.rt.d;
      if (!m.has(k) || m.get(k).score > x.score) m.set(k, x);
    }
    return { res: [...m.values()], near1, near2 };
  }

  // ---------- ETA ----------
  const etaCache = new Map();
  async function getJSON(url, opt) {
    const r = await fetch(url, opt); if (!r.ok) throw new Error(r.status); return r.json();
  }
  async function kmbStopEta(stopId) {
    const k = 'kmb:' + stopId, c = etaCache.get(k);
    if (c && Date.now() - c.t < 25000) return c.p;
    const p = getJSON('https://data.etabus.gov.hk/v1/transport/kmb/stop-eta/' + stopId).then((j) => j.data || []);
    etaCache.set(k, { t: Date.now(), p }); p.catch(() => etaCache.delete(k));
    return p;
  }
  function nearestInSeq(seq, lat, lng) {
    let b = -1, bd = 1e9;
    seq.forEach((si) => { if (si < 0) return; const s = D.stops[si]; const dd = dist(lat, lng, s[1], s[2]); if (dd < bd) { bd = dd; b = si; } });
    return bd < 250 ? b : -1;
  }
  async function etaFor(x) {
    const rt = x.rt, board = D.stops[x.rt.s[rt.p][x.i]];
    const now = Date.now(), out = [];
    const jobs = rt.c.map(async (co) => {
      try {
        const si = co === rt.p ? rt.s[co][x.i] : nearestInSeq(rt.s[co], board[1], board[2]);
        if (si < 0) return;
        const sid = D.stops[si][0];
        if (co === 'kmb') {
          const data = await kmbStopEta(sid);
          data.filter((e) => e.route === rt.r && e.dir === rt.b.kmb && String(e.service_type) === String(rt.t) && e.eta)
            .forEach((e) => out.push({ t: Date.parse(e.eta), co, rmk: e.rmk_tc }));
        } else if (co === 'ctb') {
          const j = await getJSON('https://rt.data.gov.hk/v2/transport/citybus/eta/CTB/' + sid + '/' + encodeURIComponent(rt.r));
          (j.data || []).filter((e) => e.dir === rt.b.ctb && e.eta).forEach((e) => out.push({ t: Date.parse(e.eta), co, rmk: e.rmk_tc }));
        } else if (co === 'nlb') {
          const j = await getJSON('https://rt.data.gov.hk/v2/transport/nlb/stop.php?action=estimatedArrivals', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ routeId: rt.n, stopId: sid, language: 'zh' }),
          });
          (j.estimatedArrivals || []).forEach((e) => out.push({ t: Date.parse(e.estimatedArrivalTime.replace(' ', 'T') + '+08:00'), co }));
        }
      } catch (e) { out.err = true; }
    });
    await Promise.all(jobs);
    const list = out.filter((e) => e.t && e.t > now - 60000).sort((a, b) => a.t - b.t);
    list.err = out.err;
    return list;
  }

  // ---------- map ----------
  const map = L.map('map', { zoomControl: false }).setView([22.302, 114.177], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  const pin = (color, label) => L.divIcon({ className: '', html: `<div class="pin" style="background:${color}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 30] });
  let oMarker = null, dMarker = null, oCircle = null, dCircle = null, routeLayer = L.layerGroup().addTo(map);

  const state = {
    origin: null, dest: LS.get('dest', null), mode: 'dest',
    r1: LS.get('r1', 400), r2: LS.get('r2', 500), results: [], stopFilter: 'all', watch: null,
  };

  function drawPoints() {
    if (oMarker) map.removeLayer(oMarker), map.removeLayer(oCircle);
    if (dMarker) map.removeLayer(dMarker), map.removeLayer(dCircle);
    if (state.origin) {
      oMarker = L.marker([state.origin.lat, state.origin.lng], { icon: pin('#2563eb', '今') }).addTo(map);
      oCircle = L.circle([state.origin.lat, state.origin.lng], { radius: state.r1, color: '#2563eb', weight: 1, fillOpacity: 0.06 }).addTo(map);
    }
    if (state.dest) {
      dMarker = L.marker([state.dest.lat, state.dest.lng], { icon: pin('#dc2626', '目') }).addTo(map);
      dCircle = L.circle([state.dest.lat, state.dest.lng], { radius: state.r2, color: '#dc2626', weight: 1, fillOpacity: 0.06 }).addTo(map);
    }
  }
  function fitBoth() {
    const pts = [state.origin, state.dest].filter(Boolean).map((p) => [p.lat, p.lng]);
    if (pts.length === 2) map.fitBounds(pts, { padding: [40, 40] });
    else if (pts.length === 1) map.setView(pts[0], 16);
  }

  map.on('click', (e) => {
    const p = { lat: e.latlng.lat, lng: e.latlng.lng, name: '地図で指定した地点' };
    if (state.mode === 'origin') { state.origin = p; stopGPS(); setMode('dest'); }
    else { state.dest = p; LS.set('dest', p); $('#destInput').value = p.name; }
    drawPoints(); run();
  });

  function setMode(m) {
    state.mode = m;
    $('#modeHint').textContent = m === 'origin' ? '地図をタップして「出発地」を指定' : '地図をタップでも目的地を指定できます';
    $('#pickOrigin').classList.toggle('on', m === 'origin');
  }

  // ---------- GPS ----------
  function startGPS() {
    if (!navigator.geolocation) { toast('この端末では位置情報が使えません'); return; }
    stopGPS();
    $('#gpsBtn').classList.add('on');
    let first = true;
    state.watch = navigator.geolocation.watchPosition((p) => {
      const o = { lat: p.coords.latitude, lng: p.coords.longitude, name: '現在地' };
      const moved = !state.origin || dist(o.lat, o.lng, state.origin.lat, state.origin.lng) > 40;
      state.origin = o; drawPoints();
      if (first) { first = false; fitBoth(); }
      if (moved) run();
    }, (err) => { toast('位置情報を取得できませんでした（' + err.message + '）。地図のタップで出発地を指定してください'); $('#gpsBtn').classList.remove('on'); },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }
  function stopGPS() { if (state.watch != null) navigator.geolocation.clearWatch(state.watch); state.watch = null; $('#gpsBtn').classList.remove('on'); }

  // ---------- destination search ----------
  let searchTimer = null;
  $('#destInput').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    if (q.length < 1) { $('#suggest').innerHTML = ''; return; }
    searchTimer = setTimeout(() => search(q), 300);
  });
  async function search(q) {
    const ql = q.toLowerCase(), seen = new Set(), items = [];
    for (const s of D.stops) {
      if ((s[3] && s[3].includes(q)) || (s[4] && s[4].toLowerCase().includes(ql))) {
        const key = s[3]; if (seen.has(key)) continue; seen.add(key);
        items.push({ lat: s[1], lng: s[2], name: s[3], sub: 'バス停 ' + s[4] });
        if (items.length >= 8) break;
      }
    }
    render(items);
    try {
      const j = await getJSON('https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=hk&accept-language=zh-HK,en&q=' + encodeURIComponent(q));
      j.forEach((r) => items.push({ lat: +r.lat, lng: +r.lon, name: r.display_name.split(',')[0], sub: '地名 ' + r.display_name.split(',').slice(1, 3).join(',') }));
      if ($('#destInput').value.trim() === q) render(items);
    } catch (e) {}
    function render(arr) {
      $('#suggest').innerHTML = arr.map((it, i) => `<div class="sg" data-i="${i}"><b>${esc(it.name)}</b><small>${esc(it.sub)}</small></div>`).join('');
      $('#suggest').querySelectorAll('.sg').forEach((el) => el.onclick = () => {
        const it = arr[+el.dataset.i]; state.dest = { lat: it.lat, lng: it.lng, name: it.name }; LS.set('dest', state.dest);
        $('#destInput').value = it.name; $('#suggest').innerHTML = ''; $('#destInput').blur();
        addRecent(state.dest); drawPoints(); fitBoth(); run();
      });
    }
  }
  function addRecent(p) {
    const r = LS.get('recent', []).filter((x) => x.name !== p.name); r.unshift(p); LS.set('recent', r.slice(0, 6)); renderRecent();
  }
  function renderRecent() {
    const r = LS.get('recent', []);
    $('#recent').innerHTML = r.map((p, i) => `<button data-i="${i}">${esc(p.name)}</button>`).join('');
    $('#recent').querySelectorAll('button').forEach((b) => b.onclick = () => {
      const p = r[+b.dataset.i]; state.dest = p; LS.set('dest', p); $('#destInput').value = p.name; drawPoints(); fitBoth(); run();
    });
  }

  // ---------- main ----------
  function esc(s) { return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 4000); }

  let runId = 0;
  async function run() {
    const id = ++runId;
    if (!state.origin || !state.dest) {
      $('#list').innerHTML = `<div class="empty">${!state.dest ? '① 目的地を入力してください' : '② 「現在地」を押すか、出発地を地図で指定してください'}</div>`;
      $('#stopSel').innerHTML = ''; return;
    }
    const { res, near1, near2 } = findRoutes(state.origin, state.dest, state.r1, state.r2);
    if (!res.length) {
      $('#list').innerHTML = `<div class="empty">直通のバスが見つかりません。<br>${!near1.size ? '出発地の近くにバス停がありません。' : !near2.size ? '目的地の近くにバス停がありません。' : ''}設定で徒歩範囲を広げてみてください。</div>`;
      $('#stopSel').innerHTML = ''; routeLayer.clearLayers(); return;
    }
    state.results = res.map((x) => Object.assign(x, { eta: null }));
    renderStopFilter();
    renderList();
    await refreshEta(id);
  }
  async function refreshEta(id) {
    $('#updated').textContent = '到着時刻を取得中…';
    await Promise.all(state.results.map(async (x) => {
      x.eta = await etaFor(x); if (id === runId) renderList();
    }));
    if (id === runId) {
      const d = new Date(); $('#updated').textContent = '更新 ' + d.toTimeString().slice(0, 8) + '（30秒ごと自動更新）';
    }
  }
  function renderStopFilter() {
    const m = new Map();
    state.results.forEach((x) => { const si = x.rt.s[x.rt.p][x.i]; const s = D.stops[si]; const k = s[3]; if (!m.has(k)) m.set(k, { n: 0, w: x.w1 }); m.get(k).n++; m.get(k).w = Math.min(m.get(k).w, x.w1); });
    const arr = [...m.entries()].sort((a, b) => a[1].w - b[1].w);
    if (!arr.find((a) => a[0] === state.stopFilter)) state.stopFilter = 'all';
    $('#stopSel').innerHTML = `<option value="all">すべての乗り場（${state.results.length}路線）</option>` +
      arr.map(([k, v]) => `<option value="${esc(k)}" ${k === state.stopFilter ? 'selected' : ''}>${esc(k)}（徒歩${Math.round(v.w)}m・${v.n}路線）</option>`).join('');
  }
  $('#stopSel').onchange = (e) => { state.stopFilter = e.target.value; renderList(); };

  function mins(t) { const m = Math.round((t - Date.now()) / 60000); return m <= 0 ? '到着' : m + '分'; }
  function renderList() {
    let arr = state.results.slice();
    if (state.stopFilter !== 'all') arr = arr.filter((x) => D.stops[x.rt.s[x.rt.p][x.i]][3] === state.stopFilter);
    const first = (x) => (x.eta && x.eta.length ? x.eta[0].t : Infinity);
    arr.sort((a, b) => first(a) - first(b) || a.score - b.score);
    $('#list').innerHTML = arr.map((x, k) => {
      const rt = x.rt, b = D.stops[rt.s[rt.p][x.i]], a = D.stops[rt.s[rt.p][x.j]];
      let etaHtml;
      if (x.eta === null) etaHtml = '<span class="muted">取得中…</span>';
      else if (!x.eta.length) etaHtml = `<span class="muted">${x.eta.err ? '取得失敗' : '到着予定なし'}</span>`;
      else etaHtml = x.eta.slice(0, 3).map((e, n) => `<span class="eta ${n === 0 ? 'first' : ''}">${mins(e.t)}</span>`).join('') + (x.eta[0].rmk ? `<small class="muted"> ${esc(x.eta[0].rmk)}</small>` : '');
      const soon = x.eta && x.eta.length && x.eta[0].t - Date.now() < 3 * 60000;
      return `<div class="card ${soon ? 'soon' : ''}" data-k="${k}">
        <div class="top"><div class="no">${esc(rt.r)}</div>
          <div class="dir"><span class="co">${rt.c.map((c) => CO_NAME[c]).join('・')}</span> 往 <b>${esc(rt.d)}</b></div>
          <div class="etas">${etaHtml}</div></div>
        <div class="st">🚏 乗車 <b>${esc(b[3])}</b> <span class="muted">徒歩${Math.round(x.w1)}m</span></div>
        <div class="st">🏁 下車 <b>${esc(a[3])}</b> <span class="muted">${x.j - x.i}停留所先・降りて徒歩${Math.round(x.w2)}m</span></div>
      </div>`;
    }).join('');
    $('#list').querySelectorAll('.card').forEach((el) => el.onclick = () => showRoute(arr[+el.dataset.k], el));
  }
  function showRoute(x, el) {
    document.querySelectorAll('.card.sel').forEach((c) => c.classList.remove('sel')); el.classList.add('sel');
    routeLayer.clearLayers();
    const seq = x.rt.s[x.rt.p].slice(x.i, x.j + 1).map((si) => [D.stops[si][1], D.stops[si][2]]);
    L.polyline(seq, { color: '#16a34a', weight: 5, opacity: 0.8 }).addTo(routeLayer);
    seq.forEach((p, n) => L.circleMarker(p, { radius: n === 0 || n === seq.length - 1 ? 7 : 3, color: '#16a34a', fillOpacity: 1 }).addTo(routeLayer));
    map.fitBounds(seq, { padding: [30, 30] });
    document.body.classList.remove('listFull');
  }

  // ---------- settings / controls ----------
  $('#gpsBtn').onclick = () => { setMode('dest'); startGPS(); };
  $('#pickOrigin').onclick = () => { setMode(state.mode === 'origin' ? 'dest' : 'origin'); if (state.mode === 'origin') toast('地図をタップして出発地を指定してください'); };
  $('#r1').value = state.r1; $('#r2').value = state.r2;
  const showR = () => { $('#r1v').textContent = state.r1 + 'm'; $('#r2v').textContent = state.r2 + 'm'; };
  showR();
  $('#r1').oninput = (e) => { state.r1 = +e.target.value; LS.set('r1', state.r1); showR(); };
  $('#r2').oninput = (e) => { state.r2 = +e.target.value; LS.set('r2', state.r2); showR(); };
  $('#r1').onchange = $('#r2').onchange = () => { drawPoints(); run(); };
  $('#setBtn').onclick = () => $('#settings').classList.toggle('open');
  $('#expand').onclick = () => document.body.classList.toggle('listFull');
  $('#refresh').onclick = () => { etaCache.clear(); if (state.results.length) refreshEta(runId); else run(); };
  setInterval(() => { if (state.results.length && !document.hidden) { etaCache.clear(); refreshEta(runId); } }, 30000);
  setInterval(() => { if (state.results.length) renderList(); }, 15000);

  if (state.dest) $('#destInput').value = state.dest.name;
  renderRecent(); drawPoints(); setMode('dest');
  startGPS();
  run();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
