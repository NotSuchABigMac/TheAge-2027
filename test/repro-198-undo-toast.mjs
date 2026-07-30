/* ─────────────────────────────────────
   REGRESSION TEST — issue #198: undo toast on score entry.

   Undo is deliberately not a new mechanism -- it's the same forward-write
   restore path #132's Admin Restore button already uses
   (buildRestoreRow() + applyUpdateToState() + insertUpdate()), just
   triggered from a toast. This drives the real Day 1 hole grid via the
   real setHoleScore() path and checks:

     - entering a score shows a toast naming the field + new value
       (describeUpdateRow()'s vocabulary) with an Undo button
     - clicking Undo restores the previous value, both in local state and
       via a fresh forward-write (through insertUpdate(), same as any
       normal edit)
     - the toast auto-dismisses after 6s (not the 10s the issue itself
       suggested) if left alone
     - a different scorer's write landing on the same field while the
       toast is up dismisses it instead of leaving a stale Undo offer
       that would clobber their newer change
     - this device's OWN write echoing back through the sync loop does
       NOT dismiss its own toast

   Self-contained: a tiny static file server for the app plus an in-memory
   Supabase mock via Playwright route interception (needed here, unlike
   most of this repo's other Playwright tests, because the "superseded by
   a remote row" case requires actually feeding a synced row back through
   the real poll path). Google Fonts is blocked outright, same as every
   other Playwright test in this repo.

   Run: node test/repro-198-undo-toast.mjs
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

    // 1. Entering a score shows the undo toast with a field label + value.
    await page.evaluate(() => setHoleScore(0, 'A', 1, '5'));
    await page.waitForTimeout(50);
    const toastAfterFirstEntry = await page.evaluate(() => ({
      shown: document.getElementById('undo-toast').classList.contains('show'),
      text: document.querySelector('.undo-toast-text').textContent
    }));
    if (!toastAfterFirstEntry.shown) fail('expected the undo toast to show after entering a score');
    if (!/5/.test(toastAfterFirstEntry.text)) fail(`expected the toast to mention the new value "5", got "${toastAfterFirstEntry.text}"`);

    // 2. Clicking Undo restores the previous value (null -> cleared box)
    // both in local state and via a real forward-write. Invoked directly
    // (rather than page.click()) because an unrelated fixed-position
    // countdown banner intercepts pointer events at this viewport size --
    // the button's own onclick wiring is a one-line HTML attribute, not
    // the behavior under test here.
    await page.evaluate(() => performUndo());
    await page.waitForTimeout(50);
    const afterUndo = await page.evaluate(() => ({
      stateValue: state.day1.matches[0].holesA[0],
      inputValue: document.getElementById('day1-in-0-A-1').value,
      toastShown: document.getElementById('undo-toast').classList.contains('show')
    }));
    if (afterUndo.stateValue !== null) fail(`expected Undo to clear the score back to null, got ${afterUndo.stateValue}`);
    if (afterUndo.inputValue !== '') fail(`expected the input to reflect the cleared value, got "${afterUndo.inputValue}"`);
    if (afterUndo.toastShown) fail('expected the toast to dismiss itself after Undo is clicked');
    const rowsAfterUndo = mock.rows.filter(r => r.update_type === 'day1_hole' && r.field_key === 'A1');
    if (rowsAfterUndo.length < 2 || rowsAfterUndo[rowsAfterUndo.length - 1].value !== null) {
      fail(`expected Undo to write a fresh forward row restoring null, got ${JSON.stringify(rowsAfterUndo)}`);
    }

    // 3. Enter a score again and let the toast time out on its own (6s,
    // not the issue's own suggested 10s).
    await page.evaluate(() => setHoleScore(0, 'A', 2, '4'));
    await page.waitForTimeout(50);
    const shownRightAway = await page.evaluate(() => document.getElementById('undo-toast').classList.contains('show'));
    if (!shownRightAway) fail('expected the undo toast to show immediately after a second entry');
    await page.waitForTimeout(6300);
    const goneAfterTimeout = await page.evaluate(() => document.getElementById('undo-toast').classList.contains('show'));
    if (goneAfterTimeout) fail('expected the undo toast to auto-dismiss after 6s');

    // 4. A DIFFERENT scorer's write on the same field dismisses the toast
    // (their change is newer; undoing would clobber it) -- but this
    // device's OWN write echoing back must NOT dismiss its own toast.
    await page.evaluate(() => setHoleScore(0, 'A', 3, '6'));
    await page.waitForTimeout(50);
    // Simulate this exact write echoing back from a poll (same author) --
    // must NOT dismiss.
    await page.evaluate(() => {
      const own = { update_type: 'day1_hole', match_idx: 0, field_key: 'A3', value: 6, updated_by: currentUsername, updated_at: new Date().toISOString() };
      applyUpdate(own);
    });
    await page.waitForTimeout(30);
    const stillShownAfterOwnEcho = await page.evaluate(() => document.getElementById('undo-toast').classList.contains('show'));
    if (!stillShownAfterOwnEcho) fail("expected this device's own write echoing back to NOT dismiss its own undo toast");

    // Now simulate a genuinely different scorer overwriting the same hole.
    await page.evaluate(() => {
      const other = { update_type: 'day1_hole', match_idx: 0, field_key: 'A3', value: 9, updated_by: 'Someone Else', updated_at: new Date().toISOString() };
      applyUpdate(other);
    });
    await page.waitForTimeout(30);
    const dismissedAfterOtherWrite = await page.evaluate(() => document.getElementById('undo-toast').classList.contains('show'));
    if (dismissedAfterOtherWrite) fail("expected a different scorer's write on the same field to dismiss the undo toast");

    console.log('All #198 undo-toast assertions passed.');
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
