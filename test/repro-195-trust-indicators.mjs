/* ─────────────────────────────────────
   REGRESSION TEST — issue #195: trust indicators (sync pill + per-entry
   ticks).

   The sync layer is genuinely robust (offline queue, #141 auth-vs-network
   classification) but was invisible. This drives the real app and
   checks:

     - the sync pill shows "Live · synced Xs ago" after a successful poll
     - a queued (offline) write shows "Offline · N queued" and the
       affected input gets the dashed entry-tick-queued outline
     - once the queued write is flushed successfully, the tick flips to
       the solid entry-tick-ok outline
     - a wrong-PIN ('auth') response flips the pill to "Sign-in needed"

   Self-contained: a tiny static file server for the app plus an
   in-memory Supabase mock via Playwright route interception (needed here
   to actually exercise the offline-queue-then-flush path). Google Fonts
   is blocked outright, same as every other Playwright test in this repo.

   Run: node test/repro-195-trust-indicators.mjs
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

function createMockRows() {
  let nextId = 1;
  const rows = [];
  let failWrites = false;
  let rejectAuth = false;
  return {
    rows,
    setFailWrites(v) { failWrites = v; },
    shouldFail: () => failWrites,
    setRejectAuth(v) { rejectAuth = v; },
    shouldRejectAuth: () => rejectAuth,
    insert(row, { returnId } = {}) {
      const stored = { id: String(nextId++), tournament_id: row.tournament_id, update_type: row.update_type,
        match_idx: row.match_idx ?? null, player_id: row.player_id ?? null, field_key: row.field_key ?? null,
        value: row.value ?? null, updated_by: row.updated_by ?? null, updated_at: new Date().toISOString() };
      rows.push(stored);
      return returnId ? [{ id: stored.id }] : null;
    },
    select({ tournamentId, cursor }) {
      return rows
        .filter(r => r.tournament_id === tournamentId && r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
    }
  };
}

async function routeSupabase(route, mock) {
  const req = route.request();
  const url = new URL(req.url());
  const method = req.method();
  if (url.pathname === '/rest/v1/tournament_updates' && method === 'POST') {
    if (mock.shouldRejectAuth()) { await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }); return; }
    if (mock.shouldFail()) { await route.abort('failed'); return; }
    const body = JSON.parse(req.postData() || '{}');
    const prefer = req.headers()['prefer'] || '';
    const wantsRepresentation = /return=representation/.test(prefer);
    const result = mock.insert(body, { returnId: wantsRepresentation });
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(result || []) });
    return;
  }
  if (url.pathname === '/rest/v1/tournament_updates' && method === 'GET') {
    const tournamentId = (url.searchParams.get('tournament_id') || '').replace('eq.', '');
    const cursor = decodeURIComponent((url.searchParams.get('updated_at') || 'gte.1970-01-01').replace('gte.', ''));
    const result = mock.select({ tournamentId, cursor });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
    return;
  }
  await route.fulfill({ status: 404, body: '{}' });
}

function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;
  const mock = createMockRows();

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const page = await browser.newPage();
    await page.route(SUPABASE_HOST_GLOB, route => routeSupabase(route, mock));
    await page.route('**fonts.googleapis.com**', route => route.abort());
    await page.route('**fonts.gstatic.com**', route => route.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));

    // 1. After the initial successful poll, the pill reads "Live · synced ...".
    const liveText = await page.evaluate(() => document.querySelector('.sync-bar .sync-text').textContent);
    if (!/^Live · synced/.test(liveText)) fail(`expected "Live · synced ..." after initial sync, got "${liveText}"`);

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

    // 2. A write that fails to reach the server queues offline: the pill
    // shows "Offline · N queued" and the input gets the dashed tick.
    mock.setFailWrites(true);
    await page.evaluate(() => setHoleScore(0, 'A', 1, '7'));
    await page.waitForTimeout(150);
    const offlineState = await page.evaluate(() => ({
      pillText: document.querySelector('.sync-bar .sync-text').textContent,
      tickQueued: document.getElementById('day1-in-0-A-1').classList.contains('entry-tick-queued')
    }));
    if (!/Offline · 1 queued/.test(offlineState.pillText)) fail(`expected "Offline · 1 queued", got "${offlineState.pillText}"`);
    if (!offlineState.tickQueued) fail('expected the queued write to show the dashed entry-tick-queued outline');

    // 3. Once connectivity returns and the queue flushes, the tick flips
    // to the solid "ok" outline and the pill returns to reporting queue-free.
    mock.setFailWrites(false);
    await page.evaluate(() => flushPendingWrites());
    await page.waitForTimeout(150);
    const afterFlush = await page.evaluate(() => ({
      tickOk: document.getElementById('day1-in-0-A-1').classList.contains('entry-tick-ok'),
      tickQueued: document.getElementById('day1-in-0-A-1').classList.contains('entry-tick-queued'),
      pillText: document.querySelector('.sync-bar .sync-text').textContent
    }));
    if (!afterFlush.tickOk) fail('expected the flushed write to show the solid entry-tick-ok outline');
    if (afterFlush.tickQueued) fail('expected the dashed queued outline to be gone once flushed');
    if (/queued/.test(afterFlush.pillText)) fail(`expected the pill to stop mentioning a queue once flushed, got "${afterFlush.pillText}"`);

    // 4. A wrong-PIN response (401/403, per sendUpdateRow()'s own
    // classification) flips the pill to "Sign-in needed" via the real
    // insertUpdate() path, not a directly-poked flag.
    mock.setRejectAuth(true);
    await page.evaluate(() => setHoleScore(0, 'A', 2, '4'));
    await page.waitForTimeout(150);
    const authText = await page.evaluate(() => document.querySelector('.sync-bar .sync-text').textContent);
    if (authText !== 'Sign-in needed') fail(`expected "Sign-in needed", got "${authText}"`);

    console.log('All #195 trust-indicator assertions passed.');
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
