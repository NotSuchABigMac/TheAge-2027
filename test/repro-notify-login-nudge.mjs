/* ─────────────────────────────────────
   REGRESSION TEST — post-login notification nudge.

   Golfers previously had to find the 🔔 button on the Wire tab to opt in
   to system notifications. completeLogin() now offers a one-time modal
   nudge right after a fresh name/PIN login instead. Drives the real
   scorecard-live.html and checks:

     - the nudge appears once notification permission is still 'default'
       right after a successful login
     - "Turn On" calls through to the existing requestPermission() ->
       localStorage -> bell-state wiring (the Wire tab's bell reflects it)
     - the nudge does not reappear on a second login on the same device
       (localStorage-backed "seen" flag)
     - "Not Now" also marks it seen without granting permission

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; Supabase calls aborted (never hit for real).

   Run: node test/repro-notify-login-nudge.mjs
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
  const base = `http://127.0.0.1:${sitePort}/scorecard-live.html?demo=1`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());

    const page = await context.newPage();
    // Stub Notification the same way repro-186 does, but starting from
    // 'default' (undecided) so requestPermission() is actually exercised,
    // and tracking whether it was ever called.
    await page.addInitScript(() => {
      window.__requestPermissionCalls = 0;
      let permission = 'default';
      window.Notification = class {
        constructor(title, opts) { this.title = title; this.opts = opts; }
        static requestPermission() {
          window.__requestPermissionCalls++;
          permission = 'granted';
          return Promise.resolve('granted');
        }
        static get permission() { return permission; }
      };
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.waitForTimeout(200);

    // 1. Log in via completeLogin() directly (same path confirmUsername()
    // uses on success) -- the nudge should appear since permission is
    // still 'default' and this device has never seen it.
    await page.evaluate(() => completeLogin('Gary King', 'test-token'));
    await page.waitForTimeout(100);
    const afterLogin = await page.evaluate(() => ({
      nudgeHidden: document.getElementById('notify-nudge-modal').classList.contains('hidden'),
      usernameModalHidden: document.getElementById('username-modal').classList.contains('hidden')
    }));
    if (afterLogin.nudgeHidden) fail('expected the notify nudge to appear right after a fresh login');
    if (!afterLogin.usernameModalHidden) fail('expected the username modal to be closed once login completes');

    // 2. "Turn On" routes through the existing requestPermission() wiring
    // and the Wire tab's bell reflects the opt-in.
    await page.click('#notify-nudge-modal .resync-nudge-btn.primary');
    await page.waitForTimeout(100);
    const afterAccept = await page.evaluate(() => ({
      nudgeHidden: document.getElementById('notify-nudge-modal').classList.contains('hidden'),
      requestCalls: window.__requestPermissionCalls,
      stored: localStorage.getItem('demo_wongaCup2026_wireNotify'),
      seen: localStorage.getItem('demo_wongaCup2026_notifyNudgeSeen')
    }));
    if (!afterAccept.nudgeHidden) fail('expected the nudge to close after "Turn On"');
    if (afterAccept.requestCalls !== 1) fail(`expected exactly one requestPermission() call, got ${afterAccept.requestCalls}`);
    if (afterAccept.stored !== '1') fail(`expected the Wire opt-in to persist under its usual key, got "${afterAccept.stored}"`);
    if (afterAccept.seen !== '1') fail('expected the nudge-seen flag to be set after accepting');

    await page.click('#tab-wire');
    const bellPressed = await page.evaluate(() => document.getElementById('wire-bell-btn').getAttribute('aria-pressed'));
    if (bellPressed !== 'true') fail(`expected the Wire tab bell to reflect the opt-in, got aria-pressed="${bellPressed}"`);

    // 3. A second login on the same device must not re-show the nudge.
    await page.evaluate(() => completeLogin('Someone Else', 'test-token-2'));
    await page.waitForTimeout(100);
    const secondLoginNudgeHidden = await page.evaluate(() => document.getElementById('notify-nudge-modal').classList.contains('hidden'));
    if (!secondLoginNudgeHidden) fail('expected the nudge NOT to reappear on a second login on the same device');

    console.log('All notify-login-nudge assertions passed.');
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
