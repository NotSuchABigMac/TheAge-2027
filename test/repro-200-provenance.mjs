/* ─────────────────────────────────────
   REGRESSION TEST — issue #200 follow-up: focus a filled score field to
   see its last 3 changes.

   The original design showed a single "who/when" popover on a long-press,
   deliberately separate from tap-to-focus-and-edit. That gesture turned
   out to be unreliable on real touch input (a finger drifts a few pixels
   even while held still, cancelling the timer before it fired), so the
   feature now triggers on an ordinary focus of a field that already has
   a value, and shows its last 3 recorded changes instead of just the
   latest one. Drives the real Day 1 hole grid and checks:

     - focusing a filled field fetches and shows its last 3 changes
       (value, who, when), most recent first
     - focusing a field with no value yet shows nothing -- a scorer
       entering fresh scores shouldn't get a panel on every hole
     - blurring the field (tapping away) dismisses the panel

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked by default, with one route fulfilled with
   canned data standing in for this field's history so the test never
   depends on real Supabase data.

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

const MOCK_HISTORY_ROWS = [
  { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '5', updated_by: 'Gary King', updated_at: new Date().toISOString() },
  { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '6', updated_by: 'Dave Lyons', updated_at: new Date(Date.now() - 3600e3).toISOString() },
  { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4', updated_by: 'Gary King', updated_at: new Date(Date.now() - 7200e3).toISOString() }
];

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
    await page.route('**wtyyarvyscbrrkawjcvo**', route => {
      const req = route.request();
      const reqUrl = req.url();
      if (req.method() === 'GET' && reqUrl.includes('/rest/v1/tournament_updates') &&
          reqUrl.includes('update_type=eq.day1_hole') && reqUrl.includes('field_key=eq.A1')) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_HISTORY_ROWS) });
      }
      return route.abort();
    });
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

    // day1-in-0-A-1 ends up with field_key 'A1', matching the mocked route.
    await page.evaluate(() => setHoleScore(0, 'A', 1, '5'));

    // 1. Focusing a field with no value yet shows nothing.
    await page.locator('#day1-in-0-A-2').scrollIntoViewIfNeeded();
    await page.locator('#day1-in-0-A-2').focus();
    await page.waitForTimeout(150);
    const emptyFieldShown = await page.evaluate(() => document.getElementById('field-history-panel').classList.contains('show'));
    if (emptyFieldShown) fail('expected focusing an empty field to show no history panel');
    await page.locator('#day1-in-0-A-2').blur();

    // 2. Focusing the filled field shows its last 3 changes, most recent first.
    await page.locator('#day1-in-0-A-1').scrollIntoViewIfNeeded();
    await page.locator('#day1-in-0-A-1').focus();
    await page.waitForTimeout(200);
    const afterFocus = await page.evaluate(() => {
      const panel = document.getElementById('field-history-panel');
      const rows = Array.from(panel.querySelectorAll('.field-history-row')).map(r => r.textContent);
      return { shown: panel.classList.contains('show'), rows };
    });
    if (!afterFocus.shown) fail('expected focusing a filled field to show the field-history panel');
    if (afterFocus.rows.length !== 3) fail(`expected 3 history rows, got ${afterFocus.rows.length}: ${JSON.stringify(afterFocus.rows)}`);
    if (!/5/.test(afterFocus.rows[0]) || !/Gary King/.test(afterFocus.rows[0])) fail(`expected row 1 to show value 5 · Gary King, got "${afterFocus.rows[0]}"`);
    if (!/6/.test(afterFocus.rows[1]) || !/Dave Lyons/.test(afterFocus.rows[1])) fail(`expected row 2 to show value 6 · Dave Lyons, got "${afterFocus.rows[1]}"`);
    if (!/4/.test(afterFocus.rows[2]) || !/Gary King/.test(afterFocus.rows[2])) fail(`expected row 3 to show value 4 · Gary King, got "${afterFocus.rows[2]}"`);

    // 3. Blurring (tapping away) dismisses the panel.
    await page.mouse.click(10, 10);
    await page.waitForTimeout(50);
    const afterBlur = await page.evaluate(() => document.getElementById('field-history-panel').classList.contains('show'));
    if (afterBlur) fail('expected blurring the field to dismiss the field-history panel');

    console.log('All #200 field-history-panel assertions passed.');
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
