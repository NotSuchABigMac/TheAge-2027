/* ─────────────────────────────────────
   REGRESSION TEST — issue #200: tap a score to see who entered it and
   when.

   Provenance (updated_by/updated_at) is already synced to every device
   but wasn't surfaced anywhere outside the Admin tab. Drives the real
   Day 1 hole grid and checks:

     - entering a score records optimistic local provenance immediately
       (before any poll), attributed to the current user
     - long-pressing (~500ms pointer hold) the cell shows a popover with
       the "{time} · {name}" text
     - a genuine tap (pointerdown followed quickly by pointerup) does NOT
       show the popover -- it must not fight normal tap-to-focus
     - long-press never triggers while the input is already focused (a
       scorer mid-entry, not someone asking "who set this")
     - tapping away dismisses the popover

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (this feature doesn't need real
   Supabase traffic -- it calls the app's own functions directly to
   simulate a remote row's provenance).

   Run: node test/repro-200-provenance.mjs
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
    await page.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });
    await page.evaluate(() => {
      setMatchPlayer(0, 'A', 0, '0');
      setMatchPlayer(0, 'B', 0, '1');
      document.querySelector('.hole-grid-details').open = true;
    });
    await page.waitForTimeout(100);

    // 1. Entering a score records optimistic local provenance immediately.
    await page.evaluate(() => setHoleScore(0, 'A', 1, '5'));
    const recorded = await page.evaluate(() => {
      const coord = coordForElement(document.getElementById('day1-in-0-A-1'));
      return provenance[undoCoordKey(coord)];
    });
    if (!recorded || recorded.updated_by !== 'Gary King') fail(`expected optimistic provenance for Gary King, got ${JSON.stringify(recorded)}`);

    // 2. Long-press (~500ms hold) shows the popover with "{time} · {name}".
    await page.locator('#day1-in-0-A-1').scrollIntoViewIfNeeded();
    const box = await page.locator('#day1-in-0-A-1').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    const afterHold = await page.evaluate(() => ({
      shown: document.getElementById('provenance-popover').classList.contains('show'),
      text: document.getElementById('provenance-popover').textContent
    }));
    await page.mouse.up();
    if (!afterHold.shown) fail('expected the provenance popover to show after a ~500ms long-press');
    if (!/Gary King/.test(afterHold.text)) fail(`expected the popover to name Gary King, got "${afterHold.text}"`);

    // Tapping away dismisses it.
    await page.mouse.click(10, 10);
    await page.waitForTimeout(50);
    const afterTapAway = await page.evaluate(() => document.getElementById('provenance-popover').classList.contains('show'));
    if (afterTapAway) fail('expected tapping away to dismiss the provenance popover');

    // 3. A genuine quick tap (hold well under 500ms) does NOT show the popover.
    await page.evaluate(() => document.getElementById('day1-in-0-A-2').blur());
    await page.locator('#day1-in-0-A-2').scrollIntoViewIfNeeded();
    const box2 = await page.locator('#day1-in-0-A-2').boundingBox();
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(80);
    await page.mouse.up();
    await page.waitForTimeout(50);
    const afterQuickTap = await page.evaluate(() => document.getElementById('provenance-popover').classList.contains('show'));
    if (afterQuickTap) fail('expected a genuine quick tap to NOT show the provenance popover');

    // 4. Long-press never triggers while the input is already focused.
    await page.evaluate(() => document.getElementById('day1-in-0-A-3').focus());
    await page.locator('#day1-in-0-A-3').scrollIntoViewIfNeeded();
    const box3 = await page.locator('#day1-in-0-A-3').boundingBox();
    await page.mouse.move(box3.x + box3.width / 2, box3.y + box3.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    const whileFocused = await page.evaluate(() => document.getElementById('provenance-popover').classList.contains('show'));
    if (whileFocused) fail('expected long-press on an already-focused input to never show the popover');

    console.log('All #200 provenance-popover assertions passed.');
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
