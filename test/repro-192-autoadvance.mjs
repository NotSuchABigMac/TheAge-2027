/* ─────────────────────────────────────
   REGRESSION TEST — issue #192: hole-grid auto-advance + outlier nudge.

   Scores are 1-15 (DAY1_GROSS_MAX/DAY2_HOLE_GROSS_MAX), so a lone "1" is
   genuinely ambiguous -- it could be the whole score, or the first digit
   of 10-15. This drives the real Day 1 hole grid via actual keystrokes
   (not a single programmatic .fill(), which wouldn't exercise the
   per-digit oninput logic) and checks:

     - a leading digit 2-9 advances focus to the next hole immediately
     - a lone "1" waits (~400ms) for a possible second digit before
       advancing, so 10-15 can still be typed as a normal two-keystroke
       sequence
     - a double-digit entry advances immediately without waiting
     - a double-digit gross score (10-15) triggers the soft "seems very
       high" nudge toast, without blocking or reverting the entry

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (this feature touches neither, but
   every Playwright test in this repo blocks them regardless).

   Run: node test/repro-192-autoadvance.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs, same
   convention as this repo's other Playwright-driven scripts) -- it needs
   Playwright + a browser, which the fast unit suite must not depend on.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE_HOST_GLOB = '**wtyyarvyscbrrkawjcvo**';


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
  const method = req.method();
  if (method === 'GET') { await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); return; }
  if (method === 'POST') { await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); return; }
  await route.fulfill({ status: 404, body: '{}' });
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

    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });

    // Assign both players to match 0 so the hole grid actually renders,
    // then open its <details> panel (collapsed by default).
    await page.evaluate(() => {
      setMatchPlayer(0, 'A', 0, '0');
      setMatchPlayer(0, 'B', 0, '1');
      document.querySelector('.hole-grid-details').open = true;
    });
    await page.waitForTimeout(100);

    // 1. Leading digit 2-9: advances immediately, no waiting.
    await page.click('#day1-in-0-A-1');
    await page.locator('#day1-in-0-A-1').pressSequentially('7', { delay: 30 });
    await page.waitForTimeout(80);
    const focusedAfter7 = await page.evaluate(() => document.activeElement.id);
    if (focusedAfter7 !== 'day1-in-0-A-2') fail(`expected typing "7" to advance immediately to hole 2, focus is on ${focusedAfter7}`);

    // 2. A lone "1": must NOT advance immediately (10-15 still possible).
    await page.click('#day1-in-0-A-3');
    await page.locator('#day1-in-0-A-3').pressSequentially('1', { delay: 30 });
    await page.waitForTimeout(80);
    const focusedRightAfter1 = await page.evaluate(() => document.activeElement.id);
    if (focusedRightAfter1 !== 'day1-in-0-A-3') {
      fail(`expected a lone "1" to NOT advance immediately, focus already moved to ${focusedRightAfter1}`);
    }
    // ...but does advance once the ~400ms window elapses with no second digit.
    await page.waitForTimeout(450);
    const focusedAfter1Timeout = await page.evaluate(() => document.activeElement.id);
    if (focusedAfter1Timeout !== 'day1-in-0-A-4') {
      fail(`expected a lone "1" to advance after the wait window, focus is on ${focusedAfter1Timeout}`);
    }

    // 3. Typing "1" then a second digit quickly: advances immediately as
    // soon as the second digit lands (this is the actual 10-15 case the
    // ambiguity exists for), not clamped or blocked.
    await page.click('#day1-in-0-A-5');
    await page.locator('#day1-in-0-A-5').pressSequentially('13', { delay: 30 });
    await page.waitForTimeout(80);
    const focusedAfter13 = await page.evaluate(() => document.activeElement.id);
    if (focusedAfter13 !== 'day1-in-0-A-6') fail(`expected "13" to advance immediately to hole 6, focus is on ${focusedAfter13}`);
    const valueOfHole5 = await page.evaluate(() => document.getElementById('day1-in-0-A-5').value);
    if (valueOfHole5 !== '13') fail(`expected hole 5's committed value to be "13", got "${valueOfHole5}"`);

    // 4. The outlier nudge: a double-digit score shows the soft, non-
    // blocking "seems very high" toast (delayed so it doesn't clobber the
    // save-confirmation toast) without altering the stored value.
    await page.waitForTimeout(2400);
    const toast = await page.evaluate(() => {
      const el = document.getElementById('save-toast');
      return { text: el.textContent, isNudge: el.classList.contains('nudge'), isShown: el.classList.contains('show') };
    });
    if (!toast.isNudge || !toast.isShown) fail(`expected the outlier nudge toast to be showing, got ${JSON.stringify(toast)}`);
    if (!/seems very high/i.test(toast.text)) fail(`expected the nudge toast text to mention the high score, got "${toast.text}"`);
    const finalValueOfHole5 = await page.evaluate(() => document.getElementById('day1-in-0-A-5').value);
    if (finalValueOfHole5 !== '13') fail(`expected the nudge to not alter the stored value, got "${finalValueOfHole5}"`);

    console.log('All #192 auto-advance/outlier-nudge assertions passed.');
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
