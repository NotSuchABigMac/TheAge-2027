/* ─────────────────────────────────────
   REGRESSION TEST — issue #304: Wonga Wire should only create a Day 1
   commentary event once BOTH players' gross scores for a hole are in,
   not once per individual score entry.

   Before this fix, entering player A's hole score fired one "thru N"
   feed line, and entering player B's score for that same physical hole
   fired a second, near-identical one -- noisy, duplicate commentary for
   a single real result.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - a day1_hole row that only fills in one side of a hole (the other
       side still null -- the hole isn't "thru" yet) adds NOTHING to the
       Wire feed
     - the row that completes the hole (both sides now scored) is the
       one that adds exactly one new feed entry, describing that hole

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked with fixture rows,
   never hit for real.

   Run: node test/repro-304-wire-dedup.mjs
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

    let currentRows = [];
    const page = await context.newPage();
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      const url = new URL(route.request().url());
      const cursor = decodeURIComponent((url.searchParams.get('updated_at') || 'gte.1970-01-01T00:00:00.000Z').replace(/^gte\./, ''));
      const filtered = currentRows
        .filter(r => r.updated_at >= cursor)
        .sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id.localeCompare(b.id)));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(filtered) });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'Gary King';
      currentWriteToken = 'test-token';
      // Match players don't matter for this test beyond having real ids
      // to name in the headline -- Day 1 draft/assignment is a separate
      // concern (issue #302), out of scope here.
      state.day1.matches[0].pA = [PLAYERS[0].id];
      state.day1.matches[0].pB = [PLAYERS[1].id];
      saveState();
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    const beforeAnyScore = await page.evaluate(() => document.getElementById('wire-feed-list').textContent);
    if (!/No events yet/.test(beforeAnyScore)) fail(`expected an empty Wire feed before any score, got "${beforeAnyScore}"`);

    // 1. Complete hole 1 (both sides scored) -- the legitimate first Wire
    // entry, thru advances 0 -> 1. Not the case this issue is about, but
    // needed so hole 2's partial entry below has a non-zero prevStatus.thru
    // to (wrongly, pre-fix) fall through on.
    currentRows = [
      { id: 'row-1', tournament_id: 'wonga-cup-2026', updated_by: 'James McIntyre', updated_at: new Date().toISOString(), update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4' },
      { id: 'row-2', tournament_id: 'wonga-cup-2026', updated_by: 'James McIntyre', updated_at: new Date(Date.now() + 1000).toISOString(), update_type: 'day1_hole', match_idx: 0, field_key: 'B1', value: '5' }
    ];
    await page.click('.refresh-btn');
    await page.waitForTimeout(600);

    const afterHole1 = await page.evaluate(() => document.querySelectorAll('#wire-feed-list .wire-item').length);
    if (afterHole1 !== 1) fail(`expected exactly ONE Wire feed entry once hole 1 is complete, got ${afterHole1}`);

    // 2. Player A's hole 2 score arrives -- hole 2 isn't complete (B's
    // side is still null, thru stays at 1), so this must NOT add a second,
    // duplicate feed entry (issue #304's actual bug: this used to still
    // fall through to the generic "thru N" feed line even though nothing
    // new had actually completed).
    currentRows = [
      ...currentRows,
      { id: 'row-3', tournament_id: 'wonga-cup-2026', updated_by: 'James McIntyre', updated_at: new Date(Date.now() + 2000).toISOString(), update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: '4' }
    ];
    await page.click('.refresh-btn');
    await page.waitForTimeout(600);

    const afterOnlyA2 = await page.evaluate(() => ({
      feedText: document.getElementById('wire-feed-list').textContent,
      itemCount: document.querySelectorAll('#wire-feed-list .wire-item').length
    }));
    if (afterOnlyA2.itemCount !== 1) fail(`expected still exactly ONE Wire feed entry for a half-entered hole 2 (A only), got ${afterOnlyA2.itemCount}: "${afterOnlyA2.feedText}"`);

    // 3. Player B's hole 2 score arrives, completing the hole (thru
    // advances 1 -> 2) -- this is the row that should add the second,
    // genuinely new feed entry.
    currentRows = [
      ...currentRows,
      { id: 'row-4', tournament_id: 'wonga-cup-2026', updated_by: 'James McIntyre', updated_at: new Date(Date.now() + 3000).toISOString(), update_type: 'day1_hole', match_idx: 0, field_key: 'B2', value: '5' }
    ];
    await page.click('.refresh-btn');
    await page.waitForTimeout(600);

    const afterHole2 = await page.evaluate(() => ({
      feedText: document.getElementById('wire-feed-list').textContent,
      itemCount: document.querySelectorAll('#wire-feed-list .wire-item').length
    }));
    if (afterHole2.itemCount !== 2) fail(`expected exactly TWO Wire feed entries once hole 2 is also complete, got ${afterHole2.itemCount}: "${afterHole2.feedText}"`);
    if (!/thru 2/.test(afterHole2.feedText)) fail(`expected the newest feed entry to describe hole 2 completing, got "${afterHole2.feedText}"`);

    console.log('All #304 Wonga Wire dedup assertions passed.');
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
