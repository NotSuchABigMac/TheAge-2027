/* ─────────────────────────────────────
   REGRESSION TEST — issue #204: multi-tab safety.

   Two tabs of the scorecard on one phone used to share localStorage
   state, the sync cursors, and pendingWrites while each held an
   independent in-memory copy -- one tab could resurrect what the other
   cleared, or double-flush the write queue. This drives two real
   Playwright pages in the SAME browser context (so they genuinely share
   localStorage/BroadcastChannel, like two tabs on one phone) and checks:

     - opening a second tab dormants the first (near-instantly, via
       BroadcastChannel) -- the dormant tab shows the full-screen
       "Take Over Here" notice, the newer tab does not
     - a dormant tab's saveState() is a no-op -- it never overwrites
       localStorage with whatever it happens to hold in memory
     - tapping "Take Over Here" reloads that tab, reclaims active status,
       and dormants whichever tab was previously active
     - killing the active tab outright (page.close(), no clean handoff)
       is recovered from automatically: the survivor's heartbeat-staleness
       check reclaims active status within the heartbeat window, with no
       tap required

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-204-multi-tab-safety.mjs
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

async function dormantState(page) {
  return page.evaluate(() => ({
    dormant: typeof tabDormant !== 'undefined' ? tabDormant : 'undef',
    modalShown: getComputedStyle(document.getElementById('dormant-tab-modal')).display !== 'none'
  }));
}

async function waitForDormant(page, expected, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = await dormantState(page);
    if (s.dormant === expected && s.modalShown === expected) return s;
    await page.waitForTimeout(100);
  }
  return dormantState(page);
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
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    // Tab 1: loads alone -- must claim active status, no dormant overlay.
    const page1 = await context.newPage();
    await page1.goto(base, { waitUntil: 'domcontentloaded' });
    await page1.waitForTimeout(200);
    await page1.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    const tab1Alone = await dormantState(page1);
    if (tab1Alone.dormant !== false || tab1Alone.modalShown) fail(`expected tab 1 to be active when it's the only tab open, got ${JSON.stringify(tab1Alone)}`);

    // Tab 2: a second tab opens -- it claims active, tab 1 must go dormant.
    const page2 = await context.newPage();
    await page2.goto(base, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(200);
    await page2.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    const tab2Alone = await dormantState(page2);
    if (tab2Alone.dormant !== false || tab2Alone.modalShown) fail(`expected the newer tab 2 to be active, got ${JSON.stringify(tab2Alone)}`);

    const tab1Dormant = await waitForDormant(page1, true);
    if (!tab1Dormant.dormant || !tab1Dormant.modalShown) fail(`expected tab 1 to go dormant once tab 2 opened, got ${JSON.stringify(tab1Dormant)}`);

    // A dormant tab's saveState() must be a complete no-op.
    const saveGuardResult = await page1.evaluate(() => {
      const before = localStorage.getItem(STATE_KEY);
      state.teamNameA = 'SHOULD NOT PERSIST';
      saveState();
      const after = localStorage.getItem(STATE_KEY);
      return { unchanged: before === after, leakedIntoStorage: (after || '').includes('SHOULD NOT PERSIST') };
    });
    if (!saveGuardResult.unchanged || saveGuardResult.leakedIntoStorage) {
      fail(`expected a dormant tab's saveState() to never touch localStorage, got ${JSON.stringify(saveGuardResult)}`);
    }

    // Tapping "Take Over Here" on tab 1 reloads it, reclaims active status,
    // and dormants tab 2 (previously active).
    await page1.click('.dormant-tab-btn');
    await page1.waitForLoadState('domcontentloaded');
    await page1.waitForTimeout(300);
    await page1.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    const tab1AfterTakeover = await dormantState(page1);
    if (tab1AfterTakeover.dormant !== false || tab1AfterTakeover.modalShown) {
      fail(`expected tab 1 to be active again after "Take Over Here", got ${JSON.stringify(tab1AfterTakeover)}`);
    }
    const tab2AfterTakeover = await waitForDormant(page2, true);
    if (!tab2AfterTakeover.dormant || !tab2AfterTakeover.modalShown) {
      fail(`expected tab 2 to go dormant once tab 1 took over, got ${JSON.stringify(tab2AfterTakeover)}`);
    }

    // Killing the active tab outright (no clean handoff) -- the dormant
    // survivor must reclaim automatically once the heartbeat goes stale,
    // no tap required. TAB_HEARTBEAT_STALE_MS is 15s, checked every 5s,
    // so this genuinely needs to wait out that real window.
    await page1.close();
    const start = Date.now();
    let reclaimed = null;
    while (Date.now() - start < 25000) {
      reclaimed = await dormantState(page2);
      if (!reclaimed.dormant) break;
      await page2.waitForTimeout(1000);
    }
    if (reclaimed.dormant !== false || reclaimed.modalShown) {
      fail(`expected tab 2 to auto-reclaim active status once the killed tab 1's heartbeat went stale, got ${JSON.stringify(reclaimed)}`);
    }

    console.log('All #204 multi-tab-safety assertions passed.');
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
