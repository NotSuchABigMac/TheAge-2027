/* ─────────────────────────────────────
   REGRESSION TEST — issue #202: silent client error beacon.

   During the tournament, breakage on one of ~14 devices currently
   surfaces as "the site's cooked" in the group chat with zero detail.
   error-beacon.js should report uncaught errors/rejections to Supabase's
   client_errors table before that happens. Covers:

     - a genuine uncaught error on scorecard-live.html fires a POST to
       .../rest/v1/client_errors with the message, page, and the
       session's write_token/username
     - a known-benign audio play() rejection is NOT reported
       (ignore-list)
     - reporting is capped at MAX_REPORTS_PER_SESSION even when errors
       keep coming
     - the beacon is also wired up on a marketing page (practical.html),
       which has no Supabase awareness of its own otherwise

   Self-contained: a tiny static file server for the app; the real
   Supabase host and Google Fonts are blocked, and the client_errors
   endpoint specifically is intercepted (not the real project) so we can
   inspect exactly what gets sent without it going anywhere real.

   Run: node test/repro-202-error-beacon.mjs
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
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. A genuine uncaught error fires a POST with the right shape.
    {
      const page = await context.newPage();
      const requests = [];
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/client_errors', (route) => {
        requests.push(JSON.parse(route.request().postData()));
        route.fulfill({ status: 201, body: '' });
      });
      // Everything else to the real project (e.g. the scorecard's own
      // sync polling) is still blocked outright -- this test only cares
      // about the beacon.
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/client_errors')) { route.fallback(); return; } // handled above
        route.abort();
      });
      await page.goto(`${base}/scorecard-live.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        sessionStorage.setItem('wongaCup_username', 'Gary King');
        sessionStorage.setItem('wongaCup_writeToken', 'test-token');
      });
      await page.evaluate(() => { setTimeout(() => { throw new Error('deliberate test boom'); }, 0); });
      await page.waitForTimeout(200);
      if (requests.length !== 1) fail(`expected exactly 1 error report, got ${requests.length}`);
      const r = requests[0];
      if (r.tournament_id !== 'wonga-cup-2026') fail(`expected tournament_id wonga-cup-2026, got "${r.tournament_id}"`);
      if (r.page !== 'scorecard-live.html') fail(`expected page "scorecard-live.html", got "${r.page}"`);
      if (!/deliberate test boom/.test(r.message)) fail(`expected the message to include the thrown error, got "${r.message}"`);
      if (r.write_token !== 'test-token') fail(`expected write_token "test-token", got "${r.write_token}"`);
      if (r.username !== 'Gary King') fail(`expected username "Gary King", got "${r.username}"`);
      await page.close();
    }

    // 2. A known-benign audio play() rejection is not reported.
    {
      const page = await context.newPage();
      const requests = [];
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/client_errors', (route) => {
        requests.push(JSON.parse(route.request().postData()));
        route.fulfill({ status: 201, body: '' });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/client_errors')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}/scorecard-live.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
          reason: new Error("play() failed because the user didn't interact first")
        }));
      });
      await page.waitForTimeout(200);
      if (requests.length !== 0) fail(`expected the benign play() rejection to be ignored, got ${requests.length} report(s)`);
      await page.close();
    }

    // 3. Reporting is capped even when errors keep coming.
    {
      const page = await context.newPage();
      const requests = [];
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/client_errors', (route) => {
        requests.push(JSON.parse(route.request().postData()));
        route.fulfill({ status: 201, body: '' });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/client_errors')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}/scorecard-live.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        for (let i = 0; i < 10; i++) {
          window.dispatchEvent(Object.assign(new Event('unhandledrejection'), {
            reason: new Error(`distinct error #${i}`)
          }));
        }
      });
      await page.waitForTimeout(300);
      if (requests.length !== 5) fail(`expected the report cap (5) to hold across 10 distinct errors, got ${requests.length}`);
      await page.close();
    }

    // 4. Also wired up on a marketing page with no Supabase config of
    // its own otherwise.
    {
      const page = await context.newPage();
      const requests = [];
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/client_errors', (route) => {
        requests.push(JSON.parse(route.request().postData()));
        route.fulfill({ status: 201, body: '' });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/client_errors')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}/practical.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => { setTimeout(() => { throw new Error('marketing page boom'); }, 0); });
      await page.waitForTimeout(200);
      if (requests.length !== 1) fail(`expected practical.html to report too, got ${requests.length}`);
      if (requests[0].page !== 'practical.html') fail(`expected page "practical.html", got "${requests[0].page}"`);
      await page.close();
    }

    console.log('All #202 error-beacon assertions passed.');
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
