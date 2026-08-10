/* ─────────────────────────────────────
   REGRESSION TEST — mini scoreboard bar (.mini-sb, issue #301's sticky
   "follows down the page" bar) left an 8px gap under the masthead on
   mobile, through which whatever page content was scrolling underneath
   showed through as ghosted text.

   Root cause: .mini-sb{top:58px} and body{padding-top:58px} hardcoded the
   DESKTOP masthead height. styles.css shrinks the masthead to a real
   ~50px under its own 820px breakpoint (.masthead-inner, and
   .mobile-menu{top:49px} already accounts for this same shrink) --
   scorecard-live.html's copy of that height never did, so on any viewport
   <=820px wide, .mini-sb only caught up to the masthead's real bottom
   edge 8px late. Fixed with a matching @media(max-width:820px) override,
   plus making .mini-sb's background fully opaque (was a near-opaque
   rgba(...,.97)) so no blending trace is visible even at the seam.

   Drives the real scorecard-live.html at a mobile viewport width and
   checks, at several scroll offsets while .mini-sb is in its stuck
   (sticky) state:
     - .mini-sb's computed `top` matches the masthead's actual live
       offsetHeight (not a stale/desktop value)
     - there is no gap: the pixel immediately below the masthead's real
       bottom edge belongs to .mini-sb, not to whatever normal-flow
       content happens to be scrolled to that band
     - .mini-sb's background is fully opaque (alpha 1, not a fractional
       rgba alpha that could let content bleed through)

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright (demo mode + direct state mutation
   means no real network round-trip is needed).

   Run: node test/repro-mini-sb-mobile-masthead-gap.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs) --
   it needs Playwright + a browser.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png' };

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
    // A phone-width viewport, well under the 820px breakpoint where the
    // masthead shrinks.
    const context = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; });

    // .mini-sb's sticky `top` must match the masthead's real, live height
    // -- not a stale desktop value.
    const heights = await page.evaluate(() => ({
      masthead: document.querySelector('.masthead').offsetHeight,
      miniSbTop: getComputedStyle(document.querySelector('.mini-sb')).top,
      bodyPaddingTop: getComputedStyle(document.body).paddingTop
    }));
    if (heights.masthead >= 58) fail(`expected the mobile masthead to be shorter than the desktop 58px value (sanity check for this test's premise), got ${heights.masthead}px`);
    if (heights.miniSbTop !== `${heights.masthead}px`) {
      fail(`expected .mini-sb's sticky top (${heights.miniSbTop}) to match the masthead's real height (${heights.masthead}px)`);
    }
    if (heights.bodyPaddingTop !== `${heights.masthead}px`) {
      fail(`expected body's padding-top (${heights.bodyPaddingTop}) to match the masthead's real height (${heights.masthead}px)`);
    }

    // .mini-sb's background must be fully opaque, not a fractional alpha
    // that could blend with whatever scrolls underneath.
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.mini-sb')).backgroundColor);
    if (/rgba\([^)]*,\s*0(?:\.\d+)?\s*\)/.test(bg) && !/,\s*1\s*\)$/.test(bg)) {
      fail(`expected .mini-sb's background to be fully opaque, got "${bg}"`);
    }

    // No gap: at several scroll offsets while .mini-sb is stuck, the pixel
    // immediately below the masthead's real bottom edge must belong to
    // .mini-sb (or one of its descendants) -- not to whatever normal-flow
    // content happens to be scrolled to that band.
    for (const y of [400, 550, 650, 700, 750, 850, 1000, 1200]) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(80);
      const result = await page.evaluate(() => {
        const masthead = document.querySelector('.masthead');
        const miniSb = document.querySelector('.mini-sb');
        const miniSbRect = miniSb.getBoundingClientRect();
        // Only meaningful once .mini-sb has actually engaged its sticky
        // position (top flush with the masthead) -- early in the scroll
        // it's still in normal flow below everything, which is correct.
        if (Math.round(miniSbRect.top) !== masthead.offsetHeight) return { skipped: true };
        const probeY = masthead.offsetHeight + 2;
        const el = document.elementFromPoint(60, probeY);
        const insideMiniSb = !!(el && miniSb.contains(el));
        return { skipped: false, insideMiniSb, tag: el?.tagName, cls: el?.className, text: el?.textContent?.slice(0, 60) };
      });
      if (!result.skipped && !result.insideMiniSb) {
        fail(`gap detected at scrollY=${y}: expected .mini-sb to cover the pixel just below the masthead, but found ${result.tag}.${result.cls} ("${result.text}") instead`);
      }
    }

    console.log('All mini-sb mobile masthead-gap assertions passed.');
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
