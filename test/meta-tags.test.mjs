/* Issue #180 -- every page gets a real favicon, a meta description, and
   Open Graph/Twitter card tags (so a pasted link actually unfurls),
   plus a branded 404 page instead of GitHub Pages' bare default. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = ['index.html', 'golfers.html', 'practical.html', 'records.html', 'format.html', 'scorecard-live.html', 'print-cards.html'];

test('every page links a favicon (32x32, 16x16, apple-touch-icon)', () => {
  for (const page of PAGES) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="images\/favicon-32\.png">/, `${page} missing 32x32 favicon`);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="16x16" href="images\/favicon-16\.png">/, `${page} missing 16x16 favicon`);
    assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="images\/apple-touch-icon\.png">/, `${page} missing apple-touch-icon`);
  }
});

test('every page has a non-empty meta description', () => {
  for (const page of PAGES) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    const m = /<meta name="description" content="([^"]+)">/.exec(html);
    assert.ok(m, `${page} missing meta description`);
    assert.ok(m[1].trim().length > 10, `${page} has a suspiciously short description`);
  }
});

test('every page has Open Graph + Twitter card tags pointing at the real domain and og-card.jpg', () => {
  for (const page of PAGES) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    for (const prop of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image']) {
      assert.match(html, new RegExp(`<meta property="${prop}" content="[^"]+">`), `${page} missing ${prop}`);
    }
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, `${page} missing twitter:card`);
    assert.match(html, /og:url" content="https:\/\/theage\.golf/, `${page} og:url isn't the real domain`);
    assert.match(html, /og:image" content="https:\/\/theage\.golf\/images\/og-card\.jpg"/, `${page} og:image isn't the real og-card.jpg URL`);
  }
});

test('the favicon/apple-touch-icon/og-card image files actually exist and are non-trivially sized', () => {
  const files = ['images/favicon-32.png', 'images/favicon-16.png', 'images/apple-touch-icon.png', 'images/og-card.jpg'];
  for (const f of files) {
    const full = path.join(ROOT, f);
    assert.ok(existsSync(full), `${f} does not exist`);
    assert.ok(statSync(full).size > 200, `${f} is suspiciously small (${statSync(full).size} bytes) -- likely a broken/empty image`);
  }
});

test('404.html exists, is branded (masthead + a way home), and is not a bare stub', () => {
  const full = path.join(ROOT, '404.html');
  assert.ok(existsSync(full), '404.html does not exist');
  const html = readFileSync(full, 'utf8');
  assert.match(html, /class="masthead/, '404.html has no masthead -- looks unbranded');
  assert.match(html, /href="index\.html"/, '404.html has no link back home');
  assert.match(html, /<link rel="icon"/, '404.html missing its own favicon links');
});
