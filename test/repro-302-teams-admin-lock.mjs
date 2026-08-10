/* ─────────────────────────────────────
   REGRESSION TEST — issue #302: move team editing into the Admin panel
   (unlocked there, since only an admin who already cleared the PIN gate
   can reach the tab at all) and add an explicit "Lock Teams" toggle that
   warns before unlocking.

   Drives the real scorecard-live.html against a mocked (never real)
   Supabase and checks:

     - the standalone "Teams" tab/panel is gone entirely
     - Team Setup (names + assignment) now renders inside the Admin tab,
       already editable (no "organiser-only" notice, no dimmed overlay)
       for a signed-in admin
     - "Lock Teams" toggles a locked badge and dims/disables the editing
       controls (.locked-for-viewer)
     - clicking "Unlock Teams" while locked prompts a confirmation; a
       decline leaves it locked, an accept unlocks it

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright; the real Supabase host is mocked, never hit for real.

   Run: node test/repro-302-teams-admin-lock.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs) --
   it needs Playwright + a browser.
───────────────────────────────────── */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


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

    const page = await context.newPage();
    await page.route('**wtyyarvyscbrrkawjcvo**/rest/v1/tournament_updates**', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**wtyyarvyscbrrkawjcvo**', (route) => {
      if (route.request().url().includes('/tournament_updates')) { route.fallback(); return; }
      route.abort();
    });

    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    // Sign in as one of ADMIN_NAMES and pre-fill the cached admin PIN
    // (same shortcut repro-186 uses for currentUsername/currentWriteToken)
    // so activateTab()'s PIN gate doesn't need a real prompt() dialog.
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
      currentAdminToken = 'test-admin-pin';
      updateAdminVisibility();
    });
    await page.waitForTimeout(600); // let the initial poll/replay land

    // 1. The standalone Teams tab/panel no longer exists.
    const teamsGone = await page.evaluate(() => ({
      tab: document.getElementById('tab-teams'),
      panel: document.getElementById('sc-teams')
    }));
    if (teamsGone.tab !== null) fail('expected #tab-teams to be removed');
    if (teamsGone.panel !== null) fail('expected #sc-teams to be removed');

    // 2. Team Setup now lives inside the Admin tab, already editable.
    await page.click('#tab-admin');
    await page.waitForTimeout(200);
    const adminState = await page.evaluate(() => {
      const editable = document.getElementById('teams-editable');
      return {
        adminPanelActive: document.getElementById('sc-admin').classList.contains('active'),
        editablePresent: !!editable,
        lockedForViewer: editable ? editable.classList.contains('locked-for-viewer') : null,
        noticeGone: document.getElementById('teams-locked-notice') === null,
        tnInputDisabled: document.getElementById('tn-input-a')?.disabled
      };
    });
    if (!adminState.adminPanelActive) fail('expected the Admin tab to activate for a signed-in admin with a cached PIN');
    if (!adminState.editablePresent) fail('expected #teams-editable (Team Setup) to render inside the Admin panel');
    if (adminState.lockedForViewer) fail('expected Team Setup to start unlocked (not dimmed) for an admin');
    if (!adminState.noticeGone) fail('expected the old "organiser-only" notice element to be gone entirely');
    if (adminState.tnInputDisabled) fail('expected the team name input to be enabled once initial sync settled');

    // 3. "Lock Teams" locks the panel (dims it) and flips the button.
    await page.click('#teams-lock-row button');
    await page.waitForTimeout(100);
    const afterLock = await page.evaluate(() => ({
      lockedForViewer: document.getElementById('teams-editable').classList.contains('locked-for-viewer'),
      rowText: document.getElementById('teams-lock-row').textContent,
      stateLocked: state.teamsLocked
    }));
    if (!afterLock.lockedForViewer) fail('expected Team Setup to dim once locked');
    if (!/Unlock Teams/.test(afterLock.rowText)) fail(`expected an "Unlock Teams" button once locked, got "${afterLock.rowText}"`);
    if (afterLock.stateLocked !== true) fail('expected state.teamsLocked to be true after locking');

    // 4. Declining the unlock confirmation leaves it locked.
    await page.evaluate(() => { window.confirm = () => false; });
    await page.click('#teams-lock-row button');
    await page.waitForTimeout(100);
    const afterDecline = await page.evaluate(() => ({
      lockedForViewer: document.getElementById('teams-editable').classList.contains('locked-for-viewer'),
      stateLocked: state.teamsLocked
    }));
    if (!afterDecline.lockedForViewer) fail('expected declining the unlock confirmation to leave Team Setup locked');
    if (afterDecline.stateLocked !== true) fail('expected state.teamsLocked to remain true after declining unlock');

    // 5. Accepting the unlock confirmation unlocks it.
    await page.evaluate(() => { window.confirm = () => true; });
    await page.click('#teams-lock-row button');
    await page.waitForTimeout(100);
    const afterAccept = await page.evaluate(() => ({
      lockedForViewer: document.getElementById('teams-editable').classList.contains('locked-for-viewer'),
      rowText: document.getElementById('teams-lock-row').textContent,
      stateLocked: state.teamsLocked
    }));
    if (afterAccept.lockedForViewer) fail('expected accepting the unlock confirmation to un-dim Team Setup');
    if (!/^Lock Teams/.test(afterAccept.rowText.trim())) fail(`expected a "Lock Teams" button again once unlocked, got "${afterAccept.rowText}"`);
    if (afterAccept.stateLocked !== false) fail('expected state.teamsLocked to be false after accepting unlock');

    console.log('All #302 Teams-in-Admin / Lock Teams assertions passed.');
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
