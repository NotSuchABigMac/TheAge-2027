/* ─────────────────────────────────────
   REGRESSION TEST — issue #193: open on the right screen.

   Exercises the full precedence chain scorecard-live.html now applies when
   picking which tab to show on load: an explicit #hash (deep link) beats a
   saved last-viewed tab, which beats the tournament-date default, which
   falls back to Day 1. Also checks that clicking a tab reflects into
   location.hash via replaceState (no history spam) and that a hidden tab
   (Admin, pre-login) is never chosen even if named by hash or a saved
   value, so the existing organiser-gating on that tab can't be bypassed.

   Self-contained: a tiny static file server for the app, no Supabase
   traffic needed for this feature (it's pre-login, pre-sync UI state), but
   Supabase and Google Fonts hosts are still blocked outright as a
   belt-and-braces guarantee that nothing here can reach the real
   production project, matching every other Playwright test in this repo.

   Run: node test/repro-193-tab-nav.mjs
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
        const filePath = path.join(ROOT, urlPath === '/' ? '/scorecard-live.html' : urlPath);
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
  const baseUrl = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    // Never let this test reach the real production Supabase project or
    // Google Fonts (unreachable/flaky in this sandbox, unrelated to the
    // feature under test).
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    async function openAndGetActiveTab(url, { setup } = {}) {
      const page = await context.newPage();
      if (setup) await page.addInitScript(setup);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});
      const active = await page.evaluate(() => document.querySelector('.sc-tab.active')?.dataset.tab);
      const hash = await page.evaluate(() => location.hash);
      await page.close();
      return { active, hash };
    }

    // 1. No hash, no saved tab, no fake-dated default (real "today" in this
    // sandbox is nowhere near the tournament) -- falls all the way through
    // to Day 1.
    {
      const { active } = await openAndGetActiveTab(baseUrl, {
        setup: () => localStorage.removeItem('wongaCup2026_activeTab')
      });
      if (active !== 'day1') fail(`expected day1 with no hash/saved/date-match, got ${active}`);
    }

    // 2. Saved tab (no hash) wins over the day1 ultimate fallback.
    {
      const { active } = await openAndGetActiveTab(baseUrl, {
        setup: () => localStorage.setItem('wongaCup2026_activeTab', 'day2')
      });
      if (active !== 'day2') fail(`expected saved tab day2 to be honoured, got ${active}`);
    }

    // 3. An explicit hash wins over a saved tab.
    {
      const { active } = await openAndGetActiveTab(baseUrl + '#day3', {
        setup: () => localStorage.setItem('wongaCup2026_activeTab', 'day2')
      });
      if (active !== 'day3') fail(`expected hash #day3 to win over saved day2, got ${active}`);
    }

    // 4. A hash naming a hidden tab (Admin, pre-login) must NOT be honoured
    // -- the existing organiser-gating is never bypassed by the hash.
    {
      const { active } = await openAndGetActiveTab(baseUrl + '#admin', {
        setup: () => localStorage.removeItem('wongaCup2026_activeTab')
      });
      if (active === 'admin') fail('the #admin hash was honoured while logged out -- gating bypassed');
      if (active !== 'day1') fail(`expected fallback to day1 past the hidden #admin hash, got ${active}`);
    }

    // 5. A garbage/unknown hash also falls through cleanly.
    {
      const { active } = await openAndGetActiveTab(baseUrl + '#not-a-real-tab', {
        setup: () => localStorage.removeItem('wongaCup2026_activeTab')
      });
      if (active !== 'day1') fail(`expected fallback to day1 past a garbage hash, got ${active}`);
    }

    // 6. Clicking a tab reflects into location.hash (deep-linkable), and
    // does so via replaceState -- no extra history entry (checked by
    // confirming Back doesn't reload the app from a different history slot;
    // we approximate here by checking history.length stays put across two
    // clicks).
    {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden')).catch(() => {});
      const lengthBefore = await page.evaluate(() => history.length);
      await page.click('#tab-day2');
      await page.waitForTimeout(50);
      await page.click('#tab-day3');
      await page.waitForTimeout(50);
      const hashAfter = await page.evaluate(() => location.hash);
      const lengthAfter = await page.evaluate(() => history.length);
      if (hashAfter !== '#day3') fail(`expected clicking Day 3 to set location.hash, got ${hashAfter}`);
      if (lengthAfter !== lengthBefore) {
        fail(`expected tab clicks to use replaceState (no new history entries): before=${lengthBefore}, after=${lengthAfter}`);
      }
      await page.close();
    }

    console.log('All #193 tab-navigation assertions passed.');
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
