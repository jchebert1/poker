/* Bear-Net Poker client. Vanilla JS, state pushed from the server over SSE. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const html = document.documentElement;

  let me = null;          // profile from /api/me
  let state = null;       // latest table state
  let es = null;
  let settingsDirty = false;
  let sideOpen = false;
  let clockOffset = 0;    // serverTime - Date.now()
  let lastHandResultKey = null;

  const THEME_META = {
    felt: { label: 'Classic felt', icon: '🃏', swatch: '#1f5a37' },
    nature: { label: 'Nature', icon: '🌲', swatch: '#35612a' },
    city: { label: 'City nights', icon: '🌆', swatch: '#1c1f50' },
    retro: { label: 'Retro lounge', icon: '📼', swatch: '#8a2f22' },
    space: { label: 'Deep space', icon: '🚀', swatch: '#101c44' },
    ocean: { label: 'Ocean', icon: '🌊', swatch: '#135f7b' },
  };
  const SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

  // ---------- helpers
  function toast(msg, ok = false) {
    const t = $('#toast'); t.textContent = msg; t.className = ok ? 'ok' : ''; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, 2600);
  }
  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status === 401) { onUnauthed(await r.json().catch(() => ({}))); throw new Error('unauthenticated'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function act(body) {
    try { return await api('/api/action', body); } catch (e) { if (e.message !== 'unauthenticated') toast(e.message); return null; }
  }
  function onUnauthed(j) {
    if (j && j.devMode) { location.href = '/dev/login'; return; }
    $('#login-gate').hidden = false;
    $('#login-msg').textContent = 'Your Cloudflare Access session was not found. Reloading…';
    setTimeout(() => location.reload(), 1500);
  }
  function fmt(n) { return Number(n).toLocaleString(); }
  function avatarHtml(a) { return a && a.startsWith('data:') ? `<img src="${a}" alt="">` : escapeHtml(a || '🙂'); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
  function cardHtml(c, cls = '') {
    if (!c) return '';
    if (c === 'XX') return `<div class="card back ${cls}"></div>`;
    const r = c[0] === 'T' ? '10' : c[0], s = c[1];
    const red = s === 'h' || s === 'd';
    return `<div class="card ${red ? 'red' : ''} ${cls}"><span class="r">${r}</span><span class="s">${SUIT_SYM[s]}</span></div>`;
  }

  // ---------- mode / theme
  function applyMode(mode) { html.dataset.mode = mode; $('#btn-mode').textContent = mode === 'dark' ? '🌙' : '☀️'; try { localStorage.setItem('mode', mode); } catch {} }
  $('#btn-mode').onclick = () => {
    const m = html.dataset.mode === 'dark' ? 'light' : 'dark';
    applyMode(m);
    api('/api/profile', { settings: { mode: m } }).catch(() => {});
  };
  $('#btn-theme').onclick = (e) => { e.stopPropagation(); const m = $('#theme-menu'); m.hidden = !m.hidden; renderThemeMenu(); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#theme-menu') && !e.target.closest('#btn-theme')) $('#theme-menu').hidden = true; });
  async function pickTheme(t) {
    if (state.phase === 'lobby' && state.isAdmin) { await act({ type: 'settings', settings: { theme: t } }); }
    else if (!(state.me && state.me.seat !== undefined && state.me.seat !== null)) { toast('Sit down at the table to pick a theme'); return; }
    else { const r = await act({ type: 'theme', theme: t }); if (r && !r.applied) toast('Theme queued — switches on your turn', true); }
    $('#theme-menu').hidden = true;
  }
  function renderThemeMenu() {
    if (!state) return;
    const list = $('#theme-list'); list.innerHTML = '';
    const mark = (t) => (state.theme === t ? ' current' : '') + (state.me && state.me.pendingTheme === t ? ' queued' : '');
    for (const t of state.themes) {
      const m = THEME_META[t] || { label: t, icon: '🎨', swatch: '#888' };
      const d = document.createElement('div');
      d.className = 'theme-opt' + mark(t);
      d.innerHTML = `<span class="swatch" style="background:${m.swatch}"></span><span>${m.icon} ${m.label}</span>`;
      d.onclick = () => pickTheme(t);
      list.appendChild(d);
    }
    const cl = $('#custom-theme-list'); cl.innerHTML = '';
    for (const c of state.customThemes || []) {
      const t = 'custom:' + c.id;
      const d = document.createElement('div');
      d.className = 'theme-opt custom' + mark(t);
      d.innerHTML = `<div class="thumb" style="background-image:url('/api/theme-image/${c.id}')"></div><div class="tname" title="by ${escapeHtml(c.ownerName)}">${escapeHtml(c.name)} <span class="muted">· ${escapeHtml(c.ownerName)}</span></div>`;
      d.onclick = () => pickTheme(t);
      if (state.isAdmin) {
        const del = document.createElement('button'); del.className = 'tdel'; del.textContent = '✕'; del.title = 'Delete theme (admin)';
        del.onclick = (e) => { e.stopPropagation(); if (confirm(`Delete theme "${c.name}" for everyone?`)) act({ type: 'deleteTheme', id: t }); };
        d.appendChild(del);
      }
      cl.appendChild(d);
    }
    if (!(state.customThemes || []).length) cl.innerHTML = '<div class="muted small" style="grid-column:1/-1">None yet — upload a picture below.</div>';
    $('#theme-note').textContent = state.phase === 'lobby'
      ? (state.isAdmin ? 'In the lobby, your pick applies immediately as the starting theme.' : 'Your pick is queued and switches for everyone on your first turn.')
      : 'Your pick is queued and switches for everyone when it\'s your turn.';
  }
  $('#theme-file').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const name = prompt('Name this theme (what everyone will see):', file.name.replace(/\.[^.]+$/, '').slice(0, 24));
    if (name === null) { e.target.value = ''; return; }
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = async () => {
      const MAX = 1920, scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      let q = 0.82, data = c.toDataURL('image/jpeg', q);
      while (data.length > 1.4 * 1024 * 1024 && q > 0.4) { q -= 0.1; data = c.toDataURL('image/jpeg', q); }
      URL.revokeObjectURL(url); e.target.value = '';
      const r = await act({ type: 'addTheme', name, image: data });
      if (r) { toast(`Theme "${name}" added`, true); renderThemeMenu(); }
    };
    img.onerror = () => { toast('Could not read that image'); e.target.value = ''; };
    img.src = url;
  };
  function applyTheme(t) {
    if (t && t.startsWith('custom:')) {
      html.dataset.theme = 'felt';
      html.dataset.customBg = '1';
      html.style.setProperty('--custom-bg', `url('/api/theme-image/${t.slice(7)}')`);
    } else {
      html.dataset.theme = t;
      delete html.dataset.customBg;
      html.style.removeProperty('--custom-bg');
    }
  }


  // ---------- sound effects (synthesized with Web Audio; nothing to download)
  const sfx = (() => {
    let ctx = null, enabled = true, master = null;
    try { enabled = localStorage.getItem('sound') !== 'off'; } catch {}
    const ensure = () => {
      if (!ctx) { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null; ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.45; master.connect(ctx.destination); }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    };
    const unlock = () => { ensure(); };
    ['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, unlock, { once: false, passive: true }));
    let noiseBuf = null;
    const noise = () => { if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; } const s = ctx.createBufferSource(); s.buffer = noiseBuf; return s; };
    const env = (node, t0, a, d, peak = 1) => { const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); node.connect(g); g.connect(master); return g; };
    const tone = (freq, t0, a, d, type = 'sine', peak = 0.6, slideTo = null) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t0); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + a + d); env(o, t0, a, d, peak); o.start(t0); o.stop(t0 + a + d + 0.05); };
    const burst = (t0, a, d, filterFreq, q = 1, peak = 0.8, type = 'bandpass') => { const n = noise(); const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = filterFreq; f.Q.value = q; n.connect(f); env(f, t0, a, d, peak); n.start(t0); n.stop(t0 + a + d + 0.05); };
    const play = (fn) => { if (!enabled) return; const c = ensure(); if (!c || c.state !== 'running') return; try { fn(c.currentTime + 0.01); } catch (e) { /* ignore */ } };
    const chip = (t, n = 3, gap = 0.045) => { for (let i = 0; i < n; i++) { const tt = t + i * gap + Math.random() * 0.01; burst(tt, 0.003, 0.05, 3800 + Math.random() * 1500, 6, 1.0); tone(2400 + Math.random() * 900, tt, 0.002, 0.04, 'triangle', 0.25); } };
    const cardFlip = (t) => { burst(t, 0.004, 0.06, 1800, 1.2, 0.5, 'highpass'); tone(900, t, 0.003, 0.03, 'triangle', 0.08, 500); };
    return {
      get enabled() { return enabled; },
      toggle() { enabled = !enabled; try { localStorage.setItem('sound', enabled ? 'on' : 'off'); } catch {} if (enabled) this.check(); return enabled; },
      shuffle() { play(t => { for (let i = 0; i < 22; i++) { const tt = t + i * 0.028 + Math.random() * 0.006; burst(tt, 0.002, 0.03, 2500 + Math.random() * 2500, 2, 0.35 + Math.random() * 0.2, 'highpass'); } for (let i = 0; i < 3; i++) cardFlip(t + 0.75 + i * 0.12); }); },
      deal(n = 1) { play(t => { for (let i = 0; i < n; i++) cardFlip(t + i * 0.11); }); },
      bet() { play(t => chip(t, 3)); },
      call() { play(t => chip(t, 2)); },
      raise() { play(t => chip(t, 5, 0.04)); },
      allin() { play(t => { chip(t, 10, 0.035); tone(220, t, 0.02, 0.5, 'sawtooth', 0.12, 110); }); },
      check() { play(t => { burst(t, 0.002, 0.05, 700, 1.5, 1.0, 'lowpass'); burst(t + 0.11, 0.002, 0.05, 650, 1.5, 0.9, 'lowpass'); }); },
      fold() { play(t => burst(t, 0.02, 0.16, 1200, 0.8, 0.7, 'bandpass')); },
      turn() { play(t => { tone(880, t, 0.01, 0.18, 'sine', 0.5); tone(1320, t + 0.12, 0.01, 0.25, 'sine', 0.4); }); },
      win() { play(t => { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.09, 0.01, 0.35, 'triangle', 0.45)); chip(t + 0.3, 8, 0.05); }); },
      lose() { play(t => { tone(440, t, 0.01, 0.25, 'sine', 0.25, 392); }); },
      chat() { play(t => tone(1500, t, 0.005, 0.08, 'sine', 0.25, 1900)); },
      tick() { play(t => burst(t, 0.002, 0.03, 2000, 3, 0.3, 'bandpass')); },
      bust() { play(t => { tone(300, t, 0.02, 0.5, 'sawtooth', 0.2, 80); }); },
    };
  })();
  $('#btn-sound').textContent = sfx.enabled ? '🔊' : '🔇';
  $('#btn-sound').onclick = () => { const on = sfx.toggle(); $('#btn-sound').textContent = on ? '🔊' : '🔇'; toast(on ? 'Sound on' : 'Sound off', true); };

  // fire sounds by diffing consecutive states
  let prevSnap = null, lastTickSec = null;
  function soundDiff(s) {
    const snap = {
      hand: s.hand ? s.hand.number : 0, street: s.hand ? s.hand.street : '', comm: s.hand ? s.hand.community.length : 0,
      results: !!(s.hand && s.hand.results), myTurn: !!(s.me && s.me.actions), chat: s.chat.length, busted: !!(s.me && s.me.busted),
      acts: s.seats.map(p => p ? p.lastAction : null), bets: s.seats.map(p => p ? p.bet : 0),
    };
    const p = prevSnap; prevSnap = snap;
    if (!p) return;
    if (snap.hand !== p.hand && snap.hand > 0) { sfx.shuffle(); return; }
    if (snap.comm > p.comm) sfx.deal(snap.comm - p.comm);
    if (snap.results && !p.results && s.hand.results) { const me = s.me && s.me.id; const iWon = s.hand.results.winners.some(w => w.id === me); if (iWon) sfx.win(); else if (s.hand.results.showdown) sfx.lose(); else sfx.call(); }
    for (let i = 0; i < snap.acts.length; i++) {
      const a = snap.acts[i]; if (!a || a === p.acts[i]) continue;
      if (/^All-in/.test(a)) sfx.allin();
      else if (/^Raise/.test(a)) sfx.raise();
      else if (/^Bet/.test(a)) sfx.bet();
      else if (/^Call/.test(a)) sfx.call();
      else if (a === 'Check') sfx.check();
      else if (a === 'Fold') sfx.fold();
    }
    if (snap.myTurn && !p.myTurn) sfx.turn();
    if (snap.chat > p.chat && s.chat.length) { const last = s.chat[s.chat.length - 1]; if (!me || last.from.name !== me.name) sfx.chat(); }
    if (snap.busted && !p.busted) sfx.bust();
  }

  // ---------- profile
  let pendingAvatar = null;
  $('#btn-profile').onclick = () => openProfile();
  function openProfile() {
    const f = $('#profile-form');
    f.name.value = me.name; pendingAvatar = me.avatar;
    $('#profile-email').textContent = me.email;
    $('#avatar-preview').innerHTML = avatarHtml(me.avatar);
    const g = $('#avatar-grid'); g.innerHTML = '';
    for (const a of me.avatars) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = a; b.className = a === me.avatar ? 'sel' : '';
      b.onclick = () => { pendingAvatar = a; $$('#avatar-grid button').forEach(x => x.classList.toggle('sel', x === b)); $('#avatar-preview').innerHTML = avatarHtml(a); };
      g.appendChild(b);
    }
    $('#avatar-file').value = '';
    $('#profile-dialog').showModal();
  }
  $('#profile-cancel').onclick = () => $('#profile-dialog').close();
  $('#avatar-file').onchange = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const S = 96, c = document.createElement('canvas'); c.width = S; c.height = S;
      const ctx = c.getContext('2d');
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
      pendingAvatar = c.toDataURL('image/jpeg', 0.85);
      $('#avatar-preview').innerHTML = avatarHtml(pendingAvatar);
      $$('#avatar-grid button').forEach(x => x.classList.remove('sel'));
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };
  $('#profile-form').addEventListener('submit', async (e) => {
    if (e.submitter && e.submitter.value !== 'save') return;
    e.preventDefault();
    try {
      me = { ...me, ...(await api('/api/profile', { name: $('#profile-form').name.value, avatar: pendingAvatar })) };
      $('#me-avatar').innerHTML = avatarHtml(me.avatar);
      $('#profile-dialog').close(); toast('Profile saved', true);
    } catch (err) { toast(err.message); }
  });

  // ---------- lobby wiring
  $('#btn-sit').onclick = () => act({ type: 'sit' });
  $('#btn-stand').onclick = () => act({ type: 'leave' });
  const openBotDialog = () => $('#bot-dialog').showModal();
  $('#btn-add-bot').onclick = openBotDialog;
  $('#btn-add-bot-game').onclick = openBotDialog;
  $('#bot-cancel').onclick = () => $('#bot-dialog').close();
  $$('#bot-dialog [data-level]').forEach(b => b.onclick = async () => { $('#bot-dialog').close(); const r = await act({ type: 'addBot', level: Number(b.dataset.level) }); if (r) toast(`Added ${r.player ? r.player.name : 'a bot'}`, true); });
  $('#btn-start').onclick = () => act({ type: 'start' });
  $('#btn-clear-summary').onclick = () => act({ type: 'clearSummary' });
  $('#settings-form').addEventListener('input', () => { settingsDirty = true; $('#settings-status').textContent = 'unsaved changes'; });
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target); const s = {};
    for (const [k, v] of fd.entries()) s[k] = v;
    s.allowRebuy = e.target.allowRebuy.checked; s.botsAutoRebuy = e.target.botsAutoRebuy.checked;
    const r = await act({ type: 'settings', settings: s });
    if (r) { settingsDirty = false; $('#settings-status').textContent = 'saved'; toast('Settings saved', true); }
  });

  // ---------- game wiring
  $('#btn-join-game').onclick = () => act({ type: 'sit' });
  $('#btn-stand-game').onclick = () => { if (confirm('Leave the table?')) act({ type: 'leave' }); };
  $('#btn-leave-game').onclick = () => act({ type: 'leave' });
  $('#btn-sitout').onclick = () => act({ type: 'sitout', out: !(state.me && state.me.sittingOut) });
  $('#btn-rebuy').onclick = () => act({ type: 'rebuy' });
  $('#btn-pause').onclick = () => act({ type: 'pause', pause: !state.pauseRequested });
  $('#btn-end').onclick = () => { if (confirm('End the game now? Current hand bets are returned and everyone goes back to the lobby.')) act({ type: 'end' }); };
  $$('#action-bar [data-act]').forEach(b => b.onclick = () => {
    const a = b.dataset.act;
    const body = { type: 'act', action: a };
    if (a === 'raise') body.amount = Number($('#raise-amount').value);
    act(body);
  });
  $$('#action-bar [data-preset]').forEach(b => b.onclick = () => {
    const A = state.me.actions; if (!A) return;
    const potAfterCall = A.pot + A.toCall;
    const cur = A.maxRaiseTo - (state.seats[state.me.seat].chips); // my current bet
    const map = { min: A.minRaiseTo, half: cur + A.toCall + Math.round(potAfterCall / 2), pot: cur + A.toCall + potAfterCall, max: A.maxRaiseTo };
    setRaise(map[b.dataset.preset]);
  });
  $('#raise-slider').oninput = (e) => $('#raise-amount').value = e.target.value;
  $('#raise-amount').oninput = (e) => $('#raise-slider').value = e.target.value;
  function setRaise(v) { const A = state.me.actions; v = Math.max(A.minRaiseTo, Math.min(A.maxRaiseTo, Math.round(v))); $('#raise-amount').value = v; $('#raise-slider').value = v; }

  // side panel
  $('#btn-side').onclick = () => { sideOpen = !sideOpen; $('#side').hidden = !sideOpen; };
  $('#btn-side-close').onclick = () => { sideOpen = false; $('#side').hidden = true; };
  $$('.side-tabs [data-tab]').forEach(b => b.onclick = () => {
    $$('.side-tabs [data-tab]').forEach(x => x.classList.toggle('active', x === b));
    for (const t of ['log', 'chat', 'players']) $(`#side-${t}`).hidden = b.dataset.tab !== t;
    $('#chat-form').hidden = b.dataset.tab !== 'chat';
  });
  $('#chat-form').addEventListener('submit', async (e) => { e.preventDefault(); const v = $('#chat-input').value.trim(); if (!v) return; $('#chat-input').value = ''; await act({ type: 'chat', text: v }); });

  // ---------- seat geometry
  // seats spaced equally by arc length around the ellipse, starting bottom-center, clockwise
  const arcCache = {};
  function seatPos(displayIdx, n) {
    const mobile = window.innerWidth <= 860;
    const rect = $('#table').getBoundingClientRect();
    const W = rect.width || 1000, H = rect.height || 600;
    // keep every seat box fully inside the #table box: radius = half-size minus half a seat box
    const probe = $('#seats .seat:not([hidden]) .seat-box');
    const seatW = probe ? probe.parentElement.offsetWidth : (mobile ? 92 : 136), seatH = probe ? probe.parentElement.offsetHeight + 24 : (mobile ? 118 : 165);
    const rx = W / 2 - seatW / 2 - 2, ry = H / 2 - seatH / 2 - 2, E = 2 / 2.6; // superellipse: straighter sides so side seats don't stack
    const key = `${n}:${Math.round(W)}:${Math.round(H)}:${seatW}:${seatH}`;
    if (!arcCache[key]) {
      const N = 1440, pts = [], len = [0];
      for (let i = 0; i <= N; i++) {
        const a = Math.PI / 2 + (i / N) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
        pts.push([rx * Math.sign(c) * Math.pow(Math.abs(c), E), ry * Math.sign(sn) * Math.pow(Math.abs(sn), E)]);
        if (i) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      }
      const total = len[N], out = [];
      for (let k = 0; k < n; k++) { const target = (k / n) * total; let i = 0; while (len[i] < target) i++; out.push({ left: 50 + pts[i][0] / W * 100, top: 50 + pts[i][1] / H * 100 }); }
      arcCache[key] = out;
    }
    return arcCache[key][displayIdx];
  }

  // ---------- render
  function render() {
    if (!state) return;
    const s = state;
    clockOffset = s.serverTime - Date.now();
    document.body.classList.toggle('is-admin', !!s.isAdmin);
    applyTheme(s.theme);
    $('#table-name').textContent = s.settings.tableName;
    document.title = `${s.settings.tableName} · Poker`;
    const inLobby = s.phase === 'lobby';
    $('#lobby').hidden = !inLobby; $('#game').hidden = inLobby;
    $('#blinds-pill').hidden = inLobby;
    $('#blinds-pill').textContent = `Hand #${s.handNumber} · Blinds ${fmt(s.blinds.sb)}/${fmt(s.blinds.bb)}`;
    if (inLobby) renderLobby(); else renderGame();
    renderSide();
    soundDiff(s);
    if (!$('#theme-menu').hidden) renderThemeMenu();
  }

  function renderLobby() {
    const s = state;
    const players = s.seats.filter(Boolean);
    $('#player-count').textContent = `${players.length}/${s.settings.maxPlayers}`;
    const ul = $('#player-list'); ul.innerHTML = '';
    for (const p of players) {
      const li = document.createElement('li'); if (p.isSelf) li.classList.add('me');
      li.innerHTML = `<div class="pl-avatar">${avatarHtml(p.avatar)}</div><div><div class="pl-name">${escapeHtml(p.name)}</div><div class="pl-tags">${p.isBot ? `<span class="tag bot">BOT · L${p.botLevel}</span>` : ''}${!p.connected && !p.isBot ? '<span class="tag off">offline</span>' : ''}<span class="tag">seat ${p.seat + 1}</span><span class="tag">${fmt(p.chips)} chips</span></div></div><span class="spacer"></span>`;
      if (p.isBot) {
        const sel = document.createElement('select'); sel.className = 'small';
        for (let l = 1; l <= 5; l++) { const o = document.createElement('option'); o.value = l; o.textContent = 'L' + l; o.selected = l === p.botLevel; sel.appendChild(o); }
        sel.onchange = () => act({ type: 'botLevel', id: p.id, level: Number(sel.value) });
        li.appendChild(sel);
        const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = 'Remove'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k);
      } else if (s.isAdmin && !p.isSelf) { const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = 'Kick'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k); }
      ul.appendChild(li);
    }
    if (!players.length) ul.innerHTML = '<li class="muted">Nobody seated yet.</li>';
    const seated = !!s.me;
    $('#btn-sit').hidden = seated; $('#btn-stand').hidden = !seated;
    $('#btn-sit').disabled = players.length >= s.settings.maxPlayers;
    const withChips = players.filter(p => p.chips > 0 && !p.sittingOut).length;
    $('#btn-start').disabled = withChips < 2;
    $('#lobby-hint').textContent = s.isAdmin ? (withChips < 2 ? 'Need at least 2 players (or bots) to start.' : 'Ready when you are.') : 'Anyone can add or remove bots. Waiting for the admin to start the game.';
    // settings form
    const f = $('#settings-form');
    const sel = f.theme; const wanted = s.themes.length + (s.customThemes || []).length;
    if (sel.options.length !== wanted) {
      const cur = sel.value; sel.innerHTML = '';
      for (const t of s.themes) { const o = document.createElement('option'); o.value = t; o.textContent = (THEME_META[t] || {}).label || t; sel.appendChild(o); }
      for (const c of s.customThemes || []) { const o = document.createElement('option'); o.value = 'custom:' + c.id; o.textContent = `📷 ${c.name}`; sel.appendChild(o); }
      if (cur) sel.value = cur;
    }
    if (!settingsDirty) {
      for (const k of Object.keys(s.settings)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!s.settings[k]; else el.value = s.settings[k]; }
    }
    // summary
    $('#summary-panel').hidden = !s.summary;
    if (s.summary) {
      const rows = s.summary.players.map((p, i) => `<tr><td>${i + 1}</td><td>${avatarHtml(p.avatar)} ${escapeHtml(p.name)}${p.isBot ? ' <span class="tag bot">BOT</span>' : ''}</td><td>${fmt(p.chips)}</td><td>${p.buyIns}</td><td class="${p.net >= 0 ? 'pos' : 'neg'}">${p.net >= 0 ? '+' : ''}${fmt(p.net)}</td></tr>`).join('');
      $('#summary-body').innerHTML = `<p class="muted small">${s.summary.hands} hands · ${s.summary.durationMin} min</p><table class="summary-table"><tr><th>#</th><th>Player</th><th>Chips</th><th>Buy-ins</th><th>Net</th></tr>${rows}</table>`;
    }
  }

  function renderGame() {
    const s = state, h = s.hand;
    const n = Math.max(2, Math.min(s.maxSeats, s.settings.maxPlayers));
    const anchor = s.me ? s.me.seat : 0;
    const seatsEl = $('#seats');
    // build/update seat elements
    for (let i = 0; i < s.maxSeats; i++) {
      let el = seatsEl.children[i];
      if (!el) { el = document.createElement('div'); el.className = 'seat'; el.dataset.seat = i; seatsEl.appendChild(el); }
      const p = s.seats[i];
      if (i >= n && !p) { el.hidden = true; continue; }
      el.hidden = false;
      const disp = ((i - anchor) % n + n) % n;
      const pos = seatPos(disp, n);
      el.style.left = pos.left + '%'; el.style.top = pos.top + '%';
      renderSeat(el, p, i);
    }
    // board
    const commHtml = h ? h.community.map(c => cardHtml(c)).join('') : '';
    if ($('#community')._html !== commHtml) { $('#community')._html = commHtml; $('#community').innerHTML = commHtml; }
    const potTotal = h ? h.pot + h.potOnTable : 0;
    $('#pot').textContent = h ? `Pot ${fmt(potTotal)}` : (s.pauseRequested ? 'Paused' : 'Waiting for next hand…');
    $('#street-label').textContent = h ? (h.results ? 'Showdown' : h.street[0].toUpperCase() + h.street.slice(1)) : '';
    $('#paused-banner').hidden = !(s.pauseRequested && !h);
    // result banner
    const rb = $('#result-banner');
    if (h && h.results) {
      const key = h.number;
      rb.hidden = false;
      rb.innerHTML = h.results.winners.map(w => `🏆 ${escapeHtml(w.name)} wins ${fmt(w.amount)}${w.hand ? ' with ' + escapeHtml(w.hand) : ''}`).join(' · ');
      lastHandResultKey = key;
    } else rb.hidden = true;
    // my controls
    const meSeat = s.me ? s.seats[s.me.seat] : null;
    $('#btn-join-game').hidden = !!s.me;
    $('#btn-join-game').disabled = s.seats.filter(Boolean).length >= s.settings.maxPlayers;
    $('#btn-stand-game').hidden = !s.me;
    $('#btn-sitout').hidden = !s.me;
    $('#btn-sitout').textContent = s.me && s.me.sittingOut ? '▶ I\'m back' : 'Sit out';
    $('#btn-pause').textContent = s.pauseRequested ? '▶ Resume' : '⏸ Pause';
    const busted = s.me && s.me.busted && meSeat && meSeat.chips === 0;
    $('#rebuy-bar').hidden = !busted;
    if (busted) { $('#rebuy-amt').textContent = fmt(s.settings.startingStack); $('#btn-rebuy').hidden = !s.settings.allowRebuy; }
    // my hand strength
    const mh = $('#my-hand');
    if (meSeat && meSeat.inHand && !meSeat.folded && meSeat.handDesc) { mh.hidden = false; mh.innerHTML = `<span>Your hand:</span>${escapeHtml(meSeat.handDesc)}`; }
    else mh.hidden = true;
    // action bar
    const A = s.me && s.me.actions;
    const ab = $('#action-bar');
    if (A) {
      const wasHidden = ab.hidden;
      ab.hidden = false;
      $('[data-act=check]', ab).hidden = !A.canCheck;
      $('[data-act=call]', ab).hidden = A.canCheck;
      $('[data-act=call]', ab).textContent = `Call ${fmt(A.toCall)}`;
      const canRaise = A.maxRaiseTo > A.minRaiseTo || (A.maxRaiseTo > A.toCall + (meSeat ? meSeat.bet : 0));
      $('[data-act=raise]', ab).hidden = A.minRaiseTo >= A.maxRaiseTo;
      $('[data-act=raise]', ab).textContent = (A.toCall === 0 ? 'Bet ' : 'Raise to ') + fmt($('#raise-amount').value || A.minRaiseTo);
      $('[data-act=allin]', ab).textContent = `All-in ${fmt(A.maxRaiseTo)}`;
      const sl = $('#raise-slider'), ra = $('#raise-amount');
      sl.min = A.minRaiseTo; sl.max = A.maxRaiseTo; ra.min = A.minRaiseTo; ra.max = A.maxRaiseTo;
      if (wasHidden || Number(ra.value) < A.minRaiseTo || Number(ra.value) > A.maxRaiseTo) setRaise(A.minRaiseTo);
      $('[data-act=raise]', ab).textContent = (A.toCall === 0 ? 'Bet ' : 'Raise to ') + fmt(ra.value);
      if (wasHidden && navigator.vibrate) navigator.vibrate(60);
    } else ab.hidden = true;
  }

  function renderSeat(el, p, seatIdx) {
    const s = state, h = s.hand;
    if (!p) {
      el.className = 'seat empty';
      const e = `<div class="seat-box">Seat ${seatIdx + 1}<br><span class="small">empty</span></div>`;
      if (el._html !== e) { el._html = e; el.innerHTML = e; }
      el.onclick = () => { if (!s.me) act({ type: 'sit', seat: seatIdx }); };
      return;
    }
    el.onclick = null;
    const active = h && h.toActSeat === seatIdx && !h.results;
    const winner = h && h.results && h.results.winners.some(w => w.id === p.id);
    el.className = 'seat' + (active ? ' active' : '') + (p.folded ? ' folded' : '') + (winner ? ' winner' : '') + ((!p.inHand && h) || p.sittingOut || p.busted ? ' out' : '');
    const cards = p.inHand ? p.cards.map(c => cardHtml(c, 'sm' + (p.bestCards && !p.bestCards.includes(c) ? ' dim' : '') + (p.folded ? ' dim' : ''))).join('') : '';
    const actionTxt = p.busted && !p.inHand ? 'Busted' : p.sittingOut ? 'Sitting out' : (p.lastAction || '');
    const timer = active && !p.isBot && h.actionDeadline ? `<div class="timer"><i data-deadline="${h.actionDeadline}" data-total="${h.actionTimeSec * 1000}"></i></div>` : '';
    const htmlStr = `
      <div class="seat-box">
        ${h && h.dealerSeat === seatIdx ? '<div class="dealer">D</div>' : ''}
        ${p.buyIns > 1 ? `<div class="buyins" title="${p.buyIns} buy-ins">×${p.buyIns}</div>` : ''}
        ${actionTxt ? `<div class="action ${p.allIn ? 'allin' : ''}">${escapeHtml(actionTxt)}</div>` : ''}
        <div class="avatar">${avatarHtml(p.avatar)}</div>
        <div class="name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</div>
        ${p.isBot ? `<div class="lvl">bot · L${p.botLevel}</div>` : ''}
        <div class="chips">${fmt(p.chips)}</div>
        <div class="hole">${cards}</div>
        ${p.handDesc ? `<div class="handdesc">${escapeHtml(p.handDesc)}</div>` : ''}
        ${timer}
        ${p.pendingTheme ? '<div class="pending-theme" title="theme change queued">🎨</div>' : ''}
        ${!p.connected && !p.isBot ? '<div class="offline" title="disconnected">📵</div>' : ''}
      </div>
      ${p.bet > 0 ? `<div class="bet">${fmt(p.bet)}</div>` : ''}`;
    if (el._html !== htmlStr) { el._html = htmlStr; el.innerHTML = htmlStr; }
  }

  function renderSide() {
    const s = state;
    const log = $('#side-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.innerHTML = s.log.map(l => `<div class="log-line ${l.kind}">${escapeHtml(l.text)}</div>`).join('');
    if (atBottom) log.scrollTop = log.scrollHeight;
    const chat = $('#side-chat');
    const cb = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.innerHTML = s.chat.map(c => `<div class="chat-line">${avatarHtml(c.from.avatar)} <b>${escapeHtml(c.from.name)}</b>: ${escapeHtml(c.text)}</div>`).join('') || '<div class="muted">No messages yet.</div>';
    if (cb) chat.scrollTop = chat.scrollHeight;
    const pl = $('#side-players'); pl.innerHTML = '';
    for (const p of s.seats.filter(Boolean)) {
      const li = document.createElement('div'); li.className = 'row gap';
      li.innerHTML = `<div class="pl-avatar">${avatarHtml(p.avatar)}</div><div><div class="pl-name">${escapeHtml(p.name)}</div><div class="pl-tags">${p.isBot ? `<span class="tag bot">L${p.botLevel}</span>` : ''}<span class="tag">${fmt(p.chips)}</span><span class="tag">×${p.buyIns}</span></div></div><span class="spacer"></span>`;
      if (p.isBot) {
        const sel = document.createElement('select'); sel.className = 'small'; for (let l = 1; l <= 5; l++) { const o = document.createElement('option'); o.value = l; o.textContent = 'L' + l; o.selected = l === p.botLevel; sel.appendChild(o); } sel.onchange = () => act({ type: 'botLevel', id: p.id, level: Number(sel.value) }); li.appendChild(sel);
        const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = 'Remove'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k);
      } else if (s.isAdmin && !p.isSelf) {
        const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = 'Kick'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k);
      }
      pl.appendChild(li);
    }
  }

  // ---------- connect
  function connect() {
    if (es) es.close();
    es = new EventSource('/api/events');
    es.addEventListener('state', (e) => { state = JSON.parse(e.data); render(); });
    es.onerror = () => { /* EventSource auto-reconnects; check auth occasionally */ setTimeout(() => api('/api/me').catch(() => {}), 3000); };
  }
  // timers tick locally between server updates
  setInterval(() => {
    if (!state || !state.hand) return;
    const now = Date.now() + clockOffset;
    for (const i of $$('.seat .timer i')) { const left = Math.max(0, Number(i.dataset.deadline) - now); i.style.width = (left / Number(i.dataset.total) * 100) + '%'; }
    const A = state.me && state.me.actions;
    if (A && A.deadline) { const left = Math.max(0, A.deadline - now); $('#timer-fill').style.width = (left / (state.settings.actionTimeSec * 1000) * 100) + '%'; const sec = Math.ceil(left / 1000); if (sec <= 5 && sec > 0 && sec !== lastTickSec) { lastTickSec = sec; sfx.tick(); } } else lastTickSec = null;
  }, 500);
  window.addEventListener('resize', () => { if (state && state.phase !== 'lobby') renderGame(); });

  async function boot() {
    try { applyMode(localStorage.getItem('mode') || 'dark'); } catch {}
    try {
      me = await api('/api/me');
    } catch (e) { return; }
    $('#me-avatar').innerHTML = avatarHtml(me.avatar);
    if (me.settings && me.settings.mode) applyMode(me.settings.mode);
    $('#login-gate').hidden = true;
    connect();
  }
  boot();
})();
