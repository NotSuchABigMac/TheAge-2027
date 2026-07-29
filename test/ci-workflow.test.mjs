/* Issue #177 — CI silently ran only test/scoring.test.mjs, so a broken
   courses.test.mjs or theme.test.mjs would still merge green. Guard against
   that regressing again: the workflow's test step must run every
   *.test.mjs file present, not name them individually (which is exactly
   how the second and third file went unrun in the first place). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CI workflow runs the full test/*.test.mjs glob, not individually-named files', () => {
  const workflow = readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
  assert.match(
    workflow,
    /node --test test\/\*\.test\.mjs/,
    'expected the test step to run `node --test test/*.test.mjs` so every test file is picked up automatically'
  );
});

test('every *.test.mjs file in test/ would be covered by that glob', () => {
  const testFiles = readdirSync(path.join(ROOT, 'test')).filter(f => f.endsWith('.test.mjs'));
  // Sanity check on the check itself: if this repo ever stopped having any
  // *.test.mjs files, the glob assertion above would be vacuously fine but
  // meaningless -- make sure there's always at least the files we know about.
  assert.ok(testFiles.length >= 3, `expected at least 3 *.test.mjs files, found ${testFiles.length}`);
});
