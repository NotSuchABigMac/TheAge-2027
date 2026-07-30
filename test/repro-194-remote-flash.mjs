/* ─────────────────────────────────────
   REGRESSION TEST — issue #194: remote changes flash instead of teleport.

   When the poll applies another device's row, the value used to mutate
   silently. This drives the real Day 1 hole grid and checks:

     - a genuinely remote row (different updated_by, newer than page
       load) flashes the corresponding cell and sets a "changed · name"
       title/aria-label
     - a row authored by THIS device (own username) never flashes --
       otherwise every one of your own writes echoing back through the
       next poll would "flash" your own screen for no reason
     - a from-epoch row (older than page load -- the initial sync, or a
       post-rollback full replay) never flashes, so first load doesn't
       light up every cell on the page
     - a currently-focused input is never flashed (nothing visibly
       changed there; safeSetInput() already refuses to overwrite it)

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (this feature doesn't need real
   Supabase traffic -- it calls the app's own applyUpdate()/
   flushRemoteFlashes() directly to simulate a poll delivering rows).

   Run: node test/repro-194-remote-flash.mjs
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

    // 1. A genuinely remote row (different author, newer than page load)
    // flashes the cell and labels it.
    const remoteResult = await page.evaluate(() => {
      const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: 8, updated_by: 'Davo', updated_at: new Date(Date.now() + 1000).toISOString() };
      applyUpdate(row);
      flushRemoteFlashes();
      const el = document.getElementById('day1-in-0-A-1');
      return { flashed: el.classList.contains('remote-flash'), title: el.title, ariaLabel: el.getAttribute('aria-label') };
    });
    if (!remoteResult.flashed) fail('expected a remote row to add the remote-flash class');
    if (remoteResult.title !== 'changed · Davo') fail(`expected title "changed · Davo", got "${remoteResult.title}"`);
    if (remoteResult.ariaLabel !== 'changed · Davo') fail(`expected aria-label "changed · Davo", got "${remoteResult.ariaLabel}"`);

    // Fade completes (or the reduced-motion fallback timer fires) and the
    // flash classes are cleaned up afterwards.
    await page.waitForTimeout(2200);
    const cleanedUp = await page.evaluate(() => !document.getElementById('day1-in-0-A-1').classList.contains('remote-flash'));
    if (!cleanedUp) fail('expected the remote-flash class to be cleaned up after the fade');

    // 2. This device's OWN write must never flash its own screen.
    const ownResult = await page.evaluate(() => {
      const el = document.getElementById('day1-in-0-A-2');
      el.classList.remove('remote-flash');
      const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: 5, updated_by: currentUsername, updated_at: new Date(Date.now() + 1000).toISOString() };
      applyUpdate(row);
      flushRemoteFlashes();
      return el.classList.contains('remote-flash');
    });
    if (ownResult) fail("expected this device's own write to never flash");

    // 3. A from-epoch row (older than page load) must never flash -- the
    // initial sync / a post-rollback full replay must not light up cells.
    const staleResult = await page.evaluate(() => {
      const el = document.getElementById('day1-in-0-A-3');
      el.classList.remove('remote-flash');
      const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A3', value: 4, updated_by: 'Davo', updated_at: new Date(Date.now() - 60000).toISOString() };
      applyUpdate(row);
      flushRemoteFlashes();
      return el.classList.contains('remote-flash');
    });
    if (staleResult) fail('expected a from-epoch (pre-page-load) row to never flash');

    // 4. A focused input is never flashed (safeSetInput already skips it;
    // nothing visibly changed there to flash).
    const focusedResult = await page.evaluate(() => {
      const el = document.getElementById('day1-in-0-A-4');
      el.focus();
      const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A4', value: 6, updated_by: 'Davo', updated_at: new Date(Date.now() + 1000).toISOString() };
      applyUpdate(row);
      flushRemoteFlashes();
      return el.classList.contains('remote-flash');
    });
    if (focusedResult) fail('expected a currently-focused input to never flash');

    console.log('All #194 remote-flash assertions passed.');
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
