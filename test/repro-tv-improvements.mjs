/* ─────────────────────────────────────
   REGRESSION TEST — tv.html improvements pass (Wonga Wire ticker, Day 1
   Live screen rebuilt as a sorted leaderboard with colored UP/A-S badges,
   rotation position dots, and a phase-adaptive Live screen slot: course
   photo + format preview during the countdown, a trophy/result card once
   the Cup is decided).

   Three scenarios, each its own browser context:

     1. LIVE, Day 1 -- two matches, deliberately out of draw order and at
        different thru counts, so the leaderboard's "most holes played
        first" sort is actually exercised (not just correct by
        coincidence of match order). Match 1 (the second pairing) is 3
        holes into its front 9 and 2UP; match 0 (the first pairing, drawn
        first) is only 1 hole in and A/S. The leaderboard must show match
        1 above match 0, with match 1's badge colored in the leading
        team's color. Also asserts the Wonga Wire ticker shows the most
        recent event and the rotation dots exist with exactly one active.

     2. COUNTDOWN (before Day 1) -- the Live screen slot has nothing to
        rotate into (defaultDay() is null), so it must show the 3 days'
        course photo + one-line format instead of a "no round" filler.

     3. FINAL (after Day 3) -- same null-defaultDay() case, but now with
        a decided Cup: the Live screen slot must show a trophy card with
        the actual winning team's name, not the generic filler either.

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is either mocked with fixture
   rows or aborted, per scenario -- never hit for real.

   Run: node test/repro-tv-improvements.mjs
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

// Day 1, two matches, all handicaps 0.0 so gross == net (keeps the hole
// results unambiguous). Match 0 (players 0 v 1, drawn first): 1 hole
// played, halved -- A/S thru 1. Match 1 (players 2 v 3, drawn second): 3
// holes played, player 2 wins all 3 -- 3UP thru 3. Also fires an NTP
// event (day1_ntp) so the Wonga Wire ticker has something to show.
function liveDay1FixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  const rows = [
    row({ update_type: 'team_name', field_key: 'A', value: 'Team Alpha' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Team Beta' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'player_team', player_id: 2, value: 'A' }),
    row({ update_type: 'player_team', player_id: 3, value: 'B' })
  ];
  [0, 1, 2, 3].forEach((id) => rows.push(row({ update_type: 'player_hcp', player_id: id, value: '0.0' })));

  rows.push(row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }));
  rows.push(row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' }));
  rows.push(row({ update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4' }));
  rows.push(row({ update_type: 'day1_hole', match_idx: 0, field_key: 'B1', value: '4' }));

  rows.push(row({ update_type: 'day1_match', match_idx: 1, field_key: 'pA', value: '2' }));
  rows.push(row({ update_type: 'day1_match', match_idx: 1, field_key: 'pB', value: '3' }));
  [[1, 3, 5], [2, 3, 5], [3, 3, 5]].forEach(([hole, a, b]) => {
    rows.push(row({ update_type: 'day1_hole', match_idx: 1, field_key: `A${hole}`, value: String(a) }));
    rows.push(row({ update_type: 'day1_hole', match_idx: 1, field_key: `B${hole}`, value: String(b) }));
  });

  rows.push(row({ update_type: 'day1_ntp', field_key: 'h8', value: '0' }));
  return rows;
}

async function testLiveDay1Leaderboard(browser) {
  const context = await browser.newContext();
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  const page = await context.newPage();
  await page.addInitScript(dateMockScript('2026-08-07T02:00:00Z')); // Melbourne noon Day 1
  await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(liveDay1FixtureRows()) });
  });
  await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
    if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
    route.abort();
  });

  const site = global.__wongaSite;
  await page.goto(`http://127.0.0.1:${site.port}/tv.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  // Leaderboard order: match 1 (3 holes played) above match 0 (1 hole
  // played), even though match 0 was drawn first -- proves the sort is by
  // thru, not draw order.
  const live = await page.evaluate(() => {
    const board = document.getElementById('live-board');
    return {
      title: document.getElementById('live-title').textContent,
      rowsText: Array.from(board.querySelectorAll('.tv-row')).map(r => r.textContent),
      badgeClasses: Array.from(board.querySelectorAll('.tv-status-badge')).map(b => b.className)
    };
  });
  if (!/Day 1.*Live/.test(live.title)) fail(`expected the Live screen to show Day 1, got title "${live.title}"`);
  if (live.rowsText.length !== 2) fail(`expected 2 match rows on the Day 1 leaderboard, got ${live.rowsText.length}: ${JSON.stringify(live.rowsText)}`);
  if (!/M\. Smith/.test(live.rowsText[0])) {
    fail(`expected the 3-holes-played match (M. Smith v J. McIntyre) first in the leaderboard, got row 0: "${live.rowsText[0]}"`);
  }
  if (!/3UP/.test(live.rowsText[0])) fail(`expected a "3UP" badge on the leading match, got row 0: "${live.rowsText[0]}"`);
  if (!/A\/S/.test(live.rowsText[1])) fail(`expected an "A\\/S" badge on the halved 1-hole match, got row 1: "${live.rowsText[1]}"`);
  if (!live.badgeClasses.some(c => c.includes('tv-badge-a') || c.includes('tv-badge-b'))) {
    fail(`expected at least one team-colored badge class, got ${JSON.stringify(live.badgeClasses)}`);
  }
  if (!live.badgeClasses.some(c => c.includes('tv-badge-neutral'))) {
    fail(`expected the halved match's badge to use the neutral class, got ${JSON.stringify(live.badgeClasses)}`);
  }

  // Course photo + format strip now prepended to the Live screen.
  const courseCard = await page.evaluate(() => document.querySelector('#live-board .tv-course-name')?.textContent || '');
  if (!/Murray/.test(courseCard)) fail(`expected a Murray course card on the Day 1 Live screen, got "${courseCard}"`);

  // Wonga Wire ticker: the NTP event should be showing (only one event in
  // this fixture, so no need to wait out the 6s cycle).
  const wire = await page.evaluate(() => ({
    visible: document.getElementById('tv-wire').classList.contains('tv-wire-visible'),
    text: document.getElementById('tv-wire-text').textContent
  }));
  if (!wire.visible) fail('expected the Wonga Wire ticker to be visible once an event has fired');
  if (!/takes NTP/.test(wire.text)) fail(`expected the NTP event on the Wonga Wire ticker, got "${wire.text}"`);

  // Rotation dots: one per screen, exactly one active on load.
  const dots = await page.evaluate(() => {
    const all = document.querySelectorAll('#tv-dots .tv-dot');
    return { total: all.length, active: document.querySelectorAll('#tv-dots .tv-dot-active').length };
  });
  if (dots.total !== 3) fail(`expected 3 rotation dots (Cup/Live/NTP), got ${dots.total}`);
  if (dots.active !== 1) fail(`expected exactly 1 active rotation dot, got ${dots.active}`);

  await context.close();
  console.log('Live Day 1 leaderboard/ticker/dots assertions passed.');
}

async function testCountdownFormatPreview(browser) {
  const context = await browser.newContext();
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  const page = await context.newPage();
  await page.addInitScript(dateMockScript('2026-08-01T02:00:00Z')); // before Day 1 (2026-08-07)
  await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
    if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
    route.abort();
  });

  const site = global.__wongaSite;
  await page.goto(`http://127.0.0.1:${site.port}/tv.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const live = await page.evaluate(() => ({
    title: document.getElementById('live-title').textContent,
    cardCount: document.querySelectorAll('#live-board .tv-course-card').length,
    text: document.getElementById('live-board').textContent
  }));
  if (!/Format/.test(live.title)) fail(`expected the countdown Live screen title to mention "Format", got "${live.title}"`);
  if (live.cardCount !== 3) fail(`expected 3 course-preview cards (Day 1/2/3) during the countdown, got ${live.cardCount}`);
  if (!/Murray/.test(live.text) || !/Black Bull/.test(live.text) || !/Lake/.test(live.text)) {
    fail(`expected all 3 course names in the countdown preview, got "${live.text}"`);
  }
  if (/No round in play/.test(live.text)) fail('countdown Live screen still shows the old "no round in play" filler');

  await context.close();
  console.log('Countdown format-preview assertions passed.');
}

// Day 1/2/3 all decided, Team Alpha ahead -- final phase.
function finalFixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  return [
    row({ update_type: 'team_name', field_key: 'A', value: 'Team Alpha' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Team Beta' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'player_hcp', player_id: 0, value: '0.0' }),
    row({ update_type: 'player_hcp', player_id: 1, value: '0.0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'A' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'back9', value: 'A' })
  ];
}

async function testFinalTrophyCard(browser) {
  const context = await browser.newContext();
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  const page = await context.newPage();
  await page.addInitScript(dateMockScript('2026-08-15T02:00:00Z')); // well after Day 3 (2026-08-09)
  await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(finalFixtureRows()) });
  });
  await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
    if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
    route.abort();
  });

  const site = global.__wongaSite;
  await page.goto(`http://127.0.0.1:${site.port}/tv.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const live = await page.evaluate(() => ({
    title: document.getElementById('live-title').textContent,
    text: document.getElementById('live-board').textContent,
    hasTrophy: !!document.querySelector('#live-board .tv-trophy')
  }));
  if (!/Result/.test(live.title)) fail(`expected the final Live screen title to mention "Result", got "${live.title}"`);
  if (!live.hasTrophy) fail('expected a .tv-trophy card on the final Live screen');
  if (!/Team Alpha/.test(live.text)) fail(`expected the actual winning team name on the trophy card, got "${live.text}"`);
  if (/No round in play/.test(live.text)) fail('final Live screen still shows the old "no round in play" filler');

  await context.close();
  console.log('Final trophy-card assertions passed.');
}

async function main() {
  const site = await startStaticServer();
  global.__wongaSite = { port: site.address().port };

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    await testLiveDay1Leaderboard(browser);
    await testCountdownFormatPreview(browser);
    await testFinalTrophyCard(browser);
    console.log('All tv.html improvements assertions passed.');
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
