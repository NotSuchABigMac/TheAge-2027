/* ─────────────────────────────────────
   REGRESSION TEST — the A.G.E. 2027 "coming soon" homepage that replaced
   the old index.html once the 2026 Wonga Cup wrapped.

   Covers the three UI-visible pieces that are actually alive on the
   page (as opposed to the static stained-glass SVG dial, which has
   nothing to regress against):

   1. The live countdown (#cd-days/#cd-hours/#cd-mins/#cd-secs) actually
      ticks -- it isn't a static placeholder.
   2. The decorative "rune cipher" readouts (#sig-hex/#sig-bin/#sig-roman)
      are populated and derived from the same countdown (hex code is
      strictly decreasing as time passes).
   3. The "Relive MMXXVI" footer link still lands on index2026.html,
      which now holds the archived 2026 tournament homepage.

   Drives real index.html via a local static server, same pattern as
   repro-297/repro-183. Never touches Supabase or Google Fonts.

   Run: node test/repro-age2027-homepage.mjs
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
        const filePath = path.join(ROOT, urlPath === '/' ? '/index.html' : urlPath);
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
  const homeUrl = `http://127.0.0.1:${sitePort}/index.html`;

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

    // 1+2. Loads clean (no console/page errors), and both the countdown
    // and the rune ciphers are live -- not frozen placeholders.
    {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
      page.on('console', (msg) => { if (msg.type() === 'error') errors.push('console: ' + msg.text()); });

      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(300);

      const secsBefore = await page.textContent('#cd-secs');
      const hexBefore = await page.textContent('#sig-hex');
      const daysBefore = await page.textContent('#cd-days');
      if (!/^\d{3}$/.test(daysBefore)) fail(`expected #cd-days to be a 3-digit countdown, got ${JSON.stringify(daysBefore)}`);
      if (Number(daysBefore) <= 0) fail(`expected the countdown to August 2027 to be positive, got ${daysBefore} days`);

      await page.waitForTimeout(1200);
      const secsAfter = await page.textContent('#cd-secs');
      const hexAfter = await page.textContent('#sig-hex');

      if (secsBefore === secsAfter) fail(`expected #cd-secs to tick within ~1.2s, stayed at ${secsBefore}`);
      if (hexBefore === hexAfter) fail(`expected #sig-hex to change alongside the countdown, stayed at ${hexBefore}`);
      // Hex cipher is derived from seconds remaining, which strictly
      // decreases -- confirms it isn't just re-rendering noise.
      if (parseInt(hexAfter, 16) >= parseInt(hexBefore, 16)) {
        fail(`expected #sig-hex to strictly decrease as time passes, saw ${hexBefore} -> ${hexAfter}`);
      }

      const roman = await page.textContent('#sig-roman');
      if (!/^[MDCLXVI]+$/.test(roman)) fail(`expected #sig-roman to be a Roman numeral, got ${JSON.stringify(roman)}`);

      if (errors.length) fail(`expected zero console/page errors, saw: ${JSON.stringify(errors)}`);
      await page.close();
    }

    // 3. The archive link lands on the renamed 2026 recap page.
    {
      const page = await context.newPage();
      await page.goto(homeUrl, { waitUntil: 'domcontentloaded' });
      await Promise.all([
        page.waitForURL('**/index2026.html'),
        page.click('text=Relive MMXXVI'),
      ]);
      if (!page.url().endsWith('/index2026.html')) fail(`expected the archive link to land on index2026.html, got ${page.url()}`);
      await page.close();
    }

    console.log('All A.G.E. 2027 homepage assertions passed.');
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
