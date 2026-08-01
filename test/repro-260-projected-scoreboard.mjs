/* ─────────────────────────────────────
   REGRESSION TEST — issue #260: "if everything ended right now"
   projected scoreboard line.

   Before this fix, an in-progress Day 1 match or Day 2 group contributed
   nothing to the pinned scoreboard until it was fully decided, so the
   header sat at "0 – 0" for most of a live day even with a match all
   but over. This drives the real state + updateScoreboard() (no page
   reload between steps, so it's exercising the exact function every
   score entry already calls) and checks:

     - with no hole data at all, #projected-line stays hidden (nothing
       to project yet)
     - once a Day 1 match has a partial, undecided lead, #projected-line
       appears with the right teams/numbers -- and critically, the REAL
       #sb-total-a/#sb-total-b figures are untouched (still the real,
       not-yet-decided score), proving the projection is additive, not a
       replacement
     - once that match is fully played out and decided, the real total
       catches up to what was projected and #projected-line hides again
       (no redundant "projection" once it just repeats the real score)

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state
   mutation means no real network round-trip is needed).

   Run: node test/repro-260-projected-scoreboard.mjs
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

    // 1. No hole data at all -> nothing to project, line stays hidden.
    {
      const shown = await page.evaluate(() => getComputedStyle(document.getElementById('projected-line')).display !== 'none');
      if (shown) fail('expected #projected-line hidden with no hole data entered anywhere');
    }

    // 2. A partial, undecided lead in match 0 (A ahead 3-0 thru 3 on the
    // front nine) projects into the line -- and must NOT touch the real
    // (still 0-0, undecided) sb-total figures.
    {
      const result = await page.evaluate(() => {
        const m = state.day1.matches[0];
        m.holesA[0] = 4; m.holesB[0] = 5;
        m.holesA[1] = 4; m.holesB[1] = 5;
        m.holesA[2] = 4; m.holesB[2] = 5;
        updateScoreboard();
        return {
          shown: getComputedStyle(document.getElementById('projected-line')).display !== 'none',
          text: document.getElementById('projected-line').textContent,
          realA: document.getElementById('sb-total-a').textContent,
          realB: document.getElementById('sb-total-b').textContent,
          teamA: state.teamNameA,
          teamB: state.teamNameB
        };
      });
      if (!result.shown) fail('expected #projected-line visible once a match has an undecided in-progress lead');
      if (!result.text.toLowerCase().includes('as it stands')) fail(`expected the "as it stands" projection copy, got "${result.text}"`);
      if (!result.text.includes(result.teamA) || !result.text.includes(result.teamB)) {
        fail(`expected both team names in the projection line, got "${result.text}"`);
      }
      if (!result.text.includes('1') || !result.text.includes('0')) {
        fail(`expected the projected 1-0 lead in the line text, got "${result.text}"`);
      }
      // The real total must still read the actual (undecided) score, not
      // be silently overwritten by the projection.
      if (result.realA !== '0') fail(`expected the REAL sb-total-a to stay "0" while the match is undecided, got "${result.realA}"`);
      if (result.realB !== '0') fail(`expected the REAL sb-total-b to stay "0" while the match is undecided, got "${result.realB}"`);
    }

    // 3. Once the match is fully played and decided (A sweeps all 18
    // holes), the real total catches up to 2-0 and the now-redundant
    // projection line hides again.
    {
      const result = await page.evaluate(() => {
        const m = state.day1.matches[0];
        for (let i = 0; i < 18; i++) { m.holesA[i] = 4; m.holesB[i] = 5; }
        updateScoreboard();
        return {
          shown: getComputedStyle(document.getElementById('projected-line')).display !== 'none',
          realA: document.getElementById('sb-total-a').textContent,
          realB: document.getElementById('sb-total-b').textContent
        };
      });
      if (result.realA !== '2') fail(`expected the real total to reach "2" once the match is fully decided, got "${result.realA}"`);
      if (result.realB !== '0') fail(`expected the real total to stay "0" for the losing team, got "${result.realB}"`);
      if (result.shown) fail('expected #projected-line to hide again once the projection exactly matches the (now decided) real score');
    }

    console.log('All #260 projected-scoreboard assertions passed.');
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
