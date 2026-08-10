/* ─────────────────────────────────────
   REGRESSION TEST — issue #182: shared page chrome (music modal, masthead,
   mobile menu) extracted into site.js instead of being copy-pasted (and
   already diverged) across all five marketing pages.

   Checks:
     - none of the five pages has its own inline <script> anymore (the
       actual regression this issue is about: three different copies
       already meant three different bugs)
     - format.html's mobile menu -- previously its own separate
       implementation -- now behaves identically to the shared one
       (inert toggling, exactly like #181 already proved for index2026.html)
     - a hero-less page's masthead is NOT touched by the masthead-scroll
       logic at load (a bug the extraction itself could have introduced:
       an earlier draft ran the scrollY fallback unconditionally, which
       would have stripped masthead--scrolled off a page that hardcodes
       it in markup and has no hero to scroll past)
     - index2026.html's own hero page still gets the real masthead-scroll
       behavior

   Self-contained: a tiny static file server for the five pages; Supabase
   isn't used by any of them so nothing to mock; Google Fonts is blocked
   outright, same as every other Playwright test in this repo.

   Run: node test/repro-182-shared-chrome.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs, same
   convention as this repo's other Playwright-driven scripts) -- it needs
   Playwright + a browser, which the fast unit suite must not depend on.
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
        const filePath = path.join(ROOT, urlPath === '/' ? '/index2026.html' : urlPath);
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
    const context = await browser.newContext({ viewport: { width: 400, height: 800 } });
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. None of the five pages duplicates the chrome as its own inline
    // <script> anymore -- all load the shared site.js instead.
    const pages = ['index2026.html', 'golfers.html', 'practical.html', 'records.html', 'format.html'];
    for (const p of pages) {
      const page = await context.newPage();
      await page.goto(`${base}/${p}`, { waitUntil: 'domcontentloaded' });
      const info = await page.evaluate(() => ({
        inlineScripts: Array.from(document.querySelectorAll('script:not([src])')).length,
        loadsSiteJs: Array.from(document.querySelectorAll('script[src]')).some(s => s.getAttribute('src').startsWith('site.js'))
      }));
      if (info.inlineScripts !== 0) fail(`expected ${p} to have zero inline <script> blocks, found ${info.inlineScripts}`);
      if (!info.loadsSiteJs) fail(`expected ${p} to load site.js`);
      await page.close();
    }

    // 2. format.html's mobile menu (previously its own separate
    // implementation) now behaves identically to the shared one: closed
    // menu is inert, opening clears it.
    {
      const page = await context.newPage();
      await page.goto(`${base}/format.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const inertWhenClosed = await page.evaluate(() => document.getElementById('mobile-menu').hasAttribute('inert'));
      if (!inertWhenClosed) fail('expected format.html\'s closed mobile menu to be inert (same as the other pages)');
      await page.click('#hamburger');
      await page.waitForTimeout(50);
      const inertWhenOpen = await page.evaluate(() => document.getElementById('mobile-menu').hasAttribute('inert'));
      if (inertWhenOpen) fail('expected format.html\'s open mobile menu to not be inert');
      await page.close();
    }

    // 3. A hero-less page's masthead is untouched at load -- the
    // extraction must not run the scrollY fallback unconditionally.
    {
      const page = await context.newPage();
      await page.goto(`${base}/golfers.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const scrolledClassPresent = await page.evaluate(() => document.querySelector('.masthead').classList.contains('masthead--scrolled'));
      if (!scrolledClassPresent) fail('expected a hero-less page\'s masthead--scrolled class (hardcoded in markup) to survive site.js running');
      await page.close();
    }

    // 4. index2026.html's actual hero page still gets real masthead-scroll
    // behavior: transparent at top, solid once the hero scrolls past.
    {
      const page = await context.newPage();
      await page.goto(`${base}/index2026.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);
      const atTop = await page.evaluate(() => document.querySelector('.masthead').classList.contains('masthead--scrolled'));
      if (atTop) fail('expected index2026.html\'s masthead to start transparent (not masthead--scrolled) while the hero is in view');
      // Scroll to the very bottom of the document rather than computing
      // an offset from the hero's height -- more robust against layout
      // not having fully settled (images still loading) by the time this
      // runs, which was observed to leave the hero not fully scrolled
      // past when using a height-derived offset.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(300);
      const afterScroll = await page.evaluate(() => document.querySelector('.masthead').classList.contains('masthead--scrolled'));
      if (!afterScroll) fail('expected index2026.html\'s masthead to become masthead--scrolled once scrolled past the hero');
      await page.close();
    }

    console.log('All #182 shared-chrome assertions passed.');
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
