/* ─────────────────────────────────────
   REGRESSION TEST — pwa-admin-lock-positioning: the per-day admin lock
   control ("Lock Day" / "Admin: manage lock") used to sit at the TOP of
   each Day panel, right under the section header. It's been moved to the
   BOTTOM of each panel (last element, after that day's scoring content),
   matching the app-footer's out-of-the-way pattern (issue #293). This
   also adds a PWA "Install App" button to the app-footer, hidden until
   the browser fires `beforeinstallprompt`.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - day1-lock-row / day2-lock-row / day3-lock-row are each the LAST
       child of their .sc-panel, not near the top
     - #pwa-install-btn is hidden on load
     - dispatching a synthetic `beforeinstallprompt` event reveals it in
       the app-footer, and clicking it calls the captured event's
       .prompt()

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
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(require.resolve('playwright')); } catch { /* no local install */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(`${globalRoot}/playwright/index.js`);
  } catch { /* npm unavailable */ }
  for (const c of candidates) {
    try {
      const mod = await import(c);
      const resolved = mod.chromium ? mod : mod.default;
      if (resolved?.chromium) return resolved.chromium;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Could not resolve Playwright locally or via `npm root -g`.');
}

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

function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
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
