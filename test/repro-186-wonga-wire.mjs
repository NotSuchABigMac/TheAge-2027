/* ─────────────────────────────────────
   REGRESSION TEST — issue #186: "Wonga Wire" live commentary feed.

   The tournament_updates log is already a play-by-play feed; this
   renders it as commentary. Drives the real scorecard-live.html
   against mocked (never real) tournament_updates rows across two poll
   cycles and checks:

     - the Wire tab's feed populates retroactively from the initial
       from-epoch replay (historical rows, timestamped before page
       load) -- newest-first, no toast/notification for any of them
       (the "a rollback replay must not fire 500 notifications" guard)
     - a genuinely new row arriving on a later poll (timestamped after
       page load, authored by someone else) promotes to the top of the
       feed AND fires the wire-toast, since it's 'notify'-importance
       commentary (an NTP claim)
     - suppress own-device echo: a new row authored by THIS device's
       own username updates the feed but does NOT fire another toast
     - the opt-in bell icon toggles system-notification opt-in state
       (permission pre-granted via Playwright) and persists it

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked with fixture rows,
   never hit for real.

   Run: node test/repro-186-wonga-wire.mjs
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

// Historical rows: an NTP claim on Day 2 hole 4, timestamped years in
// the past -- must populate the feed retroactively but never toast.
function historicalRows() {
  return [
    { id: 'row-1', tournament_id: 'wonga-cup-2026', updated_by: 'Someone', updated_at: '2020-01-01T00:00:00.000Z', update_type: 'day2_ntp', field_key: 'h4', value: '1' }
  ];
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

    let currentRows = historicalRows();
    const page = await context.newPage();
    // Headless Chromium doesn't reliably honor context.grantPermissions
    // for the real Notification API -- this test's job is the app's own
    // opt-in wiring (requestPermission() -> localStorage -> button
    // state), not Chromium's permission UI, so a deterministic stub
    // sidesteps that browser-automation limitation entirely.
    await page.addInitScript(() => {
      window.Notification = class {
        constructor(title, opts) { this.title = title; this.opts = opts; }
        static requestPermission() { return Promise.resolve('granted'); }
        static get permission() { return 'granted'; }
      };
    });
    // Mimics real Supabase's updated_at=gte.<cursor> filtering -- the
    // app polls incrementally (LAST_SYNC_KEY), so a mock that always
    // returns the full row set regardless of the requested cursor would
    // make it re-apply -- and re-classify into the wire -- rows it
    // already saw on an earlier poll.
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      const url = new URL(route.request().url());
      const cursor = decodeURIComponent((url.searchParams.get('updated_at') || 'gte.1970-01-01T00:00:00.000Z').replace(/^gte\./, ''));
      const filtered = currentRows
        .filter(r => r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id.localeCompare(b.id)));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filtered) });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    // 1. Retroactive population: the historical NTP claim shows in the
    // feed, but no toast fired for it (it predates page load).
    const afterInitialReplay = await page.evaluate(() => ({
      feedText: document.getElementById('wire-feed-list').textContent,
      toastShown: document.getElementById('wire-toast').classList.contains('show')
    }));
    if (!/takes NTP.*Day 2, hole 4/s.test(afterInitialReplay.feedText)) {
      fail(`expected the historical NTP claim in the feed, got "${afterInitialReplay.feedText}"`);
    }
    // Player id 1 (holder of this NTP claim) is on Team B by default --
    // the gorilla emoji should be prepended to the headline.
    if (!/🦍.*takes NTP.*Day 2, hole 4/s.test(afterInitialReplay.feedText)) {
      fail(`expected the Team B gorilla emoji on the historical NTP claim, got "${afterInitialReplay.feedText}"`);
    }
    if (afterInitialReplay.toastShown) fail('expected no wire-toast for a historical (pre-page-load) event');

    // 2. A genuinely new row from someone else fires a toast AND jumps
    // to the top of the feed.
    currentRows = [
      ...historicalRows(),
      { id: 'row-2', tournament_id: 'wonga-cup-2026', updated_by: 'James McIntyre', updated_at: new Date().toISOString(), update_type: 'day1_ntp', field_key: 'h8', value: '0' }
    ];
    await page.click('.refresh-btn');
    await page.waitForTimeout(600);

    const afterLiveEvent = await page.evaluate(() => ({
      feedFirstLine: document.getElementById('wire-feed-list').firstElementChild?.textContent || '',
      toastShown: document.getElementById('wire-toast').classList.contains('show'),
      toastText: document.getElementById('wire-toast').textContent
    }));
    if (!/takes NTP.*Day 1, hole 8/s.test(afterLiveEvent.feedFirstLine)) {
      fail(`expected the new live NTP claim at the top of the feed, got "${afterLiveEvent.feedFirstLine}"`);
    }
    // Player id 0 (holder of this NTP claim) is on Team A by default --
    // the flamingo emoji should be prepended to the headline.
    if (!/🦩.*takes NTP.*Day 1, hole 8/s.test(afterLiveEvent.feedFirstLine)) {
      fail(`expected the Team A flamingo emoji on the live NTP claim, got "${afterLiveEvent.feedFirstLine}"`);
    }
    if (!afterLiveEvent.toastShown) fail('expected a wire-toast for a genuinely new, non-own-echo, notify-importance event');
    if (!/Day 1, hole 8/.test(afterLiveEvent.toastText)) fail(`expected the toast to name the new event, got "${afterLiveEvent.toastText}"`);

    // Let the 4s wire-toast auto-dismiss before the echo-suppression check.
    await page.waitForTimeout(4300);
    const toastGoneBeforeEcho = await page.evaluate(() => document.getElementById('wire-toast').classList.contains('show'));
    if (toastGoneBeforeEcho) fail('expected the wire-toast to have auto-dismissed after 4s');

    // 3. Own-device echo: a new row authored by THIS device's own
    // username updates the feed but must NOT fire another toast.
    currentRows = [
      ...currentRows,
      { id: 'row-3', tournament_id: 'wonga-cup-2026', updated_by: 'Gary King', updated_at: new Date().toISOString(), update_type: 'day3_ntp', field_key: 'h7', value: '1' }
    ];
    await page.click('.refresh-btn');
    await page.waitForTimeout(600);

    const afterOwnEcho = await page.evaluate(() => ({
      feedFirstLine: document.getElementById('wire-feed-list').firstElementChild?.textContent || '',
      toastShown: document.getElementById('wire-toast').classList.contains('show')
    }));
    if (!/takes NTP.*Day 3, hole 7/s.test(afterOwnEcho.feedFirstLine)) {
      fail(`expected the own-device echo to still update the feed, got "${afterOwnEcho.feedFirstLine}"`);
    }
    // Player id 1 (holder of this NTP claim) is on Team B by default --
    // the gorilla emoji should be prepended to the headline.
    if (!/🦍.*takes NTP.*Day 3, hole 7/s.test(afterOwnEcho.feedFirstLine)) {
      fail(`expected the Team B gorilla emoji on the own-echo NTP claim, got "${afterOwnEcho.feedFirstLine}"`);
    }
    if (afterOwnEcho.toastShown) fail('expected NO wire-toast for an own-device echo, even though it is notify-importance');

    // 4. Bell icon: opt-in toggles and persists (permission pre-granted
    // via Playwright, so requestPermission() resolves without a real
    // prompt).
    await page.click('#tab-wire');
    const beforeBell = await page.evaluate(() => document.getElementById('wire-bell-btn').getAttribute('aria-pressed'));
    if (beforeBell !== 'false') fail(`expected the bell to start un-opted-in, got aria-pressed="${beforeBell}"`);
    await page.click('#wire-bell-btn');
    await page.waitForTimeout(200);
    const afterBell = await page.evaluate(() => ({
      pressed: document.getElementById('wire-bell-btn').getAttribute('aria-pressed'),
      stored: localStorage.getItem('demo_wongaCup2026_wireNotify')
    }));
    if (afterBell.pressed !== 'true') fail(`expected the bell to opt in after a click (permission pre-granted), got aria-pressed="${afterBell.pressed}"`);
    if (afterBell.stored !== '1') fail(`expected the opt-in to persist under the demo-namespaced key, got "${afterBell.stored}"`);

    console.log('All #186 Wonga Wire assertions passed.');
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
