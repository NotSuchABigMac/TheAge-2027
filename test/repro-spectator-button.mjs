/* ─────────────────────────────────────
   REGRESSION TEST — "I'm just spectating" button on the player-select
   (username) modal.

   The modal that gates score entry (requireUsername()) previously only
   offered "Enter Tournament" -- a visitor with no interest in scoring had
   no way to dismiss it short of entering a name and PIN. There's now a
   secondary "I'm just spectating" button that just closes the modal (via
   the existing closeUsernameModal()) with no other effect: no username or
   write token gets set, and the deferred action never runs. Drives the
   real scorecard-live.html and checks:

     - clicking it hides the modal without setting currentUsername/token
     - the pending action passed to requireUsername() is dropped, not run
     - triggering requireUsername() again reopens the same modal

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; Supabase calls aborted (never hit for real).

   Run: node test/repro-spectator-button.mjs
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
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());

    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.waitForTimeout(200);

    // 1. Simulate an action that requires login (e.g. tapping a score cell)
    // via the same gate every such action goes through, tracking whether
    // the deferred action ever actually ran.
    await page.evaluate(() => {
      window.__actionRan = 0;
      requireUsername(() => { window.__actionRan++; });
    });
    const opened = await page.evaluate(() => !document.getElementById('username-modal').classList.contains('hidden'));
    if (!opened) fail('expected the player-select modal to open when a gated action is attempted while logged out');

    const spectateBtn = page.locator('#username-modal button:has-text("I\'m just spectating")');
    if (await spectateBtn.count() !== 1) fail('expected exactly one "I\'m just spectating" button on the player-select modal');

    // 2. Clicking it closes the modal with no other effect.
    await spectateBtn.click();
    await page.waitForTimeout(100);
    const afterSpectate = await page.evaluate(() => ({
      hidden: document.getElementById('username-modal').classList.contains('hidden'),
      username: typeof currentUsername === 'undefined' ? null : currentUsername,
      token: typeof currentWriteToken === 'undefined' ? null : currentWriteToken,
      actionRan: window.__actionRan
    }));
    if (!afterSpectate.hidden) fail('expected the player-select modal to close after "I\'m just spectating"');
    if (afterSpectate.username) fail(`expected no username to be set, got "${afterSpectate.username}"`);
    if (afterSpectate.token) fail(`expected no write token to be set, got "${afterSpectate.token}"`);
    if (afterSpectate.actionRan !== 0) fail('expected the deferred action to be dropped, not run, by "I\'m just spectating"');

    // 3. Trying another gated action pops the same modal back up.
    await page.evaluate(() => requireUsername(() => { window.__actionRan++; }));
    const reopened = await page.evaluate(() => !document.getElementById('username-modal').classList.contains('hidden'));
    if (!reopened) fail('expected the player-select modal to reopen on the next gated action');

    console.log('All spectator-button assertions passed.');
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
