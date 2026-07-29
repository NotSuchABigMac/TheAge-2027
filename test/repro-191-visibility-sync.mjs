/* ─────────────────────────────────────
   REGRESSION TEST — issue #191: visibility-aware sync.

   Before this fix, scorecard-live.html polled Supabase on a flat 30s
   setInterval regardless of tab visibility: a hidden tab kept burning
   battery/data for no one, and a tab that just came back to the foreground
   could show data up to 30s stale instead of resyncing immediately.

   This test drives the real page (no mocked-out internals) and asserts,
   via the module-level pollingIntervalId/syncInFlight state the app itself
   uses:
     - the interval is running after initial load,
     - going hidden clears it,
     - coming back visible triggers an immediate sync (through the same
       syncInFlight-guarded pollOnce() the interval itself calls) and
       restarts the interval,
     - 'pageshow' (bfcache restores) also triggers an immediate sync while
       visible.

   Self-contained: in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. Never
   touches the real Supabase project.

   Run: node test/repro-191-visibility-sync.mjs
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

// Minimal in-memory Supabase mock. Tracks GET count so the test can tell
// whether a sync actually happened.
function createMockRows() {
  let nextId = 1;
  let getCount = 0;
  const rows = [];
  return {
    rows,
    get getCount() { return getCount; },
    insert(row, { returnId } = {}) {
      const stored = { id: String(nextId++), tournament_id: row.tournament_id, update_type: row.update_type,
        match_idx: row.match_idx ?? null, player_id: row.player_id ?? null, field_key: row.field_key ?? null,
        value: row.value ?? null, updated_by: row.updated_by ?? null, updated_at: new Date().toISOString() };
      rows.push(stored);
      return returnId ? [{ id: stored.id }] : null;
    },
    select({ tournamentId, cursor }) {
      getCount++;
      return rows
        .filter(r => r.tournament_id === tournamentId && r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
    }
  };
}

async function routeSupabase(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (url.pathname === '/rest/v1/tournament_updates' && method === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    const prefer = req.headers()['prefer'] || '';
    const wantsRepresentation = /return=representation/.test(prefer);
    const result = mock.insert(body, { returnId: wantsRepresentation });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(result || []) });
    return;
  }
  if (url.pathname === '/rest/v1/tournament_updates' && method === 'GET') {
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
    // Same rationale as the #212 test: Google Fonts is unreachable in this
    // sandboxed environment and its failure mode is unpredictable, so block
    // it outright rather than let it introduce unrelated flakiness.
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // Let the initial pollOnce() (fired unconditionally on load) finish.
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });
    const countAfterInitialLoad = mock.getCount;
    if (countAfterInitialLoad < 1) fail(`expected at least one sync on initial load, saw ${countAfterInitialLoad}`);

    // Interval should be running while visible.
    const runningAfterLoad = await page.evaluate(() => pollingIntervalId !== null);
    if (!runningAfterLoad) fail('pollingIntervalId should be set after initial load (tab visible)');

    // Simulate the tab going hidden (document.hidden is normally read-only,
    // so override the getter for this test the same way a browser's own
    // page-visibility implementation would report it).
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { get: () => true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(50);
    const stoppedWhileHidden = await page.evaluate(() => pollingIntervalId === null);
    if (!stoppedWhileHidden) fail('pollingIntervalId should be cleared while the tab is hidden');

    const countWhileHidden = mock.getCount;

    // Simulate coming back to the foreground.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(() => syncInFlight === false, null, { timeout: 5000 });
    const countAfterVisible = mock.getCount;
    if (!(countAfterVisible > countWhileHidden)) {
      fail(`expected an immediate sync when the tab becomes visible again (before=${countWhileHidden}, after=${countAfterVisible})`);
    }
    const restartedAfterVisible = await page.evaluate(() => pollingIntervalId !== null);
    if (!restartedAfterVisible) fail('pollingIntervalId should be restarted once the tab is visible again');

    // pageshow (bfcache restore) should also trigger an immediate resync
    // while visible, without needing a visibilitychange event at all.
    const countBeforePageshow = mock.getCount;
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await page.waitForFunction(
      (before) => syncInFlight === false,
      countBeforePageshow,
      { timeout: 5000 }
    );
    await page.waitForTimeout(50);
    const countAfterPageshow = mock.getCount;
    if (!(countAfterPageshow > countBeforePageshow)) {
      fail(`expected pageshow to trigger an immediate sync (before=${countBeforePageshow}, after=${countAfterPageshow})`);
    }

    console.log('All #191 visibility-sync assertions passed.');
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
