'use strict';
const EventEmitter = require('node:events');
const { newDeck, evalBest, describe, cardStr, rankOf, suitOf } = require('./cards');
const bots = require('./bots');

const MAX_SEATS = 10;

const DEFAULT_SETTINGS = {
  tableName: 'Bear-Net Poker Night',
  startingStack: 1000,
  smallBlind: 5,
  bigBlind: 10,
  actionTimeSec: 30,
  maxPlayers: 10,
  allowRebuy: true,
  botsAutoRebuy: true,
  blindsIncreaseEveryMin: 0, // 0 = never
  blindsIncreaseFactor: 2,
  showdownPauseSec: 6,
  theme: 'felt',
};

const THEMES = ['felt', 'nature', 'city', 'retro', 'space', 'ocean'];

let botCounter = 0;

class Table extends EventEmitter {
  constructor(settings = {}) {
    super();
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.theme = this.settings.theme;
    this.phase = 'lobby'; // lobby | playing | paused(=playing with pauseRequested) | ended
    this.pauseRequested = false;
    this.seats = new Array(MAX_SEATS).fill(null);
    this.hand = null;
    this.handNumber = 0;
    this.log = [];
    this.chat = [];
    this.lastResults = null;
    this.gameStartedAt = null;
    this.blindLevel = 0;
    this.timers = {};
    this.usedBotNames = new Set();
    this.summary = null;
    this.customThemes = []; // [{id,name,owner,ownerName}] managed by the server
    this.fast = !!settings.__fast; // test mode: no realistic delays
    delete this.settings.__fast;
  }
  _ms(ms) { return this.fast ? 1 : ms; }
  isValidTheme(t) { return THEMES.includes(t) || (typeof t === 'string' && t.startsWith('custom:') && this.customThemes.some(c => 'custom:' + c.id === t)); }
  setCustomThemes(list) {
    this.customThemes = list;
    const fix = (t) => (t && !this.isValidTheme(t) ? 'felt' : t);
    if (fix(this.theme) !== this.theme) { this.theme = 'felt'; this.addLog('Theme was deleted; back to classic felt', 'theme'); }
    if (fix(this.settings.theme) !== this.settings.theme) this.settings.theme = 'felt';
    for (const p of this.players()) if (p.pendingTheme && !this.isValidTheme(p.pendingTheme)) p.pendingTheme = null;
    this.emitChange();
  }
  themeLabel(t) { const c = this.customThemes.find(c => 'custom:' + c.id === t); return c ? c.name : t; }

  // ---------- helpers
  players() { return this.seats.filter(Boolean); }
  findPlayer(id) { return this.seats.find(p => p && p.id === id) || null; }
  emitChange() { this.emit('change'); }
  addLog(text, kind = 'info') {
    this.log.push({ t: Date.now(), text, kind });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
  }
  clearTimer(name) { if (this.timers[name]) { clearTimeout(this.timers[name]); delete this.timers[name]; } }
  setTimer(name, ms, fn) { this.clearTimer(name); this.timers[name] = setTimeout(() => { delete this.timers[name]; try { fn(); } catch (e) { console.error('timer error', e); } }, ms); }
  destroy() { for (const k of Object.keys(this.timers)) this.clearTimer(k); }

  // ---------- settings
  updateSettings(patch) {
    const s = { ...this.settings };
    const num = (k, min, max) => { if (patch[k] !== undefined) { const v = Number(patch[k]); if (Number.isFinite(v)) s[k] = Math.max(min, Math.min(max, Math.round(v))); } };
    num('startingStack', 20, 10000000);
    num('smallBlind', 1, 1000000);
    num('bigBlind', 1, 2000000);
    num('actionTimeSec', 5, 600);
    num('maxPlayers', 2, MAX_SEATS);
    num('blindsIncreaseEveryMin', 0, 600);
    num('blindsIncreaseFactor', 1, 10);
    num('showdownPauseSec', 2, 60);
    if (s.bigBlind < s.smallBlind) s.bigBlind = s.smallBlind * 2;
    if (patch.allowRebuy !== undefined) s.allowRebuy = !!patch.allowRebuy;
    if (patch.botsAutoRebuy !== undefined) s.botsAutoRebuy = !!patch.botsAutoRebuy;
    if (typeof patch.tableName === 'string') s.tableName = patch.tableName.slice(0, 40) || s.tableName;
    if (patch.theme && this.isValidTheme(patch.theme)) { s.theme = patch.theme; if (this.phase === 'lobby') this.theme = patch.theme; }
    this.settings = s;
    this.emitChange();
    return s;
  }

  // ---------- seating
  sit(profile, seatIdx) {
    if (this.findPlayer(profile.id)) return { error: 'Already seated' };
    if (this.players().length >= this.settings.maxPlayers) return { error: 'Table is full' };
    let seat = Number(seatIdx);
    if (!Number.isInteger(seat) || seat < 0 || seat >= this.settings.maxPlayers || this.seats[seat]) {
      seat = this.seats.findIndex((s, i) => s === null && i < this.settings.maxPlayers);
      if (seat < 0) return { error: 'No free seats' };
    }
    const p = {
      id: profile.id, name: profile.name, avatar: profile.avatar, isBot: !!profile.isBot, botLevel: profile.botLevel || 0,
      seat, chips: this.settings.startingStack, buyIns: 1, connected: true,
      folded: false, allIn: false, bet: 0, totalBet: 0, holeCards: [], inHand: false, busted: false, sittingOut: false,
      pendingTheme: null, lastAction: null, joinedAt: Date.now(), wantsToLeave: false,
    };
    this.seats[seat] = p;
    this.addLog(`${p.name} sat down at seat ${seat + 1}`);
    this.emitChange();
    return { player: p };
  }

  addBot(level = 2) {
    if (this.players().length >= this.settings.maxPlayers) return { error: 'Table is full' };
    const avail = bots.BOT_NAMES.filter(n => !this.usedBotNames.has(n));
    const name = avail.length ? avail[Math.floor(Math.random() * avail.length)] : `Bot${++botCounter}`;
    this.usedBotNames.add(name);
    const avatar = bots.BOT_AVATARS[Math.floor(Math.random() * bots.BOT_AVATARS.length)];
    const id = `bot:${++botCounter}:${Date.now()}`;
    return this.sit({ id, name, avatar, isBot: true, botLevel: Math.max(1, Math.min(5, Number(level) || 2)) });
  }

  setBotLevel(id, level) {
    const p = this.findPlayer(id);
    if (!p || !p.isBot) return { error: 'Not a bot' };
    p.botLevel = Math.max(1, Math.min(5, Number(level) || 2));
    this.emitChange();
    return { ok: true };
  }

  leave(id, reason = 'left the table') {
    const p = this.findPlayer(id);
    if (!p) return { error: 'Not seated' };
    if (p.isBot) this.usedBotNames.delete(p.name);
    if (this.hand && p.inHand && !p.folded) {
      // fold them out of the hand; their bets stay in the pot
      p.wantsToLeave = true;
      p.connected = false;
      this.addLog(`${p.name} ${reason} (will fold)`);
      if (this.hand.toActSeat === p.seat) this.act(p.id, { action: 'fold' }, true);
      else { this._fold(p); this.emitChange(); this._maybeEndEarly(); }
      return { ok: true, deferred: true };
    }
    this.seats[p.seat] = null;
    this.addLog(`${p.name} ${reason}`);
    this.emitChange();
    if (this.phase === 'playing' && !this.hand) this._scheduleNextHand(500);
    return { ok: true };
  }

  setConnected(id, connected) {
    const p = this.findPlayer(id);
    if (!p) return;
    p.connected = connected;
    this.emitChange();
  }

  updateProfile(id, { name, avatar }) {
    const p = this.findPlayer(id);
    if (!p) return;
    if (name) p.name = name;
    if (avatar) p.avatar = avatar;
    this.emitChange();
  }

  queueTheme(id, theme) {
    if (!this.isValidTheme(theme)) return { error: 'Unknown theme' };
    const p = this.findPlayer(id);
    if (!p) return { error: 'Sit down first' };
    if (theme === this.theme) { p.pendingTheme = null; this.emitChange(); return { ok: true, applied: true }; }
    p.pendingTheme = theme;
    // if it's currently this player's turn, apply immediately
    if (this.hand && this.hand.toActSeat === p.seat) this._applyPendingTheme(p);
    this.emitChange();
    return { ok: true, applied: p.pendingTheme === null };
  }
  _applyPendingTheme(p) {
    if (p.pendingTheme && p.pendingTheme !== this.theme) {
      this.theme = p.pendingTheme;
      this.addLog(`${p.name} switched the theme to "${this.themeLabel(p.pendingTheme)}"`, 'theme');
    }
    p.pendingTheme = null;
  }

  rebuy(id) {
    const p = this.findPlayer(id);
    if (!p) return { error: 'Not seated' };
    if (!this.settings.allowRebuy) return { error: 'Rebuys are disabled' };
    if (p.chips > 0 || p.inHand) return { error: 'You still have chips' };
    p.chips = this.settings.startingStack;
    p.buyIns += 1;
    p.busted = false;
    p.sittingOut = false;
    this.addLog(`${p.name} rebought for ${p.chips} (buy-in #${p.buyIns})`, 'money');
    this.emitChange();
    if (this.phase === 'playing' && !this.hand) this._scheduleNextHand(500);
    return { ok: true };
  }

  sitOut(id, out) {
    const p = this.findPlayer(id);
    if (!p) return { error: 'Not seated' };
    p.sittingOut = !!out;
    this.addLog(`${p.name} is ${out ? 'sitting out' : 'back in'}`);
    this.emitChange();
    if (!out && this.phase === 'playing' && !this.hand) this._scheduleNextHand(500);
    return { ok: true };
  }

  // ---------- game control
  startGame() {
    if (this.phase === 'playing') return { error: 'Already playing' };
    const ready = this.players().filter(p => p.chips > 0 && !p.sittingOut);
    if (ready.length < 2) return { error: 'Need at least 2 players with chips' };
    this.phase = 'playing';
    this.pauseRequested = false;
    this.gameStartedAt = Date.now();
    this.blindLevel = 0;
    this.handNumber = 0;
    this.lastResults = null;
    this.summary = null;
    this.theme = this.settings.theme;
    for (const p of this.players()) { p.buyIns = p.chips > 0 ? 1 : p.buyIns; p.busted = p.chips <= 0; }
    this.addLog(`Game started. Blinds ${this.settings.smallBlind}/${this.settings.bigBlind}`, 'system');
    this.emitChange();
    this._scheduleNextHand(1500);
    return { ok: true };
  }

  pauseGame(pause) {
    if (this.phase !== 'playing') return { error: 'Not playing' };
    this.pauseRequested = !!pause;
    this.addLog(pause ? 'Game will pause after this hand' : 'Game resumed', 'system');
    this.emitChange();
    if (!pause && !this.hand) this._scheduleNextHand(1000);
    return { ok: true };
  }

  endGame() {
    if (this.phase !== 'playing') return { error: 'Not playing' };
    this.clearTimer('nextHand'); this.clearTimer('action'); this.clearTimer('bot'); this.clearTimer('street');
    if (this.hand) {
      if (!this.hand.results) {
        // hand still in progress: refund all bets of the current hand
        for (const p of this.players()) { if (p.inHand) { p.chips += p.bet; p.chips += (p.totalBet - p.bet); } }
        this.addLog('Hand cancelled by admin; bets returned', 'system');
      }
      for (const p of this.players()) this._resetHandState(p);
      this.hand = null;
    }
    this.phase = 'lobby';
    this.pauseRequested = false;
    const dur = this.gameStartedAt ? Math.round((Date.now() - this.gameStartedAt) / 60000) : 0;
    this.summary = {
      endedAt: Date.now(), durationMin: dur, hands: this.handNumber,
      players: this.players().map(p => ({ name: p.name, avatar: p.avatar, chips: p.chips, buyIns: p.buyIns, net: p.chips - p.buyIns * this.settings.startingStack, isBot: p.isBot }))
        .sort((a, b) => b.net - a.net),
    };
    this.addLog(`Game ended after ${this.handNumber} hands`, 'system');
    // reset stacks for a fresh game next time
    for (const p of this.players()) { p.chips = this.settings.startingStack; p.buyIns = 1; p.busted = false; p.pendingTheme = null; }
    this.emitChange();
    return { ok: true };
  }

  _resetHandState(p) {
    p.folded = false; p.allIn = false; p.bet = 0; p.totalBet = 0; p.holeCards = []; p.inHand = false; p.lastAction = null;
    p.showCards = false; p.handResult = null;
  }

  _scheduleNextHand(ms) {
    if (this.phase !== 'playing' || this.hand) return;
    this.setTimer('nextHand', this._ms(ms), () => this._startHand());
  }

  _maybeIncreaseBlinds() {
    const s = this.settings;
    if (!s.blindsIncreaseEveryMin || !this.gameStartedAt) return;
    const level = Math.floor((Date.now() - this.gameStartedAt) / (s.blindsIncreaseEveryMin * 60000));
    if (level > this.blindLevel) {
      this.blindLevel = level;
      this.addLog(`Blinds increased to ${this.currentBlinds().sb}/${this.currentBlinds().bb}`, 'system');
    }
  }
  currentBlinds() {
    const f = Math.pow(this.settings.blindsIncreaseFactor, this.blindLevel);
    return { sb: Math.round(this.settings.smallBlind * f), bb: Math.round(this.settings.bigBlind * f) };
  }

  // ---------- hand lifecycle
  _startHand() {
    if (this.phase !== 'playing' || this.hand) return;
    // process leavers / busted
    for (const p of this.players()) {
      if (p.wantsToLeave) { this.seats[p.seat] = null; this.addLog(`${p.name} left the table`); continue; }
      if (p.chips <= 0) {
        if (p.isBot) {
          if (this.settings.botsAutoRebuy && this.settings.allowRebuy) { p.chips = this.settings.startingStack; p.buyIns++; p.busted = false; this.addLog(`${p.name} rebought (buy-in #${p.buyIns})`, 'money'); }
          else { this.seats[p.seat] = null; this.usedBotNames.delete(p.name); this.addLog(`${p.name} busted out and left`); }
        } else p.busted = true;
      }
    }
    if (this.pauseRequested) { this.addLog('Game paused', 'system'); this.emitChange(); return; }
    const eligible = this.players().filter(p => p.chips > 0 && !p.sittingOut);
    if (eligible.length < 2) {
      this.addLog('Waiting for at least 2 players with chips...', 'system');
      this.emitChange();
      return;
    }
    this._maybeIncreaseBlinds();
    const { sb, bb } = this.currentBlinds();
    this.handNumber++;
    for (const p of this.players()) this._resetHandState(p);
    for (const p of eligible) p.inHand = true;

    // dealer button: next eligible seat after previous dealer
    const prevDealer = this.lastDealerSeat === undefined ? -1 : this.lastDealerSeat;
    const dealerSeat = this._nextSeat(prevDealer, p => p.inHand);
    this.lastDealerSeat = dealerSeat;
    const headsUp = eligible.length === 2;
    const sbSeat = headsUp ? dealerSeat : this._nextSeat(dealerSeat, p => p.inHand);
    const bbSeat = this._nextSeat(sbSeat, p => p.inHand);

    const deck = newDeck();
    const hand = {
      number: this.handNumber, dealerSeat, sbSeat, bbSeat, street: 'preflop', deck, community: [],
      pot: 0, currentBet: 0, minRaise: bb, toActSeat: null, actionDeadline: null, raisesThisRound: 0,
      lastAggressorSeat: null, acted: new Set(), sb, bb, startedAt: Date.now(), results: null,
    };
    this.hand = hand;
    // deal
    for (let r = 0; r < 2; r++) for (const p of this._orderFrom(sbSeat, p => p.inHand)) p.holeCards.push(deck.pop());
    // blinds
    this._postBlind(this.seats[sbSeat], sb, 'small blind');
    this._postBlind(this.seats[bbSeat], bb, 'big blind');
    hand.currentBet = bb;
    hand.minRaise = bb;
    this.addLog(`--- Hand #${hand.number} --- Dealer: ${this.seats[dealerSeat].name}`, 'hand');
    // first to act: left of BB (heads-up: dealer/SB)
    const first = headsUp ? dealerSeat : this._nextSeat(bbSeat, p => p.inHand && !p.allIn);
    this.emitChange();
    this._setToAct(first);
  }

  _postBlind(p, amt, label) {
    const a = Math.min(amt, p.chips);
    p.chips -= a; p.bet += a; p.totalBet += a;
    if (p.chips === 0) p.allIn = true;
    p.lastAction = label;
    this.addLog(`${p.name} posts ${label} ${a}`, 'action');
  }

  _nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const idx = (from + i) % MAX_SEATS;
      const p = this.seats[idx];
      if (p && pred(p)) return idx;
    }
    return -1;
  }
  _orderFrom(seat, pred) {
    const out = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      const idx = (seat + i) % MAX_SEATS;
      const p = this.seats[idx];
      if (p && pred(p)) out.push(p);
    }
    return out;
  }

  _activePlayers() { return this.players().filter(p => p.inHand && !p.folded); }
  _canAct(p) { return p.inHand && !p.folded && !p.allIn; }

  _setToAct(seat) {
    const hand = this.hand;
    if (seat < 0 || seat === null) return this._endStreet();
    let p = this.seats[seat];
    if (!p || !this._canAct(p)) { const n = this._nextToAct(seat); if (n < 0) return this._endStreet(); seat = n; p = this.seats[seat]; }
    hand.toActSeat = seat;
    this._applyPendingTheme(p);
    this.clearTimer('action'); this.clearTimer('bot');
    if (p.isBot) {
      hand.actionDeadline = null;
      const delay = this._ms(600 + Math.random() * 1600);
      this.setTimer('bot', delay, () => this._botAct(p));
    } else {
      const ms = this.settings.actionTimeSec * 1000;
      hand.actionDeadline = Date.now() + ms;
      this.setTimer('action', ms + 250, () => {
        if (this.hand && this.hand.toActSeat === seat) {
          const toCall = this.hand.currentBet - p.bet;
          this.addLog(`${p.name} timed out`, 'action');
          this.act(p.id, { action: toCall > 0 ? 'fold' : 'check' }, true);
        }
      });
    }
    this.emitChange();
  }

  _botAct(p) {
    if (!this.hand || this.hand.toActSeat !== p.seat) return;
    const hand = this.hand;
    const active = this._activePlayers();
    // position: fraction of active players acting before us in this street order (button = 1)
    const order = this._orderFrom(hand.dealerSeat + 1, q => q.inHand && !q.folded);
    const idx = order.findIndex(q => q.id === p.id);
    const position = order.length > 1 ? idx / (order.length - 1) : 1;
    const potTotal = hand.pot + this.players().reduce((s, q) => s + q.bet, 0);
    const ctx = {
      hole: p.holeCards, community: hand.community, street: hand.street, pot: potTotal,
      toCall: Math.min(hand.currentBet - p.bet, p.chips), currentBet: hand.currentBet, minRaise: hand.minRaise,
      chips: p.chips, bigBlind: hand.bb, nOpp: active.length - 1, position, level: p.botLevel, myBet: p.bet,
      raisesThisRound: hand.raisesThisRound,
    };
    let d;
    try { d = bots.decide(ctx); } catch (e) { console.error('bot error', e); d = { action: ctx.toCall > 0 ? 'call' : 'check' }; }
    this.act(p.id, d, true);
  }

  /** Public action entry point. action: fold|check|call|raise|allin ; amount = total bet for raise */
  act(id, { action, amount }, internal = false) {
    const hand = this.hand;
    const p = this.findPlayer(id);
    if (!hand || !p) return { error: 'No hand in progress' };
    if (hand.toActSeat !== p.seat) return { error: 'Not your turn' };
    const toCall = hand.currentBet - p.bet;
    let logText;
    switch (action) {
      case 'fold':
        this._fold(p); logText = 'folds'; p.lastAction = 'Fold'; break;
      case 'check':
        if (toCall > 0) return { error: 'Cannot check, must call ' + toCall };
        logText = 'checks'; p.lastAction = 'Check'; break;
      case 'call': {
        if (toCall <= 0) { logText = 'checks'; p.lastAction = 'Check'; break; }
        const a = Math.min(toCall, p.chips);
        p.chips -= a; p.bet += a; p.totalBet += a;
        if (p.chips === 0) { p.allIn = true; p.lastAction = 'All-in'; logText = `calls ${a} and is all-in`; }
        else { p.lastAction = `Call ${a}`; logText = `calls ${a}`; }
        break;
      }
      case 'allin':
        amount = p.bet + p.chips; // fallthrough to raise semantics
      // eslint-disable-next-line no-fallthrough
      case 'raise': {
        amount = Math.round(Number(amount));
        if (!Number.isFinite(amount)) return { error: 'Bad amount' };
        const maxTotal = p.bet + p.chips;
        if (amount > maxTotal) amount = maxTotal;
        const isAllIn = amount === maxTotal;
        const minTotal = hand.currentBet + hand.minRaise;
        if (amount < minTotal && !isAllIn) return { error: `Minimum raise is to ${minTotal}` };
        if (amount <= hand.currentBet && !(isAllIn && amount > hand.currentBet)) {
          if (isAllIn) { /* all-in for less than a call: treat as call */
            const a = p.chips; p.chips = 0; p.bet += a; p.totalBet += a; p.allIn = true; p.lastAction = 'All-in'; logText = `calls ${a} and is all-in`; break;
          }
          return { error: 'Raise must exceed current bet' };
        }
        const add = amount - p.bet;
        const raiseBy = amount - hand.currentBet;
        p.chips -= add; p.bet = amount; p.totalBet += add;
        if (raiseBy >= hand.minRaise) { hand.minRaise = raiseBy; hand.acted = new Set(); } // full raise reopens action
        hand.currentBet = amount;
        hand.raisesThisRound++;
        hand.lastAggressorSeat = p.seat;
        if (isAllIn) { p.allIn = true; p.lastAction = 'All-in'; logText = `raises to ${amount} and is all-in`; }
        else { p.lastAction = (toCall === 0 ? 'Bet ' : 'Raise ') + amount; logText = (toCall === 0 ? `bets ${amount}` : `raises to ${amount}`); }
        break;
      }
      default: return { error: 'Unknown action' };
    }
    hand.acted.add(p.id);
    this.addLog(`${p.name} ${logText}`, 'action');
    this.clearTimer('action'); this.clearTimer('bot');
    hand.toActSeat = null; hand.actionDeadline = null;
    if (this._maybeEndEarly()) return { ok: true };
    // next to act
    const next = this._nextToAct(p.seat);
    if (next < 0) this._endStreet(); else this._setToAct(next);
    return { ok: true };
  }

  _fold(p) { p.folded = true; p.lastAction = 'Fold'; }

  _maybeEndEarly() {
    if (!this.hand) return false;
    const active = this._activePlayers();
    if (active.length === 1) { this._finishHand(); return true; }
    return false;
  }

  _nextToAct(fromSeat) {
    const hand = this.hand;
    for (let i = 1; i <= MAX_SEATS; i++) {
      const idx = (fromSeat + i) % MAX_SEATS;
      const p = this.seats[idx];
      if (!p || !this._canAct(p)) continue;
      if (p.bet < hand.currentBet || !hand.acted.has(p.id)) return idx;
    }
    return -1;
  }

  _endStreet() {
    const hand = this.hand;
    // collect bets
    for (const p of this.players()) { hand.pot += p.bet; p.bet = 0; }
    hand.currentBet = 0; hand.minRaise = hand.bb; hand.acted = new Set(); hand.raisesThisRound = 0; hand.toActSeat = null; hand.actionDeadline = null;
    const canActCount = this._activePlayers().filter(p => !p.allIn).length;
    const nextStreet = { preflop: 'flop', flop: 'turn', turn: 'river', river: 'showdown' }[hand.street];
    if (nextStreet === 'showdown') { this.emitChange(); return this._finishHand(); }
    const dealBoard = () => {
      hand.street = nextStreet;
      hand.deck.pop(); // burn
      const n = nextStreet === 'flop' ? 3 : 1;
      for (let i = 0; i < n; i++) hand.community.push(hand.deck.pop());
      this.addLog(`${nextStreet[0].toUpperCase() + nextStreet.slice(1)}: ${hand.community.map(cardStr).join(' ')}`, 'board');
      for (const p of this.players()) if (p.inHand && !p.folded && !p.allIn) p.lastAction = null;
    };
    if (canActCount <= 1) {
      // run out the board with pauses
      for (const p of this._activePlayers()) p.showCards = true;
      this.emitChange();
      this.setTimer('street', this._ms(1200), () => {
        dealBoard(); this.emitChange();
        this._endStreet();
      });
      return;
    }
    dealBoard();
    this.emitChange();
    const first = this._nextSeat(hand.dealerSeat, p => this._canAct(p));
    this._setToAct(first);
  }

  _finishHand() {
    const hand = this.hand;
    this.clearTimer('action'); this.clearTimer('bot'); this.clearTimer('street');
    for (const p of this.players()) { hand.pot += p.bet; p.bet = 0; }
    hand.toActSeat = null; hand.actionDeadline = null;
    const active = this._activePlayers();
    const results = { winners: [], pots: [], showdown: false, community: hand.community.slice() };

    if (active.length === 1) {
      const w = active[0];
      w.chips += hand.pot;
      results.winners.push({ id: w.id, name: w.name, amount: hand.pot, hand: null });
      results.pots.push({ amount: hand.pot, winners: [w.name] });
      this.addLog(`${w.name} wins ${hand.pot} (everyone folded)`, 'money');
    } else {
      results.showdown = true;
      hand.street = 'showdown';
      // evaluate
      for (const p of active) {
        const r = evalBest(p.holeCards.concat(hand.community));
        p.handResult = { score: r.score, desc: describe(r), cards: r.cards };
        p.showCards = true;
      }
      // side pots based on totalBet
      const contributors = this.players().filter(p => p.inHand && p.totalBet > 0);
      const levels = [...new Set(contributors.map(p => p.totalBet))].sort((a, b) => a - b);
      let prev = 0;
      const potList = [];
      for (const lvl of levels) {
        let amount = 0;
        for (const p of contributors) amount += Math.max(0, Math.min(p.totalBet, lvl) - prev);
        const eligible = active.filter(p => p.totalBet >= lvl);
        if (amount > 0 && eligible.length) potList.push({ amount, eligible });
        prev = lvl;
      }
      // merge pots with identical eligible sets
      const merged = [];
      for (const pot of potList) {
        const key = pot.eligible.map(p => p.id).sort().join('|');
        const m = merged.find(x => x.key === key);
        if (m) m.amount += pot.amount; else merged.push({ key, amount: pot.amount, eligible: pot.eligible });
      }
      const winTotals = new Map();
      merged.forEach((pot, i) => {
        const best = Math.max(...pot.eligible.map(p => p.handResult.score));
        const winners = pot.eligible.filter(p => p.handResult.score === best);
        const share = Math.floor(pot.amount / winners.length);
        let rem = pot.amount - share * winners.length;
        // odd chips to first winner left of dealer
        const ordered = this._orderFrom(hand.dealerSeat + 1, p => winners.includes(p));
        for (const w of ordered) { const amt = share + (rem > 0 ? 1 : 0); if (rem > 0) rem--; w.chips += amt; winTotals.set(w.id, (winTotals.get(w.id) || 0) + amt); }
        const label = merged.length > 1 ? (i === 0 ? 'Main pot' : `Side pot ${i}`) : 'Pot';
        results.pots.push({ amount: pot.amount, winners: winners.map(w => w.name), label });
        this.addLog(`${label} ${pot.amount}: ${winners.map(w => `${w.name} (${w.handResult.desc})`).join(', ')}`, 'money');
      });
      for (const [id, amount] of winTotals) { const p = this.findPlayer(id); results.winners.push({ id, name: p.name, amount, hand: p.handResult.desc }); }
    }
    results.totalPot = hand.pot;
    hand.pot = 0; // chips have been awarded
    hand.results = results;
    this.lastResults = { handNumber: hand.number, ...results };
    for (const p of this.players()) if (p.inHand && p.chips === 0 && !p.isBot) this.addLog(`${p.name} is out of chips`, 'money');
    this.emitChange();
    const pause = (results.showdown ? this.settings.showdownPauseSec : Math.max(2, this.settings.showdownPauseSec / 2)) * 1000;
    this.setTimer('nextHand', this._ms(pause), () => {
      this.hand = null;
      for (const p of this.players()) this._resetHandState(p);
      this.emitChange();
      this._startHand();
    });
  }

  _liveHandDesc(hole, community) {
    if (hole.length < 2) return null;
    if (community.length >= 3) return describe(evalBest(hole.concat(community)));
    const N = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
    const r = hole.map(rankOf).sort((a, b) => b - a);
    if (r[0] === r[1]) return `Pair of ${N[r[0]]}s`;
    return `${N[r[0]]}-${N[r[1]]}${suitOf(hole[0]) === suitOf(hole[1]) ? ' suited' : ''}`;
  }

  // ---------- chat
  addChat(from, text) {
    this.chat.push({ t: Date.now(), from, text: String(text).slice(0, 300) });
    if (this.chat.length > 200) this.chat.splice(0, this.chat.length - 200);
    this.emitChange();
  }

  // ---------- state serialization (per viewer)
  stateFor(viewerId, isAdmin) {
    const hand = this.hand;
    const showAll = hand && hand.results && hand.results.showdown;
    const seats = this.seats.map(p => {
      if (!p) return null;
      const isSelf = p.id === viewerId;
      const reveal = isSelf || (p.showCards && p.inHand && !p.folded);
      return {
        id: p.id, name: p.name, avatar: p.avatar, isBot: p.isBot, botLevel: p.botLevel, seat: p.seat, chips: p.chips, buyIns: p.buyIns,
        connected: p.connected, folded: p.folded, allIn: p.allIn, bet: p.bet, totalBet: p.totalBet, inHand: p.inHand, busted: p.busted || (p.chips <= 0 && !p.inHand),
        sittingOut: p.sittingOut, lastAction: p.lastAction, pendingTheme: isSelf ? p.pendingTheme : (p.pendingTheme ? true : null),
        cards: reveal ? p.holeCards.map(cardStr) : p.holeCards.map(() => 'XX'),
        handDesc: (reveal && p.handResult) ? p.handResult.desc : (isSelf && p.inHand && !p.folded && hand ? this._liveHandDesc(p.holeCards, hand.community) : null),
        bestCards: (reveal && p.handResult && showAll) ? p.handResult.cards.map(cardStr) : null,
        isSelf,
      };
    });
    const potOnTable = this.players().reduce((s, q) => s + q.bet, 0);
    const me = this.findPlayer(viewerId);
    let actions = null;
    if (hand && me && hand.toActSeat === me.seat) {
      const toCall = Math.min(hand.currentBet - me.bet, me.chips);
      actions = {
        toCall, canCheck: toCall === 0, minRaiseTo: Math.min(hand.currentBet + hand.minRaise, me.bet + me.chips), maxRaiseTo: me.bet + me.chips,
        pot: hand.pot + potOnTable, deadline: hand.actionDeadline,
      };
    }
    return {
      serverTime: Date.now(),
      phase: this.phase, pauseRequested: this.pauseRequested, theme: this.theme, settings: this.settings, themes: THEMES, customThemes: this.customThemes,
      blinds: this.currentBlinds(), handNumber: this.handNumber, seats, maxSeats: MAX_SEATS,
      hand: hand ? {
        number: hand.number, street: hand.street, community: hand.community.map(cardStr), pot: hand.pot, potOnTable, currentBet: hand.currentBet,
        dealerSeat: hand.dealerSeat, sbSeat: hand.sbSeat, bbSeat: hand.bbSeat, toActSeat: hand.toActSeat, actionDeadline: hand.actionDeadline,
        actionTimeSec: this.settings.actionTimeSec, results: hand.results,
      } : null,
      lastResults: this.lastResults, summary: this.summary,
      me: me ? { id: me.id, seat: me.seat, actions, pendingTheme: me.pendingTheme, busted: me.chips <= 0 && !me.inHand, sittingOut: me.sittingOut } : null,
      log: this.log.slice(-60), chat: this.chat.slice(-60),
      isAdmin: !!isAdmin,
    };
  }
}

module.exports = { Table, DEFAULT_SETTINGS, THEMES, MAX_SEATS };
