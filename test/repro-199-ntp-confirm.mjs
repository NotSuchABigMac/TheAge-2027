/* ─────────────────────────────────────
   REGRESSION TEST — issue #199: "Replaces X" confirm on NTP overwrite.

   Someone genuinely will re-tap the wrong name in a crowded dropdown --
   this is a confirm, never a validation failure, and deliberately not
   window.confirm(). Drives the real Day 1 NTP select and checks:

     - the first-ever pick for a hole commits immediately, no confirm
     - replacing an already-recorded winner with a different one shows
       "Replaces {name} on {hole} — sure?" and does NOT commit yet
       (state/insertUpdate untouched until answered)
     - "Fix" reverts the select back to the previous winner and commits
       nothing
     - "Keep" commits the new winner
     - clearing a winner back to blank never shows a confirm (not a
       replacement)

   Self-contained: a tiny static file server for the app plus an
   in-memory Supabase mock via Playwright route interception. Google
   Fonts is blocked outright, same as every other Playwright test in this
   repo.

   Run: node test/repro-199-ntp-confirm.mjs
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
  return {
    rows,
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
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      sessionStorage.setItem('wongaCup_username', currentUsername);
      sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
    });

    // 1. First-ever pick for a hole: commits immediately, no confirm.
    // Uses the real <select> (selectOption fires a genuine 'change' event,
    // exactly like a real user picking from the dropdown) rather than
    // calling setDay1Ntp() directly, since the select's own displayed
    // value is native browser behavior the JS handler never sets itself.
    await page.selectOption('#ntp-day1-h8', '0');
    const first = await page.evaluate(() => ({
      ntp: state.day1.ntp.h8,
      confirmShown: document.getElementById('confirm-toast').classList.contains('show')
    }));
    if (first.ntp !== 0) fail(`expected the first pick to commit immediately, ntp.h8=${first.ntp}`);
    if (first.confirmShown) fail('expected no confirm on the first-ever pick for a hole');

    // 2. Replacing player 0 with player 1: confirm shows, does NOT commit yet.
    await page.selectOption('#ntp-day1-h8', '1');
    const replaced = await page.evaluate(() => ({
      ntp: state.day1.ntp.h8,
      confirmShown: document.getElementById('confirm-toast').classList.contains('show'),
      text: document.querySelector('.confirm-toast-text').textContent,
      selectValue: document.getElementById('ntp-day1-h8').value
    }));
    if (!replaced.confirmShown) fail('expected a confirm when replacing an already-recorded NTP winner');
    if (replaced.ntp !== 0) fail(`expected state to stay at the OLD winner until confirmed, got ${replaced.ntp}`);
    if (!/Replaces .+ on 8 — sure\?/.test(replaced.text)) fail(`expected a "Replaces ... on 8 — sure?" message, got "${replaced.text}"`);
    // The native <select> itself already shows the new pick (can't hold
    // that back without extra machinery) -- only the committed state is
    // deferred.
    if (replaced.selectValue !== '1') fail(`expected the select to show the newly picked value, got "${replaced.selectValue}"`);

    // 3. "Fix": reverts the select, commits nothing.
    const fixed = await page.evaluate(() => {
      resolveNtpConfirm(false);
      return {
        ntp: state.day1.ntp.h8,
        selectValue: document.getElementById('ntp-day1-h8').value,
        confirmShown: document.getElementById('confirm-toast').classList.contains('show')
      };
    });
    if (fixed.ntp !== 0) fail(`expected "Fix" to leave state at the old winner, got ${fixed.ntp}`);
    if (fixed.selectValue !== '0') fail(`expected "Fix" to revert the select back to the old winner, got "${fixed.selectValue}"`);
    if (fixed.confirmShown) fail('expected the confirm toast to dismiss after "Fix"');
    const rowsAfterFix = mock.rows.filter(r => r.update_type === 'day1_ntp' && r.field_key === 'h8');
    if (rowsAfterFix.length !== 1) fail(`expected "Fix" to write no new row, saw ${rowsAfterFix.length} day1_ntp/h8 rows`);

    // 4. "Keep": commits the new winner for real.
    await page.selectOption('#ntp-day1-h8', '1');
    const kept = await page.evaluate(() => {
      resolveNtpConfirm(true);
      return { ntp: state.day1.ntp.h8, confirmShown: document.getElementById('confirm-toast').classList.contains('show') };
    });
    if (kept.ntp !== 1) fail(`expected "Keep" to commit the new winner, got ${kept.ntp}`);
    if (kept.confirmShown) fail('expected the confirm toast to dismiss after "Keep"');
    await page.waitForTimeout(100);
    const rowsAfterKeep = mock.rows.filter(r => r.update_type === 'day1_ntp' && r.field_key === 'h8');
    if (rowsAfterKeep.length !== 2 || rowsAfterKeep[1].value !== '1') {
      fail(`expected "Keep" to write exactly one new row with value "1", got ${JSON.stringify(rowsAfterKeep)}`);
    }

    // 5. Clearing a winner back to blank is never a "replacement" -- no
    // confirm, commits immediately.
    await page.selectOption('#ntp-day1-h8', '');
    const cleared = await page.evaluate(() => ({
      ntp: state.day1.ntp.h8,
      confirmShown: document.getElementById('confirm-toast').classList.contains('show')
    }));
    if (cleared.ntp !== null) fail(`expected clearing to commit null immediately, got ${cleared.ntp}`);
    if (cleared.confirmShown) fail('expected no confirm when clearing a winner back to blank');

    console.log('All #199 NTP-overwrite-confirm assertions passed.');
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
