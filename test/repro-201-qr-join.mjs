/* ─────────────────────────────────────
   REGRESSION TEST — issue #201: QR-code login handoff.

   Nobody should have to type (or read aloud) the tournament PIN on the
   first tee. The Admin tab's "Share Access" control renders a QR + link
   encoding "#join=<token>" (the shared write token only -- never the
   organiser's own name, since the scanning device still has to type its
   own attribution identity). Loading a link with that hash should prefill
   the PIN field and strip the fragment from the URL immediately.

   Covers:
     - the Admin ("James McIntyre") tab renders a QR <svg> plus a join
       link containing the current write token, once logged in
     - a non-admin never sees a rendered QR/link (Admin tab is gated the
       same way the rest of it already is)
     - loading the page with "#join=<token>" in the URL: prefills
       write-token-input, strips the hash via replaceState, and opens the
       username modal automatically (scan -> pick name -> scoring)
     - a stale/wrong scanned token still lands in the pre-existing #141
       "auth" handling (modal reopens with the Wrong PIN error) rather
       than needing its own error path

   Self-contained: a tiny static file server for the app; Supabase and
   Google Fonts hosts blocked outright.

   Run: node test/repro-201-qr-join.mjs
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


async function main() {
  const site = await startStaticServer();
  const sitePort = site.address().port;
  const baseUrl = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

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

    // 1. Admin sees a rendered QR + join link containing the write token.
    {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        currentUsername = 'James McIntyre';
        currentWriteToken = 'sekrit-pin-123';
        sessionStorage.setItem('wongaCup_username', currentUsername);
        sessionStorage.setItem('wongaCup_writeToken', currentWriteToken);
        updateAdminVisibility();
      });
      const { svg, link } = await page.evaluate(() => ({
        svg: document.querySelector('#share-access-qr svg') ? document.querySelector('#share-access-qr svg').outerHTML : null,
        link: document.getElementById('share-access-link').value
      }));
      if (!svg) fail('expected an <svg> QR code to be rendered for the admin');
      if (!link.includes('#join=sekrit-pin-123')) fail(`expected the join link to encode the write token, got "${link}"`);
      await page.close();
    }

    // 2. A non-admin never sees a rendered QR or link.
    {
      const page = await context.newPage();
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        currentUsername = 'Gary King';
        currentWriteToken = 'sekrit-pin-123';
        updateAdminVisibility();
      });
      const { svg, link } = await page.evaluate(() => ({
        svg: document.querySelector('#share-access-qr svg'),
        link: document.getElementById('share-access-link').value
      }));
      if (svg) fail('expected no QR code to render for a non-admin');
      if (link) fail(`expected no join link for a non-admin, got "${link}"`);
      await page.close();
    }

    // 3. Loading a "#join=<token>" link prefills the PIN, strips the hash,
    // and opens the sign-in modal.
    {
      const page = await context.newPage();
      await page.goto(`${baseUrl}#join=scanned-token-456`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.waitForTimeout(100);
      const state = await page.evaluate(() => ({
        tokenValue: document.getElementById('write-token-input').value,
        hash: location.hash,
        modalOpen: !document.getElementById('username-modal').classList.contains('hidden')
      }));
      if (state.tokenValue !== 'scanned-token-456') fail(`expected the PIN field to be prefilled from the join link, got "${state.tokenValue}"`);
      if (state.hash !== '') fail(`expected the #join= fragment to be stripped from the URL, got "${state.hash}"`);
      if (!state.modalOpen) fail('expected a scanned join link to open the sign-in modal automatically');
      await page.close();
    }

    // 4. A stale/wrong scanned token still lands in the existing #141
    // "auth" handling once actually used to write, rather than needing a
    // new error path of its own.
    {
      const page = await context.newPage();
      await page.goto(`${baseUrl}#join=stale-token`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(200);
      await page.evaluate(() => document.getElementById('music-modal')?.classList.add('hidden'));
      await page.evaluate(() => {
        document.getElementById('username-input').value = 'Gary King';
        // sendUpdateRow itself is exercised by the existing #141 coverage;
        // here we only need to confirm insertUpdate()'s 'auth' branch --
        // the one a scanned bad token actually funnels through -- still
        // reopens the modal with the same error, unchanged by #201.
        confirmUsername();
        sendUpdateRow = async () => 'auth';
      });
      await page.evaluate(() => insertUpdate('day1', {}));
      await page.waitForTimeout(50);
      const state = await page.evaluate(() => ({
        modalOpen: !document.getElementById('username-modal').classList.contains('hidden'),
        errorText: document.getElementById('username-error').textContent
      }));
      if (!state.modalOpen) fail('expected a rejected scanned token to reopen the sign-in modal');
      if (!/Wrong PIN/i.test(state.errorText)) fail(`expected a "Wrong PIN" error, got "${state.errorText}"`);
      await page.close();
    }

    console.log('All #201 QR-code login handoff assertions passed.');
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
