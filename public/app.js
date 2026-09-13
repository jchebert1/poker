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
  function renderThemeMenu() {
    if (!state) return;
    const list = $('#theme-list'); list.innerHTML = '';
    const seated = state.me && state.me.seat !== undefined && state.me.seat !== null;
    for (const t of state.themes) {
      const m = THEME_META[t] || { label: t, icon: '🎨', swatch: '#888' };
      const d = document.createElement('div');
      d.className = 'theme-opt' + (state.theme === t ? ' current' : '') + (state.me && state.me.pendingTheme === t ? ' queued' : '');
      d.innerHTML = `<span class="swatch" style="background:${m.swatch}"></span><span>${m.icon} ${m.label}</span>`;
      d.onclick = async () => {
        if (state.phase === 'lobby' && state.isAdmin) { await act({ type: 'settings', settings: { theme: t } }); }
        else if (!seated) { toast('Sit down at the table to pick a theme'); return; }
        else { const r = await act({ type: 'theme', theme: t }); if (r && !r.applied) toast('Theme queued — switches on your turn', true); }
        $('#theme-menu').hidden = true;
      };
      list.appendChild(d);
    }
    $('#theme-note').textContent = state.phase === 'lobby'
      ? (state.isAdmin ? 'In the lobby, your pick applies immediately as the starting theme.' : 'Your pick is queued and switches for everyone on your first turn.')
      : 'Your pick is queued and switches for everyone when it\'s your turn.';
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
  $('#btn-add-bot').onclick = () => act({ type: 'addBot', level: Number($('#bot-level').value) });
  $('#btn-add-bot-game').onclick = () => act({ type: 'addBot', level: Number($('#bot-level-game').value) });
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
    const rx = (mobile ? 42 : 46) * W / 100, ry = (mobile ? 47 : 48) * H / 100, E = 2 / 2.6; // superellipse: straighter sides so side seats don't stack
    const key = `${n}:${Math.round(W)}:${Math.round(H)}:${mobile}`;
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
    html.dataset.theme = s.theme;
    $('#table-name').textContent = s.settings.tableName;
    document.title = `${s.settings.tableName} · Poker`;
    const inLobby = s.phase === 'lobby';
    $('#lobby').hidden = !inLobby; $('#game').hidden = inLobby;
    $('#blinds-pill').hidden = inLobby;
    $('#blinds-pill').textContent = `Hand #${s.handNumber} · Blinds ${fmt(s.blinds.sb)}/${fmt(s.blinds.bb)}`;
    if (inLobby) renderLobby(); else renderGame();
    renderSide();
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
      if (s.isAdmin) {
        if (p.isBot) {
          const sel = document.createElement('select'); sel.className = 'small';
          for (let l = 1; l <= 5; l++) { const o = document.createElement('option'); o.value = l; o.textContent = 'L' + l; o.selected = l === p.botLevel; sel.appendChild(o); }
          sel.onchange = () => act({ type: 'botLevel', id: p.id, level: Number(sel.value) });
          li.appendChild(sel);
        }
        if (!p.isSelf) { const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = p.isBot ? 'Remove' : 'Kick'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k); }
      }
      ul.appendChild(li);
    }
    if (!players.length) ul.innerHTML = '<li class="muted">Nobody seated yet.</li>';
    const seated = !!s.me;
    $('#btn-sit').hidden = seated; $('#btn-stand').hidden = !seated;
    $('#btn-sit').disabled = players.length >= s.settings.maxPlayers;
    const withChips = players.filter(p => p.chips > 0 && !p.sittingOut).length;
    $('#btn-start').disabled = withChips < 2;
    $('#lobby-hint').textContent = s.isAdmin ? (withChips < 2 ? 'Need at least 2 players (or bots) to start.' : 'Ready when you are.') : 'Waiting for the admin to start the game.';
    // settings form
    const f = $('#settings-form');
    const sel = f.theme; if (!sel.options.length) for (const t of s.themes) { const o = document.createElement('option'); o.value = t; o.textContent = (THEME_META[t] || {}).label || t; sel.appendChild(o); }
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
      if (s.isAdmin && !p.isSelf) {
        if (p.isBot) { const sel = document.createElement('select'); sel.className = 'small'; for (let l = 1; l <= 5; l++) { const o = document.createElement('option'); o.value = l; o.textContent = 'L' + l; o.selected = l === p.botLevel; sel.appendChild(o); } sel.onchange = () => act({ type: 'botLevel', id: p.id, level: Number(sel.value) }); li.appendChild(sel); }
        const k = document.createElement('button'); k.className = 'btn small-btn'; k.textContent = p.isBot ? 'Remove' : 'Kick'; k.onclick = () => act({ type: 'kick', id: p.id }); li.appendChild(k);
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
    if (A && A.deadline) { const left = Math.max(0, A.deadline - now); $('#timer-fill').style.width = (left / (state.settings.actionTimeSec * 1000) * 100) + '%'; }
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
