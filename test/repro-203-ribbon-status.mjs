/* ─────────────────────────────────────
   REGRESSION TEST — issue #203: homepage countdown -> live score ->
   final result.

   index.html is a static brochure right up until the moment traffic
   actually peaks. ribbon-status.js swaps the ribbon's "Holders" slot
   through three date-driven phases (WongaScoring.phaseFor), computing
   the live score via the exact same WongaScoring.computeSeasonTotals()
   the live scorecard itself calls. Covers:

     - before 7 Aug: a countdown ("Kicks Off In · N Days")
     - during the tournament: a real score, replayed from mocked
       tournament_updates rows, matching a hand-computed expectation
     - after 9 Aug: a frozen final result naming the winner
     - graceful degradation: if the read fails, the ribbon's shipped
       static content is left completely untouched -- no spinner, no
       error state

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is either mocked with fixture
   rows or aborted, per scenario -- never hit for real.

   Run: node test/repro-203-ribbon-status.mjs
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
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
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

// Overrides the zero-arg `new Date()`/`Date.now()` to a fixed instant
// while leaving `new Date(explicitArg)` (used throughout scoring.js's
// date-formatting helpers) untouched.
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

// Rows for a Day 1 match: Team Alpha (player 0) beats Team Beta (player 1)
// on both nines, manually entered (no hole-by-hole data) -- 2pts to A,
// 0 to B, day2/day3 untouched (0 each). Expected total: A 2 - 0 B.
function fixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-01T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  return [
    row({ update_type: 'team_name', field_key: 'A', value: 'Team Alpha' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Team Beta' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'A' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'back9', value: 'A' })
  ];
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const base = `http://127.0.0.1:${sitePort}`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. Before 7 Aug 2026: a countdown.
    {
      const page = await context.newPage();
      await page.addInitScript(dateMockScript('2026-07-20T00:00:00Z'));
      await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
      await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const label = await page.textContent('#ribbon-status-label');
      const value = await page.textContent('#ribbon-status-value');
      if (label !== 'Kicks Off In') fail(`expected countdown label "Kicks Off In", got "${label}"`);
      if (!/Days$/.test(value) && value !== '1 Day') fail(`expected a "N Days" countdown value, got "${value}"`);
      await page.close();
    }

    // 2. During the tournament (Day 2): a real live score.
    {
      const page = await context.newPage();
      await page.addInitScript(dateMockScript('2026-08-08T02:00:00Z')); // Melbourne 2026-08-08T12:00, Day 2
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureRows()) });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const label = await page.textContent('#ribbon-status-label');
      const value = await page.textContent('#ribbon-status-value');
      if (label !== 'Live Now') fail(`expected live label "Live Now", got "${label}"`);
      if (!value.includes('Team Alpha 2') || !value.includes('0 Team Beta')) fail(`expected the live score "Team Alpha 2 – 0 Team Beta", got "${value}"`);
      if (!/Day 2 in play/.test(value)) fail(`expected "Day 2 in play" in the live value, got "${value}"`);
      await page.close();
    }

    // 3. After 9 Aug 2026: a frozen final result.
    {
      const page = await context.newPage();
      await page.addInitScript(dateMockScript('2026-08-10T00:00:00Z'));
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixtureRows()) });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const label = await page.textContent('#ribbon-status-label');
      const value = await page.textContent('#ribbon-status-value');
      if (label !== 'Result') fail(`expected final label "Result", got "${label}"`);
      if (!/Team Alpha win/.test(value)) fail(`expected the final result to name Team Alpha as winner, got "${value}"`);
      await page.close();
    }

    // 4. Graceful degradation: a failed read during live mode leaves the
    // shipped static "Holders / Team Underdogs" content untouched.
    {
      const page = await context.newPage();
      await page.addInitScript(dateMockScript('2026-08-08T02:00:00Z'));
      await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
      await page.goto(`${base}/index.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const label = await page.textContent('#ribbon-status-label');
      const value = await page.textContent('#ribbon-status-value');
      if (label !== 'Holders') fail(`expected the static "Holders" label to survive a failed read, got "${label}"`);
      if (value !== 'Team Underdogs') fail(`expected the static "Team Underdogs" value to survive a failed read, got "${value}"`);
      await page.close();
    }

    console.log('All #203 ribbon-status assertions passed.');
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
