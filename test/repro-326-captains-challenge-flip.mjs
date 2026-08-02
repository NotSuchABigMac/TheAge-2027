/* ─────────────────────────────────────
   REGRESSION TEST — issue #326: the Captain's Challenge rule flipped from
   issue #256's original direction. It used to be that whichever team ended
   up OVER-manned after the Captain's Draft was `challengeSide` (the side
   supplying the match's 2 opponents), with the short-manned team's lone
   player facing both. Now it's the reverse: the over-manned team's spare
   player is the lone side, and the SHORT-manned team is `challengeSide`,
   supplying the 2 opponents from players it's already using elsewhere.

   renderTeamBalanceWarning() in scorecard-live.html is the only place that
   bakes in a roster-size direction for challengeSide -- this drives it
   directly via `state` (bypassing Supabase entirely, which is mocked to
   return no rows) and checks the warning banner shows/hides correctly
   under both the old (should now be flagged as WRONG) and new (should be
   silent) roster/side pairings, for both team A and team B as the
   over-manned side.

   Run: node test/repro-326-captains-challenge-flip.mjs
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

// Friday-eligible player ids (players.js) split into two disjoint pools of
// 6 and 5 so we can hand either pool to either team without overlap.
const POOL_6 = [0, 1, 2, 3, 5, 6];
const POOL_5 = [7, 8, 9, 10, 12];

async function setRosterAndSide(page, { teamAIds, teamBIds, challengeSide }) {
  await page.evaluate(({ teamAIds, teamBIds, challengeSide }) => {
    state.teamA = new Set(teamAIds);
    state.teamB = new Set(teamBIds);
    state.day1.matches[0].type = 'challenge';
    state.day1.matches[0].challengeSide = challengeSide;
    renderTeamBalanceWarning();
  }, { teamAIds, teamBIds, challengeSide });
}

async function warningState(page) {
  return page.evaluate(() => {
    const el = document.getElementById('team-balance-warning');
    return { visible: el.style.display !== 'none', text: el.textContent };
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

    // 1. Team A over-manned (6), Team B short-manned (5), challengeSide='B'
    // (the short-manned team supplies the 2 opponents, per the new rule).
    // This is the correct, intended-to-be-silent setup under #326.
    await setRosterAndSide(page, { teamAIds: POOL_6, teamBIds: POOL_5, challengeSide: 'B' });
    let w = await warningState(page);
    if (w.visible) fail(`expected NO warning for A=6/B=5, challengeSide='B' (new rule), got: "${w.text}"`);

    // 2. Same roster, but challengeSide flipped to 'A' -- under the new
    // rule this is now WRONG (the over-manned team can't also be the one
    // supplying the 2 opponents), so a warning must appear, naming the
    // team that needs the extra player (B, the short-manned side, since
    // it's the one that should hold the lone "player 6").
    await setRosterAndSide(page, { teamAIds: POOL_6, teamBIds: POOL_5, challengeSide: 'A' });
    w = await warningState(page);
    if (!w.visible) fail(`expected a warning for A=6/B=5, challengeSide='A' (wrong under the new rule)`);
    if (!/Team Rehearsal|B\b/.test(w.text) && !w.text.includes('needs exactly 1 more')) {
      fail(`expected warning text to call out the side needing 1 more player, got: "${w.text}"`);
    }

    // 3. Mirror of (1) with sides swapped: Team B over-manned (6), Team A
    // short-manned (5), challengeSide='A' -- correct under the new rule,
    // must be silent (confirms the fix isn't hardcoded to one literal side).
    await setRosterAndSide(page, { teamAIds: POOL_5, teamBIds: POOL_6, challengeSide: 'A' });
    w = await warningState(page);
    if (w.visible) fail(`expected NO warning for A=5/B=6, challengeSide='A' (new rule), got: "${w.text}"`);

    // 4. Mirror of (2): same swapped roster, challengeSide='B' is now wrong
    // (B is over-manned, so it can't be the 2-opponent supplier either).
    await setRosterAndSide(page, { teamAIds: POOL_5, teamBIds: POOL_6, challengeSide: 'B' });
    w = await warningState(page);
    if (!w.visible) fail(`expected a warning for A=5/B=6, challengeSide='B' (wrong under the new rule)`);

    console.log('All #326 Captain\'s Challenge roster-direction assertions passed.');
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
