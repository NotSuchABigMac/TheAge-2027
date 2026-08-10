/* Issue #21 -- structural sanity check on the tournament_updates index
   migration, same "read the SQL text, assert on it" style as
   pin-validation.test.mjs/client-errors-migration.test.mjs, since
   there's no real Postgres to run the migration against in CI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/007_index_tournament_updates.sql');

test('007 indexes tournament_updates on exactly the shape every poller queries', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE INDEX IF NOT EXISTS tournament_updates_tid_updated_at_id_idx/);
  assert.match(
    sql,
    /ON tournament_updates \(tournament_id, updated_at, id\)/,
    'column order must match the query shape: filtered on tournament_id, ranged on updated_at, tiebroken on id -- ' +
    'wrong order (e.g. updated_at before tournament_id) would not be usable for an equality filter + range scan'
  );
});

test('007 is additive (CREATE INDEX IF NOT EXISTS) rather than dropping/rebuilding anything', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.doesNotMatch(sql, /DROP (TABLE|INDEX)/i, 'must not drop existing schema -- this is a pure addition');
});
