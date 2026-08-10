/* Issue #185 — TODO.md (really the architecture doc) was renamed to
   ARCHITECTURE.md and README.md was written to point to it. Guard against
   a stale reference to the old filename creeping back in, and against the
   README silently reverting to its one-line placeholder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEXT_EXTENSIONS = new Set(['.md', '.js', '.html', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);

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

test('ARCHITECTURE.md exists and TODO.md does not (renamed, issue #185)', () => {
  assert.ok(existsSync(path.join(ROOT, 'ARCHITECTURE.md')), 'expected ARCHITECTURE.md to exist');
  assert.ok(!existsSync(path.join(ROOT, 'TODO.md')), 'expected TODO.md to have been renamed away, not left alongside');
});

test('no source file references the old TODO.md filename', () => {
  const offenders = [];
  for (const file of walkTextFiles(ROOT)) {
    const text = readFileSync(file, 'utf8');
    if (/\bTODO\.md\b/.test(text)) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `found stale TODO.md reference(s) in: ${offenders.join(', ')}`);
});

test('README.md is more than the old one-line placeholder and points to ARCHITECTURE.md', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.length > 200, 'expected README.md to have real content, not a one-liner');
  assert.match(readme, /ARCHITECTURE\.md/, 'expected README.md to point readers to ARCHITECTURE.md');
  assert.match(readme, /node --test/, 'expected README.md to document how to run the tests');
});

test('issue #25: every top-level .html file appears in README.md\'s page map', () => {
  const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const pages = readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const missing = pages.filter((p) => !readme.includes(`\`${p}\``));
  assert.deepEqual(missing, [], `README.md's page map is missing: ${missing.join(', ')} -- add a row so a future page addition can't drift out of sync silently, the way index2026.html/drift.html did`);
});
