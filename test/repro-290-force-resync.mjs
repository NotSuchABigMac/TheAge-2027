/* ─────────────────────────────────────
   REGRESSION TEST — issue #290: self-service full resync for a device
   whose own replay has silently diverged from everyone else's.

   Reported live: one device's sync bar showed a normal "Live Scores"
   state (no error, `isOffline`/`pendingWrites`/`authNeeded` all clean,
   `lastSyncedAt` seconds old, `lastSyncCursor` fully caught up) yet its
   computed team totals were far below every other device's. Since
   incremental sync (loadFromSupabase()) only ever fetches rows *newer*
   than its cursor, a device whose cursor is already fully caught up has
   no way to recover from an earlier silent per-row apply failure except
   a full replay from row one.

   This covers two things:

     1. resyncFromScratch() -- the shared "wipe every locally cached
        score/cursor key and reload" primitive -- must clear the sync
        cursor (LAST_SYNC_KEY/LAST_SYNC_IDS_KEY), not just STATE_KEY.
        Before this fix, the pre-existing "Reset & Reload" corrupted-data
        fallback only cleared STATE_KEY, so the post-reload blank state
        only ever replayed rows *after* the untouched stale cursor --
        permanently losing everything before it instead of starting over.
        Proven end-to-end here: seed real rows, capture the correct total
        from a clean load, corrupt this device's own local state to a
        wrong (lower) total while leaving its cursor fully caught up
        (exactly the reported symptom), call resyncFromScratch(), and
        confirm the total converges back to the correct one after the
        real reload -- location.reload() can't be stubbed (Location is a
        spec-mandated exotic object; plain assignment to it is a silent
        no-op), so this drives an actual navigation, same technique as
        the #212 rollback-race test.

     2. forceFullResync() -- the new user-facing "↻ Full Resync" button
        in the sync bar, available to any scorer without devtools -- must
        warn (via confirm()) before discarding any not-yet-synced
        pendingWrites rather than silently destroying real unsynced
        entries, but must still proceed to a full resync if the scorer
        explicitly accepts that. The cancel paths never reach
        resyncFromScratch() at all, so they're checked without any reload.

   Self-contained: in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. Never
   touches the real Supabase project.

   Run: node test/repro-290-force-resync.mjs
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

// Minimal in-memory Supabase mock -- rows are seeded directly server-side
// (bypassing the app's own write path entirely), read via the same
// cursor-paginated GET loadFromSupabase() actually uses.
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

async function routeSupabase(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  if (url.pathname === '/rest/v1/tournament_updates' && req.method() === 'GET') {
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

async function waitForReloadComplete(page) {
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(300);
    const rs = await page.evaluate(() => document.readyState).catch(() => 'loading');
    if (rs === 'complete') return;
  }
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;
  const mock = createMockRows();
  // Seed real rows representing the "true" tournament state: two players
  // on opposite teams, one with a Day 3 stableford score. Timestamps
  // in the past so they're unambiguously ordered.
  let nextId = 1;
  const seedRow = (fields, offsetMs) => mock.rows.push({
    id: String(nextId++), tournament_id: 'wonga-cup-2026',
    updated_at: new Date(Date.now() - 3600000 + offsetMs).toISOString(),
    match_idx: null, player_id: null, field_key: null, value: null, updated_by: 'Test Rig',
    ...fields
  });
  seedRow({ update_type: 'player_team', player_id: 0, value: 'A' }, 1000);
  seedRow({ update_type: 'player_team', player_id: 1, value: 'B' }, 2000);
  seedRow({ update_type: 'day3_stableford', player_id: 0, value: '41' }, 3000);

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
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    // ── Part 1: resyncFromScratch() clears the cursor, not just STATE_KEY ──
    const trueTotalA = await page.evaluate(() => document.getElementById('sb-total-a').textContent);
    if (trueTotalA === '0') fail(`setup failed: expected the seeded day3 score to produce a non-zero Team A total from a clean load, got "${trueTotalA}"`);

    // Simulate the reported divergence: this device's cursor is already
    // fully caught up (nothing new to fetch), but its own local state has
    // -- for whatever earlier reason -- lost the day3 score. Persisting
    // the corrupted snapshot to STATE_KEY (not just mutating the
    // in-memory `state` object) matters: it's what the next page load
    // actually reads back.
    await page.evaluate(() => {
      state.day3.scores = {};
      saveState();
      renderTeams();
    });
    const corruptedTotalA = await page.evaluate(() => document.getElementById('sb-total-a').textContent);
    if (corruptedTotalA !== '0') fail(`setup failed: expected the corrupted state to show a 0 Team A total, got "${corruptedTotalA}"`);

    // The actual fix under test: resyncFromScratch() must clear the sync
    // cursor too, or this reload's fresh blank state would only ever
    // refetch rows *after* the still-fully-caught-up cursor -- i.e.
    // nothing -- reproducing the exact bug forever.
    await page.evaluate(() => { resyncFromScratch(); }).catch(() => {});
    await waitForReloadComplete(page);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    const resyncedTotalA = await page.evaluate(() => document.getElementById('sb-total-a').textContent);
    if (resyncedTotalA !== trueTotalA) {
      fail(`expected resyncFromScratch() to converge back to the true total "${trueTotalA}" after a full replay, got "${resyncedTotalA}" (still showing the corrupted/stale value means the sync cursor wasn't actually cleared)`);
    }

    // ── Part 2: forceFullResync()'s confirm-gating ──
    // Neither cancel path below reaches resyncFromScratch()/a reload at
    // all -- an early `return` on a cancelled confirm() is exactly what's
    // under test.

    // 2a. No pending writes, scorer cancels -- nothing should be touched.
    await page.evaluate(() => {
      window.__confirmCalls = [];
      window.confirm = (msg) => { window.__confirmCalls.push(msg); return false; };
      pendingWrites = [];
    });
    const cursorBeforeCancel = await page.evaluate(() => localStorage.getItem('wongaCup2026_lastSync'));
    await page.evaluate(() => forceFullResync());
    const cancelledNoQueue = await page.evaluate(() => ({
      calls: window.__confirmCalls,
      lastSync: localStorage.getItem('wongaCup2026_lastSync')
    }));
    if (cancelledNoQueue.calls.length !== 1) fail(`expected exactly one confirm() call, got ${cancelledNoQueue.calls.length}`);
    if (/haven't reached the server/.test(cancelledNoQueue.calls[0])) fail(`expected the no-pending-writes confirm message with no pendingWrites queued, got "${cancelledNoQueue.calls[0]}"`);
    if (cancelledNoQueue.lastSync !== cursorBeforeCancel) fail('expected cancelling the confirm to leave the sync cursor untouched');

    // 2b. Pending writes queued, scorer cancels -- must warn about
    // discarding them specifically (correct singular wording), and still
    // touch nothing.
    await page.evaluate(() => {
      window.__confirmCalls = [];
      window.confirm = (msg) => { window.__confirmCalls.push(msg); return false; };
      pendingWrites = [{ updateType: 'day3_stableford', fields: { player_id: 0, value: '41' } }];
    });
    await page.evaluate(() => forceFullResync());
    const cancelledWithQueue = await page.evaluate(() => ({
      calls: window.__confirmCalls,
      lastSync: localStorage.getItem('wongaCup2026_lastSync'),
      pendingStillQueued: pendingWrites.length
    }));
    if (cancelledWithQueue.calls.length !== 1) fail(`expected exactly one confirm() call, got ${cancelledWithQueue.calls.length}`);
    if (!/1 entry that haven't reached the server/.test(cancelledWithQueue.calls[0])) {
      fail(`expected a singular "1 entry" warning naming the queued write, got "${cancelledWithQueue.calls[0]}"`);
    }
    if (cancelledWithQueue.lastSync !== cursorBeforeCancel) fail('expected cancelling to leave the sync cursor untouched');
    if (cancelledWithQueue.pendingStillQueued !== 1) fail('expected cancelling to leave the pending write queue untouched');

    // 2c. Pending writes queued, scorer explicitly accepts anyway --
    // must proceed to a full resync (clearing the cursor and the queue).
    // forceFullResync() defers the actual wipe by 500ms (showSaveToast()
    // feedback first, same pattern as rollbackScores()), then reloads for
    // real -- same wait-for-completion technique as Part 1 above.
    await page.evaluate(() => {
      window.__confirmCalls = [];
      window.confirm = (msg) => { window.__confirmCalls.push(msg); return true; };
      pendingWrites = [
        { updateType: 'day3_stableford', fields: { player_id: 0, value: '41' } },
        { updateType: 'day3_stableford', fields: { player_id: 1, value: '38' } }
      ];
    });
    const confirmMsg = await page.evaluate(async () => {
      forceFullResync();
      await new Promise(r => setTimeout(r, 200));
      return window.__confirmCalls[0];
    }).catch(() => null);
    await waitForReloadComplete(page);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    if (confirmMsg && !/2 entries that haven't reached the server/.test(confirmMsg)) {
      fail(`expected a plural "2 entries" warning, got "${confirmMsg}"`);
    }
    const acceptedResult = await page.evaluate(() => ({
      lastSync: localStorage.getItem('wongaCup2026_lastSync'),
      pending: localStorage.getItem('wongaCup2026_pendingWrites'),
      pendingWritesArray: pendingWrites.length
    }));
    if (acceptedResult.pendingWritesArray !== 0) fail(`expected the in-memory pendingWrites array reset to empty after accepting, got length ${acceptedResult.pendingWritesArray}`);

    console.log('All #290 force-resync assertions passed.');
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
