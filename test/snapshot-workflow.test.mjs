/* Issue #207 -- structural checks on the snapshot workflow itself
   (there's no real GitHub Actions runner to execute it against in this
   test suite, so this is the same "read the YAML/config text and
   assert on it" style as ci-workflow.test.mjs/deploy-artifact.test.mjs). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW_PATH = path.join(ROOT, '.github/workflows/snapshot.yml');

test('snapshot.yml exists, runs on a schedule and workflow_dispatch, and can push commits', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents:\s*write/);
});

test('snapshot.yml schedules an every-2-hours run scoped to 7-9 Aug specifically', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  // day-of-month 7-9, month 8 (August) -- the tournament dates, not just
  // "any day in August" or "every day forever".
  assert.match(workflow, /cron:\s*'0 \*\/2 7-9 8 \*'/, 'expected an every-2h cron scoped to day-of-month 7-9, month 8');
});

test('snapshot.yml runs the actual fetch script and commits only when the snapshot changed', () => {
  const workflow = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(workflow, /node scripts\/snapshot-tournament-updates\.mjs/);
  assert.match(workflow, /git diff --quiet/, 'expected a no-op guard so an unchanged snapshot is never committed');
  assert.match(workflow, /\[skip ci\]/, 'expected the commit message to skip re-triggering CI/deploy');
});

test('the fetch script it runs actually exists', () => {
  assert.ok(existsSync(path.join(ROOT, 'scripts/snapshot-tournament-updates.mjs')));
});
