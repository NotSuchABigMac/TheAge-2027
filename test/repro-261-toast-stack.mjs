/* ─────────────────────────────────────
   REGRESSION TEST — issue #261: single queued/prioritized toast manager.

   Before this fix, save-toast/undo-toast/update-toast/confirm-toast were
   4 independent singletons, each with its own fixed screen corner and no
   cap -- two showing at once could crowd/overlap, and a raw bottom:24px
   could land under the on-screen keyboard once the visual viewport
   shrank. This checks the new queue/stack manager two ways:

     Part A drives requestToastSlot()/releaseToastSlot() directly with
     synthetic ids (bypassing real toast DOM/content entirely) to pin the
     algorithm itself: a full stack queues arrivals, an input-tier arrival
     jumps ahead of an already-*queued* info-tier one, but an item
     already SHOWING is never preempted or reordered, and a freed slot
     promotes the highest-priority queued item.

     Part B drives the real UI end-to-end: save-toast (an indefinite
     'saving' toast), undo-toast (via a real setHoleScore() hole entry),
     and confirm-toast (via a real NTP-overwrite confirm) all showing at
     once -- proving the cap (3) comfortably covers that routine
     concurrent case -- each with a distinct --toast-offset (stacked, not
     overlapping); a 4th toast (update-toast) queues instead of showing
     while the stack is full, then gets promoted once a slot frees.

     Part C confirms the on-screen-keyboard fix: forcing a smaller
     visualViewport height and re-running updateToastKeyboardInset()
     measurably pushes a visible toast further from the bottom edge.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-261-toast-stack.mjs
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

    const page = await context.newPage();
    await page.goto(`${base}?demo=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(200);
    await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
    await page.evaluate(() => {
      currentUsername = 'James McIntyre';
      currentWriteToken = 'test-token';
    });

    // ── Part A: the queue algorithm itself, via synthetic ids ──
    {
      const result = await page.evaluate(() => {
        const log = [];
        TOAST_TIER['t-info-1'] = 'info';
        TOAST_TIER['t-input-1'] = 'input';
        TOAST_TIER['t-input-2'] = 'input';
        TOAST_TIER['t-info-2'] = 'info';
        TOAST_TIER['t-input-3'] = 'input';

        // Fill the cap (3) -- all three grant a slot immediately.
        requestToastSlot('t-info-1', () => log.push('show:t-info-1'));
        requestToastSlot('t-input-1', () => log.push('show:t-input-1'));
        requestToastSlot('t-input-2', () => log.push('show:t-input-2'));
        const visibleAfterFill = visibleToastIds.slice();

        // Stack is full -- these two queue. t-info-2 arrives first; when
        // t-input-3 arrives it must jump ahead of the already-queued
        // info-tier entry, without touching anything already showing.
        requestToastSlot('t-info-2', () => log.push('show:t-info-2'));
        requestToastSlot('t-input-3', () => log.push('show:t-input-3'));
        const queueOrder = toastQueue.map(e => e.id);

        // Free one slot -- the highest-priority queued item (t-input-3)
        // should take it, not t-info-2 which arrived first.
        releaseToastSlot('t-info-1');
        const afterFirstRelease = { log: log.slice(), visible: visibleToastIds.slice(), queue: toastQueue.map(e => e.id) };

        releaseToastSlot('t-input-1');
        releaseToastSlot('t-input-2');
        const afterAllReleased = { log: log.slice(), visible: visibleToastIds.slice(), queue: toastQueue.map(e => e.id) };

        // Cleanup: release the rest so this doesn't leak into Part B/C.
        releaseToastSlot('t-input-3');
        releaseToastSlot('t-info-2');

        return { visibleAfterFill, queueOrder, afterFirstRelease, afterAllReleased };
      });

      if (result.visibleAfterFill.length !== 3) fail(`expected all 3 immediate arrivals to fill the cap, got ${JSON.stringify(result.visibleAfterFill)}`);
      if (result.queueOrder.length !== 2 || result.queueOrder[0] !== 't-input-3' || result.queueOrder[1] !== 't-info-2') {
        fail(`expected the input-tier arrival to jump ahead of the already-queued info-tier one, got queue order ${JSON.stringify(result.queueOrder)}`);
      }
      if (!result.afterFirstRelease.log.includes('show:t-input-3')) fail('expected the freed slot to promote the highest-priority queued item (t-input-3)');
      if (result.afterFirstRelease.log.includes('show:t-info-2')) fail('expected t-info-2 to still be waiting after only one slot freed');
      if (!result.afterFirstRelease.visible.includes('t-input-1') || !result.afterFirstRelease.visible.includes('t-input-2')) {
        fail(`expected the still-showing toasts to be untouched by the promotion, got ${JSON.stringify(result.afterFirstRelease.visible)}`);
      }
      if (!result.afterAllReleased.log.includes('show:t-info-2')) fail('expected t-info-2 to finally be promoted once enough slots freed');
      if (result.afterAllReleased.queue.length !== 0) fail(`expected the queue to be empty once everything was promoted, got ${JSON.stringify(result.afterAllReleased.queue)}`);
    }

    // ── Part B: real save/undo/confirm toasts stacking at once, and a
    // 4th (update) queuing behind a full stack, then promoting. ──
    {
      // save-toast: 'saving' never auto-dismisses, so it occupies a slot
      // indefinitely until replaced -- a real, common "long-lived" toast.
      await page.evaluate(() => showSaveToast('Saving…', 'saving'));

      // undo-toast: via the real Day 1 hole-entry path (issue #198).
      await page.click('.sc-tab[onclick*="day1"]').catch(() => {});
      await page.evaluate(() => setHoleScore(0, 'A', 1, 4));

      // confirm-toast: via a real NTP overwrite (issue #199) -- first
      // pick commits immediately, second pick on the same hole confirms.
      await page.selectOption('#ntp-day1-h8', '0').catch(() => {});
      await page.selectOption('#ntp-day1-h8', '1').catch(() => {});

      const stacked = await page.evaluate(() => ({
        saveShown: document.getElementById('save-toast').classList.contains('show'),
        undoShown: document.getElementById('undo-toast').classList.contains('show'),
        confirmShown: document.getElementById('confirm-toast').classList.contains('show'),
        offsets: [
          document.getElementById('save-toast').style.getPropertyValue('--toast-offset'),
          document.getElementById('undo-toast').style.getPropertyValue('--toast-offset'),
          document.getElementById('confirm-toast').style.getPropertyValue('--toast-offset')
        ],
        visibleCount: visibleToastIds.length
      }));
      if (!stacked.saveShown || !stacked.undoShown || !stacked.confirmShown) {
        fail(`expected save-toast, undo-toast, and confirm-toast all showing at once (cap 3), got ${JSON.stringify(stacked)}`);
      }
      if (stacked.visibleCount !== 3) fail(`expected exactly 3 visible toasts at the cap, got ${stacked.visibleCount}`);
      const uniqueOffsets = new Set(stacked.offsets);
      if (uniqueOffsets.size !== 3) fail(`expected 3 distinct --toast-offset values (stacked, not overlapping), got ${JSON.stringify(stacked.offsets)}`);

      // A 4th toast (update-toast, input tier) while the stack is full ->
      // must queue, not show, and must not preempt anything already shown.
      await page.evaluate(() => {
        updateAvailable = true;
        pendingWrites.length = 0;
        document.activeElement?.blur?.();
        maybeShowUpdateToast();
      });
      const queued = await page.evaluate(() => ({
        updateShown: document.getElementById('update-toast').classList.contains('show'),
        queueIds: toastQueue.map(e => e.id),
        saveStillShown: document.getElementById('save-toast').classList.contains('show')
      }));
      if (queued.updateShown) fail('expected update-toast to queue (not show) while the stack is already at its cap');
      if (!queued.queueIds.includes('update-toast')) fail(`expected update-toast in the queue, got ${JSON.stringify(queued.queueIds)}`);
      if (!queued.saveStillShown) fail('expected the already-showing save-toast to be untouched by the queued arrival');

      // Freeing a slot (dismissing the undo toast) promotes update-toast.
      await page.evaluate(() => dismissUndoToast());
      const promoted = await page.evaluate(() => ({
        updateShown: document.getElementById('update-toast').classList.contains('show'),
        undoShown: document.getElementById('undo-toast').classList.contains('show')
      }));
      if (promoted.undoShown) fail('expected undo-toast to actually be gone after dismissUndoToast()');
      if (!promoted.updateShown) fail('expected update-toast to be promoted into the freed slot');

      // Cleanup for Part C.
      await page.evaluate(() => {
        toastDismiss('save-toast');
        toastDismiss('confirm-toast');
        toastDismiss('update-toast');
        pendingNtpConfirm = null;
      });
    }

    // ── Part C: on-screen-keyboard awareness. ──
    {
      await page.evaluate(() => showSaveToast('Saving…', 'saving'));
      const before = await page.evaluate(() => document.getElementById('save-toast').getBoundingClientRect().bottom);

      await page.evaluate(() => {
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: { height: window.innerHeight - 300, offsetTop: 0, addEventListener() {}, removeEventListener() {} }
        });
        updateToastKeyboardInset();
      });
      await page.waitForTimeout(50);

      const insetVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--toast-keyboard-inset').trim());
      if (insetVar !== '300px') fail(`expected --toast-keyboard-inset to reflect the shrunk visualViewport, got "${insetVar}"`);

      const after = await page.evaluate(() => document.getElementById('save-toast').getBoundingClientRect().bottom);
      const shiftUp = before - after;
      if (shiftUp < 250) fail(`expected the visible toast to move well clear of the simulated keyboard (~300px), moved only ${shiftUp}px`);

      await page.evaluate(() => toastDismiss('save-toast'));
    }

    console.log('All #261 toast-stack assertions passed.');
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
