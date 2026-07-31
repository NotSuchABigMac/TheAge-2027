/* ─────────────────────────────────────
   REGRESSION TEST — issues #270 (match worm chart), #271 (pin to top),
   #272 (auto-pin the logged-in player's own game).

   Drives the real scorecard-live.html in demo mode with state mutated
   directly (no real network round-trip needed):

     - #270: a decided Day 1 match with hole data renders a .match-worm
       SVG; an undecided match does not.
     - #271: toggling a Day 1 match's pin button moves it above a
       "📌 Pinned" divider and re-orders it first in #day1-matches, and
       un-pinning restores the original order. Same for a Day 2 group
       (matchup-block + side reordering) and a Day 3 player's entry card.
     - #272: logging in as a player already placed in a Day 1 match / Day
       2 group / drafted team auto-pins each exactly once, and a
       subsequent manual unpin is never silently re-applied.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-270-271-272-worm-pin-autopin.mjs
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
    // Supabase is deliberately blocked above (no real network round-trip
    // needed for this test) and version.json isn't served by this bare
    // static server -- both produce expected, benign console noise having
    // nothing to do with the worm/pin/auto-pin behavior under test.
    const BENIGN = /Supabase load failed|ERR_FAILED|version\.json|404 \(Not Found\)/;
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('console', msg => {
      if (msg.type() === 'error' && !BENIGN.test(msg.text())) consoleErrors.push('console.error: ' + msg.text());
    });

    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    /* ── #270: worm chart ── */
    await page.evaluate(() => {
      const a = PLAYERS[0], b = PLAYERS[1];
      a.hcp = '10.0'; b.hcp = '10.0';
      // Match 0: fully decided, A sweeps every hole -> should get a worm.
      const m0 = state.day1.matches[0];
      m0.pA = [a.id]; m0.pB = [b.id];
      m0.front9 = null; m0.back9 = null;
      m0.holesA = Array(18).fill(4);
      m0.holesB = Array(18).fill(5);
      // Match 1: players assigned but no scores yet -> undecided, no worm.
      const c = PLAYERS[2], d = PLAYERS[3];
      const m1 = state.day1.matches[1];
      m1.pA = [c.id]; m1.pB = [d.id];
      m1.front9 = null; m1.back9 = null;
      m1.holesA = Array(18).fill(null);
      m1.holesB = Array(18).fill(null);
      renderDay1();
    });

    const wormCheck = await page.evaluate(() => ({
      match0HasWorm: !!document.querySelector('#match-card-0 .match-worm'),
      match1HasWorm: !!document.querySelector('#match-card-1 .match-worm')
    }));
    if (!wormCheck.match0HasWorm) fail('expected a decided match (0) with hole data to render a .match-worm chart');
    if (wormCheck.match1HasWorm) fail('expected an undecided match (1) to render no .match-worm chart');

    /* ── #271: pin to top — Day 1 ── */
    // Pin match 1 (currently 2nd in DOM order) and confirm it jumps first,
    // behind a "📌 Pinned" divider; un-pin restores the original order.
    await page.click('#match-card-1 .pin-btn');
    let day1Order = await page.evaluate(() => {
      const container = document.getElementById('day1-matches');
      const cardIds = [...container.querySelectorAll('.match-card')].map(el => el.id);
      const dividerFirst = container.firstElementChild?.classList.contains('pinned-divider');
      return { cardIds, dividerFirst };
    });
    if (!day1Order.dividerFirst) fail('expected a "📌 Pinned" divider as the first child of #day1-matches once a match is pinned');
    if (day1Order.cardIds[0] !== 'match-card-1') fail(`expected match-card-1 pinned to the top, got order ${JSON.stringify(day1Order.cardIds)}`);

    await page.click('#match-card-1 .pin-btn'); // un-pin
    day1Order = await page.evaluate(() => {
      const container = document.getElementById('day1-matches');
      return [...container.querySelectorAll('.match-card')].map(el => el.id);
    });
    if (day1Order[0] !== 'match-card-0') fail(`expected default order restored after un-pinning, got ${JSON.stringify(day1Order)}`);

    /* ── #271: pin to top — Day 2 ── */
    await page.click('#tab-day2');
    await page.waitForTimeout(50);
    // Default DOM order is Group of 4 (#day2-matchup-4) then Group of 3
    // (#day2-matchup-3), and within a matchup, side A then side B.
    // Pinning b3 (side B of the group-of-3 matchup) should promote the
    // whole "Group of 3" matchup above "Group of 4", AND put side B
    // first within that matchup's grid.
    await page.click('#pin-btn-day2-b3');
    const day2Order = await page.evaluate(() => {
      const parent = document.getElementById('day2-matchup-4').parentElement;
      const matchupOrder = [...parent.children].filter(el => el.classList.contains('scramble-matchup')).map(el => el.id);
      const grid = document.querySelector('#day2-matchup-3 .matchup-grid');
      const sideOrder = [...grid.children].map(el => el.className);
      const btnActive = document.getElementById('pin-btn-day2-b3').classList.contains('pin-btn-active');
      return { matchupOrder, sideOrder, btnActive };
    });
    if (day2Order.matchupOrder[0] !== 'day2-matchup-3') fail(`expected Group of 3 promoted above Group of 4 once b3 is pinned, got ${JSON.stringify(day2Order.matchupOrder)}`);
    if (!day2Order.sideOrder[0].includes('scramble-side-b')) fail(`expected side B first within the Group of 3 matchup once b3 is pinned, got ${JSON.stringify(day2Order.sideOrder)}`);
    if (!day2Order.btnActive) fail('expected pin-btn-day2-b3 to carry the pin-btn-active class once pinned');

    await page.click('#pin-btn-day2-b3'); // un-pin
    const day2Restored = await page.evaluate(() => {
      const parent = document.getElementById('day2-matchup-4').parentElement;
      return [...parent.children].filter(el => el.classList.contains('scramble-matchup')).map(el => el.id);
    });
    if (day2Restored[0] !== 'day2-matchup-4') fail(`expected default Group of 4 / Group of 3 order restored after un-pinning, got ${JSON.stringify(day2Restored)}`);

    /* ── #271: pin to top — Day 3 ── */
    await page.click('#tab-day3');
    await page.waitForTimeout(50);
    const day3PlayerId = await page.evaluate(() => PLAYERS[5].id);
    await page.click(`#day3-details-${day3PlayerId} .pin-btn`);
    const day3Order = await page.evaluate((pid) => {
      const container = document.getElementById('day3-hole-entries');
      const detailIds = [...container.querySelectorAll('.hole-grid-details')].map(el => el.id);
      const dividerFirst = container.firstElementChild?.classList.contains('pinned-divider');
      const stillOpenAfterClick = document.getElementById(`day3-details-${pid}`).open; // pin click must not toggle <details>
      return { detailIds, dividerFirst, stillOpenAfterClick };
    }, day3PlayerId);
    if (!day3Order.dividerFirst) fail('expected a "📌 Pinned" divider as the first child of #day3-hole-entries once a player is pinned');
    if (day3Order.detailIds[0] !== `day3-details-${day3PlayerId}`) fail(`expected day3-details-${day3PlayerId} pinned to the top, got order ${JSON.stringify(day3Order.detailIds)}`);
    if (day3Order.stillOpenAfterClick) fail('expected clicking the pin button to NOT toggle the <details> panel open');

    /* ── #272: auto-pin ── */
    // Fresh player, placed in a Day 1 match, a Day 2 group, and drafted to
    // a team -- logging in as them should auto-pin all three, exactly once.
    const autoPinResult = await page.evaluate(() => {
      // Reset pin state for a clean slate.
      pinned.day1 = []; pinned.day2 = []; pinned.day3 = [];
      autoPinned.day1 = false; autoPinned.day2 = false; autoPinned.day3 = false;
      savePinned(); saveAutoPinned();

      const p = PLAYERS[7];
      state.teamA.add(p.id);
      state.day1.matches[2].pA = [p.id];
      state.day2.groups.a3.push(p.id);

      currentUsername = p.name; // simulate a completed login without the modal
      maybeAutoPin();

      return {
        name: p.id,
        day1: [...pinned.day1], day2: [...pinned.day2], day3: [...pinned.day3],
        flags: { ...autoPinned }
      };
    });
    if (!autoPinResult.day1.includes(2)) fail(`expected Day 1 match 2 auto-pinned, got ${JSON.stringify(autoPinResult.day1)}`);
    if (!autoPinResult.day2.includes('a3')) fail(`expected Day 2 group a3 auto-pinned, got ${JSON.stringify(autoPinResult.day2)}`);
    if (!autoPinResult.day3.includes(autoPinResult.name)) fail(`expected Day 3 (player id ${autoPinResult.name}) auto-pinned, got ${JSON.stringify(autoPinResult.day3)}`);
    if (!autoPinResult.flags.day1 || !autoPinResult.flags.day2 || !autoPinResult.flags.day3) fail(`expected all three auto-pinned flags set, got ${JSON.stringify(autoPinResult.flags)}`);

    // Manually un-pin Day 1's auto-pinned match, then call maybeAutoPin()
    // again -- it must NOT come back (the one-shot flag already fired).
    const stickyUnpin = await page.evaluate(() => {
      togglePin('day1', 2); // un-pin
      maybeAutoPin(); // should be a no-op for day1 now
      return [...pinned.day1];
    });
    if (stickyUnpin.includes(2)) fail(`expected a manual unpin to stick even after maybeAutoPin() runs again, got ${JSON.stringify(stickyUnpin)}`);

    if (consoleErrors.length > 0) fail('unexpected console/page errors during the run:\n' + consoleErrors.join('\n'));

    console.log('All #270/#271/#272 worm/pin/auto-pin assertions passed.');
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
