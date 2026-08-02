/* ─────────────────────────────────────
   REGRESSION TEST — issue #149's national anthem house rule was
   mechanically wrong: the +2/-1 stroke adjustment was folded into a
   player's own HANDICAP before scrambleTeamHandicap() ran, rather than
   being added straight to the group's SCORE. Two concrete bugs fell out
   of that:

     1. A group scored via the manual net-to-par field (no hole-by-hole
        entry) got NO anthem adjustment at all -- the handicap-based path
        was never consulted for a manual score.
     2. Even on the hole-by-hole path, the adjustment was diluted through
        scrambleTeamHandicap()'s group-size percentage table (10-35%)
        instead of landing as a full stroke, and it silently changed the
        team's displayed handicap number.

   The fix (day2AnthemStrokesFor() in scoring.js) adds the strokes
   directly to the group's final score on both paths, leaving the group's
   handicap untouched.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - toggling a player's anthem status on a group scored via the manual
       field changes that group's displayed score by the right amount
     - toggling a player's anthem status on a group with hole-by-hole
       data changes the displayed net-to-par by the right amount, while
       the displayed Team HCP number stays exactly the same
     - the National Anthem info-box no longer describes the rule as a
       handicap adjustment

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for real.

   Run: node test/repro-anthem-score-not-handicap.mjs
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
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
    });
    await page.click('#tab-day2');
    await page.waitForTimeout(150);

    // ── 1. Manual-score path: previously ignored the anthem rule entirely. ──
    await page.evaluate(() => {
      setDay2Group(PLAYERS[3].id, 'b3');
      setDay2Group(PLAYERS[4].id, 'b3');
      state.day2.b3 = '-5';
      saveState();
      renderDay2GroupCard('b3');
    });
    const beforeManual = await page.$eval('#b3-manual-display', el => el.textContent);
    if (!/^-5 to par/.test(beforeManual)) fail(`expected the manual score to start at -5 to par, got "${beforeManual}"`);

    await page.evaluate(() => setDay2Anthem(PLAYERS[3].id, false)); // didn't sing: +2
    const afterManual = await page.$eval('#b3-manual-display', el => el.textContent);
    if (!/^-3 to par/.test(afterManual)) fail(`expected +2 anthem strokes to move the manual score from -5 to -3, got "${afterManual}"`);
    if (!/incl\. anthem/.test(afterManual)) fail(`expected the manual display to flag that anthem strokes are included, got "${afterManual}"`);

    // ── 2. Hole-by-hole path: strokes must land on the score, and the ──
    // displayed team handicap must NOT move when the anthem toggle flips.
    await page.evaluate(() => {
      setDay2Group(PLAYERS[6].id, 'a3');
      setDay2Group(PLAYERS[7].id, 'a3');
      setDay2Group(PLAYERS[8].id, 'a3');
      setDay2HoleScore('a3', 1, 4);
    });
    const before = await page.$eval('#a3-derived', el => el.textContent);
    const hcpBefore = before.match(/Team HCP (-?\d+)/);
    const ntpBefore = before.match(/(-?\d+) to par/);
    if (!hcpBefore || !ntpBefore) fail(`could not parse the before-toggle derived line: "${before}"`);

    await page.evaluate(() => setDay2Anthem(PLAYERS[6].id, true)); // sang: -1 stroke

    const after = await page.$eval('#a3-derived', el => el.textContent);
    const hcpAfter = after.match(/Team HCP (-?\d+)/);
    const ntpAfter = after.match(/(-?\d+) to par/);
    if (!hcpAfter || !ntpAfter) fail(`could not parse the after-toggle derived line: "${after}"`);

    if (hcpAfter[1] !== hcpBefore[1]) {
      fail(`expected Team HCP to be UNCHANGED by the anthem toggle (adjustment now lands on the score, not the handicap), went from ${hcpBefore[1]} to ${hcpAfter[1]}`);
    }
    const delta = parseInt(ntpAfter[1], 10) - parseInt(ntpBefore[1], 10);
    if (delta !== -1) fail(`expected the sang toggle (-1 stroke) to move the displayed net-to-par by exactly -1, moved by ${delta} (before "${ntpBefore[1]}", after "${ntpAfter[1]}")`);

    // ── 3. The rules copy must describe a score adjustment, not a handicap one. ──
    const infoBoxText = await page.$eval('#day2-anthem', el => el.previousElementSibling.textContent);
    if (/handicap/i.test(infoBoxText)) fail(`expected the anthem info-box to no longer mention "handicap", got "${infoBoxText}"`);
    if (!/score/i.test(infoBoxText)) fail(`expected the anthem info-box to describe a score adjustment, got "${infoBoxText}"`);

    console.log('All anthem-score-not-handicap assertions passed.');
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
