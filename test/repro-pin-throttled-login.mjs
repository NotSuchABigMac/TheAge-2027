/* ─────────────────────────────────────
   REGRESSION TEST — issue #16: a throttled validate_tournament_pin
   answer must not be treated as a confirmed-wrong PIN.

   validate_tournament_pin is reachable by anyone (the publishable key
   ships in page source), not just the ~14 real scorers, so a third
   party can keep the RPC's shared lockout permanently engaged. Before
   this fix, the RPC's `false` on both "confirmed wrong" and "throttled,
   didn't check" collapsed into the same client-side branch: the login
   modal told every scorer their PIN was wrong and refused to log them
   in, for as long as the attacker sustained ~4 requests/minute.

   Drives the real scorecard-live.html against a mocked
   validate_tournament_pin RPC and checks:
     - "invalid" still shows "Wrong PIN" and keeps the modal open
     - "throttled" logs the scorer in provisionally (same UX as an
       unreachable Supabase) instead of showing "Wrong PIN"
     - "valid" logs the scorer in normally

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for
   real.

   Run: node test/repro-pin-throttled-login.mjs
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


const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

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


async function scenario(browser, url, { rpcResult, expectLoggedIn, expectWrongPinText, expectThrottledToast }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  // Playwright runs the LAST-registered matching route first, so the
  // broad catch-all is registered before the specific RPC route --
  // otherwise the catch-all would abort the RPC call too, and every
  // scenario would fall through to the unreachable-Supabase catch
  // branch regardless of rpcResult.
  //
  // Anything Supabase-shaped other than the login RPC (tournament_updates
  // reads, error beacon posts) is aborted -- this test only cares about
  // the login RPC path.
  await page.route('**wtyyarvyscbrrkawjcvo**', (route) => route.abort());
  await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/rpc/validate_tournament_pin**', (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rpcResult) });
  });
  await page.route('**fonts.googleapis.com**', route => route.abort());
  await page.route('**fonts.gstatic.com**', route => route.abort());

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

  // The username/PIN modal only opens on demand, via the same gate any
  // login-requiring action goes through -- same trigger repro-spectator-
  // button.mjs uses.
  await page.evaluate(() => requireUsername(() => {}));
  await page.waitForTimeout(100);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const select = page.locator('#username-input');
  await select.selectOption({ index: 1 });
  await page.fill('#write-token-input', 'some-pin');
  await page.click('#username-submit-btn');
  await page.waitForTimeout(300);

  const modalHidden = await page.evaluate(() => document.getElementById('username-modal').classList.contains('hidden'));
  const errorText = await page.evaluate(() => document.getElementById('username-error').textContent);
  const errorVisible = await page.evaluate(() => document.getElementById('username-error').style.display === 'block');
  const toastText = await page.evaluate(() => document.querySelector('.save-toast, #save-toast, [class*="toast"]')?.textContent || '');

  if (modalHidden !== expectLoggedIn) fail(`rpcResult=${JSON.stringify(rpcResult)}: expected modal hidden=${expectLoggedIn}, got ${modalHidden}`);
  if (expectWrongPinText && !(errorVisible && /Wrong PIN/.test(errorText))) {
    fail(`rpcResult=${JSON.stringify(rpcResult)}: expected a visible "Wrong PIN" error, got visible=${errorVisible} text="${errorText}"`);
  }
  if (!expectWrongPinText && errorVisible && /Wrong PIN/.test(errorText)) {
    fail(`rpcResult=${JSON.stringify(rpcResult)}: did not expect a "Wrong PIN" error, since the RPC never confirmed the PIN was wrong`);
  }
  if (expectThrottledToast && !/temporarily busy|confirm on first save/.test(toastText)) {
    fail(`rpcResult=${JSON.stringify(rpcResult)}: expected a provisional-login toast, got "${toastText}"`);
  }
  if (pageErrors.length) fail(`rpcResult=${JSON.stringify(rpcResult)}: expected zero page errors, saw ${JSON.stringify(pageErrors)}`);

  await context.close();
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    // 1. Confirmed-wrong PIN: modal stays open, "Wrong PIN" shown.
    await scenario(browser, url, { rpcResult: 'invalid', expectLoggedIn: false, expectWrongPinText: true, expectThrottledToast: false });

    // 2. Throttled: NOT the same as wrong -- logs in provisionally, no
    // "Wrong PIN" text, shows the provisional-login toast instead.
    await scenario(browser, url, { rpcResult: 'throttled', expectLoggedIn: true, expectWrongPinText: false, expectThrottledToast: true });

    // 3. Valid: logs in normally, no error, no throttled toast.
    await scenario(browser, url, { rpcResult: 'valid', expectLoggedIn: true, expectWrongPinText: false, expectThrottledToast: false });

    console.log('All #16 throttled-PIN-login assertions passed.');
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
