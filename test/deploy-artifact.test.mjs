/* Issue #179 — deploy.yml used to upload the entire repo root
   (`path: '.'`) to GitHub Pages: test/, supabase/migrations/, README.md,
   ARCHITECTURE.md, this workflow file, all served publicly. It also
   shipped ~4.3MB of images referenced by nothing. Guards that the
   workflow assembles an explicit _site/ directory instead of the whole
   repo, that the unreferenced images are actually gone, and that no
   source file references their old filenames. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

const DELETED_IMAGES = ['accom-deck.png', 'accom-setup.png', 'golf-cart.png', 'golf-course.png'];

test('the four unreferenced PNGs are gone', () => {
  for (const name of DELETED_IMAGES) {
    assert.ok(!existsSync(path.join(ROOT, 'images', name)), `expected images/${name} to have been removed as unreferenced`);
  }
});

test('wonga-cup-badge.png is kept (favicon/og-image candidate, not dead weight)', () => {
  assert.ok(existsSync(path.join(ROOT, 'images/wonga-cup-badge.png')), 'expected wonga-cup-badge.png to still exist');
});

test('no source file references the deleted image filenames', () => {
  const offenders = [];
  for (const file of walkTextFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    for (const name of DELETED_IMAGES) {
      if (text.includes(name)) offenders.push(`${path.relative(ROOT, file)} references ${name}`);
    }
  }
  assert.deepEqual(offenders, [], `found stale references: ${offenders.join(', ')}`);
});

test('deploy.yml assembles an explicit _site/ directory instead of uploading the whole repo', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  assert.doesNotMatch(workflow, /path:\s*'\.'/, 'expected deploy.yml to no longer upload the entire repo root');
  assert.match(workflow, /mkdir _site/, 'expected deploy.yml to build an explicit _site/ directory');
  assert.match(workflow, /path:\s*'_site'/, 'expected upload-pages-artifact to point at _site, not the repo root');
  // The explicit copy list must actually include every kind of file the
  // live site needs -- a guard against someone narrowing it and quietly
  // breaking the site (e.g. forgetting *.css or the images/ directory).
  for (const pattern of [/\*\.html/, /\*\.js/, /\*\.css/, /\*\.mp3/, /CNAME/, /version\.json/, /manifest\.webmanifest/, /cp -r images/, /cp -r fonts/, /cp -r calendar/]) {
    assert.match(workflow, pattern, `expected deploy.yml's _site/ assembly to include something matching ${pattern}`);
  }
});

test('deploy.yml never assembles _site/ from repo-internal directories', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
  for (const internal of ['test/', 'supabase/', '.github/', 'snapshots/', 'scripts/']) {
    assert.ok(!workflow.includes(`cp -r ${internal}`), `expected deploy.yml to never copy ${internal} into _site/`);
  }
});
