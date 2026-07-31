/* ─────────────────────────────────────
   REGRESSION TEST — issue #245: in-app help/tutorial for the live
   scorecard.

   This feature (the "?" help button + "How This Works" modal, masthead
   top-right) was already implemented and merged (PR #277) before this
   test existed -- issue #245 itself was left open with no dedicated
   test coverage. This backfills that coverage and pins the exact
   behavior found in scorecard-live.html:

     - a first-ever visit pulses the help button (.needs-attention)
       until it's been opened once
     - opening it shows the tutorial content and stops the pulse
     - "Got it" closes it
     - having been seen persists across a reload (no re-pulse)
     - the "seen" flag is KEY_PREFIX-scoped like every other storage key
       in this file, so demo mode (?demo=1) and the real tournament
       never leak "have you seen the help modal" state into each other

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-245-help-tutorial.mjs
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
  const base = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // 1. First-ever visit: pulsing, modal hidden.
    const page = await context.newPage();
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    const first = await page.evaluate(() => ({
      pulsing: document.getElementById('help-btn').classList.contains('needs-attention'),
      modalHidden: document.getElementById('help-modal').classList.contains('hidden')
    }));
    if (!first.pulsing) fail('expected the help button to pulse on a first-ever visit');
    if (!first.modalHidden) fail('expected the help modal to start hidden');

    // 2. Opening it shows the tutorial content and stops the pulse.
    await page.click('#help-btn');
    const opened = await page.evaluate(() => ({
      pulsing: document.getElementById('help-btn').classList.contains('needs-attention'),
      modalShown: !document.getElementById('help-modal').classList.contains('hidden'),
      title: document.getElementById('help-modal-title').textContent,
      mentionsUndo: document.getElementById('help-modal').textContent.includes('Undo'),
      seenKeySet: localStorage.getItem('wongaCup2026_helpSeen') === '1'
    }));
    if (opened.pulsing) fail('expected the pulse to stop once the help modal is opened');
    if (!opened.modalShown) fail('expected the help modal to actually show on click');
    if (!/how this works/i.test(opened.title)) fail(`expected a "How This Works" title, got "${opened.title}"`);
    if (!opened.mentionsUndo) fail('expected the tutorial content to cover Undo, one of the live scorecard\'s own UX features');
    if (!opened.seenKeySet) fail('expected opening the modal to persist the "seen" flag');

    // 3. "Got it" closes it.
    await page.click('.help-modal-close');
    const closed = await page.evaluate(() => document.getElementById('help-modal').classList.contains('hidden'));
    if (!closed) fail('expected "Got it" to close the help modal');

    // 4. Reload: having been seen persists, no re-pulse.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    const afterReload = await page.evaluate(() => document.getElementById('help-btn').classList.contains('needs-attention'));
    if (afterReload) fail('expected no pulse on reload once the help modal has already been seen');

    // 5. Demo mode's "seen" flag is namespaced separately from the real
    // one -- a fresh demo-mode visit still pulses even though the real
    // mode (this same browser/localStorage) has already seen it.
    const page2 = await context.newPage();
    await page2.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(200);
    await page2.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    const demoState = await page2.evaluate(() => ({
      pulsing: document.getElementById('help-btn').classList.contains('needs-attention'),
      demoKeyExists: localStorage.getItem('demo_wongaCup2026_helpSeen') === null,
      realKeyUntouched: localStorage.getItem('wongaCup2026_helpSeen') === '1'
    }));
    if (!demoState.pulsing) fail('expected demo mode to pulse independently, even though the real mode has already seen the help modal');
    if (!demoState.demoKeyExists) fail('expected no demo_-prefixed "seen" key yet (demo mode has never opened its own modal)');
    if (!demoState.realKeyUntouched) fail('expected the real (unprefixed) "seen" key to be untouched by visiting demo mode');

    console.log('All #245 help-tutorial assertions passed.');
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
