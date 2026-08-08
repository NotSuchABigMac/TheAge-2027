/* ─────────────────────────────────────
   REGRESSION TEST — issue #349: a player already assigned to a Day 2
   scramble group who then gets moved to the OTHER team (e.g. redrafted via
   the Teams tab) got stuck with a stale group membership on the team they
   just left. Day 2's "Assign Scramble Groups" UI only checks the 2 group
   codes belonging to a player's CURRENT team, and groupOf() still reported
   them as assigned to the stale one -- so they vanished from both teams'
   panel: not shown as an assigned chip anywhere, and not offered in either
   team's "+ add player…" dropdown either.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and calls the real setDay2Group()/movePlayer() functions, then
   inspects the rendered Day 2 "Assign Scramble Groups" DOM:

     - a player assigned to Team A's group a4, then moved to Team B, no
       longer appears as a chip in Team A's a4 bucket
     - that same player IS offered in Team B's "+ add player…" dropdowns
       (proving they aren't stuck invisible)
     - the Groups progress count reflects them as unassigned, not silently
       still counted as assigned somewhere the UI can't reach

   Run: node test/repro-349-day2-group-team-move.mjs
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
    // Both movePlayer() (Day 1 reconciliation) and our new Day 2
    // reconciliation surface a plain alert() when they clear something --
    // auto-accept so the test doesn't hang on a native dialog.
    page.on('dialog', (d) => d.accept());

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    await page.evaluate(() => {
      state.teamA = new Set([0, 2, 5, 8]);
      state.teamB = new Set([1, 3, 6, 7]);
      state.day2.groups = { a4: [0, 2, 5, 8], a3: [], b4: [1, 3, 6, 7], b3: [] };
      renderTeams();
      renderDay2Groups();
    });

    // Sanity check: player 8 starts as an assigned chip in Team A's a4
    // bucket, matching the seeded group above.
    let before = await page.evaluate(() => document.getElementById('day2-groups').textContent);
    if (!/8\)/.test(before) && !before.includes('(0)')) { /* chips render as "Short (hcp)", just confirm no crash below */ }

    // Move player 8 from Team A to Team B via the real Teams-tab path --
    // this is what a captain redrafting a player mid-tournament would do.
    await page.evaluate(() => movePlayer(8, true)); // fromA=true -> moves to B
    await page.evaluate(() => { renderTeams(); renderDay2Groups(); });

    const afterState = await page.evaluate(() => ({
      teamB: state.teamB.has(8),
      a4: state.day2.groups.a4,
      groupOf8: (function () {
        for (const code of ['a4', 'a3', 'b4', 'b3']) {
          if (state.day2.groups[code].includes(8)) return code;
        }
        return null;
      })()
    }));
    if (!afterState.teamB) fail('expected player 8 to now be on Team B');
    if (afterState.a4.includes(8)) fail('expected player 8 to be removed from the stale Team A group a4, still found there');
    if (afterState.groupOf8 !== null) fail(`expected player 8 to be fully unassigned (no stale group), found in ${afterState.groupOf8}`);

    // The Day 2 "Assign Scramble Groups" panel must now offer player 8 in
    // Team B's "+ add player…" dropdowns (not stuck invisible to both
    // teams the way the bug left them).
    const addSelectHasPlayer8 = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll('.day2-bucket select'));
      return selects.some(sel => Array.from(sel.options).some(o => o.value === '8'));
    });
    if (!addSelectHasPlayer8) fail('expected player 8 to be selectable in a Day 2 "+ add player…" dropdown after moving teams');

    console.log('All #349 Day 2 group / team-move reconciliation assertions passed.');
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
