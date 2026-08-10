/* ─────────────────────────────────────
   REGRESSION TEST — issue #331: a player who holds both an "ordinary"
   singles seat and a Captain's Challenge match's "double" opponent seat
   (the one legal double-booking, issue #328) plays the exact same physical
   nine for both. Before this fix, entering their gross score in one match's
   hole grid did nothing to the other -- the scorer had to type the same 9
   holes twice, and the two entries could silently drift out of sync.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and calls the real setHoleScore()/clearNineHoles() functions:

     - entering a hole score in the Challenge match's front-9 opponent slot
       mirrors it into that player's own singles match, same hole
     - entering a hole score in the player's singles match mirrors it into
       the Challenge match's front-9 opponent slot, same hole
     - the Challenge match's back-9 opponent slot is a DIFFERENT player and
       must NOT be touched by the front-9 opponent's mirrored entry
     - clearing a nine via clearNineHoles() clears the mirrored seat too

   Run: node test/repro-331-challenge-hole-mirror.mjs
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

    // Roster: team A (5) short-handed, team B (6) over-manned -- same shape
    // as repro-328. Match 0: ordinary singles, player 8 (A) vs player 9 (B).
    // Match 1: Captain's Challenge, team A double side -- player 8 is the
    // front-9 opponent (slot 0, same golfer as match 0's team A seat),
    // player 12 is the back-9 opponent (slot 1, a DIFFERENT golfer with no
    // other seat). Team B's spare player (13) is the lone side.
    await page.evaluate(() => {
      state.teamA = new Set([0, 2, 5, 8, 12]);
      state.teamB = new Set([1, 3, 6, 7, 9, 13]);
      state.day1.matches[0].pA = [8];
      state.day1.matches[0].pB = [9];
      state.day1.matches[1].type = 'challenge';
      state.day1.matches[1].challengeSide = 'A';
      state.day1.matches[1].pA = [8, 12];
      state.day1.matches[1].pB = [13];
      renderDay1();
    });

    // 1. Enter hole 5 (front nine) for player 8 via the Challenge match's
    // front-9 opponent slot (match 1, team A) -- must mirror into match 0's
    // team A slot, same hole.
    await page.evaluate(() => setHoleScore(1, 'A', 5, '4'));
    let mirrored = await page.evaluate(() => ({
      challenge: state.day1.matches[1].holesA[4],
      singles: state.day1.matches[0].holesA[4]
    }));
    if (mirrored.challenge !== 4) fail(`expected match 1 hole 5 to be 4, got ${mirrored.challenge}`);
    if (mirrored.singles !== 4) fail(`expected mirrored match 0 hole 5 to be 4, got ${mirrored.singles}`);

    // 2. Enter hole 6 for player 8 the OTHER direction -- via their own
    // singles match (match 0, team A) -- must mirror into the Challenge
    // match's front-9 opponent slot (match 1, team A), same hole.
    await page.evaluate(() => setHoleScore(0, 'A', 6, '5'));
    mirrored = await page.evaluate(() => ({
      singles: state.day1.matches[0].holesA[5],
      challenge: state.day1.matches[1].holesA[5]
    }));
    if (mirrored.singles !== 5) fail(`expected match 0 hole 6 to be 5, got ${mirrored.singles}`);
    if (mirrored.challenge !== 5) fail(`expected mirrored match 1 hole 6 to be 5, got ${mirrored.challenge}`);

    // 3. The back-9 opponent (player 12, match 1 slot 1) has no other seat
    // -- entering their hole 11 score must NOT touch match 0 (player 8's
    // singles match) or anything else.
    await page.evaluate(() => setHoleScore(1, 'A', 11, '3'));
    const untouched = await page.evaluate(() => state.day1.matches[0].holesA.every(v => v === null || [4, 5].includes(v)));
    if (!untouched) fail('expected the back-9 opponent (no linked seat) to leave match 0 alone beyond the two prior mirrors');
    const back9Val = await page.evaluate(() => state.day1.matches[1].holesA[10]);
    if (back9Val !== 3) fail(`expected match 1 hole 11 (back-9 opponent slot) to be 3, got ${back9Val}`);

    // 4. clearNineHoles() on the Challenge match's front nine (match 1,
    // start 0) must clear the mirrored score in match 0 too.
    await page.evaluate(() => clearNineHoles(1, 0));
    const afterClear = await page.evaluate(() => ({
      challenge: state.day1.matches[1].holesA[4],
      singles: state.day1.matches[0].holesA[4]
    }));
    if (afterClear.challenge !== null) fail(`expected match 1 hole 5 cleared, got ${afterClear.challenge}`);
    if (afterClear.singles !== null) fail(`expected mirrored match 0 hole 5 cleared, got ${afterClear.singles}`);

    console.log('All #331 Captain\'s Challenge hole-score mirroring assertions passed.');
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
