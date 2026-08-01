/* ─────────────────────────────────────
   REGRESSION TEST — issue #299 (weekend/team-wide score worm).

   Drives the real scorecard-live.html in demo mode. Supabase is blocked
   outright (same as the #270 worm test), so renderWeekendWorm() is called
   directly with synthetic `tournament_updates` rows rather than exercising
   the real fetchWeekendWormRows()/loadWeekendWorm() network path -- the
   same "inject data, call the render function" pattern used throughout
   this suite (e.g. mutating `state` then calling `renderDay1()`).

     - No rows at all -> #weekend-worm-slot stays hidden, empty.
     - Rows that resolve real team points (NTP holes) -> a visible
       .match-worm SVG renders inside #weekend-worm-slot, with one segment
       per point in the differential's change sequence.
     - A manual refresh button is present so a viewer isn't stuck with a
       stale chart until the next full page load.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-299-weekend-worm.mjs
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

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const base = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  const consoleErrors = [];
  try {
    const context = await browser.newContext();
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    // Supabase is deliberately blocked above -- loadWeekendWorm()'s own
    // one-shot boot fetch will fail and log 'Weekend worm load failed:',
    // same benign noise class as 'Supabase load failed' elsewhere in this
    // suite, having nothing to do with the render-from-injected-rows path
    // under test.
    const BENIGN = /Supabase load failed|Weekend worm load failed|ERR_FAILED|version\.json|404 \(Not Found\)/;
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('console', msg => {
      if (msg.type() === 'error' && !BENIGN.test(msg.text())) consoleErrors.push('console.error: ' + msg.text());
    });

    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    /* ── no rows at all -> nothing rendered ── */
    const emptyState = await page.evaluate(() => {
      renderWeekendWorm([]);
      const slot = document.getElementById('weekend-worm-slot');
      return { display: slot.style.display, hasSvg: !!slot.querySelector('.match-worm') };
    });
    if (emptyState.display !== 'none') fail(`expected #weekend-worm-slot hidden with no rows, got display="${emptyState.display}"`);
    if (emptyState.hasSvg) fail('expected no .match-worm SVG with no rows');

    /* ── rows that resolve nothing yet (in-progress hole scores only) -> still nothing ── */
    const noPointsYet = await page.evaluate(() => {
      const rows = [
        { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4', updated_at: '2026-08-07T09:00:00Z' }
      ];
      renderWeekendWorm(rows);
      const slot = document.getElementById('weekend-worm-slot');
      return { display: slot.style.display };
    });
    if (noPointsYet.display !== 'none') fail(`expected #weekend-worm-slot to stay hidden when no team point has actually resolved, got display="${noPointsYet.display}"`);

    /* ── rows that resolve real team points -> visible worm ── */
    const withPoints = await page.evaluate(() => {
      // PLAYERS[0] (even id -> Team A per DEFAULT_A) wins NTP hole 8;
      // PLAYERS[1] (odd id -> Team B per DEFAULT_B) wins NTP hole 17.
      const a = PLAYERS[0], b = PLAYERS[1];
      const rows = [
        { update_type: 'day1_ntp', field_key: 'h8', value: String(a.id), updated_at: '2026-08-07T09:00:00Z' },
        { update_type: 'day1_ntp', field_key: 'h17', value: String(b.id), updated_at: '2026-08-07T15:00:00Z' }
      ];
      renderWeekendWorm(rows);
      const slot = document.getElementById('weekend-worm-slot');
      const svg = slot.querySelector('.match-worm');
      return {
        display: slot.style.display,
        hasSvg: !!svg,
        segCount: svg ? svg.querySelectorAll('.worm-seg').length : 0,
        hasRefreshBtn: !!slot.querySelector('.weekend-worm-refresh')
      };
    });
    if (withPoints.display !== '') fail(`expected #weekend-worm-slot visible once team points have resolved, got display="${withPoints.display}"`);
    if (!withPoints.hasSvg) fail('expected a .match-worm SVG once team points have resolved');
    // Differential sequence is [1, 0] (A up 1, then level again) -> 2 steps (0->1, 1->0),
    // each step chart step drawn as a flat + a vertical jump -> 2 <line>s per step -> 4 total.
    if (withPoints.segCount !== 4) fail(`expected 4 worm segments (2 steps x 2 lines each) for a 2-step differential sequence, got ${withPoints.segCount}`);
    if (!withPoints.hasRefreshBtn) fail('expected a manual refresh button inside the rendered weekend worm');

    /* ── the sync bar's Refresh button also reloads the weekend worm ── */
    // Real network is blocked in this test, so loadWeekendWorm() is
    // stubbed to just record that it was called rather than exercising
    // the actual fetch -- this proves manualRefresh() is wired to it,
    // without needing a live Supabase round-trip.
    const refreshWired = await page.evaluate(async () => {
      let called = 0;
      const original = window.loadWeekendWorm;
      window.loadWeekendWorm = () => { called++; return Promise.resolve(); };
      try {
        await manualRefresh(document.querySelector('.refresh-btn'));
      } finally {
        window.loadWeekendWorm = original;
      }
      return called;
    });
    if (refreshWired < 1) fail('expected the sync bar\'s Refresh button (manualRefresh()) to also call loadWeekendWorm()');

    if (consoleErrors.length > 0) fail('unexpected console/page errors during the run:\n' + consoleErrors.join('\n'));

    console.log('All #299 weekend-worm assertions passed.');
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
