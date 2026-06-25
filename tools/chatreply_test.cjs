#!/usr/bin/env node
/* Verify the AI-chat reply feature + cloud-sync short-circuit wiring. */
const { chromium } = require('playwright');
const path = require('path');
const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + (e.message||e)));
  await page.goto(FILE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window._KH, null, { timeout: 15000 });

  const r = await page.evaluate(() => {
    const out = {};
    try {
      window._KH.S.onboardingDone = true;
      showView('chat');
      out.chatLog = !!document.getElementById('chatLog');
      out.replyStrip = !!document.getElementById('aiReplyStrip');
      // add an AI message
      addBotMsg('The capital of France is Paris.');
      // find the Reply button under it
      const btns = [...document.querySelectorAll('#chatLog button')].filter(b => /Reply/.test(b.textContent));
      out.replyBtnCount = btns.length;
      // click it
      if (btns.length) btns[btns.length-1].click();
      const strip = document.getElementById('aiReplyStrip');
      out.stripVisibleAfterClick = strip ? getComputedStyle(strip).display !== 'none' : false;
      // strip label proves _setAiReply captured the (module-scoped) context
      out.stripLabel = (document.getElementById('aiReplyStripLabel')||{}).textContent || '';
      out.replyCtxSet = /The capital of France is Paris/.test(out.stripLabel);
      // user bubble renders a quote line when given a reply ctx
      addUserMsg('Are you sure?', {text:'The capital of France is Paris.', who:'AI'});
      const quote = [...document.querySelectorAll('#chatLog div')].some(d => /↩ AI: The capital/.test(d.textContent||''));
      out.userQuoteRendered = quote;
      // cancel clears the strip
      _clearAiReply();
      const strip2 = document.getElementById('aiReplyStrip');
      out.ctxClearedAfterCancel = strip2 ? getComputedStyle(strip2).display === 'none' : false;
      // cloud sync function still has new signature
      out.doCloudSyncArity = (typeof _doCloudSync === 'function') ? _doCloudSync.length : -1;
    } catch(e) { out.err = String(e); }
    return out;
  });

  await browser.close();
  console.log(JSON.stringify(r, null, 2));
  console.log('pageerrors:', errs.length ? errs : 'none');
  const ok = r.chatLog && r.replyStrip && r.replyBtnCount>0 && r.stripVisibleAfterClick &&
             r.replyCtxSet && r.userQuoteRendered && r.ctxClearedAfterCancel && !r.err && !errs.length;
  console.log(ok ? '\n✅ CHAT REPLY OK' : '\n❌ CHAT REPLY FAILED');
  process.exit(ok ? 0 : 1);
})();
