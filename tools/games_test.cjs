#!/usr/bin/env node
/* Headless smoke test: launch every game, capture pageerrors/console errors.
   Usage: NODE_PATH=/opt/node22/lib/node_modules node tools/games_test.cjs */
const { chromium } = require('playwright');
const path = require('path');

const GAMES = ['hangman','memory','ttt','connect4','wordle','minesweeper','sudoku',
  'snake','slither','g2048','tetris','spaceinv','solitaire','towerdef','chess','checkers',
  'battleship','lightsout','snakesladders','wordsearch','candycrush','mastermind',
  'dotsboxes','blockblast','racer','digquest','hanoi','blackjack','crazy8'];

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 420, height: 720 } });

  const errors = [];
  const NET_NOISE = /ERR_TUNNEL|Failed to load resource|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::|favicon/i;
  page.on('pageerror', e => errors.push('[PAGEERROR] ' + (e.message || e)));
  page.on('console', m => { if (m.type() === 'error' && !NET_NOISE.test(m.text())) errors.push('[CONSOLE] ' + m.text()); });

  await page.goto(FILE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._KH && window._KH.launchGame, null, { timeout: 15000 });
  // mark onboarding done so nothing intercepts
  await page.evaluate(() => { try { window._KH.S.onboardingDone = true; window._KH.saveNow && window._KH.saveNow(); } catch(e){} });

  const report = {};
  for (const g of GAMES) {
    errors.length = 0;
    let launchErr = null;
    try {
      await page.evaluate((id) => {
        // exit any prior immersive
        try { if (typeof exitImmersive === 'function') exitImmersive(); } catch(e){}
        window._KH.launchGame(id);
      }, g);
      await page.waitForTimeout(900);
      // probe: is the immersive overlay actually showing content?
      const info = await page.evaluate(() => {
        const r = document.getElementById('immersiveRoot');
        const c = document.getElementById('immersiveContent');
        return {
          immersiveShown: r ? getComputedStyle(r).display !== 'none' : false,
          contentLen: c ? c.innerHTML.length : 0,
        };
      });
      report[g] = { errors: errors.slice(), info };
    } catch (e) {
      launchErr = String(e);
      report[g] = { errors: errors.slice(), launchErr };
    }
    // reset to a clean state for the next game
    await page.evaluate(() => { try { if (typeof exitImmersive === 'function') exitImmersive(); } catch(e){} });
    await page.waitForTimeout(120);
  }

  await browser.close();

  let bad = 0;
  for (const g of GAMES) {
    const r = report[g];
    const errs = (r.errors || []).filter((e, i, a) => a.indexOf(e) === i);
    const flag = errs.length || r.launchErr || !r.info?.immersiveShown || (r.info && r.info.contentLen < 50);
    if (flag) {
      bad++;
      console.log(`\n❌ ${g}`);
      if (r.launchErr) console.log('   launchErr: ' + r.launchErr);
      if (r.info) console.log(`   immersiveShown=${r.info.immersiveShown} contentLen=${r.info.contentLen}`);
      errs.slice(0, 6).forEach(e => console.log('   ' + e.slice(0, 240)));
    } else {
      console.log(`✅ ${g}  (content ${r.info.contentLen}b)`);
    }
  }
  console.log(`\n${bad} game(s) flagged of ${GAMES.length}`);
})();
