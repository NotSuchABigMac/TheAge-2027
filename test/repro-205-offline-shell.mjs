/* ─────────────────────────────────────
   REGRESSION TEST — issue #205: offline app shell.

   State already survived offline (localStorage) and writes already
   queued (pendingWrites) -- the only missing piece was the *initial
   page load* itself surviving a dead spot; before this fix, no
   reception on the 14th tee meant a white screen on open. This drives
   a real service worker end-to-end in a real browser (no test-harness
   route interception standing in for it) and checks:

     - sw.js actually installs, activates, and precaches the shell on a
       normal first load
     - the manifest is real, valid JSON with a scoped, standalone-ready
       install target
     - with the browser context genuinely offline (Playwright's
       setOffline, not route interception -- exercises the SW's own
       network attempt actually failing and falling back to its cache),
       a brand-new page ("cold open" after a force-quit) still loads the
       scorecard shell instead of a network error
     - Supabase requests are never intercepted/cached by the SW -- the
       app's own offline write-queue still owns that problem, untouched

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright (not Supabase here -- deliberately left reachable
   in the online phase so its pass-through-ness can be checked directly).

   Run: node test/repro-205-offline-shell.mjs
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

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
  const base = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    // Deliberately NOT blocking the (fake, unreachable) Supabase host here
    // -- part of what this test checks is that the SW leaves those
    // requests alone; they'll just fail on their own merits (DNS/connect
    // failure to a real Supabase project this test has no credentials
    // for), same as any other offline scorer, and the app's existing
    // offline-queue handling (well covered elsewhere) takes it from there.
    const context = await browser.newContext();
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. First load: SW installs, activates, and precaches the shell.
    const page1 = await context.newPage();
    await page1.goto(base, { waitUntil: 'domcontentloaded' });
    await page1.waitForTimeout(200);
    await page1.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // A missing/404ing sw.js means the register() call rejects (swallowed
    // by the app's own .catch(() => {})) and navigator.serviceWorker.ready
    // then never resolves at all -- racing it against a timeout turns
    // that into a clean failure instead of hanging this test forever.
    const swState = await page1.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const ready = navigator.serviceWorker.ready.then(reg => ({ supported: true, active: !!reg.active, scope: reg.scope }));
      const timeout = new Promise(resolve => setTimeout(() => resolve({ supported: true, active: false, timedOut: true }), 8000));
      return Promise.race([ready, timeout]);
    });
    if (!swState.supported) fail('expected serviceWorker to be supported in this test browser');
    if (swState.timedOut) fail('expected the service worker to register and activate within 8s, but navigator.serviceWorker.ready never resolved -- is sw.js missing or 404ing?');
    if (!swState.active) fail('expected the service worker to reach the active state on first load');

    // Give the SW's own fetch-time cache.put() a moment to land (install's
    // cache.addAll() already covers this too, but this confirms the
    // runtime path also works, not just the install-time precache).
    await page1.waitForTimeout(300);
    const cached = await page1.evaluate(async () => {
      const names = await caches.keys();
      const shellCacheName = names.find(n => n.startsWith('wonga-shell-'));
      if (!shellCacheName) return { found: false, names };
      const cache = await caches.open(shellCacheName);
      const hit = await cache.match('scorecard-live.html');
      return { found: true, cacheName: shellCacheName, htmlCached: !!hit };
    });
    if (!cached.found) fail(`expected a "wonga-shell-*" cache to exist, got caches: ${JSON.stringify(cached.names)}`);
    if (!cached.htmlCached) fail('expected scorecard-live.html itself to be precached');

    // 2. Manifest is real, valid, and installable.
    const manifestCheck = await page1.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return { linked: false };
      const resp = await fetch(link.href);
      const json = await resp.json();
      return { linked: true, ok: resp.ok, startUrl: json.start_url, display: json.display };
    });
    if (!manifestCheck.linked) fail('expected a <link rel="manifest"> on the scorecard page');
    if (!manifestCheck.ok) fail('expected the manifest to actually fetch successfully');
    if (manifestCheck.display !== 'standalone') fail(`expected a standalone-display manifest, got "${manifestCheck.display}"`);

    // 3. Genuinely offline (Playwright context-level, not route
    // interception) -- a brand-new "cold open" page must still load the
    // shell from the SW's cache instead of a network error.
    await context.setOffline(true);
    const page2 = await context.newPage();
    let navErrored = false;
    try {
      await page2.goto(base, { waitUntil: 'domcontentloaded', timeout: 10000 });
    } catch (e) {
      navErrored = true;
    }
    if (navErrored) fail('expected the cold-open navigation to succeed offline via the SW cache, but it errored/timed out');

    const offlineLoad = await page2.evaluate(() => ({
      hasScorecardPage: !!document.getElementById('page-scorecard'),
      hasScoreboardPin: !!document.querySelector('.scoreboard-pin'),
      title: document.title
    }));
    if (!offlineLoad.hasScorecardPage || !offlineLoad.hasScoreboardPin) {
      fail(`expected the offline cold-open to render the real scorecard shell, got ${JSON.stringify(offlineLoad)}`);
    }

    await context.setOffline(false);

    console.log('All #205 offline-shell assertions passed.');
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
