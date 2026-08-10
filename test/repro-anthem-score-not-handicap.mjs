/* ─────────────────────────────────────
   REGRESSION TEST — issue #149's national anthem house rule was
   mechanically wrong: the +2/-1 stroke adjustment was folded into a
   player's own HANDICAP before scrambleTeamHandicap() ran, rather than
   being added straight to the group's SCORE. Three concrete bugs fell out
   of that:

     1. A group scored via the manual net-to-par field (no hole-by-hole
        entry) got NO anthem adjustment at all -- the handicap-based path
        was never consulted for a manual score.
     2. Even on the hole-by-hole path, the adjustment was diluted through
        scrambleTeamHandicap()'s group-size percentage table (10-35%)
        instead of landing as a full stroke, and it silently changed the
        team's displayed handicap number.
     3. A follow-up fix landed the adjustment on the score, but only on
        the player's own group -- a team plays two Day 2 groups
        (four-ball and three-ball), and a player's anthem showing is
        meant to reflect on their whole team, not just their own foursome.

   The fix (day2TeamAnthemStrokesFor() in scoring.js) adds a player's
   strokes to BOTH of their team's group scores, leaving group handicaps
   untouched.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - toggling a player's anthem status on a group scored via the manual
       field changes that group's displayed score by the right amount
     - toggling a player's anthem status on a group with hole-by-hole
       data changes the displayed net-to-par by the right amount, while
       the displayed Team HCP number stays exactly the same
     - toggling a player's anthem status in ONE of their team's groups
       also changes the SIBLING group's displayed score by the same
       amount, even though that player never sets foot in it
     - the National Anthem info-box no longer describes the rule as a
       handicap adjustment, or as confined to a player's own group

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for real.

   Run: node test/repro-anthem-score-not-handicap.mjs
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
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
    });
    await page.click('#tab-day2');
    await page.waitForTimeout(150);

    // ── 1. Manual-score path: previously ignored the anthem rule entirely. ──
    // Goes through the real admin score input + updateDay2() rather than
    // poking state.day2.b3 directly -- updateDay2() re-syncs ALL FOUR
    // manual score boxes from their live DOM values on every hole-by-hole
    // commit (_doUpdateDay2(), issue #107), so a value only ever set on
    // the in-memory state object (never on its input box) gets silently
    // wiped back to null the next time any group's hole score changes.
    await page.evaluate(() => {
      setDay2Group(PLAYERS[3].id, 'b3');
      setDay2Group(PLAYERS[4].id, 'b3');
      document.getElementById('b3-score').value = '-5';
      updateDay2('b3');
    });
    const beforeManual = await page.$eval('#b3-manual-display', el => el.textContent);
    if (!/^-5 to par/.test(beforeManual)) fail(`expected the manual score to start at -5 to par, got "${beforeManual}"`);

    await page.evaluate(() => setDay2Anthem(PLAYERS[3].id, false)); // didn't sing: +2
    const afterManual = await page.$eval('#b3-manual-display', el => el.textContent);
    if (!/^-3 to par/.test(afterManual)) fail(`expected +2 anthem strokes to move the manual score from -5 to -3, got "${afterManual}"`);
    if (!/incl\. anthem/.test(afterManual)) fail(`expected the manual display to flag that anthem strokes are included, got "${afterManual}"`);

    // ── 2. Hole-by-hole path: strokes must land on the score, and the ──
    // displayed team handicap must NOT move when the anthem toggle flips.
    await page.evaluate(() => {
      setDay2Group(PLAYERS[6].id, 'a3');
      setDay2Group(PLAYERS[7].id, 'a3');
      setDay2Group(PLAYERS[8].id, 'a3');
      setDay2HoleScore('a3', 1, 4);
    });
    const before = await page.$eval('#a3-derived', el => el.textContent);
    const hcpBefore = before.match(/Team HCP (-?\d+)/);
    const ntpBefore = before.match(/(-?\d+) to par/);
    if (!hcpBefore || !ntpBefore) fail(`could not parse the before-toggle derived line: "${before}"`);

    await page.evaluate(() => setDay2Anthem(PLAYERS[6].id, true)); // sang: -1 stroke

    const after = await page.$eval('#a3-derived', el => el.textContent);
    const hcpAfter = after.match(/Team HCP (-?\d+)/);
    const ntpAfter = after.match(/(-?\d+) to par/);
    if (!hcpAfter || !ntpAfter) fail(`could not parse the after-toggle derived line: "${after}"`);

    if (hcpAfter[1] !== hcpBefore[1]) {
      fail(`expected Team HCP to be UNCHANGED by the anthem toggle (adjustment now lands on the score, not the handicap), went from ${hcpBefore[1]} to ${hcpAfter[1]}`);
    }
    const delta = parseInt(ntpAfter[1], 10) - parseInt(ntpBefore[1], 10);
    if (delta !== -1) fail(`expected the sang toggle (-1 stroke) to move the displayed net-to-par by exactly -1, moved by ${delta} (before "${ntpBefore[1]}", after "${ntpAfter[1]}")`);

    // ── 3. Cross-group propagation: a toggle in one of a team's groups ──
    // must also move its SIBLING group's score by the same amount, even
    // for a player who never plays in that sibling group. b3 is already
    // at -3 to par (from part 1's +2 toggle on PLAYERS[3]); assigning a
    // new player to the sibling b4 group and toggling THEIR anthem status
    // must move b3's displayed score too.
    await page.evaluate(() => setDay2Group(PLAYERS[9].id, 'b4'));
    const b3BeforeSibling = await page.$eval('#b3-manual-display', el => el.textContent);
    await page.evaluate(() => setDay2Anthem(PLAYERS[9].id, true)); // sang, in b4: -1 stroke
    const b3AfterSibling = await page.$eval('#b3-manual-display', el => el.textContent);
    const b3ScoreBefore = parseInt(b3BeforeSibling.match(/(-?\d+) to par/)[1], 10);
    const b3ScoreAfter = parseInt(b3AfterSibling.match(/(-?\d+) to par/)[1], 10);
    if (b3ScoreAfter - b3ScoreBefore !== -1) {
      fail(`expected a sang toggle for a player in the SIBLING b4 group to move b3's score by -1 too, moved by ${b3ScoreAfter - b3ScoreBefore} (before "${b3BeforeSibling}", after "${b3AfterSibling}")`);
    }

    // ── 4. The rules copy must describe a score adjustment (not a handicap ──
    // one), and must not claim it's confined to the player's own group.
    const infoBoxText = await page.$eval('#day2-anthem', el => el.previousElementSibling.textContent);
    if (/handicap/i.test(infoBoxText)) fail(`expected the anthem info-box to no longer mention "handicap", got "${infoBoxText}"`);
    if (!/score/i.test(infoBoxText)) fail(`expected the anthem info-box to describe a score adjustment, got "${infoBoxText}"`);
    if (!/team/i.test(infoBoxText)) fail(`expected the anthem info-box to describe a team-wide reach across both groups, got "${infoBoxText}"`);

    console.log('All anthem-score-not-handicap assertions passed.');
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
