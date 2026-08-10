/* ─────────────────────────────────────
   REGRESSION TEST — issue #183: background music resilience.

   Two independent bugs, both because the 5 marketing pages (only
   scorecard-live.html was already careful) called `.play()` bare:

   1. Autoplay policy routinely rejects a gesture-less play() on a
      consented-return visit (a fresh page after navigating away and
      back) -- with no .catch(), that's an unhandled promise rejection
      and music that silently stops being part of the site.
   2. Each page's <audio> starts TheSong.mp3 from 0:00, so navigating
      means hearing the same opening bars forever.

   This test drives the real index2026.html (chosen as one representative of
   the five pages that all received the identical fix -- verified
   separately that the same block landed in format/golfers/practical/
   records.html too) via a local static server, stubbing
   HTMLMediaElement.prototype.play so play() rejection is deterministic
   without depending on real audio decoding in a headless/sandboxed
   browser. Never touches Supabase or Google Fonts.

   Run: node test/repro-183-music-resilience.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs,
   same convention as this repo's other Playwright-driven scripts) -- it
   needs Playwright + a browser, which the fast unit suite must not
   depend on.
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
        const filePath = path.join(ROOT, urlPath === '/' ? '/index2026.html' : urlPath);
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
  const baseUrl = `http://127.0.0.1:${sitePort}/index2026.html`;

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

    // 1. A rejected play() on a consented-return visit must not surface as
    // an unhandled rejection, and must re-show the consent modal instead
    // of leaving music silently dead.
    {
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.message));
      await page.addInitScript(() => {
        sessionStorage.setItem('musicConsented', '1');
        HTMLMediaElement.prototype.play = function () {
          return Promise.reject(new Error('NotAllowedError (simulated autoplay rejection)'));
        };
      });
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const modalHidden = await page.evaluate(() => document.getElementById('music-modal').classList.contains('hidden'));
      if (modalHidden) fail('expected the music modal to reappear after a rejected play(), it stayed hidden');
      if (pageErrors.length) fail(`expected the play() rejection to be caught, saw page error(s): ${JSON.stringify(pageErrors)}`);
      await page.close();
    }

    // 2. A rejected play() must NOT reappear the modal on a first-ever
    // visit's explicit consent click -- only the resilience path (silent
    // .catch(() => {}) in startMusic()) is exercised there; this just
    // confirms startMusic() itself never throws/unhandled-rejects either.
    {
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', e => pageErrors.push(e.message));
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = function () {
          return Promise.reject(new Error('NotAllowedError (simulated autoplay rejection)'));
        };
      });
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => startMusic());
      await page.waitForTimeout(100);
      if (pageErrors.length) fail(`expected startMusic()'s play() rejection to be caught, saw page error(s): ${JSON.stringify(pageErrors)}`);
      await page.close();
    }

    // 3. Playback position persistence: pagehide persists currentTime,
    // and seekToSavedMusicTime() applies a saved position once metadata
    // is available (using a stub object so this doesn't depend on the
    // real TheSong.mp3 file actually decoding in this sandbox).
    {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      await page.evaluate(() => {
        Object.defineProperty(document.getElementById('bg-audio'), 'paused', { value: false, configurable: true });
        Object.defineProperty(document.getElementById('bg-audio'), 'currentTime', { value: 42.5, configurable: true });
      });
      await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const saved = await page.evaluate(() => sessionStorage.getItem('musicTime'));
      if (saved !== '42.5') fail(`expected pagehide to persist currentTime=42.5 to sessionStorage, got ${saved}`);

      const seekResult = await page.evaluate(() => new Promise((resolve) => {
        sessionStorage.setItem('musicTime', '17.3');
        const fakeAudio = {
          readyState: 0,
          currentTime: 0,
          _listeners: {},
          addEventListener(name, fn) { this._listeners[name] = fn; }
        };
        seekToSavedMusicTime(fakeAudio);
        // readyState 0 (metadata not loaded yet) -- must defer via the
        // 'loadedmetadata' listener rather than setting currentTime blind.
        if (fakeAudio.currentTime !== 0) return resolve({ error: 'seeked before metadata was ready' });
        fakeAudio._listeners.loadedmetadata();
        resolve({ currentTime: fakeAudio.currentTime });
      }));
      if (seekResult.error) fail(seekResult.error);
      if (seekResult.currentTime !== 17.3) fail(`expected seekToSavedMusicTime to apply the saved position once metadata is ready, got ${JSON.stringify(seekResult)}`);

      await page.close();
    }

    console.log('All #183 music-resilience assertions passed.');
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
