/* ─────────────────────────────────────
   REGRESSION TEST — photo album QR code + link.

   A QR code (encoding the Wonga Cup Google Photos album,
   https://photos.app.goo.gl/DG13eR5Fbmyb2P9i8) was added to the bottom
   corner of the Clubhouse TV page (tv.html), and a plain link to the same
   album was added to the bottom of the main site (index2026.html's footer).

   Checks:
     1. tv.html renders a fixed-position corner element linking to the
        photos URL, containing the QR image (images/photos-qr.png).
     2. index2026.html's footer colophon has a link to the same photos URL.

   Self-contained: a tiny static file server for the app; Google Fonts
   blocked outright (no other network dependency on either page for this
   assertion).

   Run: node test/repro-photos-qr-link.mjs
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
const PHOTOS_URL = 'https://photos.app.goo.gl/DG13eR5Fbmyb2P9i8';


const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript', '.png': 'image/png' };

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


async function testTvPageQrCorner(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
  const page = await context.newPage();

  const site = global.__wongaSite;
  await page.goto(`http://127.0.0.1:${site.port}/tv.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const info = await page.evaluate(() => {
    const link = document.querySelector('.tv-photos-qr');
    if (!link) return null;
    const img = link.querySelector('img');
    const style = getComputedStyle(link);
    return {
      href: link.getAttribute('href'),
      imgSrc: img ? img.getAttribute('src') : null,
      position: style.position
    };
  });
  if (!info) fail('expected a .tv-photos-qr element on tv.html');
  if (info.href !== PHOTOS_URL) fail(`expected the QR corner link to point at "${PHOTOS_URL}", got "${info.href}"`);
  if (!/photos-qr\.png/.test(info.imgSrc || '')) fail(`expected the QR corner img to load images/photos-qr.png, got "${info.imgSrc}"`);
  if (info.position !== 'fixed') fail(`expected the QR corner to be fixed-positioned (stays in the corner during rotation), got position:${info.position}`);

  const imgResponse = await page.evaluate(async () => {
    const img = document.querySelector('.tv-photos-qr img');
    return { naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  });
  if (!imgResponse.naturalWidth || !imgResponse.naturalHeight) fail('expected the QR image to actually load (non-zero natural dimensions)');

  await context.close();
  console.log('tv.html QR corner assertions passed.');
}

async function testIndexFooterLink(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  const page = await context.newPage();

  const site = global.__wongaSite;
  await page.goto(`http://127.0.0.1:${site.port}/index2026.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  const href = await page.evaluate((url) => {
    const link = Array.from(document.querySelectorAll('.foot .colophon a')).find(a => a.getAttribute('href') === url);
    return link ? link.getAttribute('href') : null;
  }, PHOTOS_URL);
  if (href !== PHOTOS_URL) fail(`expected index2026.html's footer colophon to link to "${PHOTOS_URL}", got "${href}"`);

  await context.close();
  console.log('index2026.html footer link assertions passed.');
}

async function main() {
  const site = await startStaticServer();
  global.__wongaSite = { port: site.address().port };

  const chromium = await loadChromium();
  const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) launchOpts.executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const browser = await chromium.launch(launchOpts);
  let ok = true;
  try {
    await testTvPageQrCorner(browser);
    await testIndexFooterLink(browser);
    console.log('All photos-qr-link assertions passed.');
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
