/* Issue #202 -- structural sanity checks on the client_errors migration
   and its wiring, the same "read the SQL/config text, assert on it"
   style as deploy-artifact.test.mjs, since there's no real Postgres to
   run the migration against in CI (and the instructions are explicit:
   never touch the real Supabase project). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/004_client_errors.sql');

test('004_client_errors.sql exists and is the next migration in sequence', () => {
  assert.ok(existsSync(MIGRATION_PATH), 'expected supabase/migrations/004_client_errors.sql to exist');
  const files = readdirSync(path.join(ROOT, 'supabase/migrations')).filter((f) => f.endsWith('.sql')).sort();
  assert.deepEqual(files, [
    '001_lock_down_tournament_updates.sql',
    '002_restrict_write_token_column_and_admin_secret.sql',
    '003_move_secrets_off_database_guc.sql',
    '004_client_errors.sql'
  ]);
});

test('client_errors is locked down at least as tightly as the issue requires', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS client_errors/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  // Only INSERT is ever granted to anon -- no SELECT/UPDATE/DELETE grant
  // anywhere in the file (issue #202: "no SELECT/UPDATE/DELETE grants to
  // anon at all").
  assert.match(sql, /GRANT INSERT ON client_errors TO anon/);
  assert.doesNotMatch(sql, /GRANT SELECT[^\n]*client_errors/i);
  assert.doesNotMatch(sql, /GRANT UPDATE[^\n]*client_errors/i);
  assert.doesNotMatch(sql, /GRANT DELETE[^\n]*client_errors/i);
  // Gated by the same write_token check as tournament_updates (issue's
  // own recommended decision), not a bespoke/duplicate check.
  assert.match(sql, /internal\.check_tournament_token\(write_token\)/);
});

test('error-beacon.js is loaded on every static page and scorecard-live.html', () => {
  const pages = ['index.html', 'golfers.html', 'practical.html', 'records.html', 'format.html', 'print-cards.html', 'scorecard-live.html'];
  for (const page of pages) {
    const html = readFileSync(path.join(ROOT, page), 'utf8');
    assert.match(html, /<script src="error-beacon\.js\?v=__CACHEBUST__"><\/script>/, `expected ${page} to load error-beacon.js`);
  }
});

test('error-beacon.js posts to the client_errors endpoint with the write_token field', () => {
  const js = readFileSync(path.join(ROOT, 'error-beacon.js'), 'utf8');
  assert.match(js, /\/rest\/v1\/client_errors/);
  assert.match(js, /write_token:\s*token/);
  // Never touches scoring's own retry queue (issue's explicit requirement).
  assert.doesNotMatch(js, /pendingWrites/);
});
