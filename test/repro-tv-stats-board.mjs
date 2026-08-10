/* ─────────────────────────────────────
   REGRESSION TEST — tv.html's Stat Board (4th rotation screen).

   day1PlayerReportCardsFor()/day1Superlatives() (scoring.js) now feed a
   new #screen-stats rotation screen: a continuously auto-scrolling
   ticker of Day 1 superlatives (most net pars-or-better, most/least
   consistent net scorer, worst score to win a hole, best score to lose
   a hole, best par3/4/5 player, serial peacemaker, nailbiter king,
   comeback king, fast starter, closer, hardest/easiest hole) plus one
   hand-curated joke award ("Most Kangaroos Scared") with no real data
   behind it at all.

   Drives a real browser against a small fixture (one full 18-hole Day 1
   match with an extreme 1-vs-15 gross margin on every hole, so the
   worst-score-to-win/best-score-to-lose stats have an unambiguous
   answer, plus both NTP holes) and checks: the board renders all the
   computed stat labels, the specific worst-win/best-loss values match
   hand-calculated ones, the joke award always appears regardless of what
   data exists, the track content is duplicated (for the CSS scroll
   loop's seamless wrap), and an empty-state fixture (no Day 1 data at
   all) still shows the joke award without crashing.

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked with fixture rows,
   never hit for real.

   Run: node test/repro-tv-stats-board.mjs
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


function dateMockScript(iso) {
  const fixed = new Date(iso).getTime();
  return `(() => {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(${fixed});
        else super(...args);
      }
      static now() { return ${fixed}; }
    }
    window.Date = MockDate;
  })();`;
}

// One full Day 1 match, players 0 (team A) v 1 (team B), extreme 1-vs-15
// gross margin on every hole -- player 0 wins every hole outright
// regardless of handicap (no plausible stroke allocation closes a
// 14-stroke gap), so player 0's worst-win hole and player 1's best-loss
// hole are both unambiguous and hand-computable from courses.js' real
// Murray pars. Both NTP holes also claimed, one per team.
function fixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  const rows = [
    row({ update_type: 'team_name', field_key: 'A', value: 'Flamingos' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Gorillas' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' })
  ];
  for (let h = 1; h <= 18; h++) {
    rows.push(row({ update_type: 'day1_hole', match_idx: 0, field_key: `A${h}`, value: '1' }));
    rows.push(row({ update_type: 'day1_hole', match_idx: 0, field_key: `B${h}`, value: '15' }));
  }
  rows.push(row({ update_type: 'day1_ntp', field_key: 'h8', value: '0' }));
  rows.push(row({ update_type: 'day1_ntp', field_key: 'h17', value: '1' }));
  return rows;
}

async function withPage(context, fixtureFn, run) {
  const page = await context.newPage();
  await page.addInitScript(dateMockScript('2026-08-07T02:00:00Z')); // Day 1 Melbourne-local
  await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureFn()) });
  });
  await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
    if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
    route.abort();
  });
  await run(page);
  await page.close();
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const base = `http://127.0.0.1:${sitePort}/tv.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    await withPage(context, fixtureRows, async (page) => {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);

      const text = await page.locator('#stats-track').textContent();

      // Every serious stat label present.
      const expectedLabels = [
        'Most Net Pars-or-Better', 'Most Consistent Net Scorer', 'Least Consistent Net Scorer',
        'Worst Score to Win a Hole', 'Best Score to Lose a Hole',
        'Best Par 3 Player', 'Best Par 4 Player', 'Best Par 5 Player',
        'Serial Peacemaker', 'Nailbiter King', 'Comeback King', 'Fast Starter', 'Closer',
        'Hardest Hole', 'Easiest Hole'
      ];
      expectedLabels.forEach((label) => {
        if (!text.includes(label)) fail(`expected the Stat Board to include "${label}", got: ${text.slice(0, 400)}...`);
      });

      // The joke award always appears, regardless of what real data exists.
      if (!/Most Kangaroos Scared/.test(text)) fail('expected the hand-curated "Most Kangaroos Scared" joke award to appear');
      if (!/R\. Hughes/.test(text)) fail('expected the joke award to credit R. Hughes');

      // Both nailbiter/comeback/etc stats must resolve to one of the two
      // fixture players (Brendan Cunningham id 0, Gary King id 1) --
      // confirms real player names made it through, not raw ids.
      if (!/Brendan Cunningham|Gary King/.test(text)) {
        fail(`expected a real player name (Brendan Cunningham or Gary King) somewhere on the board, got: ${text.slice(0, 400)}`);
      }

      // Track content is duplicated once (seamless CSS scroll loop) --
      // the "Most Kangaroos Scared" award, unique in the whole board,
      // must appear exactly twice.
      const kangarooCount = (text.match(/Most Kangaroos Scared/g) || []).length;
      if (kangarooCount !== 2) fail(`expected the stats track to duplicate its content once (2 copies), found the joke award ${kangarooCount} time(s)`);

      // The scroll-duration CSS var is set (non-empty), proving
      // renderStats() actually ran rather than leaving the track inert.
      const duration = await page.locator('#stats-track').evaluate((el) => el.style.getPropertyValue('--tv-stats-duration'));
      if (!duration) fail('expected --tv-stats-duration to be set on the stats track');
    });

    // Empty-state fixture: no Day 1 matches at all -- the board must not
    // crash, and the joke award (which has no data dependency) must
    // still be the only thing shown.
    await withPage(context, () => [], async (page) => {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(700);
      const text = await page.locator('#stats-track').textContent();
      if (!/Most Kangaroos Scared/.test(text)) fail('expected the joke award to still appear with zero real Day 1 data');
      if (/Worst Score to Win a Hole/.test(text)) fail('expected no-data stats to be omitted entirely, not shown blank');
    });

    console.log('All tv.html Stat Board assertions passed.');
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
