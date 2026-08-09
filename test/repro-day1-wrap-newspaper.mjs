/* ─────────────────────────────────────
   REGRESSION TEST — "Day 1 Wrap" newspaper-style recap modal.

   A floating corner icon (#day1-recap-fab, 📰) appears once every
   ASSIGNED Day 1 match has both nines decided (updateDay1RecapTrigger() /
   isDay1RecapReady()) -- against the real live tournament data, only 5 of
   6 slots were ever assigned, and gating on strict "every physical slot
   used" completeness would have kept the icon (and, before
   isDay1Complete() was unified onto this same check, the win banner too)
   hidden forever. The modal never auto-opens; the icon
   shakes on a loop (mobile-game-nudge style, .shaking class driving
   @keyframes day1-fab-shake) until it's been opened once, persisted via
   DAY1_RECAP_SEEN_KEY so the nag stops for good, not just this load.
   Opening it (openDay1RecapModal()) rebuilds a newspaper-styled recap --
   headline, byline, prose, and a box score table -- straight from live
   `state` via computeDay1Recap()/renderDay1RecapModal(), the same
   effectiveMatch()/matchStrokesFor()/nineStatusLabel() chain the Day 1
   tab itself already renders from. Opening/closing is a CSS
   transform/opacity transition (folding the card out/away) rather than a
   hard display:none swap.

   Drives the real scorecard-live.html in demo mode, assigns Day 1 matches
   with full 18-hole results (one team sweeps 2-0, three others halve
   1-1) plus both NTP holes, while leaving one match slot completely
   unassigned throughout (mirroring the real tournament), and checks: the
   icon stays hidden while an assigned match is still undecided, appears
   and shakes once every assigned match is finished (even with the one
   empty slot still empty), the fold-out/fold-away transition actually
   animates the card's opacity, the opened modal's headline/byline/box-
   score reflect the actual scores (not stale/hardcoded text) using the
   CURRENT team names -- renamed mid-test to confirm the recap re-reads
   state.teamNameA/B rather than capturing them once -- and that the icon
   stops shaking for good once opened, surviving a fresh page load.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-day1-wrap-newspaper.mjs
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
    // auto-open, no auto-nag, before any Day 1 result exists.
    const fabHiddenOnLoad = await page.locator('#day1-recap-fab').isHidden();
    if (!fabHiddenOnLoad) fail('expected the Day 1 Wrap icon to stay hidden on a fresh load with no results yet');
    const modalHiddenOnLoad = await page.locator('#day1-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenOnLoad) fail('expected the Day 1 Wrap modal to never auto-open');

    // Match 1's back 9 is deliberately left unplayed here -- an assigned
    // match that isn't finished yet must keep the icon hidden, exactly
    // as before.
    await page.evaluate(() => {
      const fridayIds = PLAYERS.filter(p => p.friday).map(p => p.id);
      const [p0, p1, p2, p3] = fridayIds;
      state.teamA = new Set([p0, p2]);
      state.teamB = new Set([p1, p3]);

      // Gross margins of DAY1_GROSS_MIN (1) vs DAY1_GROSS_MAX (15) on every
      // hole -- a 14-stroke swing no plausible handicap allocation (at
      // most ~2 strokes/hole for these players) can ever flip, so the
      // nine-by-nine winner below is unambiguous regardless of who's
      // actually paired against whom.
      const m0 = state.day1.matches[0];
      m0.pA = [p0, null]; m0.pB = [p1, null];
      // p0 wins every hole on both nines -- an unambiguous 2-0 sweep.
      for (let i = 0; i < 18; i++) { m0.holesA[i] = 1; m0.holesB[i] = 15; }

      const m1 = state.day1.matches[1];
      m1.pA = [p2, null]; m1.pB = [p3, null];
      // Front 9 to A only for now -- back 9 stays unplayed.
      for (let i = 0; i < 9; i++) { m1.holesA[i] = 1; m1.holesB[i] = 15; }

      state.day1.ntp.h8 = p0;
      state.day1.ntp.h17 = p3;

      renderDay1();
      updateScoreboard();
    });
    await page.waitForTimeout(50);

    const hiddenBefore = await page.locator('#day1-recap-fab').isHidden();
    if (!hiddenBefore) fail('expected the Day 1 Wrap icon to stay hidden while match 2\'s back 9 is still unplayed');

    // Finish match 2's back 9 (-> halved 1-1), then fill matches 3-5 too
    // -- but deliberately leave match 6 with NO players assigned at all,
    // mirroring the real tournament (only 5 of 6 slots ever got used).
    // The icon must still appear: an empty, never-assigned slot isn't a
    // match still being played, so it can't hold the recap hostage
    // forever (this is the exact bug this feature hit against the real
    // live snapshot -- isDay1Complete() requiring literally all 6 slots
    // would have kept the icon hidden permanently).
    await page.evaluate(() => {
      const m1 = state.day1.matches[1];
      for (let i = 9; i < 18; i++) { m1.holesA[i] = 15; m1.holesB[i] = 1; }

      const fridayIds = PLAYERS.filter(p => p.friday).map(p => p.id);
      const used = new Set([...state.teamA, ...state.teamB]);
      const rest = fridayIds.filter(id => !used.has(id));
      for (let mi = 2; mi < 5 && rest.length >= 2; mi++) {
        const a = rest.shift(), b = rest.shift();
        state.teamA.add(a); state.teamB.add(b);
        const m = state.day1.matches[mi];
        m.pA = [a, null]; m.pB = [b, null];
        for (let i = 0; i < 9; i++) { m.holesA[i] = 1; m.holesB[i] = 15; }
        for (let i = 9; i < 18; i++) { m.holesA[i] = 15; m.holesB[i] = 1; }
      }
      renderDay1();
      updateScoreboard();
    });
    await page.waitForTimeout(50);

    const visibleAfter = await page.locator('#day1-recap-fab').isVisible();
    if (!visibleAfter) fail('expected the Day 1 Wrap icon to appear once every ASSIGNED match is decided, even with match 6 left permanently unassigned');

    // The icon should be actively shaking to nag for attention (loops via
    // day1RecapShakeTimer) -- give the first burst a moment to land.
    await page.waitForTimeout(150);
    const shakingBeforeOpen = await page.locator('#day1-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (!shakingBeforeOpen) fail('expected the Day 1 Wrap icon to be shaking before it has ever been opened');

    // The modal must still be in its folded-away (hidden) state with the
    // card actually invisible, not just present-but-covered.
    const cardOpacityHidden = await page.locator('.day1-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityHidden) > 0.05) fail(`expected the folded-away card to be effectively invisible (opacity ~0), got ${cardOpacityHidden}`);

    // Rename teams mid-test, after all the state above was set up under
    // the defaults -- proves the recap re-reads state.teamNameA/B live
    // rather than having captured them once at some earlier point.
    await page.evaluate(() => {
      state.teamNameA = 'Testicos';
      state.teamNameB = 'Vermin';
    });

    await page.locator('#day1-recap-fab').click();
    // Let the fold-out transition actually finish before reading state.
    await page.waitForTimeout(450);

    const modalHidden = await page.locator('#day1-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (modalHidden) fail('expected the Day 1 Wrap modal to be visible after clicking the icon');
    const cardOpacityOpen = await page.locator('.day1-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityOpen) < 0.95) fail(`expected the folded-out card to be fully visible (opacity ~1), got ${cardOpacityOpen}`);

    // Opening it stops the nag for good.
    const shakingAfterOpen = await page.locator('#day1-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (shakingAfterOpen) fail('expected opening the Day 1 Wrap to stop the icon shaking');
    const seenFlag = await page.evaluate(() => localStorage.getItem('demo_wongaCup2026_day1RecapSeen'));
    if (seenFlag !== '1') fail(`expected the "seen" flag to be persisted to localStorage once opened, got ${seenFlag}`);

    const headline = (await page.locator('#gazette-headline').textContent()).trim();
    const byline = (await page.locator('#gazette-byline').textContent()).trim();
    const body = (await page.locator('#gazette-body').textContent()).trim();
    const boxscore = (await page.locator('#gazette-boxscore').textContent()).trim();

    if (!/TESTICOS/.test(headline)) fail(`expected the headline to name the leading (renamed) team, got "${headline}"`);
    if (!/Testicos/.test(byline) || !/Vermin/.test(byline)) fail(`expected the byline to use the live team names, got "${byline}"`);
    if (!/sweeping both nines/.test(body)) fail(`expected the prose to call out the 2-0 sweep, got "${body}"`);
    if (!/2 points to Testicos/.test(body)) fail(`expected the sweep paragraph to attribute the 2pts to Testicos, got "${body}"`);
    if (!/struck it closest on 8/.test(body) || !/nearest-the-pin honours on 17/.test(body)) {
      fail(`expected both NTP claims to be mentioned, got "${body}"`);
    }
    if (!/2–0/.test(boxscore)) fail(`expected the box score to show the 2-0 sweep's points, got "${boxscore}"`);
    if (!/1–1/.test(boxscore)) fail(`expected the box score to show a halved match's 1-1 points, got "${boxscore}"`);

    await page.locator('.day1-recap-close').click();
    await page.waitForTimeout(350);
    const modalHiddenAfterClose = await page.locator('#day1-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenAfterClose) fail('expected the close button to fold the modal away again');
    const cardOpacityAfterClose = await page.locator('.day1-recap-card').evaluate(el => getComputedStyle(el).opacity);
    if (Number(cardOpacityAfterClose) > 0.05) fail(`expected the fold-away transition to leave the card invisible, got ${cardOpacityAfterClose}`);

    // "Fold It Up" closes it too (the second, on-theme close affordance).
    await page.locator('#day1-recap-fab').click();
    await page.waitForTimeout(50);
    await page.locator('.day1-recap-foldup').click();
    await page.waitForTimeout(350);
    const modalHiddenAfterFoldUp = await page.locator('#day1-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (!modalHiddenAfterFoldUp) fail('expected "Fold It Up" to fold the modal away again');

    // The nag must stay off across a fresh load too (persisted, not just
    // an in-memory flag for this page instance).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      const fridayIds = PLAYERS.filter(p => p.friday).map(p => p.id);
      const [p0, p1] = fridayIds;
      state.teamA = new Set([p0]);
      state.teamB = new Set([p1]);
      const m0 = state.day1.matches[0];
      m0.pA = [p0, null]; m0.pB = [p1, null];
      for (let i = 0; i < 18; i++) { m0.holesA[i] = 1; m0.holesB[i] = 15; }
      renderDay1();
      updateScoreboard();
    });
    await page.waitForTimeout(200);
    const fabVisibleAfterReload = await page.locator('#day1-recap-fab').isVisible();
    if (!fabVisibleAfterReload) fail('expected the icon to still show after reload once its assigned match is decided');
    const shakingAfterReload = await page.locator('#day1-recap-fab').evaluate(el => el.classList.contains('shaking'));
    if (shakingAfterReload) fail('expected the "seen" flag to survive a reload and keep the icon from shaking again');

    console.log('All Day 1 Wrap newspaper-recap assertions passed.');
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
