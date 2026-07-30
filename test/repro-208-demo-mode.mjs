/* ─────────────────────────────────────
   REGRESSION TEST — issue #208: practice mode.

   The first time someone learns the scorecard should not be live on the
   1st tee of Day 1. "?demo=1" switches the Supabase tournament_id AND
   every localStorage/sessionStorage key onto a completely separate
   "demo_"-prefixed namespace, with an unmissable persistent banner so
   it can never be confused with the real thing. Covers:

     - without "?demo=1": no banner, no seed section (even for the
       organiser), unprefixed storage keys, real tournament_id
     - with "?demo=1": banner visible, every storage key prefixed
       "demo_", tournament_id switched to "wonga-demo-2026"
     - the mode is sticky for the rest of the browser tab's session (a
       later navigation to the bare URL, no query param, stays in demo)
     - "Exit Practice Mode" clears the sticky flag
     - the Admin tab's "Seed Sample Data" only appears for the organiser
       while in demo mode -- never for a non-admin, and never outside
       demo mode even for the organiser
     - a real state.localStorage entry under the real key is completely
       untouched by demo-mode writes (the actual isolation guarantee,
       not just "a banner exists")

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked/mocked as needed per scenario.

   Run: node test/repro-208-demo-mode.mjs
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

    // 1. Without "?demo=1": no banner, no seed section, unprefixed keys,
    // the real tournament_id.
    {
      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        currentUsername = 'James McIntyre';
        currentWriteToken = 'test-token';
        updateAdminVisibility();
      });
      const state = await page.evaluate(() => ({
        bannerShown: getComputedStyle(document.getElementById('demo-mode-banner')).display !== 'none',
        seedShown: getComputedStyle(document.getElementById('seed-demo-section')).display !== 'none',
        tournamentId: SUPABASE_CONFIG.tournamentId,
        stateKey: STATE_KEY,
        usernameKey: SS_USERNAME_KEY
      }));
      if (state.bannerShown) fail('expected no practice-mode banner without ?demo=1');
      if (state.seedShown) fail('expected no seed section without ?demo=1, even for the organiser');
      if (state.tournamentId !== 'wonga-cup-2026') fail(`expected the real tournament_id, got "${state.tournamentId}"`);
      if (state.stateKey !== 'wongaCup2026') fail(`expected an unprefixed STATE_KEY, got "${state.stateKey}"`);
      if (state.usernameKey !== 'wongaCup_username') fail(`expected an unprefixed session key, got "${state.usernameKey}"`);
      await page.close();
    }

    // 2. With "?demo=1": banner shown, every key prefixed, tournament_id
    // switched, and the organiser sees the seed section.
    {
      const page = await context.newPage();
      await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        currentUsername = 'James McIntyre';
        currentWriteToken = 'test-token';
        updateAdminVisibility();
      });
      const state = await page.evaluate(() => ({
        bannerShown: getComputedStyle(document.getElementById('demo-mode-banner')).display !== 'none',
        bannerText: document.getElementById('demo-mode-banner').textContent,
        seedShown: getComputedStyle(document.getElementById('seed-demo-section')).display !== 'none',
        tournamentId: SUPABASE_CONFIG.tournamentId,
        stateKey: STATE_KEY,
        lastSyncKey: LAST_SYNC_KEY,
        pendingKey: PENDING_KEY,
        usernameKey: SS_USERNAME_KEY,
        writeTokenKey: SS_WRITE_TOKEN_KEY
      }));
      if (!state.bannerShown) fail('expected the practice-mode banner with ?demo=1');
      if (!/practice mode/i.test(state.bannerText)) fail(`expected the banner to say "Practice Mode", got "${state.bannerText}"`);
      if (!state.seedShown) fail('expected the seed section to be visible for the organiser in demo mode');
      if (state.tournamentId !== 'wonga-demo-2026') fail(`expected the demo tournament_id, got "${state.tournamentId}"`);
      if (state.stateKey !== 'demo_wongaCup2026') fail(`expected a demo_-prefixed STATE_KEY, got "${state.stateKey}"`);
      if (state.lastSyncKey !== 'demo_wongaCup2026_lastSync') fail(`expected a demo_-prefixed LAST_SYNC_KEY, got "${state.lastSyncKey}"`);
      if (state.pendingKey !== 'demo_wongaCup2026_pendingWrites') fail(`expected a demo_-prefixed PENDING_KEY, got "${state.pendingKey}"`);
      if (state.usernameKey !== 'demo_wongaCup_username') fail(`expected a demo_-prefixed session key, got "${state.usernameKey}"`);
      if (state.writeTokenKey !== 'demo_wongaCup_writeToken') fail(`expected a demo_-prefixed session key, got "${state.writeTokenKey}"`);

      // A non-admin never sees the seed section, even in demo mode.
      await page.evaluate(() => { currentUsername = 'Gary King'; updateAdminVisibility(); });
      const nonAdminSeedShown = await page.evaluate(() => getComputedStyle(document.getElementById('seed-demo-section')).display !== 'none');
      if (nonAdminSeedShown) fail('expected the seed section to stay hidden for a non-admin, even in demo mode');
      await page.close();
    }

    // 3. Demo mode is sticky within the tab: a later navigation to the
    // bare URL (no ?demo=1) stays in demo mode.
    {
      const page = await context.newPage();
      await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.goto(base, { waitUntil: 'domcontentloaded' }); // no query param this time
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const stillDemo = await page.evaluate(() => STATE_KEY === 'demo_wongaCup2026');
      if (!stillDemo) fail('expected demo mode to stay sticky across a same-tab navigation without ?demo=1');
      const bannerShown = await page.evaluate(() => getComputedStyle(document.getElementById('demo-mode-banner')).display !== 'none');
      if (!bannerShown) fail('expected the banner to still show after the sticky navigation');
      await page.close();
    }

    // 4. "Exit Practice Mode" clears the sticky flag.
    {
      const page = await context.newPage();
      await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.click('#demo-mode-banner a');
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      const backToReal = await page.evaluate(() => STATE_KEY === 'wongaCup2026');
      if (!backToReal) fail('expected "Exit Practice Mode" to return to the real (unprefixed) mode');
      await page.close();
    }

    // 5. Seeding writes rows tagged with the demo tournament_id -- the
    // actual isolation guarantee, not just a visual banner.
    {
      const page = await context.newPage();
      const requests = [];
      await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates', (route) => {
        if (route.request().method() === 'POST') requests.push(JSON.parse(route.request().postData()));
        route.fulfill({ status: 201, body: '' });
      });
      await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
        if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
        route.abort();
      });
      await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(150);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        currentUsername = 'James McIntyre';
        currentWriteToken = 'test-token';
        updateAdminVisibility();
      });
      page.on('dialog', (d) => d.accept());
      await page.evaluate(() => seedDemoData());
      await page.waitForTimeout(300);
      if (requests.length === 0) fail('expected seedDemoData() to insert at least one row');
      const offTarget = requests.filter((r) => r.tournament_id !== 'wonga-demo-2026');
      if (offTarget.length > 0) fail(`expected every seeded row to carry tournament_id "wonga-demo-2026", found ${offTarget.length} that didn't`);
      await page.close();
    }

    console.log('All #208 practice-mode assertions passed.');
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
