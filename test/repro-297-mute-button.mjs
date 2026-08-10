/* ─────────────────────────────────────
   REGRESSION TEST — issue #297: persistent mute/unmute button + the
   music consent popup only firing on the homepage.

   Two behaviors, both added to site.js (shared by every marketing page):

   1. A mute/unmute button is injected into `.masthead-right` on any page
      that has both `#bg-audio` and that masthead slot -- independent of
      the initial consent modal, so a visitor can silence/resume the
      track at any time without leaving the site.
   2. The "⚠ WARNING -- appropriate music" consent modal now only ever
      shows itself on the homepage (index2026.html). A deep-linked/shared
      link straight to an inner page (golfers.html here) silently
      respects the existing `musicConsented` session state instead of
      re-prompting -- including when a consented-return `play()` gets
      rejected, which used to reopen the modal on every page.

   Drives real index2026.html/golfers.html via a local static server, same
   pattern as repro-183. Never touches Supabase or Google Fonts.

   Run: node test/repro-297-mute-button.mjs
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
  const homeUrl = `http://127.0.0.1:${sitePort}/index2026.html`;
  const innerUrl = `http://127.0.0.1:${sitePort}/golfers.html`;

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

    // 1. A deep-linked inner page with no prior consent must NOT show the
    // consent modal -- only the homepage does.
    {
      const page = await context.newPage();
      await page.goto(innerUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const modalHidden = await page.evaluate(() => document.getElementById('music-modal').classList.contains('hidden'));
      if (!modalHidden) fail('expected the consent modal to stay hidden on a deep-linked inner page with no prior consent');
      await page.close();
    }

    // 2. The homepage itself still shows the modal on a first-ever visit
    // (unchanged from #183/#27 behavior).
    {
      const page = await context.newPage();
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const modalHidden = await page.evaluate(() => document.getElementById('music-modal').classList.contains('hidden'));
      if (modalHidden) fail('expected the consent modal to show on the homepage with no prior consent');
      await page.close();
    }

    // 3. A rejected play() on a consented-return visit to an inner page
    // must NOT reopen the consent modal there (silent, mute-button-only
    // recovery) -- contrast with repro-183's assertion that the same
    // rejection DOES reopen it on the homepage.
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
      await page.goto(innerUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const modalHidden = await page.evaluate(() => document.getElementById('music-modal').classList.contains('hidden'));
      if (!modalHidden) fail('expected the consent modal to stay hidden on an inner page even after a rejected play()');
      if (pageErrors.length) fail(`expected the play() rejection to be caught, saw page error(s): ${JSON.stringify(pageErrors)}`);
      await page.close();
    }

    // 4. The mute button: present, reflects real playback state, and
    // toggling it actually pauses/resumes #bg-audio and persists
    // musicMuted so a later navigation won't silently resume playback.
    {
      const page = await context.newPage();
      await page.addInitScript(() => {
        sessionStorage.setItem('musicConsented', '1');
        // Stub play()/pause() so this doesn't depend on real audio
        // decoding in a headless/sandboxed browser -- mirrors repro-183's
        // approach for the seek assertions.
        HTMLMediaElement.prototype.play = function () {
          Object.defineProperty(this, 'paused', { value: false, configurable: true });
          this.dispatchEvent(new Event('play'));
          return Promise.resolve();
        };
        HTMLMediaElement.prototype.pause = function () {
          Object.defineProperty(this, 'paused', { value: true, configurable: true });
          this.dispatchEvent(new Event('pause'));
        };
      });
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);

      const btn = page.locator('.music-toggle');
      if (await btn.count() !== 1) fail(`expected exactly one .music-toggle button in the masthead, found ${await btn.count()}`);

      const initialLabel = await btn.getAttribute('aria-label');
      if (initialLabel !== 'Mute music') fail(`expected the button to read "Mute music" while audio is playing, got ${JSON.stringify(initialLabel)}`);

      await btn.click();
      await page.waitForTimeout(50);
      const mutedLabel = await btn.getAttribute('aria-label');
      const pausedAfterClick = await page.evaluate(() => document.getElementById('bg-audio').paused);
      const musicMuted = await page.evaluate(() => sessionStorage.getItem('musicMuted'));
      if (mutedLabel !== 'Unmute music') fail(`expected the button to read "Unmute music" after muting, got ${JSON.stringify(mutedLabel)}`);
      if (!pausedAfterClick) fail('expected #bg-audio to be paused after clicking the mute button');
      if (musicMuted !== '1') fail(`expected musicMuted to persist to sessionStorage as '1', got ${JSON.stringify(musicMuted)}`);

      await btn.click();
      await page.waitForTimeout(50);
      const resumedLabel = await btn.getAttribute('aria-label');
      const pausedAfterSecondClick = await page.evaluate(() => document.getElementById('bg-audio').paused);
      const musicMutedAfterResume = await page.evaluate(() => sessionStorage.getItem('musicMuted'));
      if (resumedLabel !== 'Mute music') fail(`expected the button to read "Mute music" after unmuting, got ${JSON.stringify(resumedLabel)}`);
      if (pausedAfterSecondClick) fail('expected #bg-audio to be playing again after clicking unmute');
      if (musicMutedAfterResume) fail(`expected musicMuted to be cleared after unmuting, got ${JSON.stringify(musicMutedAfterResume)}`);

      await page.close();
    }

    // 5. Clicking "unmute" before any consent has ever been given counts
    // as the explicit gesture the modal would otherwise have collected --
    // it grants consent and starts playback, without needing the modal.
    {
      const page = await context.newPage();
      await page.addInitScript(() => {
        HTMLMediaElement.prototype.play = function () {
          Object.defineProperty(this, 'paused', { value: false, configurable: true });
          this.dispatchEvent(new Event('play'));
          return Promise.resolve();
        };
      });
      await page.goto(innerUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      const btn = page.locator('.music-toggle');
      const beforeLabel = await btn.getAttribute('aria-label');
      if (beforeLabel !== 'Unmute music') fail(`expected the button to start as "Unmute music" with no prior consent, got ${JSON.stringify(beforeLabel)}`);
      await btn.click();
      await page.waitForTimeout(50);
      const consented = await page.evaluate(() => sessionStorage.getItem('musicConsented'));
      const playing = await page.evaluate(() => !document.getElementById('bg-audio').paused);
      if (consented !== '1') fail(`expected clicking unmute with no prior consent to set musicConsented='1', got ${JSON.stringify(consented)}`);
      if (!playing) fail('expected clicking unmute with no prior consent to start playback');
      await page.close();
    }

    console.log('All #297 mute-button assertions passed.');
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
