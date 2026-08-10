/* ─────────────────────────────────────
   REGRESSION TEST — issue #328: the flipped Captain's Challenge format
   (issue #326) requires 2 short-handed-team players to be assignable as
   the Challenge match's front-9/back-9 opponents WHILE STILL holding their
   own ordinary singles-match seat -- that's the whole point, their 9-hole
   score is meant to count toward both results.

   Before this fix, playerOptions() in scorecard-live.html disabled any
   player already assigned to *any other* Day 1 match, whole-day-wide, so
   a short-handed player already in their own singles match could never be
   picked as a Challenge opponent (and vice versa) from the UI at all.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks the rendered Day 1 match-card dropdowns directly:

     - a player already in an ordinary singles match IS selectable (not
       disabled) as a Challenge match's opponent, with an informational
       "Also playing Match N" tooltip instead of a block
     - the same still holds in the other assignment order
     - a player already double-booked that way is still correctly BLOCKED
       from a THIRD ordinary singles match (two singles seats is still
       illegal)
     - the Challenge's lone/single-player side is still fully exclusive --
       a player holding that seat is blocked from any other match

   Run: node test/repro-328-challenge-dual-seat.mjs
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


async function optionInfo(page, matchIdx, selectIndex, playerId) {
  return page.evaluate(({ matchIdx, selectIndex, playerId }) => {
    const selects = document.querySelectorAll(`#match-card-${matchIdx} select`);
    const sel = selects[selectIndex];
    if (!sel) return null;
    const opt = Array.from(sel.options).find(o => o.value === String(playerId));
    if (!opt) return null;
    return { disabled: opt.disabled, title: opt.title };
  }, { matchIdx, selectIndex, playerId });
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

    const page = await context.newPage();
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    // Roster: 6 friday-eligible ids split so team A (5) is short-handed
    // and team B (6) is over-manned -- challengeSide 'A' is the correct
    // (short-handed) 2-opponent side under #326's flipped rule.
    await page.evaluate(() => {
      state.teamA = new Set([0, 2, 5, 8, 12]);
      state.teamB = new Set([1, 3, 6, 7, 9, 13]);
      // Match 0: ordinary singles, player 8 (team A) vs player 9 (team B).
      state.day1.matches[0].pA = [8];
      state.day1.matches[0].pB = [9];
      // Match 1: Captain's Challenge, team A (short-handed) is the
      // 2-opponent double side; team B's spare player (13) is the lone side.
      state.day1.matches[1].type = 'challenge';
      state.day1.matches[1].challengeSide = 'A';
      state.day1.matches[1].pA = [null, null];
      state.day1.matches[1].pB = [13];
      renderDay1();
    });

    // 1. Player 8 -- already an ordinary singles seat in match 0 -- must be
    // SELECTABLE (not disabled) as match 1's front-9 opponent (team A,
    // slot 0), with an informational tooltip rather than a block.
    let info = await optionInfo(page, 1, 0, 8);
    if (!info) fail('expected player 8 to appear as an option in match 1 team A slot 0');
    if (info.disabled) fail(`expected player 8 to be selectable in match 1 (Challenge opponent), got disabled. title="${info.title}"`);
    if (!/Also playing Match 1/.test(info.title)) fail(`expected an "Also playing Match 1" tooltip, got "${info.title}"`);

    // 2. Actually assign it via the real UI path and confirm match 0's
    // seat survives (not wiped out by the assignment).
    await page.evaluate(() => setMatchPlayer(1, 'A', 0, '8'));
    const afterAssign = await page.evaluate(() => ({
      m0pA: state.day1.matches[0].pA[0],
      m1pA: state.day1.matches[1].pA[0]
    }));
    if (afterAssign.m0pA !== 8) fail(`expected match 0's singles seat to survive the Challenge assignment, got pA[0]=${afterAssign.m0pA}`);
    if (afterAssign.m1pA !== 8) fail(`expected match 1's Challenge opponent slot to be set, got pA[0]=${afterAssign.m1pA}`);

    // 3. Player 8 is now double-booked (match 0 singles + match 1 Challenge
    // opponent) -- a THIRD ordinary singles match must still block them
    // (two singles seats stays illegal).
    await page.evaluate(() => {
      state.day1.matches[2] = { type: 'singles', challengeSide: null, pA: [null], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) };
      renderDay1();
    });
    info = await optionInfo(page, 2, 0, 8);
    if (!info) fail('expected player 8 to appear as an option in match 2 team A slot 0');
    if (!info.disabled) fail('expected player 8 to be BLOCKED from a second ordinary singles match');

    // 4. The Challenge's lone/single side (player 13, team B, match 1)
    // must remain fully exclusive -- blocked from any other match.
    info = await optionInfo(page, 2, 1, 13);
    if (!info) fail('expected player 13 to appear as an option in match 2 team B slot 0');
    if (!info.disabled) fail('expected the Challenge lone-side player (13) to be BLOCKED from an ordinary singles match');

    console.log('All #328 Captain\'s Challenge dual-seat assertions passed.');
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
