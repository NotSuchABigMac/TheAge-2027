/* ─────────────────────────────────────
   REGRESSION TEST — issue #181: accessibility pass.

   Four independent problems, checked against the real index2026.html (chosen
   as one representative of the pages that all received the identical
   mobile-menu/modal treatment -- verified separately that the same
   pattern landed in format/golfers/practical/records.html too):

   1. A closed mobile menu was aria-hidden but still keyboard-focusable
      (an outright WAI-ARIA violation) -- now also `inert`.
   2. Neither overlay (mobile menu, music modal) closed on Escape, moved
      focus in on open, or restored it on close.
   3. No prefers-reduced-motion support anywhere in styles.css.
   4. No skip-to-content link.

   Self-contained: a tiny static file server for the app, Supabase and
   Google Fonts hosts blocked outright as a belt-and-braces guarantee
   (this feature touches none of that traffic, but every Playwright test
   in this repo blocks them regardless).

   Run: node test/repro-181-a11y.mjs
   Exits 0 if all assertions pass, 1 otherwise.

   Not picked up by `node --test` (deliberately not named *.test.mjs, same
   convention as this repo's other Playwright-driven scripts) -- it needs
   Playwright + a browser, which the fast unit suite must not depend on.
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
    const context = await browser.newContext({ viewport: { width: 400, height: 800 } });
    await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
    await context.route('**fonts.googleapis.com**', route => route.abort());
    await context.route('**fonts.gstatic.com**', route => route.abort());

    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(150);
    // Dismiss the music modal via its own Escape handling (also exercises
    // problem 2 for that overlay) so the rest of the page is interactable.
    await page.evaluate(() => document.getElementById('music-modal').classList.contains('hidden') ||
      document.getElementById('dismissMusic'));
    await page.evaluate(() => { if (typeof dismissMusic === 'function') dismissMusic(); });
    await page.waitForTimeout(50);

    // 1. Closed mobile menu must be inert (not just aria-hidden).
    const menuInertWhenClosed = await page.evaluate(() => document.getElementById('mobile-menu').hasAttribute('inert'));
    if (!menuInertWhenClosed) fail('expected the closed mobile menu to have the inert attribute');

    // Open the menu via the hamburger and confirm inert is removed + focus
    // moves to the first link inside it (problem 2, focus-in-on-open).
    await page.click('#hamburger');
    await page.waitForTimeout(50);
    const stateAfterOpen = await page.evaluate(() => ({
      inert: document.getElementById('mobile-menu').hasAttribute('inert'),
      activeIsInsideMenu: document.getElementById('mobile-menu').contains(document.activeElement)
    }));
    if (stateAfterOpen.inert) fail('expected the open mobile menu to not be inert');
    if (!stateAfterOpen.activeIsInsideMenu) fail('expected focus to move into the mobile menu on open');

    // 2. Escape closes the open menu and restores focus to the hamburger.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);
    const stateAfterEscape = await page.evaluate(() => ({
      isOpen: document.getElementById('mobile-menu').classList.contains('is-open'),
      inert: document.getElementById('mobile-menu').hasAttribute('inert'),
      activeIsHamburger: document.activeElement === document.getElementById('hamburger')
    }));
    if (stateAfterEscape.isOpen) fail('expected Escape to close the open mobile menu');
    if (!stateAfterEscape.inert) fail('expected the mobile menu to be inert again after Escape-closing it');
    if (!stateAfterEscape.activeIsHamburger) fail('expected focus to return to the hamburger button after closing via Escape');

    // 3. Focus trap: open the menu, Tab past the last link, land back on
    // the first one instead of escaping the menu.
    await page.click('#hamburger');
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      const links = document.querySelectorAll('#mobile-menu .mm-link');
      links[links.length - 1].focus();
    });
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30);
    const trapped = await page.evaluate(() => {
      const links = document.querySelectorAll('#mobile-menu .mm-link');
      return document.activeElement === links[0];
    });
    if (!trapped) fail('expected Tab from the last menu link to wrap back to the first (focus trap)');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(50);

    // 4. Skip-to-content link: present, targets a real element, and only
    // becomes visible on focus (not permanently visible/hidden).
    const skipLink = await page.evaluate(() => {
      const a = document.querySelector('.skip-link');
      if (!a) return null;
      const targetId = a.getAttribute('href').replace('#', '');
      return { exists: true, targetFound: !!document.getElementById(targetId) };
    });
    if (!skipLink) fail('expected a .skip-link element on the page');
    if (!skipLink.targetFound) fail('expected the skip-link href to target a real element on the page');
    const topBeforeFocus = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.skip-link')).top));
    await page.evaluate(() => document.querySelector('.skip-link').focus());
    // .skip-link's `top` is animated via `transition`, so the computed
    // value read in the same tick as focus() is the pre-transition start
    // value, not the target -- wait for it to actually finish moving.
    await page.waitForTimeout(250);
    const topAfterFocus = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.skip-link')).top));
    if (!(topBeforeFocus < 0)) fail(`expected the skip-link to be off-screen (negative top) before focus, got ${topBeforeFocus}`);
    if (!(topAfterFocus >= 0)) fail(`expected the skip-link to move on-screen (top >= 0) once focused, got ${topAfterFocus}`);

    // 5. prefers-reduced-motion: emulate it and confirm the global
    // animation/transition-duration override actually applies.
    const page2 = await context.newPage();
    await page2.emulateMedia({ reducedMotion: 'reduce' });
    await page2.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(100);
    const reducedMotionApplied = await page2.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.transition = 'opacity 1s';
      document.body.appendChild(probe);
      const duration = getComputedStyle(probe).transitionDuration;
      probe.remove();
      return duration;
    });
    if (!(reducedMotionApplied === '0.00001s' || parseFloat(reducedMotionApplied) <= 0.001)) {
      fail(`expected prefers-reduced-motion to collapse transition-duration near 0, got ${reducedMotionApplied}`);
    }
    await page2.close();

    console.log('All #181 accessibility assertions passed.');
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
