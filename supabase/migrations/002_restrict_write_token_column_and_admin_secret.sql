-- Wonga Cup — restrict write_token column visibility + separate admin
-- secret (issues #105 reopened, #145, #146)
--
-- Run this manually (Supabase dashboard -> SQL Editor) AFTER
-- 001_lock_down_tournament_updates.sql, against the same project. As with
-- 001, nothing here can be applied by the app itself -- it only ever holds
-- the anon publishable key.

-- ── #105 (reopened): write_token was readable by anyone ─────────────────
-- 001's `anon_select` policy (`FOR SELECT TO anon USING (true)`) controls
-- ROW visibility, not COLUMN visibility -- table-level SELECT still let
-- anon read every column, including write_token, via a plain GET. That
-- made the "shared secret" gate on inserts pointless: read the token back
-- out with the same publishable key and forge writes with the real token
-- instead of none at all.
--
-- Row Level Security cannot restrict columns, so this uses Postgres
-- column-level privileges instead: revoke blanket SELECT, then grant it
-- back only on the columns the app actually needs to read. A `SELECT *`
-- (or any query naming write_token) now fails with a permission error for
-- anon; a query naming only the safe columns still works. The RLS
-- `anon_select` policy from 001 is unchanged and still governs which ROWS
-- are visible.
REVOKE SELECT ON tournament_updates FROM anon;
GRANT SELECT (
  id, tournament_id, update_type, match_idx, player_id,
  field_key, value, updated_by, updated_at
) ON tournament_updates TO anon;

-- The app's own fetches (loadFromSupabase(), loadFieldHistory()) now pass
-- an explicit select= column list matching the grant above, so this isn't
-- just relying on the database to reject a query the client never makes
-- in the first place -- see scorecard-live.html.

-- ── #145: pin search_path on the SECURITY DEFINER function ──────────────
-- A SECURITY DEFINER function without a pinned search_path is the classic
-- Postgres privilege-escalation vector (Supabase lint:
-- function_search_path_mutable) -- an object created earlier in an
-- attacker-writable schema on the caller's search_path could shadow an
-- unqualified reference inside the definer-context body. Signature is
-- changing (see #146 below) so this needs a DROP, not just
-- CREATE OR REPLACE (which only replaces an exact signature match).
DROP FUNCTION IF EXISTS rollback_tournament_updates(text, timestamptz, text);

-- ── #146: admin rollback gated on a separate secret from the shared
-- scoring write_token ──────────────────────────────────────────────────
-- Previously any of the ~14 scorers holding the one shared write_token
-- could invoke this destructive RPC directly (the `currentUsername ===
-- 'James McIntyre'` check is client-side UI only, never enforced
-- server-side). Add a second GUC, handed only to the organiser, and
-- require it in addition to the scoring token.
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
  IF p_write_token IS DISTINCT FROM current_setting('app.tournament_secret', true) THEN
    RAISE EXCEPTION 'invalid token';
  END IF;
  IF p_admin_token IS DISTINCT FROM current_setting('app.admin_secret', true) THEN
    RAISE EXCEPTION 'invalid admin token';
  END IF;
  DELETE FROM tournament_updates
    WHERE tournament_id = p_tournament_id AND updated_at > p_cutoff;
END;
$$;

GRANT EXECUTE ON FUNCTION rollback_tournament_updates(text, timestamptz, text, text) TO anon;

-- Set both secrets (the scoring PIN should already be set from 001; set
-- the new, separate admin PIN here -- hand it out to the organiser only,
-- never to the ~14 scorers):
--   ALTER DATABASE postgres SET app.tournament_secret = 'change-me';
--   ALTER DATABASE postgres SET app.admin_secret = 'change-me-too';

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   `select=write_token` on tournament_updates must fail (permission denied).
--   `select=id,update_type,value,...` (the safe column list) must still succeed.
--   rollback_tournament_updates with only the scoring token (no/blank
--     p_admin_token, or the wrong one) must fail with 'invalid admin token'.
--   rollback_tournament_updates with both correct tokens must succeed.
