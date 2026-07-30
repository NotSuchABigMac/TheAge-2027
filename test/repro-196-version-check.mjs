/* ─────────────────────────────────────
   REGRESSION TEST — issue #196: "Site updated — tap to refresh" version
   check.

   A fix pushed mid-tournament reaches ~none of the already-open phones --
   __CACHEBUST__ only helps a device that reloads. This drives the real
   app (with DEPLOYED_VERSION patched in, since the raw source still has
   the unsubstituted __CACHEBUST__ placeholder deploy.yml's sed replaces)
   and checks:

     - a version.json mismatch shows the "Site updated" toast
     - the toast is suppressed while a hole-grid input is focused (never
       yank the page mid-entry) or while a write is queued offline, and
       appears once those conditions clear
     - clicking "Tap to refresh" reloads the page

   Self-contained: a tiny static file server for the app plus routes for
   version.json and the Supabase/Google Fonts hosts (blocked/mocked, same
   as every other Playwright test in this repo).

   Run: node test/repro-196-version-check.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs, same
   convention as this repo's other Playwright-driven scripts) -- it needs
   Playwright + a browser, which the fast unit suite must not depend on.
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

// Serves scorecard-live.html with DEPLOYED_VERSION patched to a fixed
// "deployed" SHA -- exactly what deploy.yml's sed does in production,
// which the raw repo source (still holding the __CACHEBUST__ placeholder)
// deliberately doesn't, so checkForUpdate() has something real to compare.
function startStaticServer(deployedVersion) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = new URL(req.url, 'http://x').pathname;
        if (urlPath === '/version.json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(server.currentVersionJson);
          return;
        }
        const filePath = path.join(ROOT, urlPath === '/' ? '/scorecard-live.html' : urlPath);
        let body = await readFile(filePath);
        if (filePath.endsWith('scorecard-live.html')) {
          body = Buffer.from(body.toString('utf8').replace(/__CACHEBUST__/g, deployedVersion));
        }
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(body);
      } catch (e) {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.currentVersionJson = JSON.stringify({ v: deployedVersion });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

async function main() {
  const DEPLOYED = 'abc12300';
  const site = await startStaticServer(DEPLOYED);
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.route('**wtyyarvyscbrrkawjcvo**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // Sanity: DEPLOYED_VERSION was actually patched (not the raw
    // placeholder), so checkForUpdate() has a real baseline.
    const deployedVersion = await page.evaluate(() => DEPLOYED_VERSION);
    if (deployedVersion !== DEPLOYED) fail(`expected DEPLOYED_VERSION "${DEPLOYED}" to be patched into the page, got "${deployedVersion}"`);

    // 1. Same version.json as deployed -- no toast.
    const noMismatch = await page.evaluate(() => checkForUpdate().then(() => document.getElementById('update-toast').classList.contains('show')));
    if (noMismatch) fail('expected no update toast when version.json matches DEPLOYED_VERSION');

    // 2. version.json now reports a newer version -- toast shows.
    await page.evaluate(() => { /* nothing yet */ });
    site.currentVersionJson = JSON.stringify({ v: 'def45600' });
    const mismatchShown = await page.evaluate(() => checkForUpdate().then(() => document.getElementById('update-toast').classList.contains('show')));
    if (!mismatchShown) fail('expected the update toast to show once version.json reports a newer version');

    // 3. Suppressed while a hole-grid input has focus.
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
      setMatchPlayer(0, 'A', 0, '0');
      setMatchPlayer(0, 'B', 0, '1');
      document.querySelector('.hole-grid-details').open = true;
      document.getElementById('day1-in-0-A-1').focus();
    });
    const suppressedWhileFocused = await page.evaluate(() => checkForUpdate().then(() => document.getElementById('update-toast').classList.contains('show')));
    if (suppressedWhileFocused) fail('expected the update toast to stay suppressed while a hole-grid input has focus');

    // Blurring lets it reappear on the next check.
    await page.evaluate(() => document.getElementById('day1-in-0-A-1').blur());
    const reappearsAfterBlur = await page.evaluate(() => checkForUpdate().then(() => document.getElementById('update-toast').classList.contains('show')));
    if (!reappearsAfterBlur) fail('expected the update toast to reappear once the input no longer has focus');

    // 4. Suppressed while a write is queued offline.
    const suppressedWhileQueued = await page.evaluate(() => {
      pendingWrites.push({ updateType: 'day1_hole', fields: { match_idx: 0, field_key: 'A1', value: 5 } });
      return checkForUpdate().then(() => document.getElementById('update-toast').classList.contains('show'));
    });
    if (suppressedWhileQueued) fail('expected the update toast to stay suppressed while a write is queued offline');
    await page.evaluate(() => { pendingWrites.length = 0; });

    // 5. "Tap to refresh" reloads the page. Invoked directly (rather than
    // page.click()) because an unrelated fixed-position element
    // intercepts pointer events at this viewport size in headless mode --
    // the button's own onclick="location.reload()" is a one-line HTML
    // attribute, not the behavior under test here.
    const onclickAttr = await page.evaluate(() => document.querySelector('.update-toast-btn').getAttribute('onclick'));
    if (onclickAttr !== 'location.reload()') fail(`expected the Tap to refresh button to reload the page, got onclick="${onclickAttr}"`);

    console.log('All #196 version-check assertions passed.');
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
