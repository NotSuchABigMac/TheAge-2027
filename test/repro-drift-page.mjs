/* ─────────────────────────────────────
   REGRESSION TEST — drift.html, the top-down drifting golf cart.

   A standalone page: a golf cart seen from above, drifting a circle
   around a small "AGE 2027" wordmark, laying skid marks behind its
   wheels. The brief was specific about the size of the circle -- ~20%
   of the vertical viewport -- and about the cart being *drifting*
   rather than just driving round, so both are pinned here.

   Checks:
     1. The circle's diameter is ~20% of the viewport height, and holds
        that proportion after a resize (it's derived from the viewport,
        not hardcoded).
     2. The cart stays on that circle and actually travels round it.
     3. It's drifting: the body's heading is held at a real slip angle
        off the direction of travel, with the nose inside the line.
     4. All four wheels leave skid marks, and those marks are really
        painted on the canvas behind the cart -- not just held in state.
     5. The wordmark is the page's display serif, set as large as the
        circle allows, and still sits inside it with clearance so the
        cart never drives through the text. The tagline sits below.
     6. The cart rumbles: the drawn pose is jostled off the ideal line
        by a visible but small amount, and settles back to it.
     7. There are clubs in the back -- painted, and behind the cart.
     8. Under prefers-reduced-motion the scene is painted but frozen.

   Self-contained: a tiny static file server for the app; Google Fonts
   and Supabase blocked outright (this page talks to neither).

   Run: node test/repro-drift-page.mjs
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

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png' };

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = new URL(req.url, 'http://x').pathname;
        const body = await readFile(path.join(ROOT, urlPath));
        res.writeHead(200, { 'Content-Type': MIME[path.extname(urlPath)] || 'application/octet-stream' });
        res.end(body);
      } catch {
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

async function openDrift(browser, opts = {}) {
  const context = await browser.newContext({
    viewport: opts.viewport || { width: 1280, height: 800 },
    reducedMotion: opts.reducedMotion || 'no-preference'
  });
  await context.route('**fonts.googleapis.com**', route => route.abort());
  await context.route('**fonts.gstatic.com**', route => route.abort());
  await context.route('**wtyyarvyscbrrkawjcvo**', route => route.abort());
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${global.__wongaSite.port}/drift.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__drift);
  return { context, page };
}

async function testCircleSize(browser) {
  const { context, page } = await openDrift(browser);

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(120);
    const geo = await page.evaluate(() => ({
      radius: window.__drift.radius,
      centre: window.__drift.centre,
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      vhFraction: window.__drift.CIRCLE_VH
    }));

    const diameter = geo.radius * 2;
    const ratio = diameter / geo.innerH;
    if (Math.abs(ratio - 0.20) > 0.01) {
      fail(`at ${viewport.width}x${viewport.height} the circle's diameter is ${ratio.toFixed(3)} of the viewport height, expected ~0.20`);
    }
    if (geo.vhFraction !== 0.20) fail(`CIRCLE_VH drifted from the 0.20 brief, got ${geo.vhFraction}`);
    if (Math.abs(geo.centre.x - geo.innerW / 2) > 1 || Math.abs(geo.centre.y - geo.innerH / 2) > 1) {
      fail(`the circle isn't centred in the viewport: centre ${JSON.stringify(geo.centre)} in ${geo.innerW}x${geo.innerH}`);
    }
  }

  await context.close();
  console.log('circle-size assertions passed (diameter ~20vh, recomputed on resize).');
}

async function testDriftingMotion(browser) {
  const { context, page } = await openDrift(browser);

  const samples = [];
  for (let i = 0; i < 6; i++) {
    samples.push(await page.evaluate(() => {
      const d = window.__drift;
      const c = d.cart;
      return { x: c.x, y: c.y, heading: c.heading, slip: c.slip, R: d.radius, cx: d.centre.x, cy: d.centre.y };
    }));
    await page.waitForTimeout(180);
  }

  // On the circle, every sample. The tolerance has to clear the bump
  // rumble, which deliberately knocks the cart a few px off the line.
  for (const s of samples) {
    const r = Math.hypot(s.x - s.cx, s.y - s.cy);
    if (Math.abs(r - s.R) / s.R > 0.08) {
      fail(`the cart left the circle: radius ${r.toFixed(1)} vs expected ${s.R.toFixed(1)}`);
    }
  }

  // ...and moving round it, not parked on it.
  const first = samples[0], last = samples[samples.length - 1];
  const travelled = Math.hypot(last.x - first.x, last.y - first.y);
  if (travelled < first.R * 0.2) {
    fail(`the cart barely moved over ~1s (${travelled.toFixed(1)}px around a ${first.R.toFixed(1)}px-radius circle)`);
  }

  // Drifting, not just driving: the body is held sideways to its own
  // direction of travel, nose pointed inside the line.
  for (const s of samples) {
    const theta = Math.atan2(s.y - s.cy, s.x - s.cx);
    const travelDir = theta + Math.PI / 2;
    let offset = s.heading - travelDir;
    offset = Math.atan2(Math.sin(offset), Math.cos(offset));   // wrap to ±π
    if (offset < 0.15) fail(`expected the cart to sit sideways to its travel direction (nose inside the line); slip offset was ${offset.toFixed(3)} rad`);
    if (offset > 1.0) fail(`slip offset of ${offset.toFixed(3)} rad reads as a spin, not a drift`);
  }

  await context.close();
  console.log('drift-motion assertions passed (on the circle, moving, held at a slip angle).');
}

async function testSkidMarks(browser) {
  const { context, page } = await openDrift(browser);
  await page.waitForTimeout(400);

  const counts = await page.evaluate(() => window.__drift.trailCounts);
  if (counts.length !== 4) fail(`expected a skid trail per wheel (4), got ${counts.length}`);
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] < 5) fail(`wheel ${i} laid only ${counts[i]} trail points -- expected a continuous mark`);
  }

  // The marks are actually painted: sample the canvas along the circle,
  // behind the cart, and require ink there. Directly ahead of the cart --
  // where nothing has driven yet within a trail's lifetime -- must stay
  // clear, which is what proves this is a trail and not a drawn ring.
  const ink = await page.evaluate(() => {
    const d = window.__drift;
    const cv = document.getElementById('scene');
    const c = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const theta = Math.atan2(d.cart.y - d.centre.y, d.cart.x - d.centre.x);

    // The cart travels in the +theta direction, so behind it is -theta.
    const alphaAt = (offsetRad) => {
      const a = theta + offsetRad;
      const x = Math.round((d.centre.x + Math.cos(a) * d.radius) * dpr);
      const y = Math.round((d.centre.y + Math.sin(a) * d.radius) * dpr);
      const half = Math.round(0.6 * d.cartLength * dpr);
      const px = c.getImageData(x - half, y - half, half * 2, half * 2).data;
      let max = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
      return max;
    };

    return { behind: alphaAt(-0.55), ahead: alphaAt(1.4) };
  });

  if (ink.behind < 8) fail(`expected visible skid marks on the canvas behind the cart, peak alpha was ${ink.behind}`);
  if (ink.ahead > ink.behind) fail(`the road ahead of the cart is as marked as the road behind it (${ink.ahead} vs ${ink.behind}) -- the trail isn't following the wheels`);

  await context.close();
  console.log('skid-mark assertions passed (four trails, painted behind the cart, clear ahead of it).');
}

async function testRumble(browser) {
  const { context, page } = await openDrift(browser);

  // Sample the drawn pose against the ideal line it's meant to be rumbling
  // around. Both come from the same frame, so this isolates the bumps from
  // the cart's travel round the circle.
  const stats = await page.evaluate(async () => {
    const d = window.__drift;
    let maxOffset = 0, maxRot = 0, sum = 0, n = 0;
    for (let i = 0; i < 180; i++) {
      const c = d.cart, l = d.line;
      const off = Math.hypot(c.x - l.x, c.y - l.y);
      let rot = c.heading - l.heading;
      rot = Math.abs(Math.atan2(Math.sin(rot), Math.cos(rot)));
      maxOffset = Math.max(maxOffset, off);
      maxRot = Math.max(maxRot, rot);
      sum += off; n++;
      await new Promise(r => requestAnimationFrame(r));
    }
    return { maxOffset, maxRot, mean: sum / n, L: d.cartLength };
  });

  if (stats.maxOffset < 0.02 * stats.L) {
    fail(`expected the cart to be jostled off its line by the bumps; peak offset was only ${stats.maxOffset.toFixed(2)}px on a ${stats.L.toFixed(1)}px cart`);
  }
  if (stats.maxOffset > 0.30 * stats.L) {
    fail(`the bump rumble is a wander, not a rumble: peak offset ${stats.maxOffset.toFixed(2)}px on a ${stats.L.toFixed(1)}px cart`);
  }
  // A damped spring spends most of its time near rest and only occasionally
  // peaks. A mean anywhere near the peak would mean it's just permanently
  // displaced rather than being knocked about and settling.
  if (stats.mean > stats.maxOffset * 0.75) {
    fail(`the rumble never settles back to the line: mean offset ${stats.mean.toFixed(2)}px vs peak ${stats.maxOffset.toFixed(2)}px`);
  }
  if (stats.maxRot < 0.004) fail(`expected the body to rock over the bumps, peak rotation was ${stats.maxRot.toFixed(4)} rad`);

  await context.close();
  console.log(`rumble assertions passed (peak ${stats.maxOffset.toFixed(2)}px / ${stats.maxRot.toFixed(3)} rad, mean ${stats.mean.toFixed(2)}px).`);
}

async function testClubsInTheBack(browser) {
  const { context, page } = await openDrift(browser);
  await page.waitForTimeout(300);

  const clubs = await page.evaluate(() => {
    const d = window.__drift;
    const cv = document.getElementById('scene');
    const c = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const tips = d.clubTips;
    // Painted? Sample a small box at each tip and take the peak alpha.
    const painted = tips.map(t => {
      const half = Math.max(2, Math.round(0.05 * d.cartLength * dpr));
      const px = c.getImageData(Math.round(t.x * dpr) - half, Math.round(t.y * dpr) - half, half * 2, half * 2).data;
      let max = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
      return max;
    });
    return {
      count: tips.length,
      behind: tips.every(t => t.local.x < -0.5 * d.cartLength),   // past the tail of the body
      minPainted: Math.min(...painted)
    };
  });

  if (clubs.count < 4) fail(`expected a set of clubs in the back, found ${clubs.count} shafts`);
  if (!clubs.behind) fail('expected the clubs to stick out past the back of the cart');
  if (clubs.minPainted < 24) fail(`expected every club to be painted on the canvas, faintest tip had alpha ${clubs.minPainted}`);

  await context.close();
  console.log(`clubs assertions passed (${clubs.count} shafts, painted, past the tail).`);
}

async function testWordmarkClearance(browser) {
  const { context, page } = await openDrift(browser);

  // The last two are the tight ones: a short landscape window shrinks the
  // circle (it's 20% of the height) while a rem-floored wordmark wouldn't
  // shrink with it, which is exactly how the cart ends up driving through
  // the text.
  const viewports = [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
    { width: 2560, height: 1440 },
    { width: 740, height: 360 }
  ];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(120);
    const info = await page.evaluate(() => {
      const el = document.querySelector('.mark');
      const sub = document.querySelector('.sub');
      const r = el.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      const d = window.__drift;
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];
      return {
        text: el.textContent.replace(/\s+/g, ' ').trim(),
        family: getComputedStyle(el).fontFamily,
        size: parseFloat(getComputedStyle(el).fontSize),
        width: r.width,
        worst: Math.max(...corners.map(([x, y]) => Math.hypot(x - d.centre.x, y - d.centre.y))),
        clear: d.radius - d.cartLength / 2,
        subText: sub.textContent.replace(/\s+/g, ' ').trim(),
        subTop: sr.top,
        cartOuter: d.centre.y + d.radius + d.cartLength / 2
      };
    });

    if (info.text !== 'AGE 2027') fail(`expected the wordmark to read "AGE 2027", got "${info.text}"`);
    if (!/Cormorant Garamond/.test(info.family)) fail(`expected the wordmark in the display serif, got "${info.family}"`);
    if (info.worst >= info.clear) {
      fail(`at ${viewport.width}x${viewport.height} the wordmark reaches ${info.worst.toFixed(1)}px from centre but the cart's inner edge is at ${info.clear.toFixed(1)}px -- the cart would drive through the text`);
    }
    // ...and it should genuinely fill that space, not just avoid it: the
    // wordmark is meant to be set as large as the circle allows.
    if (info.worst < info.clear * 0.75) {
      fail(`at ${viewport.width}x${viewport.height} the wordmark only reaches ${info.worst.toFixed(1)}px of the ${info.clear.toFixed(1)}px available -- it isn't being fitted to the circle`);
    }

    if (info.subText !== 'More info coming soon...') fail(`expected the tagline to read "More info coming soon...", got "${info.subText}"`);
    if (info.subTop <= info.cartOuter) {
      fail(`at ${viewport.width}x${viewport.height} the tagline starts at y=${info.subTop.toFixed(1)}, inside the cart's outer edge at y=${info.cartOuter.toFixed(1)}`);
    }
  }

  await context.close();
  console.log('wordmark assertions passed (display serif, fitted to the circle, tagline clear below it).');
}

async function testReducedMotion(browser) {
  const { context, page } = await openDrift(browser, { reducedMotion: 'reduce' });
  await page.waitForTimeout(400);

  const before = await page.evaluate(() => window.__drift.cart);
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => window.__drift.cart);
  if (Math.hypot(after.x - before.x, after.y - before.y) > 0.5) {
    fail('prefers-reduced-motion: the cart is still animating');
  }

  // Frozen, but not blank -- the still frame keeps the cart and its marks.
  const painted = await page.evaluate(() => {
    const c = document.getElementById('scene').getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const d = window.__drift;
    const px = c.getImageData(
      Math.round((d.centre.x - d.radius - d.cartLength) * dpr),
      Math.round((d.centre.y - d.radius - d.cartLength) * dpr),
      Math.round((d.radius + d.cartLength) * 2 * dpr),
      Math.round((d.radius + d.cartLength) * 2 * dpr)
    ).data;
    let max = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > max) max = px[i];
    return max;
  });
  if (painted < 32) fail(`prefers-reduced-motion: expected a static painted frame, peak alpha was ${painted}`);

  await context.close();
  console.log('reduced-motion assertions passed (painted, frozen).');
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
    await testCircleSize(browser);
    await testDriftingMotion(browser);
    await testSkidMarks(browser);
    await testRumble(browser);
    await testClubsInTheBack(browser);
    await testWordmarkClearance(browser);
    await testReducedMotion(browser);
    console.log('All drift-page assertions passed.');
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
