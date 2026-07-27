-- Wonga Cup — move shared secrets out of database-level GUCs into a
-- locked-down table (follow-up to 001/002)
--
-- Storing secrets via `ALTER DATABASE postgres SET app.*` puts them in
-- Postgres's database-level configuration, which RLS and GRANT can't
-- restrict the way they can restrict a table: any role with catalog
-- access (e.g. anyone with Supabase dashboard/SQL Editor access) can read
-- it back out via `SHOW app.tournament_secret;` or `pg_db_role_setting`,
-- and some connection poolers echo GUC startup parameters to other
-- sessions. Neither `current_setting()`'s call site nor the GUC itself
-- can be scoped down further.
--
-- This migration replaces both GUCs with a table that RLS locks to
-- nobody (no policies, no grants to anon/authenticated), read only by
-- SECURITY DEFINER functions that return a boolean match result, never
-- the stored value. Run manually (Supabase dashboard -> SQL Editor)
-- after 001 and 002, against the same project.

-- ── Locked-down secrets table ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_secrets (
  key   text PRIMARY KEY,
  value text NOT NULL
);
ALTER TABLE app_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_secrets FROM anon, authenticated;

-- Seed with placeholders if this is the first time either secret is
-- configured; ON CONFLICT DO NOTHING so re-running this migration never
-- clobbers real passphrases already in place.
INSERT INTO app_secrets (key, value) VALUES
  ('tournament_secret', 'change-me'),
  ('admin_secret',      'change-me-too')
ON CONFLICT (key) DO NOTHING;

-- ── Non-exposed schema for the check functions ───────────────────────────
-- These functions must be callable from RLS policies on public tables
-- (which requires EXECUTE granted to anon), but must NOT be reachable as
-- a standalone PostgREST RPC endpoint -- a bare boolean "does this token
-- match" call is a clean brute-force oracle with none of the friction an
-- INSERT (leaves rows) or rollback call (destructive, needs other valid
-- params too) has. Supabase's PostgREST only auto-publishes functions in
-- the dashboard's configured "Exposed schemas" list (public by default),
-- so creating these in a separate schema keeps them invisible to the API
-- even though the `public.tournament_updates` policy can still call them.
--
-- After running this migration, confirm in the Supabase dashboard under
-- Project Settings -> API -> Exposed schemas that `internal` is NOT in
-- that list (it isn't, by default -- only `public`/`graphql_public` are).
CREATE SCHEMA IF NOT EXISTS internal;
GRANT USAGE ON SCHEMA internal TO anon;

CREATE OR REPLACE FUNCTION internal.check_tournament_token(p_token text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_secrets WHERE key = 'tournament_secret' AND value = p_token
  );
$$;

CREATE OR REPLACE FUNCTION internal.check_admin_token(p_token text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM app_secrets WHERE key = 'admin_secret' AND value = p_token
  );
$$;

REVOKE ALL ON FUNCTION internal.check_tournament_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION internal.check_admin_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION internal.check_tournament_token(text) TO anon;
GRANT EXECUTE ON FUNCTION internal.check_admin_token(text) TO anon;

-- ── Swap the insert policy from current_setting() to the check function ──
DROP POLICY IF EXISTS anon_insert_with_token ON tournament_updates;
CREATE POLICY anon_insert_with_token ON tournament_updates
  FOR INSERT TO anon
  WITH CHECK (internal.check_tournament_token(write_token));

-- ── Swap rollback_tournament_updates to use both check functions ────────
DROP FUNCTION IF EXISTS rollback_tournament_updates(text, timestamptz, text, text);
CREATE OR REPLACE FUNCTION rollback_tournament_updates(
  p_tournament_id text,
  p_cutoff timestamptz,
  p_write_token text,
  p_admin_token text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT internal.check_tournament_token(p_write_token) THEN
    RAISE EXCEPTION 'invalid token';
  END IF;
  IF NOT internal.check_admin_token(p_admin_token) THEN
    RAISE EXCEPTION 'invalid admin token';
  END IF;
  DELETE FROM tournament_updates
    WHERE tournament_id = p_tournament_id AND updated_at > p_cutoff;
END;
$$;

GRANT EXECUTE ON FUNCTION rollback_tournament_updates(text, timestamptz, text, text) TO anon;

-- ── Old GUCs are NOT reset here ──────────────────────────────────────────
-- `ALTER DATABASE postgres RESET app.*` requires superuser, which
-- Supabase's hosted `postgres` role does not have ("permission denied to
-- set parameter") -- the same restriction that likely kept 001/002's
-- `ALTER DATABASE ... SET app.tournament_secret` from ever actually
-- taking effect in the first place. That's harmless here: nothing below
-- reads those GUCs anymore, so a leftover (or never-set) value is just
-- inert dead config, not a functional or security issue.

-- ── Set the real passphrases (skip if already set correctly by the
-- ON CONFLICT DO NOTHING seed above; use this to change them) ───────────
--   UPDATE app_secrets SET value = '...'       WHERE key = 'tournament_secret';
--   UPDATE app_secrets SET value = '...'       WHERE key = 'admin_secret';

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   SELECT * FROM app_secrets                         -- permission denied.
--   POST /rest/v1/rpc/check_tournament_token           -- 404/not found
--     (function not in an exposed schema, so PostgREST never published it).
--   INSERT into tournament_updates with wrong/missing write_token -- fails;
--     with the correct write_token -- succeeds (same behavior as before).
--   rollback_tournament_updates with wrong/missing tokens -- fails;
--     both correct -- succeeds (same behavior as before).
