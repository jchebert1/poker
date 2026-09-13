'use strict';
// Card representation: integer 0..51. rank = c % 13 (0=2 .. 12=Ace), suit = Math.floor(c/13)
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];
const { randomInt } = require('node:crypto');

function rankOf(c) { return c % 13; }
function suitOf(c) { return Math.floor(c / 13); }
function cardStr(c) { return RANKS[rankOf(c)] + SUITS[suitOf(c)]; }
function parseCard(s) {
  const r = RANKS.indexOf(s[0].toUpperCase());
  const su = SUITS.indexOf(s[1].toLowerCase());
  if (r < 0 || su < 0) throw new Error('bad card ' + s);
  return su * 13 + r;
}

function newDeck() {
  const d = [];
  for (let i = 0; i < 52; i++) d.push(i);
  // Fisher-Yates with CSPRNG
  for (let i = d.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---- 5-card evaluator -> numeric score; higher is better. Category in the top bits.
const CAT = { HIGH: 0, PAIR: 1, TWO_PAIR: 2, TRIPS: 3, STRAIGHT: 4, FLUSH: 5, FULL: 6, QUADS: 7, SF: 8 };
const CAT_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];

function eval5(cards) {
  const ranks = cards.map(rankOf).sort((a, b) => b - a);
  const suits = cards.map(suitOf);
  const flush = suits.every(s => s === suits[0]);
  // counts
  const cnt = new Map();
  for (const r of ranks) cnt.set(r, (cnt.get(r) || 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // by count desc, rank desc
  // straight
  let straightHigh = -1;
  const uniq = [...new Set(ranks)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 12 && uniq[1] === 3 && uniq[4] === 0) straightHigh = 3; // wheel A-5
  }
  let cat, kick;
  if (straightHigh >= 0 && flush) { cat = CAT.SF; kick = [straightHigh]; }
  else if (groups[0][1] === 4) { cat = CAT.QUADS; kick = [groups[0][0], groups[1][0]]; }
  else if (groups[0][1] === 3 && groups[1][1] === 2) { cat = CAT.FULL; kick = [groups[0][0], groups[1][0]]; }
  else if (flush) { cat = CAT.FLUSH; kick = ranks; }
  else if (straightHigh >= 0) { cat = CAT.STRAIGHT; kick = [straightHigh]; }
  else if (groups[0][1] === 3) { cat = CAT.TRIPS; kick = [groups[0][0], groups[1][0], groups[2][0]]; }
  else if (groups[0][1] === 2 && groups[1][1] === 2) { cat = CAT.TWO_PAIR; kick = [groups[0][0], groups[1][0], groups[2][0]]; }
  else if (groups[0][1] === 2) { cat = CAT.PAIR; kick = [groups[0][0], groups[1][0], groups[2][0], groups[3][0]]; }
  else { cat = CAT.HIGH; kick = ranks; }
  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 13 + (kick[i] !== undefined ? kick[i] : 0);
  return score;
}

// Best of up to 7 cards. Returns { score, cat, cards(5) }
const COMBOS7 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++) for (let b = a + 1; b < 7; b++) for (let c = b + 1; c < 7; c++)
    for (let d = c + 1; d < 7; d++) for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
  return out;
})();

function combosOf(n) {
  const out = [];
  const rec = (start, cur) => {
    if (cur.length === 5) { out.push(cur.slice()); return; }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1, cur); cur.pop(); }
  };
  rec(0, []);
  return out;
}
const COMBO_CACHE = { 5: combosOf(5), 6: combosOf(6), 7: COMBOS7 };

function evalBest(cards) {
  const n = cards.length;
  if (n < 5) throw new Error('need >= 5 cards');
  const combos = COMBO_CACHE[n] || combosOf(n);
  let best = -1, bestCards = null;
  const tmp = new Array(5);
  for (const idx of combos) {
    for (let i = 0; i < 5; i++) tmp[i] = cards[idx[i]];
    const s = eval5(tmp);
    if (s > best) { best = s; bestCards = tmp.slice(); }
  }
  const cat = Math.floor(best / Math.pow(13, 5));
  return { score: best, cat, catName: CAT_NAMES[cat], cards: bestCards };
}

function describe(result) {
  const r = result.cards.map(rankOf);
  const name = (x) => ({ 8: 'Eight', 9: 'Nine', 10: 'Ten', 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' })[x + 2] || String(x + 2);
  const cnt = new Map();
  for (const x of r) cnt.set(x, (cnt.get(x) || 0) + 1);
  const groups = [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  switch (result.cat) {
    case CAT.SF: return (Math.max(...r) === 12 && r.includes(11)) ? 'Royal Flush' : `Straight Flush, ${name(straightTop(r))} high`;
    case CAT.QUADS: return `Four ${name(groups[0][0])}s`;
    case CAT.FULL: return `Full House, ${name(groups[0][0])}s over ${name(groups[1][0])}s`;
    case CAT.FLUSH: return `Flush, ${name(Math.max(...r))} high`;
    case CAT.STRAIGHT: return `Straight, ${name(straightTop(r))} high`;
    case CAT.TRIPS: return `Three ${name(groups[0][0])}s`;
    case CAT.TWO_PAIR: return `Two Pair, ${name(groups[0][0])}s and ${name(groups[1][0])}s`;
    case CAT.PAIR: return `Pair of ${name(groups[0][0])}s`;
    default: return `${name(Math.max(...r))} high`;
  }
}
function straightTop(r) {
  const s = [...new Set(r)].sort((a, b) => b - a);
  if (s[0] === 12 && s[1] === 3) return 3;
  return s[0];
}

module.exports = { RANKS, SUITS, rankOf, suitOf, cardStr, parseCard, newDeck, eval5, evalBest, describe, CAT, CAT_NAMES };
