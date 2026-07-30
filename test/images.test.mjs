/* Issue #178 — the homepage hero (course-black-bull.jpg, 2.9 MB) was the
   landing page's LCP element; teams-photo.png (1.4 MB) had the same
   problem on records.html. Both were re-exported as WebP. Guards against
   the swap silently reverting: the old heavyweight files must be gone,
   every HTML/JS reference must point at the new WebP files, and the new
   files must actually be small (not just renamed). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.css']);
const SKIP_DIRS = new Set(['.git', 'node_modules', 'images']);

function walkTextFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTextFiles(full));
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

test('the old heavyweight course-black-bull.jpg and teams-photo.png are gone', () => {
  assert.ok(!existsSync(path.join(ROOT, 'images/course-black-bull.jpg')), 'expected course-black-bull.jpg to have been removed after the WebP swap');
  assert.ok(!existsSync(path.join(ROOT, 'images/teams-photo.png')), 'expected teams-photo.png to have been removed after the WebP swap');
});

test('the replacement WebP images exist and are actually small', () => {
  const blackBull = path.join(ROOT, 'images/course-black-bull.webp');
  const teamsPhoto = path.join(ROOT, 'images/teams-photo.webp');
  assert.ok(existsSync(blackBull), 'expected images/course-black-bull.webp to exist');
  assert.ok(existsSync(teamsPhoto), 'expected images/teams-photo.webp to exist');
  // Generous ceilings (the issue's own target was ~100-250 KB each) --
  // this is a guard against someone re-introducing an unoptimized
  // multi-megabyte file under the same name, not a strict budget.
  assert.ok(statSync(blackBull).size < 500 * 1024, `expected course-black-bull.webp under 500KB, got ${statSync(blackBull).size} bytes`);
  assert.ok(statSync(teamsPhoto).size < 500 * 1024, `expected teams-photo.webp under 500KB, got ${statSync(teamsPhoto).size} bytes`);
});

test('no source file references the old course-black-bull.jpg or teams-photo.png filenames', () => {
  const offenders = [];
  for (const file of walkTextFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (/course-black-bull\.jpg/.test(text) || /teams-photo\.png/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `found stale references to the removed image filenames in: ${offenders.join(', ')}`);
});

test('index.html preloads the hero WebP (invisible to the preload scanner as a CSS background-image)', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="preload" as="image" href="images\/course-black-bull\.webp">/);
});
