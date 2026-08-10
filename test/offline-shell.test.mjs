/* Issue #205 -- structural checks on the offline app shell: sw.js's own
   precache list, deploy.yml's cachebust/copy wiring for it, the
   manifest, and scorecard-live.html's registration. sw.js itself uses
   service-worker-only globals (self, caches, clients) that don't exist
   in Node, so this is the same "read the source text and assert on it"
   style as ci-workflow.test.mjs/snapshot-workflow.test.mjs -- the real
   install/fetch/activate behavior is covered end-to-end by
   test/repro-205-offline-shell.mjs instead (needs a real browser). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SW_PATH = path.join(ROOT, 'sw.js');
const DEPLOY_PATH = path.join(ROOT, '.github/workflows/deploy.yml');

test('sw.js exists and precaches exactly the live-scorecard shell -- not images, audio, or the other pages', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  const mustInclude = [
    'scorecard-live.html', 'styles.css', 'scorecard.css',
    'supabase-config.js', 'theme.js', 'scoring.js', 'courses.js', 'players.js',
    'fonts/cormorant-garamond.woff2', 'fonts/geist.woff2'
  ];
  for (const path of mustInclude) {
    assert.ok(sw.includes(`'${path}'`), `expected sw.js's SHELL_PATHS to include '${path}'`);
  }
  const mustExclude = ['index.html', 'practical.html', 'golfers.html', 'TheSong.mp3', 'images/'];
  for (const path of mustExclude) {
    assert.ok(!sw.includes(`'${path}`), `expected sw.js to NOT precache ${path} -- v1 scope is scoring only`);
  }
});

test('sw.js\'s cache name is versioned off the same __CACHEBUST__ placeholder every other local asset reference gets', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  assert.match(sw, /__CACHEBUST__/, 'expected sw.js to carry the __CACHEBUST__ placeholder deploy.yml substitutes');
  assert.match(sw, /CACHE_NAME\s*=.*SW_VERSION/, 'expected CACHE_NAME to be derived from the versioned placeholder');
});

test('sw.js never intercepts requests outside its own precached shell (Supabase, other pages, cross-origin)', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  assert.match(sw, /url\.origin\s*!==\s*self\.location\.origin/, 'expected a same-origin guard before handling any fetch');
  assert.match(sw, /if\s*\(!path\)\s*return;/, 'expected fetch handler to bail out (pass through untouched) for anything not in the shell');
});

test('sw.js is network-first with a cache fallback, and activate cleans up old cache versions', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  assert.match(sw, /fetch\(event\.request\)/, 'expected the fetch handler to try the network first');
  assert.match(sw, /\.catch\(async \(\)\s*=>\s*\(await caches\.match/, 'expected a cache fallback on network failure');
  assert.match(sw, /caches\.delete/, 'expected activate to delete stale cache versions');
  assert.match(sw, /clients\.claim/, 'expected activate to take control of already-open tabs');
});

test('issue #17: sw.js only caches a successful response, and falls back to a network-error Response rather than throwing on a cache miss', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  assert.match(sw, /if\s*\(resp\.ok\)\s*\{/, 'expected the fetch handler to gate caching on resp.ok, so a 404/503 error page is never cached as the shell');
  assert.match(sw, /caches\.match\(path\)\)\s*\|\|\s*Response\.error\(\)/, 'expected a cache-miss fallback that never resolves undefined to respondWith()');
});

test('issue #17: every SHELL_PATHS entry exists on disk, so a missing file fails CI instead of silently disabling the offline shell (cache.addAll is atomic -- one 404 fails the whole install)', () => {
  const sw = readFileSync(SW_PATH, 'utf8');
  const match = sw.match(/const SHELL_PATHS = \[([\s\S]*?)\];/);
  assert.ok(match, 'expected to find a SHELL_PATHS array literal in sw.js');
  const paths = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(paths.length > 0, 'expected SHELL_PATHS to list at least one path');
  for (const p of paths) {
    assert.ok(existsSync(path.join(ROOT, p)), `expected SHELL_PATHS entry '${p}' to exist on disk`);
  }
});

test('deploy.yml cachebusts sw.js (and every other .js file) the same way it cachebusts every HTML file', () => {
  const workflow = readFileSync(DEPLOY_PATH, 'utf8');
  assert.match(workflow, /sed -i "s\/__CACHEBUST__\/\$\{GITHUB_SHA::8\}\/g" \*\.html \*\.js/, 'expected the cachebust sed to target every .js file, sw.js included (issue #26)');
});

test('deploy.yml copies manifest.webmanifest into _site/', () => {
  const workflow = readFileSync(DEPLOY_PATH, 'utf8');
  assert.match(workflow, /manifest\.webmanifest/);
});

test('manifest.webmanifest exists and is valid, scoped, installable JSON', () => {
  const raw = readFileSync(path.join(ROOT, 'manifest.webmanifest'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.start_url, 'scorecard-live.html');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'expected at least one icon');
  for (const icon of manifest.icons) {
    assert.ok(existsSync(path.join(ROOT, icon.src)), `expected manifest icon ${icon.src} to actually exist`);
  }
});

test('scorecard-live.html links the manifest and registers the service worker', () => {
  const html = readFileSync(path.join(ROOT, 'scorecard-live.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /navigator\.serviceWorker\.register\(['"]sw\.js['"]\)/);
});

test('checkForUpdate() keeps the SW registration warm on the same poll cadence as the version.json check', () => {
  const html = readFileSync(path.join(ROOT, 'scorecard-live.html'), 'utf8');
  const fnMatch = html.match(/async function checkForUpdate\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(fnMatch, 'expected to find checkForUpdate()');
  assert.match(fnMatch[0], /getRegistration\(\)/, 'expected checkForUpdate() to also refresh the SW registration');
});
