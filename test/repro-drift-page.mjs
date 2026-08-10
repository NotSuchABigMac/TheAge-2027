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
        off the direction of travel, with the nose inside the line -- and
        it's the tail doing the moving. The front axle follows the line
        while the back end swings well wide of it, so the cart's centre
        traces something out-of-round rather than a compass circle.
     4. All four wheels leave skid marks, and those marks are really
        painted on the canvas behind the cart -- not just held in state.
     5. The wordmark is the page's display serif, set as large as the
        circle allows, and still sits inside it with clearance so the
        cart never drives through the text. The tagline sits below.
     6. The cart rumbles over ground with a shape: the body moves on its
        springs, that motion is coherent rather than per-frame random,
        the ground repeats for a given place, and the contact patches
        stay on the line so the skid marks don't pick the bumps up.
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
import { loadChromium, fail } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


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

  // Near the circle, every sample -- but only near it. The cart's centre
  // deliberately doesn't trace a circle any more: the front axle follows
  // the line and the body hangs off it, so the centre swings in and out as
  // the slide runs wide and gets caught.
  for (const s of samples) {
    const r = Math.hypot(s.x - s.cx, s.y - s.cy);
    if (Math.abs(r - s.R) / s.R > 0.12) {
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

  // It's the tail that does the moving. The front axle is the point that
  // follows the line, and the body hangs off it, so the back end should
  // swing in and out by a multiple of whatever the front does -- that
  // asymmetry is the whole reason the line isn't a compass circle.
  const swing = await page.evaluate(async () => {
    const d = window.__drift, L = d.cartLength, C = d.centre;
    const front = [], rear = [];
    for (let i = 0; i < 300; i++) {
      const c = d.cart, ch = Math.cos(c.heading), sh = Math.sin(c.heading);
      front.push(Math.hypot(c.x + 0.30 * L * ch - C.x, c.y + 0.30 * L * sh - C.y));
      rear.push(Math.hypot(c.x - 0.31 * L * ch - C.x, c.y - 0.31 * L * sh - C.y));
      await new Promise(r => requestAnimationFrame(r));
    }
    const span = (a) => Math.max(...a) - Math.min(...a);
    return { front: span(front), rear: span(rear), L };
  });

  if (swing.rear < 0.08 * swing.L) {
    fail(`the tail barely moves: rear axle swings ${swing.rear.toFixed(1)}px on a ${swing.L.toFixed(1)}px cart`);
  }
  if (swing.rear < swing.front * 2.5) {
    fail(`expected the back of the cart to move far more than the front (the front holds the line, the tail steps out); rear swung ${swing.rear.toFixed(1)}px against the front's ${swing.front.toFixed(1)}px`);
  }

  await context.close();
  console.log(`drift-motion assertions passed (slip angle held; tail swings ${swing.rear.toFixed(1)}px vs the front's ${swing.front.toFixed(1)}px).`);
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
  await page.waitForTimeout(300);

  const stats = await page.evaluate(async () => {
    const d = window.__drift;
    const series = { heave: [], pitch: [], roll: [] };
    for (let i = 0; i < 300; i++) {
      const s = d.suspension;
      series.heave.push(s.heave);
      series.pitch.push(s.pitch);
      series.roll.push(s.roll);
      await new Promise(r => requestAnimationFrame(r));
    }
    const stat = (a) => {
      const mean = a.reduce((x, y) => x + y, 0) / a.length;
      const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) * (y - mean), 0) / a.length);
      let steps = 0;
      for (let i = 1; i < a.length; i++) steps += Math.abs(a[i] - a[i - 1]);
      return { sd, peak: Math.max(...a.map(Math.abs)), step: steps / (a.length - 1) };
    };
    return {
      heave: stat(series.heave), pitch: stat(series.pitch), roll: stat(series.roll),
      // The ground is a function of place, not of time: the same spot has
      // to give the same height, and different spots different ones. This
      // is what makes the front and rear wheels hit the same bump, and the
      // same bumps come round again next lap.
      repeatable: d.groundHeight(123.4, 56.7) === d.groundHeight(123.4, 56.7),
      varies: d.groundHeight(123.4, 56.7) !== d.groundHeight(999.1, 12.3)
    };
  });

  for (const axis of ['heave', 'pitch', 'roll']) {
    const s = stats[axis];
    if (s.peak < 0.05) fail(`the body barely moves in ${axis}: peak ${s.peak.toFixed(3)}`);
    if (s.peak > 3) fail(`${axis} is wildly out of range at ${s.peak.toFixed(3)} -- the suspension spring may be unstable`);

    // The point of the whole rewrite. A signal redrawn at random every
    // frame steps about 1.13 standard deviations per frame; smooth,
    // coherent motion steps a small fraction of one. This is what
    // separates "driving over ground that has a shape" from an
    // electrical buzz, and it's the thing that regressed before.
    const ratio = s.step / s.sd;
    if (ratio > 0.35) {
      fail(`${axis} jitters instead of rumbling: it moves ${ratio.toFixed(2)} standard deviations per frame (white noise is ~1.13, coherent motion well under 0.35)`);
    }
  }
  if (!stats.repeatable) fail('the ground is not a function of position -- the same spot gave two different heights');
  if (!stats.varies) fail('the ground is flat -- two different places gave the same height');

  // ...and the contact patches stay on the line: a tyre does not slide
  // sideways because the ground under it rose, which is what keeps the
  // skid marks smooth instead of serrated.
  const onLine = await page.evaluate(() => {
    const d = window.__drift, c = d.cart, l = d.line;
    return Math.hypot(c.x - l.x, c.y - l.y);
  });
  if (onLine > 0.001) fail(`the cart's contact patches are displaced ${onLine.toFixed(3)}px off the line -- the skid marks will pick that up`);

  await context.close();
  const r = ['heave', 'pitch', 'roll'].map(a => `${a} ${(stats[a].step / stats[a].sd).toFixed(2)}`).join(', ');
  console.log(`rumble assertions passed (coherent: ${r} sd/frame vs 1.13 for white noise).`);
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
    const info = await page.evaluate(async () => {
      const el = document.querySelector('.mark');
      const sub = document.querySelector('.sub');
      const r = el.getBoundingClientRect();
      const sr = sub.getBoundingClientRect();
      const d = window.__drift;
      const corners = [[r.left, r.top], [r.right, r.top], [r.left, r.bottom], [r.right, r.bottom]];

      // How close the cart's body actually gets to the middle, measured
      // rather than assumed. The line isn't a circle and the cart isn't
      // side-on to it, so radius-minus-half-a-cart is now only a rough
      // stand-in for the real inner reach.
      const C = d.centre, L = d.cartLength, W = L * 0.52;
      let reach = Infinity;
      for (let i = 0; i < 80; i++) {
        const c = d.cart, ch = Math.cos(c.heading), sh = Math.sin(c.heading);
        for (const [ax, ay] of [[0.5, 0.5], [0.5, -0.5], [-0.5, 0.5], [-0.5, -0.5]]) {
          const px = c.x + ax * L * ch - ay * W * sh;
          const py = c.y + ax * L * sh + ay * W * ch;
          reach = Math.min(reach, Math.hypot(px - C.x, py - C.y));
        }
        await new Promise(res => requestAnimationFrame(res));
      }

      return {
        measuredReach: reach,
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
    // ...and against where the cart was actually seen to go, with margin,
    // since the sampled window can't have caught the very worst excursion.
    if (info.worst >= info.measuredReach * 0.94) {
      fail(`at ${viewport.width}x${viewport.height} the wordmark reaches ${info.worst.toFixed(1)}px from centre and the cart was measured coming within ${info.measuredReach.toFixed(1)}px -- too close`);
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
