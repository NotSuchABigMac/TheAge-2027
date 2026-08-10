/* ─────────────────────────────────────
   REGRESSION TEST — day-specific pickers show the slope-adjusted Daily
   Handicap, not just the raw GA Index.

   PR #336/#337 wired Golf Australia's slope-adjusted Daily Handicap into
   Day 1/2/3 stroke allocation, but every player-picking UI (Day 1's match
   slot dropdown, Day 2's group chips/add-player dropdown, Day 3's
   leaderboard) kept showing only the raw, portable GA Handicap Index --
   the number two organisers would compare to sanity-check a stroke count
   ("why does he get 10 shots when our handicap is only 9 apart?"), with
   no visible reason the two don't match once slope adjustment applies.
   handicapDisplay() in scorecard-live.html now shows "raw → adjusted"
   (e.g. "30.0 → 32") whenever a course has slope data and the two differ,
   so the jump is self-explanatory at the point of picking, not just
   buried in the resulting stroke dots.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and reads the rendered <option>/chip text directly:

     - Day 1's match-slot dropdown shows "30.0 → 32" for a Murray-adjusted
       player (default roster + teams, no setup needed)
     - Day 2's "+ add player…" dropdown shows "10.0 → 13" for a
       Black-Bull-adjusted player
     - Day 2's group chip shows "29.0 → 34" once that player is actually
       grouped
     - Day 3's leaderboard HCP column shows "29.0 → 30" (Lake-adjusted)

   Run: node test/repro-day-picker-daily-handicap.mjs
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
    await page.waitForTimeout(600); // let the initial poll/replay land

    // 1. Day 1 match slot dropdown -- player 9 (J. Hepburn, hcp 30.0, on
    // the default roster's Team B) is Murray-adjusted to 32. Default
    // teams/matches need no setup: match 0 is an empty singles match, and
    // team B's pool always includes any Friday-eligible Team B player.
    const day1OptionText = await page.evaluate(() => {
      const selects = document.querySelectorAll('#match-card-0 select');
      const teamBSelect = selects[1];
      const opt = teamBSelect && Array.from(teamBSelect.options).find(o => o.value === '9');
      return opt ? opt.textContent : null;
    });
    if (day1OptionText === null) fail('expected player 9 to appear as an option in match 0 team B slot');
    if (!/30\.0 → 32/.test(day1OptionText)) {
      fail(`expected Day 1's match dropdown to show "30.0 → 32" (Murray Daily Handicap) for player 9, got "${day1OptionText}"`);
    }

    // 2. Day 2's "+ add player…" dropdown -- player 0 (B. Cunningham, hcp
    // 10.0, Team A) is unassigned to any group by default, so shows in
    // group a4's add-player select. Black-Bull-adjusted to 13.
    const day2AddOptionText = await page.evaluate(() => {
      const select = Array.from(document.querySelectorAll('#day2-groups select'))
        .find(sel => Array.from(sel.options).some(o => o.value === '0'));
      const opt = select && Array.from(select.options).find(o => o.value === '0');
      return opt ? opt.textContent : null;
    });
    if (day2AddOptionText === null) fail('expected player 0 to appear as an option in a Day 2 add-player select');
    if (!/10\.0 → 13/.test(day2AddOptionText)) {
      fail(`expected Day 2's add-player dropdown to show "10.0 → 13" (Black Bull Daily Handicap) for player 0, got "${day2AddOptionText}"`);
    }

    // 3. Day 2's group chip -- directly assign player 8 (S. Koenig, hcp
    // 29.0, Team A, Black-Bull-adjusted to 34) into group a3, bypassing
    // the requireUsername()-gated setDay2Group() the same way #328's repro
    // exercises Day 1 assignment: mutate state directly and re-render.
    const day2ChipText = await page.evaluate(() => {
      state.day2.groups.a3 = [8];
      renderDay2Groups();
      const chip = Array.from(document.querySelectorAll('.day2-chip')).find(el => el.textContent.includes('S. Koenig'));
      return chip ? chip.textContent : null;
    });
    if (day2ChipText === null) fail('expected a Day 2 chip for player 8 (S. Koenig) after assigning them to group a3');
    if (!/29\.0 → 34/.test(day2ChipText)) {
      fail(`expected Day 2's group chip to show "29.0 → 34" (Black Bull Daily Handicap) for player 8, got "${day2ChipText}"`);
    }

    // 4. Day 3 leaderboard HCP column -- player 8 (S. Koenig, hcp 29.0) is
    // Lake-adjusted to 30.
    const day3HcpText = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll('#sf-tbody tr')).find(tr => tr.textContent.includes('S. Koenig'));
      return row ? row.children[3].textContent : null;
    });
    if (day3HcpText === null) fail('expected a Day 3 leaderboard row for player 8 (S. Koenig)');
    if (!/29\.0 → 30/.test(day3HcpText)) {
      fail(`expected Day 3's leaderboard HCP column to show "29.0 → 30" (Lake Daily Handicap) for player 8, got "${day3HcpText}"`);
    }

    console.log('All day-picker Daily Handicap display assertions passed.');
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
