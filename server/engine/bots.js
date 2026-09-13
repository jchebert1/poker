'use strict';
const { evalBest, rankOf, suitOf, newDeck } = require('./cards');
const { randomInt } = require('node:crypto');

const BOT_NAMES = [
  'xXNoScopeGrandmaXx', 'CtrlAltDefeat', 'SirLagsALot', 'MicMuted4Ever', 'Trash_Panda_TTV', 'ButterBeanz',
  'TiltedAndTilting', 'OopsAllBluffs', 'RiverRatRick', 'FoldingChair', 'AllInAllTheTime', 'Baconator3000',
  'DefinitelyNotABot', 'PocketRocketz', 'MomSaidNoMore', 'LagSwitchLarry', 'ChairBreaker', 'SnackAttack',
  'DialUpDan', 'ThumbsOfFury', 'CaptainCheckFold', 'PixelPusher', 'NoobTube99', 'SoggyWaffle',
  'GrandmasSlippers', 'TheRealSlimShady', 'WifiWarrior', 'ToasterBath', 'CheeseWizard', 'PanicButton',
  'BigDealDaddy', 'CouchPotatoKing', 'HotPocketHero', 'ShuffleTruffle', 'YeetMaster5000', 'DadJokeDealer',
  'FlopGoblin', 'TurnCoat', 'RiverDance', 'BluffMuffin', 'ChipMunk', 'AceVentura', 'KingOfPing', 'QueenBean',
];
const BOT_AVATARS = ['🤖', '👾', '🦝', '🐸', '🦖', '🐙', '🦊', '🐼', '🦄', '🐧', '🦜', '🐢', '🦥', '🐨', '🦦', '🐲', '🦔', '🐝', '🦩', '🐺'];

// ---- Chen formula-ish preflop strength (0..20)
function preflopStrength(hole) {
  const r1 = rankOf(hole[0]), r2 = rankOf(hole[1]);
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const val = (r) => (r === 12 ? 10 : r === 11 ? 8 : r === 10 ? 7 : r === 9 ? 6 : (r + 2) / 2);
  let s = val(hi);
  if (r1 === r2) { s = Math.max(5, s * 2); return Math.min(20, s); }
  if (suitOf(hole[0]) === suitOf(hole[1])) s += 2;
  const gap = hi - lo - 1;
  if (gap === 1) s -= 1; else if (gap === 2) s -= 2; else if (gap === 3) s -= 4; else if (gap >= 4) s -= 5;
  if (gap <= 1 && hi < 10) s += 1;
  return Math.max(0, s);
}

// ---- Monte Carlo equity: fraction of pot this hand expects vs nOpp random hands
function equity(hole, community, nOpp, sims) {
  const used = new Set([...hole, ...community]);
  const base = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) base.push(c);
  let share = 0;
  const need = 5 - community.length;
  for (let s = 0; s < sims; s++) {
    // partial shuffle of base
    const pool = base.slice();
    const draw = (n) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const j = i + randomInt(pool.length - i);
        [pool[i], pool[j]] = [pool[j], pool[i]];
        out.push(pool[i]);
      }
      // remove drawn from front
      pool.splice(0, n);
      return out;
    };
    const board = community.concat(draw(need));
    const my = evalBest(hole.concat(board)).score;
    let best = my, ties = 1, lost = false;
    for (let o = 0; o < nOpp; o++) {
      const oh = draw(2);
      const os = evalBest(oh.concat(board)).score;
      if (os > my) { lost = true; break; }
      if (os === my) ties++;
    }
    if (!lost) share += 1 / ties;
  }
  return share / sims;
}

// Draw detection for semi-bluffing (flop/turn only)
function drawInfo(hole, community) {
  const all = hole.concat(community);
  const suits = [0, 0, 0, 0];
  for (const c of all) suits[suitOf(c)]++;
  const flushDraw = suits.some(n => n === 4) && community.length < 5;
  const ranks = new Set(all.map(rankOf));
  if (ranks.has(12)) ranks.add(-1);
  let straightDraw = false;
  for (let lo = -1; lo <= 8; lo++) {
    let n = 0;
    for (let r = lo; r < lo + 5; r++) if (ranks.has(r)) n++;
    if (n === 4) straightDraw = true;
  }
  return { flushDraw, straightDraw: straightDraw && community.length < 5 };
}

const SIMS = { 1: 0, 2: 40, 3: 120, 4: 300, 5: 500 };

/**
 * Decide an action for a bot.
 * ctx: { hole, community, street, pot, toCall, currentBet, minRaise, chips, bigBlind, nOpp, position(0..1, 1=button), level, myBet, raisesThisRound }
 * returns { action: 'fold'|'check'|'call'|'raise'|'allin', amount? } amount = total bet size for raise
 */
function decide(ctx) {
  const L = Math.max(1, Math.min(5, ctx.level || 2));
  const rnd = () => randomInt(1000) / 1000;
  const canCheck = ctx.toCall === 0;
  const pot = ctx.pot + ctx.toCall; // pot after call
  const potOdds = ctx.toCall > 0 ? ctx.toCall / (ctx.pot + ctx.toCall) : 0;
  const maxTotal = ctx.myBet + ctx.chips; // all-in total
  const raiseTo = (mult) => {
    // bet mult * pot, clamped to min raise and all-in
    const target = Math.round(ctx.currentBet + Math.max(ctx.minRaise, pot * mult));
    if (target >= maxTotal * 0.85) return { action: 'allin' };
    return { action: 'raise', amount: Math.max(ctx.currentBet + ctx.minRaise, target) };
  };
  const callOrCheck = () => (canCheck ? { action: 'check' } : (ctx.toCall >= ctx.chips ? { action: 'allin' } : { action: 'call' }));
  const foldOrCheck = () => (canCheck ? { action: 'check' } : { action: 'fold' });

  // ---------- Level 1: the fish. Random, sticky, occasionally wild.
  if (L === 1) {
    const r = rnd();
    if (r < 0.10 && ctx.raisesThisRound < 3) return raiseTo(0.5 + rnd());
    if (r < 0.85 || canCheck) return callOrCheck();
    return foldOrCheck();
  }

  // ---------- Preflop
  if (ctx.street === 'preflop') {
    const s = preflopStrength(ctx.hole); // 0..20
    const posBonus = ctx.position * (L >= 4 ? 2 : 1);
    const str = s + posBonus + (rnd() - 0.5) * (L === 2 ? 4 : L === 3 ? 2 : 1);
    const bbCall = ctx.toCall / ctx.bigBlind; // how many BBs to call
    if (L === 2) {
      if (str >= 11 && ctx.raisesThisRound < 2 && rnd() < 0.6) return raiseTo(0.6);
      if (str >= 7 || (bbCall <= 1 && rnd() < 0.7)) return callOrCheck();
      return foldOrCheck();
    }
    // L3+
    const premium = str >= 12, strong = str >= 9, playable = str >= 6.5;
    if (premium) {
      if (ctx.raisesThisRound >= 2 && bbCall > 15 && L >= 4 && s < 15) return callOrCheck();
      if (bbCall > ctx.chips / ctx.bigBlind * 0.5) return { action: 'allin' };
      return rnd() < 0.85 ? raiseTo(0.7 + ctx.raisesThisRound * 0.3) : callOrCheck();
    }
    if (strong) {
      if (bbCall > 12) return L >= 4 ? foldOrCheck() : callOrCheck();
      if (ctx.raisesThisRound === 0 && rnd() < 0.5) return raiseTo(0.6);
      return callOrCheck();
    }
    if (playable) {
      if (bbCall <= 3 + ctx.position * 2) {
        if (ctx.raisesThisRound === 0 && ctx.position > 0.6 && rnd() < 0.35) return raiseTo(0.6); // steal
        return callOrCheck();
      }
      return foldOrCheck();
    }
    // junk: occasional late-position steal
    if (canCheck) return { action: 'check' };
    if (ctx.raisesThisRound === 0 && ctx.position > 0.75 && rnd() < (L >= 4 ? 0.25 : 0.1)) return raiseTo(0.6);
    if (bbCall <= 1 && rnd() < 0.15) return callOrCheck();
    return { action: 'fold' };
  }

  // ---------- Postflop
  let eq;
  if (L === 2) {
    // crude: made hand category with some noise
    const res = evalBest(ctx.hole.concat(ctx.community));
    const catEq = [0.25, 0.45, 0.62, 0.75, 0.82, 0.86, 0.92, 0.97, 0.99][res.cat];
    // top pair vs bottom pair matters a bit
    eq = Math.max(0.05, Math.min(0.99, catEq - (ctx.nOpp - 1) * 0.06 + (rnd() - 0.5) * 0.2));
  } else {
    eq = equity(ctx.hole, ctx.community, Math.min(ctx.nOpp, 4), SIMS[L]);
    if (ctx.nOpp > 4) eq *= Math.pow(0.93, ctx.nOpp - 4);
  }
  const draws = drawInfo(ctx.hole, ctx.community);
  const hasDraw = draws.flushDraw || draws.straightDraw;
  const aggression = { 2: 0.4, 3: 0.5, 4: 0.65, 5: 0.7 }[L];
  const bluffFreq = { 2: 0.05, 3: 0.08, 4: 0.15, 5: 0.18 }[L];
  const scary = ctx.raisesThisRound >= 2;

  if (canCheck) {
    if (eq > 0.75) return rnd() < aggression + 0.2 ? raiseTo(0.6 + rnd() * 0.4) : { action: 'check' };
    if (eq > 0.55) return rnd() < aggression ? raiseTo(0.5) : { action: 'check' };
    if (hasDraw && L >= 3 && rnd() < aggression * 0.7) return raiseTo(0.5); // semi-bluff
    if (L >= 4 && ctx.nOpp === 1 && rnd() < bluffFreq * 1.5) return raiseTo(0.6); // c-bet style bluff
    return { action: 'check' };
  }
  // facing a bet
  const callAllIn = ctx.toCall >= ctx.chips;
  if (eq > 0.8 && !callAllIn) return rnd() < aggression + 0.25 ? raiseTo(0.8) : callOrCheck();
  if (eq > 0.65) {
    if (!scary && rnd() < aggression * 0.6 && !callAllIn) return raiseTo(0.7);
    return callOrCheck();
  }
  // marginal: use pot odds. equity must exceed pot odds (with a level-based margin)
  const margin = { 2: -0.08, 3: -0.02, 4: 0.0, 5: 0.02 }[L];
  let need = potOdds + margin;
  if (scary) need += 0.08;
  if (hasDraw && ctx.street !== 'river' && L >= 3) {
    // draws: implied odds
    if (eq + 0.1 > need) return callOrCheck();
  }
  if (eq > need) return callOrCheck();
  // bluff-raise occasionally on a single opponent with a small bet
  if (L >= 4 && ctx.nOpp === 1 && ctx.toCall < pot * 0.35 && rnd() < bluffFreq && !callAllIn) return raiseTo(0.9);
  // L2 hates folding small bets
  if (L === 2 && ctx.toCall <= ctx.bigBlind * 2 && rnd() < 0.5) return callOrCheck();
  return { action: 'fold' };
}

module.exports = { decide, equity, preflopStrength, BOT_NAMES, BOT_AVATARS };
