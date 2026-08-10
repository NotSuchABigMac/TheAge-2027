/* Issue #6 -- nothing ever ran test/repro-*.mjs, so a rename/refactor
   could silently invalidate one (as actually happened after #2 -- see
   #4). Structural checks on the CI workflow that now runs them and the
   shell runner it calls, same "read the file, assert on it" style as
   ci-workflow.test.mjs/deploy-artifact.test.mjs. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/repro-scripts.yml');
const RUNNER_PATH = path.join(ROOT, 'test/run-repro.sh');

test('repro-scripts.yml exists and installs Playwright + Chromium before running anything', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /playwright/i);
  assert.match(workflow, /chromium/i);
});

test('repro-scripts.yml runs on a schedule, not just on demand -- rot between PRs must still surface', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /schedule:/, 'expected a cron schedule so this catches rot even with no open PR touching the affected files');
  assert.match(workflow, /cron:/);
});

test('repro-scripts.yml delegates to test/run-repro.sh rather than re-implementing the loop inline', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /run-repro\.sh/);
});

test('test/run-repro.sh exists, is executable, and runs the full test/repro-*.mjs glob', () => {
  assert.ok(existsSync(RUNNER_PATH), 'expected test/run-repro.sh to exist');
  const mode = statSync(RUNNER_PATH).mode;
  assert.ok(mode & 0o111, 'expected test/run-repro.sh to be executable');
  const sh = readFileSync(RUNNER_PATH, 'utf8');
  assert.match(sh, /test\/repro-\*\.mjs/, 'must run the full glob, not individually-named scripts -- the same gap that let #177-style rot through test.yml once already');
});

test('test/run-repro.sh exits non-zero if any repro script fails, so the workflow run is visibly red', () => {
  const sh = readFileSync(RUNNER_PATH, 'utf8');
  assert.match(sh, /exit 1/);
});

test('test/run-repro.sh keeps running the rest of the scripts after one fails, rather than stopping at the first failure', () => {
  const sh = readFileSync(RUNNER_PATH, 'utf8');
  assert.doesNotMatch(sh, /^set -e/m, 'must not use `set -e`, which would abort the loop on the first non-zero exit instead of running every script');
});

/* The invariant issue #6 is actually about is a *partition*: every .mjs
   file in test/ is executed by exactly one runner -- test.yml's
   `*.test.mjs` glob or run-repro.sh's `repro-*.mjs` glob. Asserting it
   this way is what makes it able to fail: counting repro-*.mjs files and
   re-globbing them with the same pattern cannot catch a file renamed
   *out* of both conventions (test/repro-foo.mjs -> test/foo-repro.mjs),
   which is exactly the rot that went unnoticed after #2. Any new
   convention needs adding here deliberately, rather than a file going
   quietly unrun. */
test('every .mjs file in test/ is claimed by exactly one runner -- none silently unrun', () => {
  const files = readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.mjs'));
  assert.ok(files.length > 0, 'expected test/ to contain .mjs files at all');

  const fastSuite = files.filter((f) => f.endsWith('.test.mjs'));      // test.yml
  const reproSuite = files.filter((f) => f.startsWith('repro-'));       // run-repro.sh

  const orphans = files.filter((f) => !fastSuite.includes(f) && !reproSuite.includes(f));
  assert.deepEqual(orphans, [], `these test/ files match neither runner's glob, so nothing executes them: ${orphans.join(', ')}`);

  const both = fastSuite.filter((f) => reproSuite.includes(f));
  assert.deepEqual(both, [], `these would be run twice, by both runners: ${both.join(', ')}`);

  assert.ok(reproSuite.length >= 10, `expected the repro suite to be substantial, found ${reproSuite.length}`);
});
