/* ─────────────────────────────────────
   REGRESSION TEST — front9/back9 "nine-status" line (e.g. "AS thru 2",
   "Flamingos 2UP thru 5") rendered at the same small, muted size/weight
   as everything else around it, so the current state of a match blended
   into the surrounding fine print instead of standing out.

   Fixed by giving the status text its own class (.nine-status-text,
   applied via nineStatusClass()/nineDisplayClass() in scorecard-live.html)
   that's larger/bolder than the "Front 9"/"Back 9" label next to it, and
   colored by whichever team is actually up (--team-a / --team-b), with
   the gold accent for all-square/halved -- so a scorer can tell who's
   ahead in a nine at a glance instead of having to read the words.

   Drives the real scorecard-live.html in demo mode, assigns players to
   Match 1, enters hole scores directly via `state` to put the front 9 in
   three states (all square, Team A up, Team B up), and checks the status
   span's color and font-weight track that state.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-nine-status-emphasis.mjs
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

function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function parseRgb(str) {
  const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3] };
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
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // Get the accent colors and the muted/default ink color straight from
    // the page's own CSS custom properties, so this test tracks the theme
    // rather than hardcoding hex values that could drift from styles.css.
    const colors = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { teamA: cs.getPropertyValue('--team-a').trim(), teamB: cs.getPropertyValue('--team-b').trim(), gold: cs.getPropertyValue('--gold').trim() };
    });

    async function setFront9AndRead(scores) {
      // scores: array of 9 [a, b] gross-score pairs (or null for unplayed holes)
      await page.evaluate((scores) => {
        const match = state.day1.matches[0];
        const firstPlayer = PLAYERS.find(p => p.friday);
        match.pA = [firstPlayer.id, null];
        const otherPlayer = PLAYERS.find(p => p.friday && p.id !== firstPlayer.id);
        match.pB = [otherPlayer.id, null];
        state.teamA = new Set([firstPlayer.id]);
        state.teamB = new Set([otherPlayer.id]);
        scores.forEach(([a, b], i) => {
          match.holesA[i] = a;
          match.holesB[i] = b;
        });
        renderDay1();
      }, scores);
      await page.waitForTimeout(50);
      const el = page.locator('#nine-status-0-front9');
      const color = await el.evaluate(e => getComputedStyle(e).color);
      const weight = await el.evaluate(e => getComputedStyle(e).fontWeight);
      const text = await el.textContent();
      return { color, weight, text };
    }

    // All square through 2 holes -- expect the gold accent, not the plain
    // muted ink the rest of the fine print uses.
    const as = await setFront9AndRead([[4, 4], [3, 3], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]]);
    if (!/thru 2/i.test(as.text)) fail(`expected "AS thru 2"-style text, got "${as.text}"`);
    if (Number(as.weight) < 600) fail(`expected the status text to be bold (>=600), got font-weight ${as.weight}`);
    const asRgb = parseRgb(as.color);
    if (!asRgb || rgbToHex(asRgb).toLowerCase() !== colors.gold.toLowerCase()) {
      fail(`expected the all-square status to use the gold accent (${colors.gold}), got ${as.color}`);
    }

    // Team A wins hole 1, halves hole 2 -- Team A should be up, and the
    // status text should be colored with --team-a.
    const aUp = await setFront9AndRead([[3, 5], [3, 3], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]]);
    if (!/1UP/i.test(aUp.text)) fail(`expected a "1UP thru 2"-style text for the leading team, got "${aUp.text}"`);
    const aRgb = parseRgb(aUp.color);
    if (!aRgb || rgbToHex(aRgb).toLowerCase() !== colors.teamA.toLowerCase()) {
      fail(`expected Team A's lead to be colored --team-a (${colors.teamA}), got ${aUp.color}`);
    }

    // Team B wins both holes -- status text should switch to --team-b.
    const bUp = await setFront9AndRead([[5, 3], [4, 3], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null], [null, null]]);
    if (!/2UP/i.test(bUp.text)) fail(`expected a "2UP thru 2"-style text for the leading team, got "${bUp.text}"`);
    const bRgb = parseRgb(bUp.color);
    if (!bRgb || rgbToHex(bRgb).toLowerCase() !== colors.teamB.toLowerCase()) {
      fail(`expected Team B's lead to be colored --team-b (${colors.teamB}), got ${bUp.color}`);
    }

    console.log('All nine-status emphasis assertions passed.');
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
