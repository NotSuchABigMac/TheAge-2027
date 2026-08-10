/* Issue: login accepted any PIN unchecked ("quiet failure") -- a wrong
   PIN was only ever discovered later, on the first score write's RLS
   rejection, by which point the user looked fully logged in. Structural
   sanity checks on the validate_tournament_pin migration and its client
   wiring, same "read the SQL/JS text, assert on it" style as
   client-errors-migration.test.mjs, since there's no real Postgres to run
   the migration against in CI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/005_validate_tournament_pin_rpc.sql');
const THROTTLE_MIGRATION_PATH = path.join(ROOT, 'supabase/migrations/006_validate_tournament_pin_distinguish_throttled.sql');

test('validate_tournament_pin RPC checks the real token and is rate-limited', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.validate_tournament_pin\(p_token text\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/, 'must pin search_path against the SECURITY DEFINER privilege-escalation vector, same as the other functions');
  assert.match(sql, /internal\.check_tournament_token\(p_token\)/, 'must reuse the existing check rather than re-deriving a second copy of the secret comparison');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.validate_tournament_pin\(text\) TO anon/);
});

test('validate_tournament_pin throttles after repeated wrong guesses instead of exposing a bare check', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS pin_validation_attempts/);
  assert.match(sql, /ALTER TABLE pin_validation_attempts ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON pin_validation_attempts FROM anon, authenticated/, 'the attempt log itself must not be directly readable/writable by anon');
  assert.match(sql, /recent_failures >= \d+/, 'must stop checking the token past some failure threshold');
  assert.match(sql, /RETURN false/, 'lockout path must return false without confirming/denying the real token');
});

test('supabase/migrations lists 005 as a migration', () => {
  const files = readFileSync(path.join(ROOT, 'test/client-errors-migration.test.mjs'), 'utf8');
  assert.match(files, /005_validate_tournament_pin_rpc\.sql/, 'client-errors-migration.test.mjs\'s exact migration-file-list assertion must include 005');
});

test('issue #16: 006 replaces validate_tournament_pin with a version that distinguishes throttled from invalid', () => {
  const sql = readFileSync(THROTTLE_MIGRATION_PATH, 'utf8');
  // CREATE OR REPLACE can't change a function's return type -- the old
  // boolean-returning signature must be dropped first.
  assert.match(sql, /DROP FUNCTION IF EXISTS public\.validate_tournament_pin\(text\)/);
  assert.match(sql, /CREATE FUNCTION public\.validate_tournament_pin\(p_token text\)/);
  assert.match(sql, /RETURNS text/, 'must widen the return type past a boolean so throttled/invalid are distinguishable');
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, public/);
  assert.match(sql, /internal\.check_tournament_token\(p_token\)/, 'must still reuse the existing check rather than re-deriving a second copy of the secret comparison');
  assert.match(sql, /RETURN 'throttled'/, 'the lockout path must return a distinguishable value, not the same false a wrong PIN gets');
  assert.match(sql, /RETURN 'invalid'/);
  assert.match(sql, /RETURN 'valid'/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.validate_tournament_pin\(text\) TO anon/);
  // The lockout check must still happen before the real token check, same
  // as 005 -- a throttled caller must not be able to use response timing
  // (or anything else) to still probe the real token.
  const lockoutIdx = sql.indexOf("RETURN 'throttled'");
  const checkIdx = sql.indexOf('internal.check_tournament_token');
  assert.ok(lockoutIdx > 0 && checkIdx > 0 && lockoutIdx < checkIdx, 'the throttle check must come before the real token check');
});

test('supabase/migrations lists 006 as the newest migration', () => {
  const files = readFileSync(path.join(ROOT, 'test/client-errors-migration.test.mjs'), 'utf8');
  assert.match(files, /006_validate_tournament_pin_distinguish_throttled\.sql/, 'client-errors-migration.test.mjs\'s exact migration-file-list assertion must include 006');
});

const APP_PATH = path.join(ROOT, 'scorecard-live.html');

test('confirmUsername() actually validates the PIN before letting the user in', () => {
  const js = readFileSync(APP_PATH, 'utf8');
  assert.match(js, /async function validateTournamentPin\(token\)/);
  assert.match(js, /\/rest\/v1\/rpc\/validate_tournament_pin/);
  assert.match(js, /async function confirmUsername\(\)/, 'confirmUsername must await the PIN check rather than accepting input synchronously');
  const fnMatch = js.match(/async function confirmUsername\(\)[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'expected to find confirmUsername() body');
  const fn = fnMatch[0];
  assert.match(fn, /await validateTournamentPin\(token\)/);
  assert.match(fn, /if \(result === 'invalid'\)/, 'must branch on a confirmed-wrong PIN');
  // A confirmed-wrong PIN must never reach completeLogin (which persists
  // the token to sessionStorage and hides the modal) -- the `return`
  // inside the `if (result === 'invalid')` block is what keeps the modal
  // open/reopened instead of silently letting a wrong PIN through.
  const wrongBranch = fn.slice(fn.indexOf("if (result === 'invalid')"), fn.indexOf("if (result === 'throttled')"));
  assert.match(wrongBranch, /return;/, 'the wrong-PIN branch must return before completeLogin() runs');
  assert.doesNotMatch(wrongBranch, /completeLogin/);
});

test('issue #16: a throttled RPC answer is treated as "couldn\'t confirm", not as a confirmed-wrong PIN', () => {
  const js = readFileSync(APP_PATH, 'utf8');
  const fnMatch = js.match(/async function confirmUsername\(\)[\s\S]*?\n}\n/);
  const fn = fnMatch[0];
  assert.match(fn, /if \(result === 'throttled'\)/, 'must branch on the RPC being rate-limited, distinct from a confirmed-wrong PIN');
  const throttledBranch = fn.slice(fn.indexOf("if (result === 'throttled')"), fn.indexOf('} catch (e)'));
  // Unlike the 'invalid' branch, this one must let the scorer in
  // provisionally -- a throttled answer means the token was never
  // actually checked, so refusing login here would let a third party
  // (the RPC is reachable by anyone, not just real scorers) lock every
  // legitimate scorer out by keeping the shared lockout engaged.
  assert.match(throttledBranch, /completeLogin\(name, token\)/, 'a throttled answer must still let the scorer in provisionally');
  assert.doesNotMatch(throttledBranch, /Wrong PIN/, 'must not tell the user their PIN is wrong when it was never actually checked');
});

test('a network/timeout failure (offline course wifi) is distinguished from a confirmed-wrong PIN', () => {
  const js = readFileSync(APP_PATH, 'utf8');
  const fnMatch = js.match(/async function confirmUsername\(\)[\s\S]*?\n}\n/);
  const fn = fnMatch[0];
  assert.match(fn, /catch \(e\)/, 'must handle validateTournamentPin() throwing (unreachable Supabase) separately from a false return value');
  const catchBlock = fn.slice(fn.indexOf('catch (e)'));
  assert.match(catchBlock, /completeLogin\(name, token\)/, 'an unreachable Supabase must not lock the scorer out entirely -- the write-time auth check is still the backstop');
});
