/* ─────────────────────────────────────
   REGRESSION TEST — PR #336 follow-up: tv.html's live Day 1 board must
   use the same slope-adjusted Daily Handicap as scorecard-live.html.

   PR #336 wired Golf Australia's slope-adjusted Daily Handicap (courses.js'
   rating/slope) into scoring.js and scorecard-live.html's Day 1/2/3 stroke
   allocation, but left tv.html's live-board wrapper functions
   (matchLiveLabel/liveDay1Rows, liveDay2Field, liveDay3Field) calling the
   same shared functions without the new `course`/`courses` argument, or
   reimplementing the pre-adjustment raw-handicap formula directly. That let
   the clubhouse TV board silently disagree with the real scorecard about
   who's leading a given hole.

   This drives a real browser against a fixture picked so the two handicap
   models disagree about a single scored hole:
     - player 0 (hcp 0.0) vs player 1 (hcp 5.0) on Murray (courses[1]),
       hole 1 (stroke index 6) is the only hole scored: A shoots 4 (par),
       B shoots 5.
     - Unadjusted (raw hcp): diff 5, extra 5 -- SI 6 > 5, so B gets 0
       strokes on hole 1 -> net B (5) beats net A (4) the other way, i.e.
       A's net 4 wins the hole outright -> a "1UP" badge, not "A/S".
     - Murray-adjusted (Daily Handicap): dailyHandicap(0, Murray) = 0,
       dailyHandicap(5, Murray) = 6 -- diff 6, extra 6 -- SI 6 <= 6, so B
       now gets 1 stroke on hole 1 -> net B (4) ties net A (4) -> halve ->
       an "A/S" badge with a "Front 9 thru 1" sub-line.
   Only the adjusted result is correct once slope adjustment is wired in
   everywhere -- a live board still on raw handicaps would show a "1UP"
   badge instead, disagreeing with the real scorecard.

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is either mocked with fixture
   rows or aborted, per scenario -- never hit for real.

   Run: node test/repro-tv-slope-handicap.mjs
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

// Day 1 match 0 (players 0 v 1): hcp 0.0 vs hcp 5.0, only hole 1 (Murray SI
// 6) scored -- A (4, par) vs B (5). See file header for why the raw vs
// slope-adjusted handicap models disagree about who wins this hole.
function fixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  const rows = [
    row({ update_type: 'team_name', field_key: 'A', value: 'Team Alpha' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Team Beta' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'player_hcp', player_id: 0, value: '0.0' }),
    row({ update_type: 'player_hcp', player_id: 1, value: '5.0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' }),
    row({ update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4' }),
    row({ update_type: 'day1_hole', match_idx: 0, field_key: 'B1', value: '5' })
  ];
  return rows;
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

    const page = await context.newPage();
    // 2026-08-07T02:00:00Z is 2026-08-07T12:00 Melbourne -> Day 1.
    await page.addInitScript(dateMockScript('2026-08-07T02:00:00Z'));
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureRows()) });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);

    const header = await page.evaluate(() => document.getElementById('tv-status').textContent);
    if (!/Day 1 in play/.test(header)) fail(`expected "Day 1 in play" status, got "${header}"`);

    const live = await page.evaluate(() => ({
      title: document.getElementById('live-title').textContent,
      text: document.getElementById('live-board').textContent
    }));
    if (!/Day 1.*Live/.test(live.title)) fail(`expected the Live screen to show Day 1, got title "${live.title}"`);
    if (!/A\/S/.test(live.text) || !/Front 9 thru 1/.test(live.text)) {
      fail(`expected the slope-adjusted "A/S" / "Front 9 thru 1" badge (Murray Daily Handicaps 0/6 halve hole 1), got "${live.text}" -- tv.html is likely back to using raw, unadjusted handicaps`);
    }

    console.log('All tv.html slope-handicap parity assertions passed.');
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
