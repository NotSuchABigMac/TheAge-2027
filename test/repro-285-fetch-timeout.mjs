/* ─────────────────────────────────────
   REGRESSION TEST — issue #285: a hung Supabase fetch used to wedge sync
   forever.

   Reported as "scores desynced after everyone entered the tournament PIN
   -- other devices show 0-10, mine still shows 0-1" with the reporter's
   own device stuck showing "Syncing..." in the sync-bar, no offline
   banner. Root cause: none of scorecard-live.html's fetch() calls carried
   a timeout. pollOnce() sets syncInFlight = true, awaits
   loadFromSupabase(), and only resets syncInFlight (and flips syncStatus
   to 'offline', which is what makes the loud red #offline-banner appear)
   in its finally block once that await settles. A request that hangs
   (flaky course wifi/cell) never settles -- syncInFlight stays true
   forever, every subsequent 30s tick's pollOnce() early-returns on
   `if (syncInFlight) return`, and the only visible symptom is the
   easy-to-miss grey "Syncing..." sync-bar text, never the offline
   banner, since isOffline is never actually set.

   This test hangs a GET to tournament_updates (never fulfilled or
   aborted -- the request is simply left pending, as a stalled connection
   would leave it) and asserts the app still recovers: syncInFlight
   resets, isOffline flips true, the offline banner becomes visible, and
   a subsequent poll against a working mock succeeds normally.

   Self-contained: in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. Never
   touches the real Supabase project.

   Run: node test/repro-285-fetch-timeout.mjs
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

// Minimal in-memory Supabase mock, same shape as the #191 test's.
function createMockRows() {
  const rows = [];
  return {
    rows,
    select({ tournamentId, cursor }) {
      return rows
        .filter(r => r.tournament_id === tournamentId && r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
    }
  };
}

let hangGets = false;

async function routeSupabase(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (url.pathname === '/rest/v1/tournament_updates' && method === 'GET') {
    if (hangGets) return; // simulate a stalled connection: never fulfill, never abort
    const tournamentId = (url.searchParams.get('tournament_id') || '').replace('eq.', '');
    const cursor = decodeURIComponent((url.searchParams.get('updated_at') || 'gte.1970-01-01').replace('gte.', ''));
    const result = mock.select({ tournamentId, cursor });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
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
  const mock = createMockRows();

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.route(SUPABASE_HOST_GLOB, route => routeSupabase(route, mock));
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // Let the initial pollOnce() (fired unconditionally on load) finish normally.
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    // Now stall every GET and manually trigger a poll -- simulates the
    // flaky-connection window from the bug report. pollOnce() is called
    // directly (rather than waiting up to 30s for the real interval) so
    // the test controls timing precisely.
    hangGets = true;
    const start = Date.now();
    await page.evaluate(() => pollOnce());
    const elapsedMs = Date.now() - start;

    // FETCH_TIMEOUT_MS is 15000 -- the hung request must be aborted around
    // there, not hang indefinitely. Generous upper bound for CI jitter.
    if (elapsedMs > 25000) fail(`expected the hung poll to resolve near the 15s fetch timeout, took ${elapsedMs}ms`);

    const afterHang = await page.evaluate(() => ({
      syncInFlight, isOffline,
      bannerVisible: document.getElementById('offline-banner').style.display === 'block'
    }));
    if (afterHang.syncInFlight !== false) fail('expected syncInFlight to reset to false once the hung fetch times out, not stay wedged forever');
    if (afterHang.isOffline !== true) fail('expected isOffline to be set true once the timed-out fetch is caught as a network failure');
    if (!afterHang.bannerVisible) fail('expected the red #offline-banner to become visible once the timeout is caught -- this is the loud signal the subtle grey "Syncing..." text was never providing');

    // Recovery: once the connection comes back, the very next poll must
    // succeed normally -- the earlier hang must not have left anything
    // (syncInFlight, aborted controllers, etc.) permanently broken.
    hangGets = false;
    await page.evaluate(() => pollOnce());
    const afterRecovery = await page.evaluate(() => ({ syncInFlight, isOffline }));
    if (afterRecovery.syncInFlight !== false) fail('expected syncInFlight false after a normal recovering poll');
    if (afterRecovery.isOffline !== false) fail('expected isOffline false again once a poll actually succeeds');

    console.log('All #285 fetch-timeout assertions passed.');
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
