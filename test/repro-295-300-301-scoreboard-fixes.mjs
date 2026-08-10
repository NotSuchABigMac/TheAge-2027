/* ─────────────────────────────────────
   REGRESSION TEST — issues #295 (right-align Team A on the pinned
   scoreboard), #300 (mini scoreboard should show the "as it stands"
   projected score, not the literal current total, and label itself
   "Projected"), #301 (swap sticky behavior: the pinned scoreboard stays
   at the top of the page, the mini scoreboard bar is the one that follows
   down the page).

   Drives the real scorecard-live.html in demo mode with state mutated
   directly (no real network round-trip needed):

     - #295: .team-a is right-aligned (text-align + its .sb-day-chips row
       justify-content), unlike the unmodified .team-b.
     - #301: .scoreboard-pin is NOT position:sticky (normal document flow,
       scrolls away), .mini-sb IS position:sticky and stays on-screen after
       a big scroll while .scoreboard-pin scrolls out of view.
     - #300: .mini-sb has a "Projected" header label. With an in-progress,
       undecided Day 1 match lead, the mini scoreboard's score reflects the
       "as it stands" projected total (not the still-0-0 literal total).
       Once the match is fully decided, the mini scoreboard reads the same
       as the (now caught-up) real total. The pinned scoreboard's old
       on-panel "Standing: As It Stands" projection line (#260) is gone
       (#projected-line no longer exists) -- .mini-sb is now the only place
       the projected score is shown, avoiding the duplication both bars
       used to show.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-295-300-301-scoreboard-fixes.mjs
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
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // ── #295: Team A's column is right-aligned, hugging VS; Team B's
    // (unmodified, already-close) column stays whatever the default is.
    {
      const align = await page.evaluate(() => ({
        teamA: getComputedStyle(document.querySelector('.team-a')).textAlign,
        chipsA: getComputedStyle(document.querySelector('.team-a .sb-day-chips')).justifyContent
      }));
      if (align.teamA !== 'right') fail(`expected .team-a to be right-aligned, got textAlign "${align.teamA}"`);
      if (align.chipsA !== 'flex-end') fail(`expected .team-a .sb-day-chips to justify-content:flex-end, got "${align.chipsA}"`);
    }

    // ── #301: .scoreboard-pin is normal flow (not sticky); .mini-sb is
    // sticky and stays on-screen after a big scroll while .scoreboard-pin
    // scrolls away.
    {
      const positions = await page.evaluate(() => ({
        pin: getComputedStyle(document.querySelector('.scoreboard-pin')).position,
        miniSb: getComputedStyle(document.querySelector('.mini-sb')).position
      }));
      if (positions.pin === 'sticky') fail('expected .scoreboard-pin to NOT be position:sticky (should stay at the top of the page)');
      if (positions.miniSb !== 'sticky') fail(`expected .mini-sb to be position:sticky, got "${positions.miniSb}"`);

      // html has scroll-behavior:smooth (styles.css) -- force instant so
      // the scroll has actually landed before we read bounding rects.
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = 'auto';
        window.scrollTo(0, 2000);
      });
      await page.waitForTimeout(50);
      const rects = await page.evaluate(() => ({
        pin: document.querySelector('.scoreboard-pin').getBoundingClientRect(),
        miniSb: document.querySelector('.mini-sb').getBoundingClientRect()
      }));
      if (rects.pin.bottom > 0) fail(`expected .scoreboard-pin to have scrolled off-screen, got rect ${JSON.stringify(rects.pin)}`);
      if (rects.miniSb.top < 0 || rects.miniSb.bottom > 2000) {
        fail(`expected .mini-sb to stay pinned on-screen after scrolling, got rect ${JSON.stringify(rects.miniSb)}`);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
    }

    // Pin match 0 onto two real players with equal handicaps (no strokes,
    // so gross == net keeps the expected numbers simple), starting from a
    // clean slate.
    await page.evaluate(() => {
      const a = PLAYERS[0], b = PLAYERS[1];
      a.hcp = '10.0'; b.hcp = '10.0';
      const m = state.day1.matches[0];
      m.pA = [a.id]; m.pB = [b.id];
      m.front9 = null; m.back9 = null;
      m.holesA = Array(18).fill(null);
      m.holesB = Array(18).fill(null);
      updateScoreboard();
    });

    // ── #300: .mini-sb has a "Projected" header, and the pinned
    // scoreboard's old #projected-line duplicate is gone entirely.
    {
      const miniState = await page.evaluate(() => ({
        header: document.querySelector('.mini-sb-header')?.textContent,
        projectedLineExists: !!document.getElementById('projected-line')
      }));
      if (miniState.header !== 'Projected') fail(`expected .mini-sb-header to read "Projected", got "${miniState.header}"`);
      if (miniState.projectedLineExists) fail('expected #projected-line to no longer exist on the pinned scoreboard (moved to .mini-sb)');
    }

    // ── #300: with no hole data, mini-sb reads 0-0 (nothing to project).
    {
      const scores = await page.evaluate(() => ({
        a: document.getElementById('mini-score-a').textContent,
        b: document.getElementById('mini-score-b').textContent
      }));
      if (scores.a !== '0' || scores.b !== '0') fail(`expected mini-sb "0"-"0" with no hole data, got "${scores.a}"-"${scores.b}"`);
    }

    // ── #300: a partial, undecided lead in match 0 (A ahead 3-0 thru 3 on
    // the front nine) must show up in the mini-sb's score as the projected
    // 1-0 match-points lead, NOT the still 0-0 real/current totals.
    {
      const result = await page.evaluate(() => {
        const m = state.day1.matches[0];
        m.holesA[0] = 4; m.holesB[0] = 5;
        m.holesA[1] = 4; m.holesB[1] = 5;
        m.holesA[2] = 4; m.holesB[2] = 5;
        updateScoreboard();
        return {
          miniA: document.getElementById('mini-score-a').textContent,
          miniB: document.getElementById('mini-score-b').textContent,
          realA: document.getElementById('sb-total-a').textContent,
          realB: document.getElementById('sb-total-b').textContent
        };
      });
      if (result.realA !== '0' || result.realB !== '0') fail(`expected real totals to stay "0"-"0" while undecided, got "${result.realA}"-"${result.realB}"`);
      if (result.miniA !== '1' || result.miniB !== '0') {
        fail(`expected the mini scoreboard to show the projected 1-0 lead, got "${result.miniA}"-"${result.miniB}"`);
      }
    }

    // ── #300: once the match is fully decided, the mini scoreboard reads
    // the same as the caught-up real total (projection degrades to real).
    {
      const result = await page.evaluate(() => {
        const m = state.day1.matches[0];
        for (let i = 0; i < 18; i++) { m.holesA[i] = 4; m.holesB[i] = 5; }
        updateScoreboard();
        return {
          miniA: document.getElementById('mini-score-a').textContent,
          miniB: document.getElementById('mini-score-b').textContent,
          realA: document.getElementById('sb-total-a').textContent,
          realB: document.getElementById('sb-total-b').textContent
        };
      });
      if (result.miniA !== result.realA || result.miniB !== result.realB) {
        fail(`expected mini-sb to match the decided real total ("${result.realA}"-"${result.realB}"), got "${result.miniA}"-"${result.miniB}"`);
      }
      if (result.realA !== '2') fail(`expected the real total to reach "2" once the match is fully decided, got "${result.realA}"`);
    }

    console.log('All #295/#300/#301 scoreboard-fixes assertions passed.');
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
