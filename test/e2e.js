// End-to-end smoke test through the real browser UI (dev auth mode). Run: node test/e2e.js [baseUrl]
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:3000';
const SHOTS = process.env.SHOTS || '/tmp/shots';
require('node:fs').mkdirSync(SHOTS, { recursive: true });

async function login(ctx, email) {
  const page = await ctx.newPage();
  page.on('pageerror', e => console.error('PAGE ERROR', email, e.message));
  page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', email, m.text()); });
  await page.goto(BASE + '/dev/login');
  await page.fill('input[name=email]', email);
  await page.click('button.btn.primary');
  await page.waitForSelector('#main section:not([hidden])', { timeout: 5000 });
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const friendCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const admin = await login(adminCtx, 'jchebert1@gmail.com');
  const friend = await login(friendCtx, 'friend@gmail.com');

  // admin: profile + settings
  await admin.click('#btn-profile');
  await admin.fill('#profile-form input[name=name]', 'Jason');
  await admin.click('#avatar-grid button:nth-child(1)');
  await admin.click('#profile-form button.btn.primary');
  await admin.waitForTimeout(300);
  await admin.fill('#settings-form input[name=startingStack]', '500');
  await admin.fill('#settings-form input[name=actionTimeSec]', '8');
  await admin.fill('#settings-form input[name=showdownPauseSec]', '2');
  await admin.click('#settings-form button[type=submit]');
  await admin.waitForTimeout(300);
  // sit + bots
  await admin.click('#btn-sit');
  await friend.click('#btn-sit');
  for (let i = 0; i < 2; i++) { await admin.click('#btn-add-bot'); await admin.click('#bot-dialog [data-level="3"]'); await admin.waitForTimeout(200); }
  await friend.click('#btn-add-bot'); await friend.click('#bot-dialog [data-level="2"]'); await friend.waitForTimeout(300); // non-admin can add
  await friend.click('#btn-add-bot'); await friend.click('#bot-dialog [data-level="1"]'); await friend.waitForTimeout(300);
  const removeBtns = friend.locator('#player-list button', { hasText: 'Remove' });
  console.log('friend sees Remove buttons:', await removeBtns.count(), 'Kick buttons:', await friend.locator('#player-list button', { hasText: 'Kick' }).count());
  await removeBtns.last().click(); await friend.waitForTimeout(300); // non-admin can remove a bot
  await admin.waitForTimeout(400);
  await admin.screenshot({ path: `${SHOTS}/1-lobby-admin.png` });
  await friend.screenshot({ path: `${SHOTS}/2-lobby-mobile.png` });
  const count = await admin.locator('#player-list li').count();
  console.log('players in lobby:', count);
  if (count !== 5) throw new Error('expected 5 players');

  // start
  await admin.click('#btn-start');
  await admin.waitForSelector('#game', { state: 'visible' });
  await friend.waitForSelector('#game', { state: 'visible' });
  console.log('game started');

  // friend uploads a custom image theme and queues it
  const png = require('node:fs').readFileSync(process.env.THEME_IMG || '/tmp/shots/theme-test.jpg');
  await friend.click('#btn-theme');
  friend.once('dialog', d => d.accept('Test Beach'));
  await friend.setInputFiles('#theme-file', { name: 'beach.jpg', mimeType: 'image/jpeg', buffer: png });
  await friend.waitForTimeout(1500);
  const customCount = await friend.locator('#custom-theme-list .theme-opt').count();
  console.log('custom themes listed:', customCount);
  if (customCount !== 1) throw new Error('custom theme not listed');
  await friend.click('#custom-theme-list .theme-opt');
  await friend.waitForTimeout(300);

  // play: whenever an action bar shows for either human, act (call/check mostly, raise sometimes)
  let acts = 0, themeSwitched = false, sawTimer = false;
  const t0 = Date.now();
  async function maybeAct(page, who) {
    const ab = page.locator('#action-bar');
    if (!(await ab.isVisible())) return false;
    const call = ab.locator('[data-act=call]'), check = ab.locator('[data-act=check]'), raise = ab.locator('[data-act=raise]');
    const r = Math.random();
    if (r < 0.15 && await raise.isVisible()) { await page.click('[data-preset=pot]'); await raise.click(); }
    else if (await check.isVisible()) await check.click();
    else if (r < 0.75) await call.click();
    else await ab.locator('[data-act=fold]').click();
    acts++;
    return true;
  }
  while (Date.now() - t0 < 90000) {
    await maybeAct(admin, 'admin');
    await maybeAct(friend, 'friend');
    const theme = await friend.evaluate(() => document.documentElement.dataset.customBg ? 'custom' : document.documentElement.dataset.theme);
    if (theme === 'custom' && !themeSwitched) { themeSwitched = true; console.log('theme switched to city after', Math.round((Date.now() - t0) / 1000), 's'); await admin.screenshot({ path: `${SHOTS}/3-game-city.png` }); await friend.screenshot({ path: `${SHOTS}/4-game-mobile.png` }); }
    const hn = await admin.evaluate(() => document.querySelector('#blinds-pill').textContent);
    if (/Hand #6/.test(hn)) break;
    await admin.waitForTimeout(400);
  }
  console.log('human actions taken:', acts, 'themeSwitched:', themeSwitched);
  const handTxt = await admin.locator('#my-hand').textContent().catch(() => '');
  console.log('my-hand strip:', handTxt);
  // admin deletes the custom theme -> table falls back to felt
  await admin.click('#btn-theme'); admin.once('dialog', d => d.accept()); await admin.click('#custom-theme-list .tdel'); await admin.waitForTimeout(500);
  console.log('theme after delete:', await admin.evaluate(() => document.documentElement.dataset.customBg ? 'custom' : document.documentElement.dataset.theme));
  await admin.mouse.click(5, 400); await admin.waitForTimeout(200);
  await admin.screenshot({ path: `${SHOTS}/5-game-admin.png` });
  // dark/light + side panel
  await admin.click('#btn-mode'); await admin.click('#btn-side'); await admin.waitForTimeout(300);
  await admin.screenshot({ path: `${SHOTS}/6-light-side.png` });
  const logLines = await admin.locator('.log-line').count();
  console.log('log lines:', logLines);
  // end game
  admin.once('dialog', d => d.accept());
  await admin.click('#btn-end');
  await admin.waitForSelector('#lobby', { state: 'visible' });
  await admin.waitForTimeout(300);
  await admin.screenshot({ path: `${SHOTS}/7-summary.png` });
  const summaryRows = await admin.locator('.summary-table tr').count();
  console.log('summary rows:', summaryRows);
  // profile persistence: reload friend, avatar/name stays
  await friend.reload(); await friend.waitForSelector('#lobby', { state: 'visible' });
  console.log('friend avatar after reload:', await friend.locator('#me-avatar').textContent());
  await browser.close();
  if (!themeSwitched) throw new Error('theme never switched');
  console.log('E2E OK');
})().catch(e => { console.error('E2E FAILED', e); process.exit(1); });
