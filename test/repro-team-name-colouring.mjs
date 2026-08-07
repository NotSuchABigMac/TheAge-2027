/* ─────────────────────────────────────
   REGRESSION TEST — flamingo/gorilla colouring on drafted player names.

   The Team Assignment panel's column headers (#team-col-h-a/-b) were
   already colored with --team-a (flamingo, pink) / --team-b (gorilla,
   blue), same as team badges, score cells, and match-card borders
   elsewhere in this app -- but a drafted player's own name inside
   #team-a-list/#team-b-list stayed neutral ink (.team-player-item span
   was hardcoded to var(--ink)). Scoped color rules now make each
   player's name match the column/team it's actually sitting in, while a
   still-unassigned player (in #team-unassigned-list, a third column with
   its own neutral border) stays neutral since no team's color applies
   yet.

   Drives `state` directly and calls renderTeams() (same pattern as
   test/repro-326-captains-challenge-flip.mjs), bypassing Supabase (mocked
   to return no rows) and the admin PIN gate -- #team-a-list/#team-b-list
   exist in the DOM regardless of which tab is active or whether an admin
   is logged in, so querying them directly is sufficient to check the
   CSS rule actually applies.

   Run: node test/repro-team-name-colouring.mjs
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
const TEAM_A_RGB = 'rgb(244, 114, 182)'; // #f472b6
const TEAM_B_RGB = 'rgb(106, 184, 247)'; // #6ab8f7

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

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Player 0 drafted to A, player 1 to B, player 2 left unassigned.
    await page.evaluate(() => {
      state.teamA = new Set([0]);
      state.teamB = new Set([1]);
      renderTeams();
    });

    const colors = await page.evaluate(() => ({
      a: getComputedStyle(document.querySelector('#team-a-list .team-player-item span')).color,
      b: getComputedStyle(document.querySelector('#team-b-list .team-player-item span')).color,
      unassigned: (() => {
        const el = document.querySelector('#team-unassigned-list .team-player-item span');
        return el ? getComputedStyle(el).color : null;
      })()
    }));

    if (colors.a !== TEAM_A_RGB) fail(`expected a drafted Team A player's name in flamingo pink (${TEAM_A_RGB}), got "${colors.a}"`);
    if (colors.b !== TEAM_B_RGB) fail(`expected a drafted Team B player's name in gorilla blue (${TEAM_B_RGB}), got "${colors.b}"`);
    if (colors.unassigned !== null) {
      if (colors.unassigned === TEAM_A_RGB || colors.unassigned === TEAM_B_RGB) {
        fail(`expected an unassigned player's name to stay neutral (no team color yet), got "${colors.unassigned}"`);
      }
    }

    console.log('Team A/B drafted-name colouring assertions passed.');
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
