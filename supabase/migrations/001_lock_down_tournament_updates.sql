-- Wonga Cup — lock down tournament_updates (issues #105, #106)
--
-- The Supabase publishable key ships in scorecard-live.html's page source
-- by design, so it can never be the security boundary -- Row Level
-- Security is. This migration must be run manually (Supabase dashboard ->
-- SQL Editor -> paste and run) against the project referenced by
-- SUPABASE_CONFIG in scorecard-live.html; nothing in the app's own code
-- can apply it, since the app only ever holds the anon publishable key,
-- never a service-role key or dashboard access.
--
-- After running this, set the actual passphrase once (replace the
-- placeholder -- pick anything, it just needs to match what you hand out
-- to the ~14 scorers and what you paste into the app's "Tournament PIN"
-- prompt on first save):
--   ALTER DATABASE postgres SET app.tournament_secret = 'change-me';

-- ── #106: insert-only for anon ──────────────────────────────────────────
-- RLS default-denies anything without a matching policy, but revoke
-- explicitly so a future GRANT can't silently reopen UPDATE/DELETE.
ALTER TABLE tournament_updates ENABLE ROW LEVEL SECURITY;
REVOKE UPDATE, DELETE ON tournament_updates FROM anon;

DROP POLICY IF EXISTS anon_select ON tournament_updates;
CREATE POLICY anon_select ON tournament_updates
  FOR SELECT TO anon USING (true);

-- ── #105: require a shared write_token on every insert ──────────────────
-- The token is NOT baked into the client bundle (that would be the same
-- hole as the publishable key itself) -- the app prompts for it once and
-- stores it in sessionStorage; distribute the real value out-of-band.
ALTER TABLE tournament_updates ADD COLUMN IF NOT EXISTS write_token text;

DROP POLICY IF EXISTS anon_insert_with_token ON tournament_updates;
CREATE POLICY anon_insert_with_token ON tournament_updates
  FOR INSERT TO anon
  WITH CHECK (write_token = current_setting('app.tournament_secret', true));

-- ── Admin rollback (issue #103) needs a privileged delete path now that
-- anon DELETE is revoked above -- expose it as a SECURITY DEFINER
-- function gated on the same token, instead of re-opening anon DELETE.
CREATE OR REPLACE FUNCTION rollback_tournament_updates(
  p_tournament_id text,
  p_cutoff timestamptz,
  p_write_token text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF p_write_token IS DISTINCT FROM current_setting('app.tournament_secret', true) THEN
    RAISE EXCEPTION 'invalid token';
  END IF;
  DELETE FROM tournament_updates
    WHERE tournament_id = p_tournament_id AND updated_at > p_cutoff;
END;
$$;

GRANT EXECUTE ON FUNCTION rollback_tournament_updates(text, timestamptz, text) TO anon;

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   UPDATE/DELETE on tournament_updates must fail.
--   INSERT without a matching write_token must fail.
--   INSERT with the correct write_token must succeed.
--   SELECT must still succeed (the board is not private).
