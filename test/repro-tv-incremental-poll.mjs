/* ─────────────────────────────────────
   REGRESSION TEST — issue #20: tv.html used to re-download and replay
   the ENTIRE tournament_updates log from epoch on every 30s poll. The
   fix keeps state/wireCandidates/cursor across polls (module-level) and
   only fetches rows newer than the last one seen.

   This drives real tv.html against a mock Supabase endpoint that (unlike
   the other tv.html repro scripts' static fixtures) actually honours the
   `updated_at=gte.<cursor>` query param, the way real PostgREST does --
   so a poll that fetches more than just the new rows would show up as
   an assertion failure here, not just as wasted bandwidth nothing here
   can observe.

   Uses window.__tv (test-only hook, see tv.html) to call refresh()
   directly rather than waiting a real 30s for the next scheduled tick.

   Checks:
     - the first load makes exactly one request, from epoch
     - a second refresh() after one new row lands makes exactly one MORE
       request, using a cursor equal to the previous poll's last
       updated_at -- not epoch again
     - the wire feed's underlying candidate list grows by exactly one
       (the new row), not re-counting rows already seen -- the `gte`
       cursor is inclusive, so the boundary row comes back on the next
       poll too, and must be deduped rather than double-added
     - the rendered totals reflect the new row correctly

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for
   real.

   Run: node test/repro-tv-incremental-poll.mjs
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

function dateMockScript(iso) {
  const fixed = new Date(iso).getTime();
  return `(() => {
    const RealDate = Date;
    class MockDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) super(${fixed});
        else super(...args);
      }
      static now() { return ${fixed}; }
    }
    window.Date = MockDate;
  })();`;
}

// Day 1, one match: player 0 (Team A) beats player 1 (Team B) 4-3 on
// hole 1 -- a genuine wire-worthy event (day1_hole completing a hole).
function baseFixtureRows() {
  let t = 0;
  const row = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:00:${String(t++).padStart(2, '0')}.000Z`, ...fields });
  return [
    row({ update_type: 'team_name', field_key: 'A', value: 'Team Alpha' }),
    row({ update_type: 'team_name', field_key: 'B', value: 'Team Beta' }),
    row({ update_type: 'player_team', player_id: 0, value: 'A' }),
    row({ update_type: 'player_team', player_id: 1, value: 'B' }),
    row({ update_type: 'player_hcp', player_id: 0, value: '0.0' }),
    row({ update_type: 'player_hcp', player_id: 1, value: '0.0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '0' }),
    row({ update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '1' }),
    row({ update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4' }),
    row({ update_type: 'day1_hole', match_idx: 0, field_key: 'B1', value: '5' })
  ];
}

async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const url = `http://127.0.0.1:${sitePort}/tv.html`;

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    const context = await browser.newContext();
    await context.addInitScript(dateMockScript('2026-08-07T12:00:00.000Z'));
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const dataset = baseFixtureRows();
    const requestCursors = [];
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    // Playwright runs the LAST-registered matching route first, so the
    // broad catch-all is registered before the specific
    // tournament_updates route -- otherwise the catch-all would swallow
    // every request, including the ones this test needs to inspect.
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      const reqUrl = new URL(route.request().url());
      const rawFilter = reqUrl.searchParams.get('updated_at') || 'gte.1970-01-01T00:00:00.000Z';
      const cursor = rawFilter.replace(/^gte\./, '');
      requestCursors.push(cursor);
      // Real PostgREST semantics: >= cursor, ordered, capped at 500 --
      // exactly the contract fetchAllRows()/fetchWithTimeout() rely on.
      const rows = dataset.filter(r => r.updated_at >= cursor).sort((a, b) => a.updated_at < b.updated_at ? -1 : 1).slice(0, 500);
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
    });

    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // 1. First load: exactly one request, from epoch.
    if (requestCursors.length !== 1) fail(`expected exactly 1 request on first load, saw ${requestCursors.length}`);
    if (requestCursors[0] !== '1970-01-01T00:00:00.000Z') fail(`expected the first request to start from epoch, got cursor ${requestCursors[0]}`);

    const cursorAfterFirstLoad = await page.evaluate(() => window.__tv.cursor);
    const wireCandidatesAfterFirstLoad = await page.evaluate(() => window.__tv.wireCandidateCount);
    const match0AfterFirstLoad = await page.evaluate(() => window.__tv.day1Match0);
    if (wireCandidatesAfterFirstLoad < 1) fail('expected at least one wire candidate after the hole-1 result loaded');
    if (match0AfterFirstLoad.holesA[0] !== 4 || match0AfterFirstLoad.holesB[0] !== 5) {
      fail(`expected hole 1 scores 4/5 after first load, got ${JSON.stringify(match0AfterFirstLoad.holesA[0])}/${JSON.stringify(match0AfterFirstLoad.holesB[0])}`);
    }
    if (match0AfterFirstLoad.holesA[1] != null || match0AfterFirstLoad.holesB[1] != null) {
      fail('expected hole 2 to be unplayed after first load');
    }

    // 2. A new row lands (hole 2, same match, Team A wins again).
    let t2 = 10;
    const row2 = (fields) => ({ tournament_id: 'wonga-cup-2026', updated_by: 'test', updated_at: `2026-08-07T00:01:${String(t2++).padStart(2, '0')}.000Z`, ...fields });
    dataset.push(row2({ update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: '4' }));
    dataset.push(row2({ update_type: 'day1_hole', match_idx: 0, field_key: 'B2', value: '5' }));

    await page.evaluate(() => window.__tv.refresh());
    await page.waitForTimeout(100);

    // 3. Exactly one more request, and it's incremental (starts from the
    // previous poll's cursor, not epoch again).
    if (requestCursors.length !== 2) fail(`expected exactly 2 requests total after the second poll, saw ${requestCursors.length}`);
    if (requestCursors[1] === '1970-01-01T00:00:00.000Z') fail('expected the second poll to use an incremental cursor, not re-fetch from epoch');
    if (requestCursors[1] !== cursorAfterFirstLoad) {
      fail(`expected the second poll's cursor (${requestCursors[1]}) to equal the first poll's last-seen updated_at (${cursorAfterFirstLoad})`);
    }

    // 4. The wire candidate count grew by exactly 1 (the new hole-2
    // event) -- the `gte` cursor re-returns the boundary row from the
    // first poll, which must be deduped rather than counted again.
    const wireCandidatesAfterSecondPoll = await page.evaluate(() => window.__tv.wireCandidateCount);
    if (wireCandidatesAfterSecondPoll !== wireCandidatesAfterFirstLoad + 1) {
      fail(`expected wire candidates to grow by exactly 1 (${wireCandidatesAfterFirstLoad} -> ${wireCandidatesAfterFirstLoad + 1}), got ${wireCandidatesAfterSecondPoll}`);
    }

    // 5. State reflects both holes now -- hole 1 untouched, hole 2 newly
    // applied. If the incremental fetch had re-applied the whole log
    // from epoch (or dropped the delta), one of these would be wrong.
    const match0AfterSecondPoll = await page.evaluate(() => window.__tv.day1Match0);
    if (match0AfterSecondPoll.holesA[0] !== 4 || match0AfterSecondPoll.holesB[0] !== 5) fail('expected hole 1 scores to still be 4/5 after the second poll');
    if (match0AfterSecondPoll.holesA[1] !== 4 || match0AfterSecondPoll.holesB[1] !== 5) fail('expected hole 2 scores to be 4/5 after the second poll picked up the new row');

    // 6. The rendered wire feed itself has no duplicate headline for the
    // same underlying row (a symptom double-counting the boundary row
    // would produce).
    const wireFeed = await page.evaluate(() => window.__tv.wireFeed.map((w) => w.headline));
    const uniqueHeadlines = new Set(wireFeed);
    if (uniqueHeadlines.size !== wireFeed.length) fail(`expected no duplicate wire headlines, got ${JSON.stringify(wireFeed)}`);

    if (pageErrors.length) fail(`expected zero page errors, saw: ${JSON.stringify(pageErrors)}`);

    console.log('All tv.html incremental-poll assertions passed.');
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
