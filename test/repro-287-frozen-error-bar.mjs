/* ─────────────────────────────────────
   REGRESSION TEST — issue #287: freeze the sync bar red and pinned under
   the score once there's an actual sync problem.

   Follow-up to #285 (hung fetch wedged sync forever). Once that was
   fixed, the remaining complaint was that the sync-bar's error state was
   too easy to miss: it sat in normal document flow directly under the
   sticky .scoreboard-pin, so it scrolled out of view the moment a scorer
   entered holes further down the page -- exactly when an offline/auth
   problem most needs to be seen.

   This drives the real page and asserts, via the same
   syncInFlight/isOffline/pendingWrites state #191's test already pokes:
     - the ordinary "Live" state never gets the .sync-frozen treatment
       (no need to freeze a bar with nothing to say),
     - once a write queues offline, the bar gains .sync-frozen, a
       position:sticky `top` that docks it directly under the live
       .mini-sb height (masthead height + mini scoreboard height, not a
       hardcoded pixel guess -- .mini-sb rather than .scoreboard-pin since
       issue #301 made .mini-sb the sticky bar that follows down the page),
       and stays reachable (still in the DOM, still showing its text)
       after scrolling the page down,
     - a wrong-PIN ('auth') rejection freezes it too,
     - and once the connection recovers and the queue drains, the frozen
       treatment is lifted again.

   Self-contained: in-memory Supabase mock via Playwright route
   interception, plus a tiny static file server for the app itself. Never
   touches the real Supabase project.

   Run: node test/repro-287-frozen-error-bar.mjs
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
const SUPABASE_HOST_GLOB = '**wtyyarvyscbrrkawjcvo**';

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

// Minimal in-memory Supabase mock. Writes can be forced to fail (queues
// offline) or forced to reject as a bad write_token (401).
function createMock() {
  let nextId = 1;
  const rows = [];
  let failWrites = false;
  let rejectAuth = false;
  return {
    setFailWrites(v) { failWrites = v; },
    setRejectAuth(v) { rejectAuth = v; },
    async handle(route) {
      const req = route.request();
      const url = new URL(req.url());
      const method = req.method();
      if (url.pathname === '/rest/v1/tournament_updates' && method === 'GET') {
        const tournamentId = (url.searchParams.get('tournament_id') || '').replace('eq.', '');
        const cursor = decodeURIComponent((url.searchParams.get('updated_at') || 'gte.1970-01-01').replace('gte.', ''));
        const result = rows
          .filter(r => r.tournament_id === tournamentId && r.updated_at >= cursor)
          .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
        return;
      }
      if (url.pathname === '/rest/v1/tournament_updates' && method === 'POST') {
        if (rejectAuth) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; }
        if (failWrites) { await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }); return; }
        const body = JSON.parse(req.postData() || '{}');
        const stored = { id: String(nextId++), tournament_id: body.tournament_id, update_type: body.update_type,
          match_idx: body.match_idx ?? null, player_id: body.player_id ?? null, field_key: body.field_key ?? null,
          value: body.value ?? null, updated_by: body.updated_by ?? null, updated_at: new Date().toISOString() };
        rows.push(stored);
        await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
        return;
      }
      await route.fulfill({ status: 404, body: '{}' });
    }
  };
}

function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;
  const mock = createMock();

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.route(SUPABASE_HOST_GLOB, route => mock.handle(route));
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.waitForFunction(() => typeof syncInFlight !== 'undefined' && syncInFlight === false, null, { timeout: 5000 });

    // 1. Ordinary "Live" state -- never frozen.
    const liveState = await page.evaluate(() => ({
      frozen: document.querySelector('.sync-bar').classList.contains('sync-frozen'),
      text: document.querySelector('.sync-bar .sync-text').textContent
    }));
    if (liveState.frozen) fail(`expected the bar NOT frozen in the ordinary Live state, text was "${liveState.text}"`);

    // Log in so writes are attributed (needed for setHoleScore -> insertUpdate).
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });
    await page.evaluate(() => {
      setMatchPlayer(0, 'A', 0, '0');
      setMatchPlayer(0, 'B', 0, '1');
      document.querySelector('.hole-grid-details').open = true;
    });
    await page.waitForTimeout(100);

    // 2. A write that fails to reach the server queues offline -- the bar
    // must go red/frozen, with a `top` computed from the live scoreboard
    // height rather than a hardcoded guess.
    mock.setFailWrites(true);
    await page.evaluate(() => setHoleScore(0, 'A', 1, '7'));
    await page.waitForTimeout(150);
    const offlineState = await page.evaluate(() => {
      const bar = document.querySelector('.sync-bar');
      const miniSb = document.querySelector('.mini-sb');
      const masthead = document.querySelector('.masthead');
      return {
        frozen: bar.classList.contains('sync-frozen'),
        top: bar.style.top,
        expectedTop: `${masthead.offsetHeight + miniSb.offsetHeight}px`,
        text: bar.textContent
      };
    });
    if (!offlineState.frozen) fail('expected the bar to gain .sync-frozen once a write queues offline');
    if (offlineState.top !== offlineState.expectedTop) {
      fail(`expected the frozen bar's top to match masthead+mini-sb height (${offlineState.expectedTop}), got ${offlineState.top}`);
    }
    if (!/queued/.test(offlineState.text)) fail(`expected the frozen bar to still show queue text, got "${offlineState.text}"`);

    // It must actually stay visible after scrolling the page down -- the
    // whole point of freezing it. position:sticky means the element never
    // leaves the DOM/layout, so assert its bounding rect is still within
    // the viewport after a big scroll.
    await page.evaluate(() => window.scrollBy(0, 2000));
    await page.waitForTimeout(50);
    const rectAfterScroll = await page.evaluate(() => document.querySelector('.sync-bar').getBoundingClientRect());
    if (rectAfterScroll.top < 0 || rectAfterScroll.bottom > 2000) {
      fail(`expected the frozen bar to stay pinned on-screen after scrolling, got rect ${JSON.stringify(rectAfterScroll)}`);
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // 3. Recovery: once the connection returns, the next real poll cycle
    // (pollOnce() -> loadFromSupabase(), same as the 30s interval/manual
    // refresh/visibility-change paths all use) resets isOffline before
    // flushing the queue -- the frozen treatment must lift.
    mock.setFailWrites(false);
    await page.evaluate(() => pollOnce());
    await page.waitForTimeout(150);
    const recoveredState = await page.evaluate(() => ({
      frozen: document.querySelector('.sync-bar').classList.contains('sync-frozen'),
      top: document.querySelector('.sync-bar').style.top
    }));
    if (recoveredState.frozen) fail('expected .sync-frozen to be lifted once the queue drains and sync recovers');
    if (recoveredState.top !== '') fail(`expected the inline top style to be cleared once un-frozen, got "${recoveredState.top}"`);

    // 4. A wrong-PIN ('auth') rejection freezes it too.
    mock.setRejectAuth(true);
    await page.evaluate(() => setHoleScore(0, 'A', 2, '4'));
    await page.waitForTimeout(150);
    const authState = await page.evaluate(() => ({
      frozen: document.querySelector('.sync-bar').classList.contains('sync-frozen'),
      text: document.querySelector('.sync-bar .sync-text').textContent
    }));
    if (!authState.frozen) fail('expected a wrong-PIN rejection to freeze the bar too');
    if (authState.text !== 'Sign-in needed') fail(`expected exact text "Sign-in needed" (unchanged from #195), got "${authState.text}"`);

    console.log('All #287 frozen-error-bar assertions passed.');
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
