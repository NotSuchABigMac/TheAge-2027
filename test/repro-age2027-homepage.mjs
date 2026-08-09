/* ─────────────────────────────────────
   REGRESSION TEST — the AGE 2027 placeholder homepage that replaced the
   old index.html once the 2026 Wonga Cup wrapped.

   It's a deliberately simple page: a "more info coming soon" line plus a
   canvas golf-cart runner. The things worth guarding are the ones that
   silently break without anyone noticing on a placeholder nobody's
   watching:

   1. The teaser line is actually on the page.
   2. The game boots -- canvas present, 2D context live, and the
      requestAnimationFrame loop actually painting pixels (a thrown error
      in the script would leave a blank canvas and no console clue for a
      visitor).
   3. Space/tap jumps the cart rather than scrolling the page.
   4. drift.html plays first, full-screen, over the game (which is
      already running underneath, not started fresh on dismiss); a click
      drops the overlay.
   5. So does a real touch tap -- not just a synthetic mouse click, which
      takes a different path on a touchscreen (see the comment at that
      assertion for why the two are not equivalent here).
   6. The "Relive 2026" link still lands on index2026.html, which now
      holds the archived 2026 tournament homepage -- reachable only once
      the overlay covering it is dismissed.

   Drives real index.html via a local static server, same pattern as
   repro-297/repro-183. Never touches Supabase or Google Fonts.

   Run: node test/repro-age2027-homepage.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs,
   same convention as this repo's other Playwright-driven scripts) -- it
   needs Playwright + a browser, which the fast unit suite must not
   depend on.
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

// How many non-transparent pixels the canvas is painting right now --
// the cheapest honest "is the game actually running" signal.
const PAINTED_PIXELS = () => {
  const c = document.getElementById('gameCanvas');
  const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
  return n;
};

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const homeUrl = `http://127.0.0.1:${sitePort}/index.html`;

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

    // 1+2. Teaser copy is present and the game actually boots and paints.
    {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });

      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const copy = (await page.textContent('body')) || '';
      if (!/AGE\s*2027/i.test(copy)) fail(`expected "AGE 2027" on the page, got ${JSON.stringify(copy.slice(0, 200))}`);
      if (!/more info coming soon/i.test(copy)) fail(`expected "more info coming soon" on the page, got ${JSON.stringify(copy.slice(0, 200))}`);

      if (await page.locator('#gameCanvas').count() !== 1) fail('expected exactly one #gameCanvas on the page');

      const painted = await page.evaluate(PAINTED_PIXELS);
      if (painted < 100) fail(`expected the game to be painting the cart onto the canvas, only ${painted} non-transparent pixels`);

      if (errors.length) fail(`expected zero console/page errors, saw: ${JSON.stringify(errors)}`);
      await page.close();
    }

    // 3. Space jumps the cart (and doesn't scroll the page instead).
    {
      const page = await context.newPage();
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const groundY = await page.evaluate(() => player.y);
      await page.keyboard.press('Space');
      await page.waitForTimeout(100);
      const airborneY = await page.evaluate(() => player.y);
      if (!(airborneY < groundY)) {
        fail(`expected Space to lift the cart (smaller y), went from ${groundY} to ${airborneY}`);
      }
      const scrolled = await page.evaluate(() => window.scrollY);
      if (scrolled !== 0) fail(`expected Space to be prevented from scrolling the page, scrollY=${scrolled}`);
      await page.close();
    }

    // 4. The drift.html overlay covers the page on load and a click drops
    // it, revealing the game it was covering (which was already running
    // underneath, not started fresh on dismiss).
    {
      const page = await context.newPage();
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const overlay = page.locator('#drift-overlay');
      if (await overlay.count() !== 1) fail('expected exactly one #drift-overlay button on the page');

      const iframeSrc = await page.locator('#drift-overlay iframe').getAttribute('src');
      if (!/^drift\.html(\?|$)/.test(iframeSrc || '')) fail(`expected the overlay iframe to point at drift.html, got ${JSON.stringify(iframeSrc)}`);

      const visibleBefore = await overlay.evaluate((el) => getComputedStyle(el).display !== 'none');
      if (!visibleBefore) fail('expected the drift overlay to cover the page before any interaction');

      // The game underneath is live the whole time -- the overlay is only
      // ever a visual cover, so a jump taken before the click still counts.
      const scoreBefore = await page.evaluate(() => score);
      await page.waitForTimeout(600);
      const scoreAfterWait = await page.evaluate(() => score);
      if (!(scoreAfterWait > scoreBefore)) fail(`expected the score to accrue under the overlay (game already running), stayed at ${scoreBefore}`);

      await overlay.click();
      const visibleAfter = await overlay.evaluate((el) => getComputedStyle(el).display !== 'none');
      if (visibleAfter) fail('expected the drift overlay to be hidden after a click');
      await page.close();
    }

    // 5. A real touch tap dismisses the overlay too -- not just a mouse
    // click. This is its own context because page.tap() requires
    // hasTouch. It matters because a *synthetic* click (page.click(),
    // step 4 above) goes through a completely different code path on a
    // touchscreen than an actual tap does: the game's own window-level
    // "tap to jump" handler calls preventDefault() on every touchstart on
    // the page, which per spec suppresses the browser's synthetic click
    // for that touch -- so a real tap on the overlay used to reach
    // touchstart/touchend but the click the old dismiss handler was
    // waiting for never came, and nothing happened. Also confirms that
    // same tap doesn't leak through to the hidden game and jump the cart.
    {
      const touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 700 } });
      const page = await touchContext.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const groundedBefore = await page.evaluate(() => player.grounded);
      await page.tap('#drift-overlay');
      await page.waitForTimeout(200);

      const visibleAfterTap = await page.evaluate(() => getComputedStyle(document.getElementById('drift-overlay')).display !== 'none');
      if (visibleAfterTap) fail('expected a real touch tap to dismiss the drift overlay, same as a mouse click does');

      const groundedAfter = await page.evaluate(() => player.grounded);
      if (groundedAfter !== groundedBefore) fail('expected dismissing the overlay by tap not to also jump the hidden cart underneath');

      if (errors.length) fail(`expected zero page errors from the tap, saw: ${JSON.stringify(errors)}`);
      await touchContext.close();
    }

    // 6. The archive link lands on the renamed 2026 recap page, once the
    // overlay covering it has been dismissed.
    {
      const page = await context.newPage();
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      await page.click('#drift-overlay');
      await Promise.all([
        page.waitForURL('**/index2026.html'),
        page.click('text=Relive 2026'),
      ]);
      if (!page.url().endsWith('/index2026.html')) fail(`expected the archive link to land on index2026.html, got ${page.url()}`);
      await page.close();
    }

    console.log('All AGE 2027 placeholder homepage assertions passed.');
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
