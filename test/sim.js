'use strict';
// Simulate bot-only games quickly and sanity-check chip conservation.
const { Table } = require('../server/engine/table');
const N_GAMES = Number(process.argv[2] || 3), HANDS = Number(process.argv[3] || 40);
let errors = 0;
async function run(g) {
  const t = new Table({ __fast: true, startingStack: 500, smallBlind: 5, bigBlind: 10, botsAutoRebuy: false, showdownPauseSec: 2 });
  const n = 2 + (g % 9);
  for (let i = 0; i < n; i++) t.addBot(1 + (i % 5));
  const levels = Object.fromEntries(t.players().map(p => [p.name, p.botLevel]));
  const startTotal = t.players().reduce((s, p) => s + p.chips, 0);
  let done=false;
  t.on('change', () => {
    if (done) return;
    const chips = t.players().reduce((s, p) => s + p.chips + p.bet, 0) + (t.hand ? t.hand.pot : 0);
    if (chips !== startTotal) { errors++; console.error(`game ${g}: chip mismatch ${chips} vs ${startTotal} hand#${t.handNumber} street=${t.hand && t.hand.street}`); console.error(t.log.slice(-25).map(l=>l.text).join('\n')); process.exit(1); }
    for (const p of t.players()) if (p.chips < 0) { errors++; console.error('negative chips', p); process.exit(1); }
  });
  t.startGame();
  await new Promise(res => {
    const iv = setInterval(() => {
      if (t.handNumber >= HANDS || t.players().filter(p => p.chips > 0).length < 2) { clearInterval(iv); done=true; t.endGame(); t.destroy(); res(); }
    }, 5);
  });
  const stacks = t.summary.players.map(p => `${p.name}[L${levels[p.name]}]:${p.net}`).join(' ');
  console.log(`game ${g}: ${n} bots, ${t.summary.hands} hands OK. ${stacks}`);
}
(async () => { for (let g = 0; g < N_GAMES; g++) await run(g); console.log('errors:', errors); })();
