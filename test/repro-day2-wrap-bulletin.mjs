/* ─────────────────────────────────────
   REGRESSION TEST — "Day 2 Wrap" newspaper-style recap modal ("The Black
   Bull Bulletin"), the Day 2 scramble counterpart to the existing Day 1
   Wrap (see test/repro-day1-wrap-newspaper.mjs).

   A floating corner icon (#day2-recap-fab, 📰, stacked directly above the
   Day 1 fab) appears once isDay2Complete() is true -- all four scramble
   groups (a4/a3/b4/b3) have resolved scores via effectiveDay2State() --
   driven by updateDay2RecapTrigger(), which is wired into the single
   choke point every Day 2 score change already runs through
   (_doUpdateDay2()), so it fires on both manual entry and hole-by-hole
   entry, local edits and poll-driven refreshes alike. The modal never
   auto-opens; the icon shakes on a loop until opened once, persisted via
   DAY2_RECAP_SEEN_KEY. Opening it (openDay2RecapModal()) rebuilds a
   newspaper-styled recap -- headline, byline, prose (four-ball, three-ball,
   combined bonus, NTP, national-anthem house rule), and a box-score table
   -- straight from live `state` via computeDay2Recap()/renderDay2RecapModal().

   Drives the real scorecard-live.html in demo mode, assigns Team A's
   default 7 players into groups a4 (4) / a3 (3) and Team B's into b4 (4) /
   b3 (3), enters manual net-to-par scores for all four groups (the
   simplest path to a resolved score -- no hole-by-hole/handicap machinery
   needed since effectiveDay2FieldFor() falls back to the manual value
   whenever no hole data exists), and checks: the icon stays hidden until
   literally all four groups are in, appears and shakes once complete,
   opening it shows the correct winner/margin per grouping and the
   combined-bonus winner using the CURRENT (renamed mid-test) team names,
   the box score reflects the right point splits, NTP and national-anthem
   toggles are called out in the prose, and the icon stops shaking for
   good (surviving a reload) once opened. Also checks the Day 1 and Day 2
   fabs don't visually overlap when both are showing at once.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-day2-wrap-bulletin.mjs
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
  try {
    const context = await browser.newContext();
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // The icon must never appear/shake on a plain fresh load -- no
    // auto-open, no auto-nag, before any Day 2 result exists.
    const fabHiddenOnLoad = await page.locator('#day2-recap-fab').isHidden();
    if (!fabHiddenOnLoad) fail('expected the Day 2 Wrap icon to stay hidden on a fresh load with no results yet');
    const modalHiddenOnLoad = await page.locator('#day2-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenOnLoad) fail('expected the Day 2 Wrap modal to never auto-open');

    // Team A/B default to the even/odd-id split (DEFAULT_A/DEFAULT_B) --
    // 7 players each -- split here into a group of 4 and a group of 3 per
    // side, matching the real Day 2 scramble format.
    await page.evaluate(() => {
      state.day2.groups.a4 = [0, 2, 4, 6];
      state.day2.groups.a3 = [8, 10, 12];
      state.day2.groups.b4 = [1, 3, 5, 7];
      state.day2.groups.b3 = [9, 11, 13];

      // Only 3 of the 4 groups reported so far -- the icon must stay
      // hidden until literally every group is in (isDay2Complete()),
      // unlike Day 1's looser "only assigned matches" gate. Setting the
      // score boxes' values directly (rather than state.day2[code], and
      // bypassing updateDay2()'s requireUsername() gate the same way the
      // Day 1 test bypasses match setters) because _doUpdateDay2() reads
      // the boxes' current text back into state on every call -- an empty
      // box would otherwise clobber state.day2[code] straight back to null.
      document.getElementById('a4-score').value = '-15';
      document.getElementById('a3-score').value = '-8';
      document.getElementById('b4-score').value = '-10';
      _doUpdateDay2();
    });
    await page.waitForTimeout(50);

    const hiddenBefore = await page.locator('#day2-recap-fab').isHidden();
    if (!hiddenBefore) fail('expected the Day 2 Wrap icon to stay hidden while one of the four groups has no score yet');

    // Fill in the last group -- b3 -- completing all four scores:
    //   fours: a4 -15 vs b4 -10 -> Team A wins by 5 (5-0)
    //   threes: a3 -8 vs b3 -12 -> Team B wins by 4 (0-4)
    //   combined: A -23 vs B -22 -> Team A's combined card is better -> 5pt bonus to A
    //   totals: A 5+0+5=10, B 0+4+0=4
    // Also sets both NTP holes.
    await page.evaluate(() => {
      document.getElementById('b3-score').value = '-12';
      state.day2.ntp.h4 = 0;  // Team A (group a4)
      state.day2.ntp.h16 = 1; // Team B (group b4)
      _doUpdateDay2();
    });
    await page.waitForTimeout(50);

    const visibleAfter = await page.locator('#day2-recap-fab').isVisible();
    if (!visibleAfter) fail('expected the Day 2 Wrap icon to appear once all four scramble groups have a score');

    // The icon should be actively shaking to nag for attention -- give the
    // first burst a moment to land.
    await page.waitForTimeout(150);
    const shakingBeforeOpen = await page.locator('#day2-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (!shakingBeforeOpen) fail('expected the Day 2 Wrap icon to be shaking before it has ever been opened');

    // The modal must still be folded away, not just present-but-covered.
    const cardOpacityHidden = await page.locator('.day2-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityHidden) > 0.05) fail(`expected the folded-away card to be effectively invisible (opacity ~0), got ${cardOpacityHidden}`);

    // The Day 1 and Day 2 fabs, if both showing, must not overlap --
    // stacking the new one above the existing one is the whole point of
    // the extra bottom offset in its CSS.
    await page.evaluate(() => {
      const fridayIds = PLAYERS.filter(p => p.friday).map(p => p.id);
      const [p0, p1] = fridayIds;
      const m0 = state.day1.matches[0];
      m0.pA = [p0, null]; m0.pB = [p1, null];
      for (let i = 0; i < 18; i++) { m0.holesA[i] = 1; m0.holesB[i] = 15; }
      renderDay1();
    });
    await page.waitForTimeout(50);
    const bothVisible = await page.evaluate(() => {
      const d1 = document.getElementById('day1-recap-fab');
      const d2 = document.getElementById('day2-recap-fab');
      return d1 && d2 && getComputedStyle(d1).display !== 'none' && getComputedStyle(d2).display !== 'none';
    });
    if (!bothVisible) fail('expected both the Day 1 and Day 2 Wrap icons to be visible once both days have results');
    const overlap = await page.evaluate(() => {
      const r1 = document.getElementById('day1-recap-fab').getBoundingClientRect();
      const r2 = document.getElementById('day2-recap-fab').getBoundingClientRect();
      return !(r1.bottom <= r2.top || r2.bottom <= r1.top);
    });
    if (overlap) fail('expected the Day 1 and Day 2 Wrap icons to be stacked without overlapping');

    // Rename teams mid-test, after all the state above was set up under
    // the defaults -- proves the recap re-reads state.teamNameA/B live
    // rather than having captured them once at some earlier point.
    await page.evaluate(() => {
      state.teamNameA = 'Testicos';
      state.teamNameB = 'Vermin';
    });

    await page.locator('#day2-recap-fab').click();
    await page.waitForTimeout(450);

    const modalHidden = await page.locator('#day2-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (modalHidden) fail('expected the Day 2 Wrap modal to be visible after clicking the icon');
    const cardOpacityOpen = await page.locator('.day2-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityOpen) < 0.95) fail(`expected the folded-out card to be fully visible (opacity ~1), got ${cardOpacityOpen}`);

    const shakingAfterOpen = await page.locator('#day2-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (shakingAfterOpen) fail('expected opening the Day 2 Wrap to stop the icon shaking');
    const seenFlag = await page.evaluate(() => localStorage.getItem('demo_wongaCup2026_day2RecapSeen'));
    if (seenFlag !== '1') fail(`expected the "seen" flag to be persisted to localStorage once opened, got ${seenFlag}`);

    const headline = (await page.locator('#day2-gazette-headline').textContent()).trim();
    const byline = (await page.locator('#day2-gazette-byline').textContent()).trim();
    const body = (await page.locator('#day2-gazette-body').textContent()).trim();
    const boxscore = (await page.locator('#day2-gazette-boxscore').textContent()).trim();

    if (!/TESTICOS/.test(headline)) fail(`expected the headline to name the leading (renamed) team, got "${headline}"`);
    if (!/Testicos/.test(byline) || !/Vermin/.test(byline)) fail(`expected the byline to use the live team names, got "${byline}"`);
    if (!/four-ball/.test(body) || !/Testicos/.test(body)) fail(`expected the four-ball paragraph to credit Testicos, got "${body}"`);
    if (!/three-ball/.test(body) || !/Vermin/.test(body)) fail(`expected the three-ball paragraph to credit Vermin, got "${body}"`);
    if (!/Testicos.*bonus|bonus.*Testicos/.test(body)) fail(`expected the combined-bonus paragraph to credit Testicos, got "${body}"`);
    if (!/closest on 4/.test(body) || !/nearest-the-pin honours on 16/.test(body)) {
      fail(`expected both NTP claims to be mentioned, got "${body}"`);
    }
    if (!/5–0/.test(boxscore)) fail(`expected the box score to show the four-ball's 5-0 points, got "${boxscore}"`);
    if (!/0–4/.test(boxscore)) fail(`expected the box score to show the three-ball's 0-4 points, got "${boxscore}"`);
    if (!/5–0/.test(boxscore)) fail(`expected the box score to show the combined bonus going 5-0 to Testicos, got "${boxscore}"`);

    // Close the modal from the assertions above before reopening it below
    // -- otherwise it still covers the fab and intercepts the next click.
    await page.evaluate(() => closeDay2RecapModal());
    await page.waitForTimeout(350);

    // National-anthem house rule: toggle one player's status and confirm
    // it's called out in a re-rendered edition (this shifts the group
    // scores too, since the strokes reach both of that player's team's
    // groups -- only the prose mention is asserted here, not the numbers
    // above, which were captured before this toggle).
    await page.evaluate(() => {
      state.day2.anthem = { 0: false };
      _doUpdateDay2();
    });
    await page.locator('#day2-recap-fab').click();
    await page.waitForTimeout(450);
    const bodyWithAnthem = (await page.locator('#day2-gazette-body').textContent()).trim();
    if (!/anthem/i.test(bodyWithAnthem) || !/B\. Cunningham/.test(bodyWithAnthem)) {
      fail(`expected the national-anthem paragraph to name the player who didn't sing, got "${bodyWithAnthem}"`);
    }

    await page.locator('.day2-recap-close').click();
    await page.waitForTimeout(350);
    const modalHiddenAfterClose = await page.locator('#day2-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenAfterClose) fail('expected the close button to fold the modal away again');
    const cardOpacityAfterClose = await page.locator('.day2-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityAfterClose) > 0.05) fail(`expected the fold-away transition to leave the card invisible, got ${cardOpacityAfterClose}`);

    // "Fold It Up" closes it too (the second, on-theme close affordance).
    await page.locator('#day2-recap-fab').click();
    await page.waitForTimeout(50);
    await page.locator('.day2-recap-foldup').click();
    await page.waitForTimeout(350);
    const modalHiddenAfterFoldUp = await page.locator('#day2-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenAfterFoldUp) fail('expected "Fold It Up" to fold the modal away again');

    // The nag must stay off across a fresh load too (persisted, not just
    // an in-memory flag for this page instance).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      state.day2.groups.a4 = [0, 2, 4, 6];
      state.day2.groups.a3 = [8, 10, 12];
      state.day2.groups.b4 = [1, 3, 5, 7];
      state.day2.groups.b3 = [9, 11, 13];
      document.getElementById('a4-score').value = '-15';
      document.getElementById('a3-score').value = '-8';
      document.getElementById('b4-score').value = '-10';
      document.getElementById('b3-score').value = '-12';
      _doUpdateDay2();
    });
    await page.waitForTimeout(200);
    const fabVisibleAfterReload = await page.locator('#day2-recap-fab').isVisible();
    if (!fabVisibleAfterReload) fail('expected the icon to still show after reload once all groups are decided');
    const shakingAfterReload = await page.locator('#day2-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (shakingAfterReload) fail('expected the "seen" flag to survive a reload and keep the icon from shaking again');

    console.log('All Day 2 Wrap newspaper-recap assertions passed.');
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
