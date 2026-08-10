/* ─────────────────────────────────────
   REGRESSION TEST — "Day 3 Wrap" newspaper-style recap modal, including
   the washout edition, plus the cross-day reading-order rule that gates
   all three Wraps (Day 1 -> Day 2 -> Day 3).

   Day 3 is "resolved" either by isDay3Complete() actually finishing, or
   by an admin declaring a washout (state.day3.washoutMm, set via the
   Admin tab's Washout section / setDay3Washout()) -- a genuinely rained-
   out day that will never produce Stableford scores. Either way,
   updateDay3RecapTrigger() shows #day3-recap-fab once resolved, UNLESS
   day3RecapBlockedByDay2() says the Day 2 Wrap is ready but still
   unopened -- the three editions come out in order, so nobody's Day 3
   spoiler jumps ahead of a Day 2 they haven't read yet. The identical
   rule (day2RecapBlockedByDay1()) gates Day 2 on Day 1 having been read
   first. Opening either Wrap (openDay1RecapModal()/openDay2RecapModal())
   immediately re-evaluates the next day's trigger rather than waiting for
   an unrelated re-render.

   Drives the real scorecard-live.html in demo mode: completes Day 1 (one
   match, a clean 2-0 sweep) and Day 2 (all four scramble groups, manual
   entry) without opening either Wrap, checks Day 2's icon stays hidden
   despite being complete (blocked on Day 1), opens Day 1, checks Day 2's
   icon appears, declares a Day 3 washout, checks Day 3's icon stays
   hidden (blocked on Day 2), opens Day 2, checks Day 3's icon appears,
   and opens it to check the washout edition's headline/byline/prose
   (rain amount, standing-lead winner, no individual honours, a working
   photo-album link) and box score (day-by-day points table).

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-day3-wrap-washout.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs) --
   it needs Playwright + a browser.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


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

    // Nothing showing on a fresh load.
    for (const id of ['day1-recap-fab', 'day2-recap-fab', 'day3-recap-fab']) {
      if (!(await page.locator('#' + id).isHidden())) fail(`expected #${id} to stay hidden on a fresh load`);
    }

    // Complete Day 1: fill all 6 match slots with the 12 Friday-eligible
    // players, Team A sweeping every match 2-0 (same unambiguous-margin
    // trick as repro-day1-wrap-newspaper.mjs) so Day 1 + Day 2 combined
    // gives Team A a clean, unambiguous standing lead for the washout to
    // hand the Cup on. (isDay1Complete() is now the same "every ASSIGNED
    // match decided" check as isDay1RecapReady() -- filling all 6 here is
    // just for a clean, fully-used-field scenario, not because it's
    // required for the win banner to consider Day 1 done.)
    // Team A/B membership doesn't affect match scoring itself (matchPoints()
    // is purely structural -- whichever player sits in a match's pA slot
    // scores for Team A) so the default DEFAULT_A/DEFAULT_B split is left
    // alone here; only the match assignments matter.
    await page.evaluate(() => {
      const fridayIds = PLAYERS.filter(p => p.friday).map(p => p.id);
      for (let mi = 0; mi < 6; mi++) {
        const m = state.day1.matches[mi];
        m.pA = [fridayIds[mi * 2], null]; m.pB = [fridayIds[mi * 2 + 1], null];
        for (let i = 0; i < 18; i++) { m.holesA[i] = 1; m.holesB[i] = 15; }
      }
      renderDay1();
      updateScoreboard();
    });
    await page.waitForTimeout(50);

    // Complete Day 2: all four scramble groups, manual entry (same
    // technique as repro-day2-wrap-bulletin.mjs) -- Team A wins clearly
    // (fours 5-0, threes 0-4, bonus 5-0 => 10-4) so Day 1 + Day 2 combined
    // gives Team A an unambiguous standing lead for the washout to hand
    // the Cup on.
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
    await page.waitForTimeout(50);

    // Day 1 is ready and unopened; Day 2 is complete but must stay hidden
    // -- it isn't Day 2's turn yet.
    if (!(await page.locator('#day1-recap-fab').isVisible())) fail('expected the Day 1 Wrap icon to be visible once Day 1 is decided');
    if (!(await page.locator('#day2-recap-fab').isHidden())) fail('expected the Day 2 Wrap icon to stay hidden while the Day 1 Wrap is still unopened, even though Day 2 is complete');

    // Read Day 1 -> Day 2's icon should appear immediately (no unrelated
    // re-render needed).
    await page.locator('#day1-recap-fab').click();
    await page.waitForTimeout(450);
    await page.locator('.day1-recap-close').click();
    await page.waitForTimeout(350);
    if (!(await page.locator('#day2-recap-fab').isVisible())) fail('expected the Day 2 Wrap icon to appear immediately after the Day 1 Wrap is opened');

    // Declare a Day 3 washout through the real gated setDay3Washout() path
    // (not a direct state write) so the admin-only auto-lock it triggers
    // gets exercised too -- needs a simulated admin session, same shortcut
    // test/repro-302-teams-admin-lock.mjs uses for currentUsername/
    // currentWriteToken/currentAdminToken rather than a real PIN prompt.
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
      currentAdminToken = 'test-admin-pin';
      setDay3Washout('28');
    });
    await page.waitForTimeout(50);

    // Day 2 is ready and unopened; Day 3 is washed out (resolved) but must
    // stay hidden -- it isn't Day 3's turn yet.
    if (!(await page.locator('#day3-recap-fab').isHidden())) fail('expected the Day 3 Wrap icon to stay hidden while the Day 2 Wrap is still unopened, even though Day 3 is resolved (washed out)');

    // The washout must also already be visible on the main Day 3 tab and
    // in the win banner, independent of the Wrap modal.
    const washoutBanner = (await page.locator('#day3-washout-banner').textContent()).trim();
    if (!/28mm/.test(washoutBanner)) fail(`expected the Day 3 tab's washout banner to mention 28mm, got "${washoutBanner}"`);
    const winBanner = (await page.locator('#win-banner').textContent()).trim();
    if (!/WASHED OUT/.test(winBanner) || !/28MM/.test(winBanner)) fail(`expected the win banner to mention the washout and its mm, got "${winBanner}"`);

    // Declaring the washout must have auto-locked Day 3 -- a round that
    // never happened shouldn't stay open for a score to be fat-fingered
    // into afterwards.
    const day3LockedAfterWashout = await page.evaluate(() => isDayLocked(3));
    if (!day3LockedAfterWashout) fail('expected declaring a Day 3 washout to auto-lock Day 3');

    // The win banner appearing for the first time must have kicked off the
    // flamingo shower (a celebratory flourish, not conditional on which
    // team actually wins).
    const shower = await page.evaluate(() => {
      const el = document.querySelector('.flamingo-shower');
      return el ? { count: el.children.length, allFlamingos: [...el.children].every(c => c.textContent === '🦩') } : null;
    });
    if (!shower) fail('expected a .flamingo-shower element once the win banner first appears');
    if (shower.count === 0 || !shower.allFlamingos) fail(`expected the flamingo shower to be full of 🦩 spans, got ${JSON.stringify(shower)}`);

    // It must only fire once per page load -- further updateScoreboard()
    // calls (e.g. from the upcoming Day 2/Day 3 Wrap opens) must not stack
    // a second shower container on top.
    await page.evaluate(() => updateScoreboard());
    const showerCount = await page.evaluate(() => document.querySelectorAll('.flamingo-shower').length);
    if (showerCount !== 1) fail(`expected exactly one flamingo shower container, got ${showerCount}`);

    // Read Day 2 -> Day 3's icon should appear immediately.
    await page.locator('#day2-recap-fab').click();
    await page.waitForTimeout(450);
    await page.locator('.day2-recap-close').click();
    await page.waitForTimeout(350);
    if (!(await page.locator('#day3-recap-fab').isVisible())) fail('expected the Day 3 Wrap icon to appear immediately after the Day 2 Wrap is opened');

    await page.locator('#day3-recap-fab').click();
    await page.waitForTimeout(450);

    const modalHidden = await page.locator('#day3-recap-modal').evaluate(el => el.classList.contains('hidden'));
    if (modalHidden) fail('expected the Day 3 Wrap modal to be visible after clicking the icon');
    const seenFlag = await page.evaluate(() => localStorage.getItem('demo_wongaCup2026_day3RecapSeen'));
    if (seenFlag !== '1') fail(`expected the "seen" flag to be persisted to localStorage once opened, got ${seenFlag}`);

    const title = (await page.locator('#day3-gazette-title').textContent()).trim();
    const headline = (await page.locator('#day3-gazette-headline').textContent()).trim();
    const byline = (await page.locator('#day3-gazette-byline').textContent()).trim();
    const body = (await page.locator('#day3-gazette-body').textContent()).trim();
    const boxscore = (await page.locator('#day3-gazette-boxscore').textContent()).trim();

    if (!/WASHOUT/.test(title)) fail(`expected the washout edition's masthead title to say so, got "${title}"`);
    if (!/RAIN/.test(headline)) fail(`expected the headline to lead with the rain, got "${headline}"`);
    if (!/28mm/.test(byline)) fail(`expected the byline to mention 28mm of rain, got "${byline}"`);
    if (!/28mm of rain/.test(body)) fail(`expected the prose to mention 28mm of rain, got "${body}"`);
    if (!/standing lead/.test(body) && !/reverts to the standing lead/.test(body)) fail(`expected the prose to explain the standing-lead decision, got "${body}"`);
    if (!/Team Beer/.test(body)) fail(`expected the prose to name the leading team (Team Beer, the default Team A), got "${body}"`);
    // Day 1: 6 matches, each a 2-0 sweep to Team A -> 12. Day 2: fours 5-0 +
    // threes 0-4 + bonus 5-0 -> 10-4. Combined: 22-4.
    if (!/22/.test(byline) || !/4/.test(byline)) fail(`expected the byline to show the 22-4 final score, got "${byline}"`);
    if (!/22/.test(boxscore) || !/4/.test(boxscore)) fail(`expected the box score's Final row to show 22-4, got "${boxscore}"`);
    if (!/washed out/.test(boxscore.toLowerCase())) fail(`expected the box score to label the Day 3 row as washed out, got "${boxscore}"`);

    // The photo album link must be a real, working anchor, not just text.
    const photoHref = await page.locator('#day3-gazette-body a').first().getAttribute('href');
    if (photoHref !== 'https://photos.app.goo.gl/DG13eR5Fbmyb2P9i8') fail(`expected a photo album link in the prose, got href="${photoHref}"`);

    console.log('All Day 3 Wrap washout + cross-day ordering assertions passed.');
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
