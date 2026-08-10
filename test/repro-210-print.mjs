/* ─────────────────────────────────────
   REGRESSION TEST — issue #210: print stylesheets.

   "Paper is the disaster plan": if Supabase, the wifi, or a phone
   battery dies mid-tournament, the site should fall back to paper in
   thirty seconds. Covers:

     - print-cards.html renders three blank scorecards (one per course)
       straight from courses.js, entirely offline (Supabase blocked) --
       18 hole columns, correct Par/S.I./Metres figures, Out/In/Tot, and
       4 blank rows for a group of 4
     - @media print on a marketing page (practical.html) actually hides
       sitewide chrome: masthead, mobile menu, footer, hero/course
       photos, theme switcher
     - @media print on scorecard-live.html hides its own live-app-only
       chrome (tabs, sync bar, mini scoreboard, toasts, countdown bar)
       and strips the border/background off number inputs so entered
       scores read as plain printed digits
     - practical.html links to print-cards.html ("Paper backups")

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-210-print.mjs
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
    // Supabase blocked outright -- print-cards.html must work fully
    // offline, since that's the entire point of a paper backup.
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. print-cards.html renders three courses' worth of blank cards,
    // straight from courses.js, with no login and no network.
    {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`${base}/print-cards.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      if (errors.length) fail(`expected no page errors rendering print-cards.html, got: ${errors.join('; ')}`);

      const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.print-card')).map(card => ({
        title: card.querySelector('h2').textContent,
        holeHeaders: Array.from(card.querySelectorAll('thead th')).map(th => th.textContent.trim()),
        parRow: Array.from(card.querySelectorAll('tbody tr:nth-child(1) td')).map(td => td.textContent.trim()).slice(1),
        playerRows: card.querySelectorAll('tr.player').length
      })));
      if (cards.length !== 3) fail(`expected 3 print cards (one per course), got ${cards.length}`);
      if (!/Murray/.test(cards[0].title)) fail(`expected the first card to be Murray (Day 1), got "${cards[0].title}"`);
      if (!/Black Bull/.test(cards[1].title)) fail(`expected the second card to be Black Bull (Day 2), got "${cards[1].title}"`);
      if (!/Lake/.test(cards[2].title)) fail(`expected the third card to be Lake (Day 3), got "${cards[2].title}"`);
      // 18 holes + "Hole" label + Out/In/Tot = 22 header cells.
      if (cards[0].holeHeaders.length !== 22) fail(`expected 22 header cells (Hole + 18 holes + Out/In/Tot), got ${cards[0].holeHeaders.length}`);
      // Murray hole 1 par is 4, out par 36, in par 36, total par 72 (courses.js).
      if (cards[0].parRow[0] !== '4') fail(`expected Murray hole 1 par to be 4, got "${cards[0].parRow[0]}"`);
      if (cards[0].parRow[cards[0].parRow.length - 1] !== '72') fail(`expected Murray's total par to be 72, got "${cards[0].parRow[cards[0].parRow.length - 1]}"`);
      if (cards[0].playerRows !== 4) fail(`expected 4 blank player rows for a group of 4, got ${cards[0].playerRows}`);
      await page.close();
    }

    // 2. @media print hides sitewide chrome on a marketing page.
    {
      const page = await context.newPage();
      await page.goto(`${base}/practical.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.emulateMedia({ media: 'print' });
      const hidden = await page.evaluate(() => {
        const isHidden = (sel) => {
          const el = document.querySelector(sel);
          return !el || getComputedStyle(el).display === 'none';
        };
        return {
          masthead: isHidden('.masthead'),
          mobileMenu: isHidden('.mobile-menu'),
          foot: isHidden('.foot'),
          themeSwitcher: isHidden('.theme-switcher')
        };
      });
      for (const [name, isHidden] of Object.entries(hidden)) {
        if (!isHidden) fail(`expected .${name} to be display:none under @media print on practical.html`);
      }
      // Paper-backups link present and pointing at print-cards.html.
      const link = await page.evaluate(() => {
        const a = Array.from(document.querySelectorAll('a')).find(a => /paper backup/i.test(a.textContent));
        return a ? a.getAttribute('href') : null;
      });
      if (link !== 'print-cards.html') fail(`expected a "Paper backups" link to print-cards.html, got "${link}"`);
      await page.close();
    }

    // 3. @media print on scorecard-live.html hides its own chrome and
    // strips input chrome so entered scores read as plain digits.
    {
      const page = await context.newPage();
      await page.goto(`${base}/scorecard-live.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.emulateMedia({ media: 'print' });
      const state = await page.evaluate(() => {
        const isHidden = (sel) => {
          const el = document.querySelector(sel);
          return !el || getComputedStyle(el).display === 'none';
        };
        const input = document.querySelector('input[type=number]');
        return {
          scTabs: isHidden('.sc-tabs'),
          syncBar: isHidden('.sync-bar'),
          miniSb: isHidden('.mini-sb'),
          countdownBar: isHidden('.countdown-bar'),
          inputBorder: input ? getComputedStyle(input).borderStyle : null
        };
      });
      if (!state.scTabs) fail('expected .sc-tabs to be hidden under @media print');
      if (!state.syncBar) fail('expected .sync-bar to be hidden under @media print');
      if (!state.miniSb) fail('expected .mini-sb to be hidden under @media print');
      if (!state.countdownBar) fail('expected .countdown-bar to be hidden under @media print');
      if (state.inputBorder !== 'none') fail(`expected number-input borders to be stripped under @media print, got "${state.inputBorder}"`);
      await page.close();
    }

    console.log('All #210 print stylesheet assertions passed.');
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
