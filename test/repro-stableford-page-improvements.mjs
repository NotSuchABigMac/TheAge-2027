/* ─────────────────────────────────────
   REGRESSION TEST — three Stableford (Day 3) tab fixes:

     1. The leaderboard's Team column showed literal "Team A"/"Team B"
        text instead of this year's flamingo/gorilla mascot emoji already
        used everywhere else a team needs a compact marker.
     2. A player's net Stableford total could be typed directly into a
        manual box; hole-by-hole entry should be the only way in, with the
        total always shown read-only.
     3. The leaderboard had no points-per-hole figure and was ordered by
        raw total, which unfairly ranks a player who's only played a few
        holes below one who's played more at a worse pace.

   Drives the real scorecard-live.html in demo mode with state mutated
   directly (no real network round-trip needed), same pattern as
   test/repro-270-271-272-worm-pin-autopin.mjs.

   Run: node test/repro-stableford-page-improvements.mjs
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
  const consoleErrors = [];
  try {
    const context = await browser.newContext();
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    const BENIGN = /Supabase load failed|Weekend worm load failed|Wonga Wire history seed failed|ERR_FAILED|version\.json|404 \(Not Found\)/;
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('console', msg => {
      if (msg.type() === 'error' && !BENIGN.test(msg.text())) consoleErrors.push('console.error: ' + msg.text());
    });

    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.click('#tab-day3');
    await page.waitForTimeout(50);

    /* ── #1: flamingo/gorilla emoji, not "Team A"/"Team B" text ── */
    const teamCellText = await page.evaluate(() => document.getElementById('sf-tbody').textContent);
    if (/Team A/.test(teamCellText) || /Team B/.test(teamCellText)) {
      fail(`expected no literal "Team A"/"Team B" text on the Stableford leaderboard, got: ${teamCellText}`);
    }
    const teamCellHtml = await page.evaluate(() => document.getElementById('sf-tbody').innerHTML);
    if (!teamCellHtml.includes('🦩')) fail('expected a flamingo emoji (🦩) badge for Team A');
    if (!teamCellHtml.includes('🦍')) fail('expected a gorilla emoji (🦍) badge for Team B');

    /* ── #2: no manual entry -- hole-by-hole only, totals read-only ── */
    const manualInputCount = await page.evaluate(() => document.querySelectorAll('.sf-in').length);
    if (manualInputCount !== 0) fail(`expected zero manual Stableford-total inputs on the page, found ${manualInputCount}`);
    const infoBoxText = await page.evaluate(() => document.querySelector('#day3-lockable .info-box').textContent);
    if (/18-hole total/.test(infoBoxText)) fail('expected the Day 3 info box to no longer mention manual 18-hole-total entry');

    /* ── #3: leaderboard adds points-per-hole and ranks by it ── */
    await page.evaluate(() => {
      currentUsername = 'Test Scorer';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });

    const seeded = await page.evaluate(() => {
      // Player 0 (Team A): 3 holes in at a birdie-every-hole pace.
      // Player 1 (Team B): a full round at even par every hole -- a much
      // bigger raw total, but a worse pace.
      const pA = PLAYERS[0], pB = PLAYERS[1];
      pA.hcp = '0.0'; pB.hcp = '0.0'; // scratch -- no strokes, simplest math
      const courseHoles = day3CourseHoles();
      if (!Array.isArray(state.day3.holes[pA.id])) state.day3.holes[pA.id] = Array(18).fill(null);
      if (!Array.isArray(state.day3.holes[pB.id])) state.day3.holes[pB.id] = Array(18).fill(null);
      for (let i = 0; i < 3; i++) state.day3.holes[pA.id][i] = courseHoles[i].par - 1; // net birdie
      for (let i = 0; i < 18; i++) state.day3.holes[pB.id][i] = courseHoles[i].par; // net par
      saveState();
      renderDay3();
      return { aId: pA.id, bId: pB.id, aShort: pA.short, bShort: pB.short };
    });

    /* ── #4: no "Clear hole scores" escape hatch on Day 3 -- with manual
       entry gone, a bulk clear has no safe fallback (Day 1/Day 2 keep
       theirs since they still fall back to a manual box). ── */
    const clearButtonCount = await page.evaluate((pid) => {
      return document.querySelectorAll(`#day3-details-${pid} .clear-btn`).length;
    }, seeded.aId);
    if (clearButtonCount !== 0) fail(`expected no "Clear hole scores" button on a Day 3 player with hole data entered, found ${clearButtonCount}`);

    const rows = await page.evaluate(() => {
      return [...document.querySelectorAll('#sf-tbody tr')].map(tr => {
        const cells = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        return { name: cells[1], total: cells[4], perHole: cells[5], pts: cells[6] };
      });
    });

    const rowA = rows.find(r => r.name === seeded.aShort);
    const rowB = rows.find(r => r.name === seeded.bShort);
    if (!rowA || !rowB) fail(`expected both seeded players' rows in the leaderboard, got: ${JSON.stringify(rows)}`);

    if (rowA.total !== '9 pts') fail(`expected player A's raw total to read "9 pts", got "${rowA.total}"`);
    if (rowB.total !== '36 pts') fail(`expected player B's raw total to read "36 pts", got "${rowB.total}"`);
    if (rowA.perHole !== '3.00') fail(`expected player A's points-per-hole to read "3.00", got "${rowA.perHole}"`);
    if (rowB.perHole !== '2.00') fail(`expected player B's points-per-hole to read "2.00", got "${rowB.perHole}"`);

    // The whole point of #3: player A's smaller raw total (9 < 36) must
    // still rank ABOVE player B, because the leaderboard orders by
    // points-per-hole pace (3.00 > 2.00), not raw total.
    const aIndex = rows.findIndex(r => r.name === seeded.aShort);
    const bIndex = rows.findIndex(r => r.name === seeded.bShort);
    if (!(aIndex < bIndex)) {
      fail(`expected player A (lower total, better pace) ranked above player B, got order: ${JSON.stringify(rows.map(r => r.name))}`);
    }
    if (Number(rowA.pts) <= Number(rowB.pts)) {
      fail(`expected player A to earn more finishing-position points than player B (pace-ranked 1st), got A=${rowA.pts} B=${rowB.pts}`);
    }

    if (consoleErrors.length > 0) fail('unexpected console/page errors during the run:\n' + consoleErrors.join('\n'));

    console.log('All Stableford page-improvement assertions passed.');
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
