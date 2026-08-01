/* ─────────────────────────────────────
   REGRESSION TEST — issue #293: Full Resync moved to a page footer, and a
   nudge popup for scorers who keep hitting Refresh without it helping.

   Follow-up to #290, which put the "↻ Full Resync" button in the sync bar
   next to Refresh -- feedback was that it read as an everyday control
   there and confused scorers who didn't need it. This checks:

     1. The button is no longer in the sync bar, and instead lives in a
        new `.app-footer` at the bottom of the page content (a sibling of
        every .sc-panel, so it's reachable from whichever tab is open).

     2. noteManualRefresh() -- a scorer tapping Refresh repeatedly with
        nothing changing is exactly the case Full Resync solves and
        Refresh can't (a device whose cursor is already caught up, so
        Refresh has nothing new to fetch) -- shows a dismissable
        "#resync-nudge-modal" after REFRESH_NUDGE_COUNT manual refreshes
        inside REFRESH_NUDGE_WINDOW_MS, not before. "Not Now" dismisses
        without triggering a resync; "Resync Now" calls forceFullResync()
        directly. The counter resets after firing so the very next tap
        doesn't immediately re-trigger it.

   Self-contained: in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. Never
   touches the real Supabase project.

   Run: node test/repro-293-refresh-nudge.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs, same
   convention as this repo's other Playwright-driven scripts) -- it needs
   Playwright + a browser, which the fast unit suite must not depend on.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE_HOST_GLOB = '**wtyyarvyscbrrkawjcvo**';

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
        const filePath = path.join(ROOT, urlPath === '/' ? '/scorecard-live.html' : urlPath);
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

async function routeSupabase(route) {
  const req = route.request();
  const url = new URL(req.url());
  if (url.pathname === '/rest/v1/tournament_updates' && req.method() === 'GET') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return;
  }
  await route.fulfill({ status: 404, body: '{}' });
}

function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.route(SUPABASE_HOST_GLOB, routeSupabase);
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    // ── Part 1: Full Resync lives in the footer, not the sync bar ──
    const placement = await page.evaluate(() => ({
      inSyncBar: !!document.querySelector('.sync-bar .resync-btn'),
      inFooter: !!document.querySelector('.app-footer .resync-btn'),
      footerIsSiblingOfPanels: document.querySelector('.app-footer')?.parentElement === document.querySelector('.sc-panel').parentElement
    }));
    if (placement.inSyncBar) fail('expected the Full Resync button to be gone from the sync bar');
    if (!placement.inFooter) fail('expected the Full Resync button to be in .app-footer');
    if (!placement.footerIsSiblingOfPanels) fail('expected .app-footer to be a sibling of the .sc-panel tabs, not nested inside just one of them');

    // ── Part 2: the repeated-refresh nudge ──
    const nudgeHidden = async () => page.evaluate(() => document.getElementById('resync-nudge-modal').classList.contains('hidden'));

    if (!(await nudgeHidden())) fail('expected the nudge modal hidden on a fresh load');

    const refreshCount = await page.evaluate(() => REFRESH_NUDGE_COUNT);
    if (typeof refreshCount !== 'number' || refreshCount < 2) fail(`expected REFRESH_NUDGE_COUNT to be a sane small number, got ${refreshCount}`);

    // One tap short of the threshold -- must not show yet.
    for (let i = 0; i < refreshCount - 1; i++) {
      await page.evaluate(() => manualRefresh(document.querySelector('.refresh-btn')));
      await page.waitForTimeout(30);
    }
    if (!(await nudgeHidden())) fail(`expected the nudge to stay hidden after only ${refreshCount - 1} manual refreshes`);

    // The Nth tap crosses the threshold -- must show.
    await page.evaluate(() => manualRefresh(document.querySelector('.refresh-btn')));
    await page.waitForTimeout(30);
    if (await nudgeHidden()) fail(`expected the nudge to show after ${refreshCount} manual refreshes inside the window`);

    // "Not Now" dismisses without triggering a resync (no reload, no
    // cursor wipe) -- and the counter must have reset, so it takes a
    // fresh full count of refreshes to show again, not just one more.
    await page.evaluate(() => localStorage.setItem('wongaCup2026_lastSync', '2026-01-01T00:00:00.000Z'));
    await page.click('.resync-nudge-btn.sec'); // "Not Now"
    const afterDismiss = await page.evaluate(() => ({
      hidden: document.getElementById('resync-nudge-modal').classList.contains('hidden'),
      lastSync: localStorage.getItem('wongaCup2026_lastSync')
    }));
    if (!afterDismiss.hidden) fail('expected "Not Now" to hide the nudge modal');
    if (afterDismiss.lastSync !== '2026-01-01T00:00:00.000Z') fail('expected "Not Now" to leave the sync cursor untouched (no resync triggered)');

    await page.evaluate(() => manualRefresh(document.querySelector('.refresh-btn')));
    await page.waitForTimeout(30);
    if (!(await nudgeHidden())) fail('expected a single refresh right after a dismissed nudge to NOT immediately re-trigger it (the counter must have reset)');

    // ── Part 3: "Resync Now" calls forceFullResync() directly ──
    for (let i = 0; i < refreshCount - 1; i++) {
      await page.evaluate(() => manualRefresh(document.querySelector('.refresh-btn')));
      await page.waitForTimeout(30);
    }
    await page.evaluate(() => {
      window.confirm = () => true; // no pendingWrites queued, so forceFullResync() only asks the generic confirm
      localStorage.setItem('wongaCup2026_lastSync', '2026-01-01T00:00:00.000Z');
    });
    await page.evaluate(() => manualRefresh(document.querySelector('.refresh-btn')));
    await page.waitForTimeout(30);
    if (await nudgeHidden()) fail('setup failed: expected the nudge visible before testing "Resync Now"');
    await page.click('.resync-nudge-btn.primary'); // "Resync Now"
    await page.waitForTimeout(600); // forceFullResync()'s internal 500ms toast delay before resyncFromScratch()

    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(300);
      const rs = await page.evaluate(() => document.readyState).catch(() => 'loading');
      if (rs === 'complete') break;
    }
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});
    const afterResyncNow = await page.evaluate(() => localStorage.getItem('wongaCup2026_lastSync')).catch(e => { fail('evaluate after "Resync Now" failed: ' + e.message); });
    if (afterResyncNow === '2026-01-01T00:00:00.000Z') fail('expected "Resync Now" to actually trigger a full resync (cursor cleared/rebuilt), but it was left untouched');

    console.log('All #293 refresh-nudge assertions passed.');
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
