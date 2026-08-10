/* ─────────────────────────────────────
   REGRESSION TEST — issue #313: Day 1/Day 2/Day 3 tabs used to
   proactively prompt for the Admin PIN on arrival, for anyone signed in
   under an organiser name (ADMIN_NAMES) with no cached token yet.
   requireAdminToken() caches nothing on a decline, so cancelling that
   prompt once meant getting prompted again on the very next Day-tab
   click -- indefinitely.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - clicking Day 1, then Day 2, then Day 3 as an organiser-named user
       with no cached admin token fires NO window.prompt() at all
     - each Day tab instead shows an on-demand "Admin: manage lock"
       button
     - clicking that button DOES prompt (exactly once for that click),
       and a successful PIN swaps it for the real Lock Day control

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for real.

   Run: node test/repro-313-day-lock-pin-prompt.mjs
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

    let promptCount = 0;
    let lastPromptResponse = null;
    page.on('dialog', async (dialog) => {
      promptCount++;
      if (dialog.type() !== 'prompt') { await dialog.dismiss(); return; }
      if (lastPromptResponse === null) await dialog.dismiss();
      else await dialog.accept(lastPromptResponse);
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre'; // one of ADMIN_NAMES
      currentWriteToken = 'test-token';
      // A real login goes through completeLogin(), which calls this to
      // reflect the new isAdmin() status into the Day-lock rows -- bypassing
      // the login modal here means doing the same refresh by hand.
      updateAdminVisibility();
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    // 1. Clicking Day 1, Day 2, Day 3 with no cached admin token must NOT
    // pop any prompt() at all -- the old bug fired one on every single
    // click here.
    await page.click('#tab-day1');
    await page.waitForTimeout(150);
    await page.click('#tab-day2');
    await page.waitForTimeout(150);
    await page.click('#tab-day3');
    await page.waitForTimeout(150);
    await page.click('#tab-day1');
    await page.waitForTimeout(150);
    if (promptCount !== 0) fail(`expected NO admin PIN prompt from Day-tab navigation alone, got ${promptCount}`);

    // 2. Each Day tab instead shows an on-demand "Admin: manage lock"
    // button rather than the plain read-only view a non-admin sees.
    const day1RowText = await page.evaluate(() => document.getElementById('day1-lock-row')?.textContent || '');
    if (!/Admin: manage lock/.test(day1RowText)) fail(`expected an on-demand "Admin: manage lock" button on Day 1, got "${day1RowText}"`);

    // 3. Clicking that button DOES prompt (exactly once for this click),
    // and a correct PIN swaps it for the real Lock Day control.
    lastPromptResponse = 'test-admin-pin';
    await page.click('#day1-lock-row button');
    await page.waitForTimeout(150);
    if (promptCount !== 1) fail(`expected exactly ONE prompt from the explicit "Admin: manage lock" click, got ${promptCount}`);
    const afterUnlock = await page.evaluate(() => document.getElementById('day1-lock-row')?.textContent || '');
    if (!/^Lock Day$/.test(afterUnlock.trim())) fail(`expected the real "Lock Day" control after entering the PIN, got "${afterUnlock}"`);

    // 4. Now that the token is cached, switching to Day 2 must not prompt
    // again, and Day 2 should already show the real Lock Day control too.
    await page.click('#tab-day2');
    await page.waitForTimeout(150);
    if (promptCount !== 1) fail(`expected no further prompt once the admin token is cached, got ${promptCount} total`);
    const day2RowText = await page.evaluate(() => document.getElementById('day2-lock-row')?.textContent || '');
    if (!/^Lock Day$/.test(day2RowText.trim())) fail(`expected Day 2 to already show the real Lock Day control once unlocked, got "${day2RowText}"`);

    console.log('All #313 Day-lock on-demand PIN assertions passed.');
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
