/* ─────────────────────────────────────
   REGRESSION TEST — issue #212: a rollback's localStorage wipe used to be
   undone by the same poll pass before the page actually reloaded.

   location.reload() only *schedules* a navigation; it does not stop the
   synchronous JS already running above it in the call stack. Before the
   #212 fix, applyUpdate()'s rollback handler wiped four localStorage keys
   and called location.reload(), but execution then returned straight back
   into loadFromSupabase()'s loop (which rewrote the sync cursor) and then
   into pollOnce() -> refreshAllDays() -> ... -> saveState() (which wrote
   the untouched in-memory state back over wongaCup2026) -- all before the
   reload actually took effect. The reloaded page then read back exactly
   the pre-rollback data.

   This test is self-contained (no dependency on any other branch's test
   harness): a minimal in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. It
   simulates the exact scenario from issue #212 -- a device with an
   already-synced score, then a poll that discovers a rollback marker (and
   the score's deletion) in the same batch -- and checks the OUTCOME after
   the resulting reload completes, which is what actually matters and
   avoids trying to catch the mid-flight race in a headless browser (that
   was tried and found too flaky during issue #153's testing earlier in
   this project's history).

   Run: node test/repro-212-rollback-race.mjs
   Exits 0 if the reloaded device's state was genuinely cleared (fixed),
   1 if the rolled-back score survived the reload (bug reproduced).

   Not picked up by `node --test` (deliberately not named *.test.mjs,
   same convention already used for this repo's other Playwright-driven
   scripts) -- it needs Playwright + a browser, which the fast unit suite
   must not depend on.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUPABASE_HOST_GLOB = '**wtyyarvyscbrrkawjcvo**';

// This repo has no package.json/node_modules by design -- Playwright is
// installed globally in this environment instead. Resolve it from there
// (or a local install, if one ever exists) rather than a static `import
// 'playwright'`, which would fail to resolve at all otherwise.

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

// Minimal in-memory Supabase mock -- just enough of the REST surface
// sendUpdateRow()/loadFromSupabase()/insertRollbackMarker() actually use.
function createMockRows() {
  let nextId = 1;
  const rows = [];
  return {
    rows,
    insert(row, { returnId } = {}) {
      const stored = { id: String(nextId++), tournament_id: row.tournament_id, update_type: row.update_type,
        match_idx: row.match_idx ?? null, player_id: row.player_id ?? null, field_key: row.field_key ?? null,
        value: row.value ?? null, updated_by: row.updated_by ?? null, updated_at: new Date().toISOString() };
      rows.push(stored);
      return returnId ? [{ id: stored.id }] : null;
    },
    select({ tournamentId, cursor }) {
      return rows
        .filter(r => r.tournament_id === tournamentId && r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
    },
    deleteAfter({ tournamentId, cutoff }) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].tournament_id === tournamentId && rows[i].updated_at > cutoff) rows.splice(i, 1);
      }
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
  if (url.pathname === '/rest/v1/rpc/rollback_tournament_updates' && method === 'POST') {
    const body = JSON.parse(req.postData() || '{}');
    mock.deleteAfter({ tournamentId: body.p_tournament_id, cutoff: body.p_cutoff });
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return;
  }
  await route.fulfill({ status: 404, body: '{}' });
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
  let reproduced = false;
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.route(SUPABASE_HOST_GLOB, route => routeSupabase(route, mock));
    // Google Fonts is unreachable in this sandboxed test environment. On the
    // first load that fails fast (ERR_CONNECTION_RESET); on reload it was
    // observed to hang indefinitely instead, which -- because this stylesheet
    // <link> sits before the inline <script> in <head> -- blocks the page's
    // own script from ever running. Block it outright so both loads behave
    // identically and predictably; irrelevant to the #212 logic under test.
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // Log in and enter a distinctive Day 3 score, exactly like a real
    // scorer -- goes through the real insertUpdate()/sendUpdateRow() path,
    // landing in the mock via the route interception above.
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });
    await page.evaluate(() => setStableford(0, '41'));
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => JSON.parse(JSON.stringify(state.day3.scores)));
    if (before['0'] !== '41') {
      console.log('SETUP FAILED: score never made it into state.day3.scores:', JSON.stringify(before));
      process.exit(2);
    }
    // Force the sync cursor back to epoch so the next poll re-fetches
    // everything (the score row plus the marker below) in one batch --
    // this is what actually produced the race: the rollback marker
    // arriving in the SAME processUpdateRows() batch as (now-deleted)
    // scoring rows, with the rest of loadFromSupabase()'s loop and
    // pollOnce()'s downstream chain still queued to run right after.
    await page.evaluate(() => localStorage.removeItem('wongaCup2026_lastSync'));

    // Simulate the rollback: the score row is gone (deleted server-side)
    // and a marker row exists after it, exactly like a real
    // rollback_tournament_updates call followed by the marker insert in
    // rollbackScores().
    mock.rows.length = 0;
    mock.insert({ tournament_id: 'wonga-cup-2026', update_type: 'rollback', updated_by: 'James McIntyre', value: new Date().toISOString() });

    // The real entry point a 30s auto-poll timer calls -- exercises the
    // full chain: loadFromSupabase() -> (if #212 not fixed) resurrected
    // cursor -> refreshAllDays() -> ... -> saveState().
    await page.evaluate(() => { pollOnce(); }).catch(() => {});
    // The reload this triggers may destroy the execution context mid-call
    // above (expected -- that's the same real-navigation behavior found
    // during issue #153's testing) or complete cleanly first; either way,
    // wait for the resulting reload to actually finish loading (and its own
    // inline <script> to run) before checking.
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(500);
      const rs = await page.evaluate(() => document.readyState).catch(() => 'loading');
      if (rs === 'complete') break;
    }
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});

    const after = await page.evaluate(() => JSON.parse(JSON.stringify(state.day3.scores))).catch(e => { console.log('evaluate error:', e.message); return null; });
    console.log('day3.scores after the rollback + reload:', JSON.stringify(after));

    if (after && after['0'] === '41') {
      reproduced = true;
      console.log('\n─────────────────────────────────────────────────────');
      console.log('BUG REPRODUCED (issue #212): the rolled-back score survived the reload.');
      console.log('The device resurrected its own pre-rollback state before the reload');
      console.log('actually navigated away.');
      console.log('─────────────────────────────────────────────────────');
    } else if (after && (after['0'] === undefined || after['0'] === null)) {
      console.log('\nFixed: the reloaded device shows no trace of the rolled-back score.');
    } else {
      console.log(`\nINCONCLUSIVE: unexpected post-reload state: ${JSON.stringify(after)}`);
      process.exit(2);
    }
    if (pageErrors.length) console.log('Page errors seen:', JSON.stringify(pageErrors));
  } finally {
    await browser.close();
    site.close();
  }
  process.exit(reproduced ? 1 : 0);
}

main();
