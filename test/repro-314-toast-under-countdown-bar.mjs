/* ─────────────────────────────────────
   REGRESSION TEST — toasts rendering underneath the countdown bar.

   Reported: event/wire toasts looked "really small and off the bottom of
   the screen". Root cause: #countdown-bar is position:fixed at the very
   bottom of the viewport with z-index:990, while the toast stack
   (.save-toast/.undo-toast/.update-toast/.confirm-toast/.wire-toast) sits
   only `24px + env(safe-area-inset-bottom) + ...` above the viewport
   bottom at z-index:100 -- squarely inside the bar's own footprint. Any
   time the countdown bar is visible (i.e. before tee-off), a toast at
   that base offset renders mostly *underneath* the bar, with only a
   sliver poking out above it.

   Fix: a new --toast-bar-inset CSS var (same pattern as the existing
   --toast-keyboard-inset), kept live by updateCountdown() to match the
   bar's actual rendered height, added into the toast stack's bottom
   offset.

   This drives the real countdown bar and a real toast (wire-toast, via
   showWireToast()) and checks the toast's bounding box clears the bar's
   top edge -- i.e. no overlap -- both with the bar showing and (as a
   sanity check) after it's hidden.

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-314-toast-under-countdown-bar.mjs
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

    // ── With the countdown bar visible (tee-off in the future), a
    // real toast must not overlap it. ──
    {
      const state = await page.evaluate(() => {
        const bar = document.getElementById('countdown-bar');
        bar.style.display = ''; // ensure visible regardless of wall-clock date
        updateCountdown();
        showWireToast('Test headline for repro-314');
        const barRect = bar.getBoundingClientRect();
        const toastRect = document.getElementById('wire-toast').getBoundingClientRect();
        return { barTop: barRect.top, toastBottom: toastRect.bottom, toastTop: toastRect.top, toastShown: document.getElementById('wire-toast').classList.contains('show') };
      });
      if (!state.toastShown) fail('expected wire-toast to be showing');
      if (state.toastBottom > state.barTop) {
        fail(`expected the toast to clear the countdown bar's top edge (bar top=${state.barTop}, toast bottom=${state.toastBottom}) -- toast is rendering underneath the bar`);
      }
      await page.evaluate(() => toastDismiss('wire-toast'));
    }

    // ── Sanity check: once the bar is hidden, the inset var relaxes
    // back to 0 and doesn't leave the toast stranded high up. ──
    {
      const state = await page.evaluate(() => {
        const bar = document.getElementById('countdown-bar');
        bar.style.display = 'none';
        document.documentElement.style.setProperty('--toast-bar-inset', '0px');
        showWireToast('Bar hidden now');
        const toastRect = document.getElementById('wire-toast').getBoundingClientRect();
        const insetVar = getComputedStyle(document.documentElement).getPropertyValue('--toast-bar-inset').trim();
        return { toastBottomFromViewport: window.innerHeight - toastRect.bottom, insetVar };
      });
      if (state.insetVar !== '0px') fail(`expected --toast-bar-inset to relax to 0px once the bar is hidden, got "${state.insetVar}"`);
      if (state.toastBottomFromViewport > 100) fail(`expected the toast back near its base 24px offset once the bar is gone, got ${state.toastBottomFromViewport}px from the bottom`);
      await page.evaluate(() => toastDismiss('wire-toast'));
    }

    console.log('All toast/countdown-bar overlap assertions passed.');
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
