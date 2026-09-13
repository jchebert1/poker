const { Table } = require('../server/engine/table');
(async () => {
  const totals = {1:0,2:0,3:0,4:0,5:0};
  for (let g = 0; g < 4; g++) {
    const t = new Table({ __fast: true, startingStack: 500, smallBlind: 5, bigBlind: 10, botsAutoRebuy: true, showdownPauseSec: 2 });
    for (let i = 1; i <= 5; i++) t.addBot(i); for (let i = 1; i <= 5; i++) t.addBot(i);
    t.startGame();
    await new Promise(r => { const iv = setInterval(() => { if (t.handNumber >= 100) { clearInterval(iv); t.endGame(); t.destroy(); r(); } }, 5); });
    for (const p of t.summary.players) { const lvl = Number(p.name && t.players().find(q => q.name === p.name)?.botLevel); totals[lvl] += p.net; }
  }
  console.log('net per level over 6 games x 150 hands:', totals);
})();
