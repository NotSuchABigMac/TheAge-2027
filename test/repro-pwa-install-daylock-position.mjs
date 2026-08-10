/* ─────────────────────────────────────
   REGRESSION TEST — pwa-admin-lock-positioning: the per-day admin lock
   control ("Lock Day" / "Admin: manage lock") used to sit at the TOP of
   each Day panel, right under the section header. It's been moved to the
   BOTTOM of each panel (last element, after that day's scoring content),
   matching the app-footer's out-of-the-way pattern (issue #293). This
   also adds a PWA "Install App" button to the app-footer, hidden until
   the browser fires `beforeinstallprompt` -- except no WebKit browser
   (Safari, Chrome, Firefox on iOS all use WebKit under Apple's rules)
   implements that event at all, so iOS gets its own always-visible
   button wired to a manual "Add to Home Screen" instructions modal
   instead.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - day1-lock-row / day2-lock-row / day3-lock-row are each the LAST
       child of their .sc-panel, not near the top
     - #pwa-install-btn is hidden on load
     - dispatching a synthetic `beforeinstallprompt` event reveals it in
       the app-footer, and clicking it calls the captured event's
       .prompt()
     - with an iPhone user agent, #pwa-install-btn is visible without any
       beforeinstallprompt, and clicking it opens #ios-install-modal
       (closable) instead of trying to call .prompt()

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for real.

   Run: node test/repro-pwa-install-daylock-position.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs) --
   it needs Playwright + a browser.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript' };

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = new URL(req.url, 'http://x').pathname;
        const filePath = path.join(ROOT, urlPath);
        const body = await readFile(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(body);
      } catch (e) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}


async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const base = `http://127.0.0.1:${sitePort}/scorecard-live.html?demo=1`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });
    page.on('dialog', (dialog) => dialog.accept('test-admin-pin'));

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre'; // one of ADMIN_NAMES
      currentWriteToken = 'test-token';
      updateAdminVisibility();
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    // 1. The day-lock row must be the LAST element of each Day panel, not
    // sitting near the top under the section header.
    for (const day of [1, 2, 3]) {
      await page.click(`#tab-day${day}`);
      await page.waitForTimeout(150);
      const isLast = await page.evaluate((d) => {
        const panel = document.getElementById(`sc-day${d}`);
        const row = document.getElementById(`day${d}-lock-row`);
        return !!panel && !!row && panel.lastElementChild === row;
      }, day);
      if (!isLast) fail(`expected day${day}-lock-row to be the last element of sc-day${day} (bottom of the panel)`);
    }

    // 2. The lock control itself still works from its new position --
    // clicking the on-demand "Admin: manage lock" button on Day 1 prompts
    // for the PIN and swaps in the real Lock Day control.
    await page.click('#tab-day1');
    await page.waitForTimeout(150);
    const beforeUnlock = await page.evaluate(() => document.getElementById('day1-lock-row')?.textContent || '');
    if (!/Admin: manage lock/.test(beforeUnlock)) fail(`expected the on-demand admin button on Day 1, got "${beforeUnlock}"`);
    await page.click('#day1-lock-row button');
    await page.waitForTimeout(150);
    const afterUnlock = await page.evaluate(() => document.getElementById('day1-lock-row')?.textContent || '');
    if (!/^Lock Day$/.test(afterUnlock.trim())) fail(`expected the real "Lock Day" control after entering the PIN, got "${afterUnlock}"`);

    // 3. The PWA install button lives in the app-footer, hidden until the
    // browser offers to install, then wires through to the captured
    // event's prompt() on click.
    const initialDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('pwa-install-btn')).display);
    if (initialDisplay !== 'none') fail(`expected #pwa-install-btn hidden on load, got display:${initialDisplay}`);

    await page.evaluate(() => {
      window.__promptCalled = false;
      const ev = new Event('beforeinstallprompt', { cancelable: true });
      ev.prompt = () => { window.__promptCalled = true; };
      ev.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(ev);
    });
    await page.waitForTimeout(100);
    const shownDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('pwa-install-btn')).display);
    if (shownDisplay === 'none') fail('expected #pwa-install-btn to become visible after beforeinstallprompt fires');

    await page.click('#pwa-install-btn');
    await page.waitForTimeout(100);
    const { promptCalled, hiddenAfterClick } = await page.evaluate(() => ({
      promptCalled: window.__promptCalled,
      hiddenAfterClick: getComputedStyle(document.getElementById('pwa-install-btn')).display === 'none',
    }));
    if (!promptCalled) fail('expected clicking #pwa-install-btn to call the captured beforeinstallprompt event\'s prompt()');
    if (!hiddenAfterClick) fail('expected #pwa-install-btn to hide itself again once the install prompt has been actioned');

    // 4. On iOS (no beforeinstallprompt exists there at all) the same
    // button is visible unconditionally and opens the manual "Add to Home
    // Screen" instructions instead of trying to call .prompt() on nothing.
    const iosContext = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await iosContext.route('**fonts.googleapis.com**', route => route.abort());
    await iosContext.route('**fonts.gstatic.com**', route => route.abort());
    const iosPage = await iosContext.newPage();
    await iosPage.route('**wtyyarvyscbrrkawjcvo**', (route) => route.abort());
    await iosPage.goto(base, { waitUntil: 'domcontentloaded' });
    await iosPage.waitForTimeout(300);
    await iosPage.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await iosPage.waitForTimeout(200);

    const iosBtnDisplay = await iosPage.evaluate(() => getComputedStyle(document.getElementById('pwa-install-btn')).display);
    if (iosBtnDisplay === 'none') fail('expected #pwa-install-btn visible on an iPhone user agent with no beforeinstallprompt');

    await iosPage.click('#pwa-install-btn');
    await iosPage.waitForTimeout(150);
    const iosModalVisible = await iosPage.evaluate(() => !document.getElementById('ios-install-modal').classList.contains('hidden'));
    if (!iosModalVisible) fail('expected clicking #pwa-install-btn on iOS to open #ios-install-modal');

    await iosPage.click('#ios-install-modal .help-modal-close');
    await iosPage.waitForTimeout(150);
    const iosModalClosed = await iosPage.evaluate(() => document.getElementById('ios-install-modal').classList.contains('hidden'));
    if (!iosModalClosed) fail('expected #ios-install-modal to close again');
    await iosContext.close();

    console.log('All pwa-install/day-lock-position assertions passed.');
  } catch (e) {
    console.log('Error:', e.message);
    ok = false;
  } finally {
    await browser.close();
    site.close();
  }
  process.exit(ok ? 0 : 1);
}

main();
