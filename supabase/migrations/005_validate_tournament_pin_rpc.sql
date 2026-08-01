-- Wonga Cup — validate_tournament_pin RPC: give the login screen a real
-- answer instead of a quiet failure
--
-- Today the login modal (scorecard-live.html confirmUsername()) accepts
-- whatever PIN is typed with zero validation. The only place a wrong PIN
-- is ever actually discovered is the first score write, when RLS on
-- tournament_updates rejects the insert -- by which point the user has
-- already closed the modal and looks fully logged in. That's the "quiet
-- failure": wrong credentials are silently accepted and only surface
-- later, if at all.
--
-- 003 deliberately did NOT expose internal.check_tournament_token() as a
-- public RPC, because a bare boolean "does this token match" endpoint is
-- a clean brute-force oracle -- see that migration's comments. This
-- migration adds a *rate-limited* public wrapper so the login screen can
-- get an immediate yes/no without reopening that hole: after a burst of
-- wrong guesses it stops even checking the token for a few minutes,
-- rather than confirming or denying anything.
--
-- The lockout is global (not per-IP/per-session) since there's no
-- reliable client identity available to an anon PostgREST caller here,
-- and this is a single-tournament tool for ~14 known scorers -- a shared
-- cool-down is an acceptable trade for not needing to trust a
-- spoofable client-supplied identifier. It throttles brute force to a
-- crawl without needing per-caller tracking.
--
-- Run this manually (Supabase dashboard -> SQL Editor) after 001-004,
-- against the same project -- nothing client-side can apply it.

-- ── Attempt log for the rate limit ───────────────────────────────────────
-- Locked down like app_secrets: RLS with no policies and no grants means
-- only the SECURITY DEFINER function below can ever read or write it.
CREATE TABLE IF NOT EXISTS pin_validation_attempts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pin_validation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pin_validation_attempts FROM anon, authenticated;

-- ── Rate-limited validation wrapper ──────────────────────────────────────
-- Only failed attempts are logged/counted -- a correct PIN never adds
-- friction for the other ~13 scorers on the same shared secret.
CREATE OR REPLACE FUNCTION public.validate_tournament_pin(p_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  recent_failures int;
  is_valid boolean;
BEGIN
  DELETE FROM pin_validation_attempts WHERE attempted_at < now() - interval '5 minutes';

  SELECT count(*) INTO recent_failures FROM pin_validation_attempts;
  IF recent_failures >= 20 THEN
    RETURN false; -- locked out: don't even check the token while throttled
  END IF;

  is_valid := internal.check_tournament_token(p_token);
  IF NOT is_valid THEN
    INSERT INTO pin_validation_attempts DEFAULT VALUES;
  END IF;

  RETURN is_valid;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_tournament_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_tournament_pin(text) TO anon;

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   POST /rest/v1/rpc/validate_tournament_pin {"p_token":"wrong"}   -- false
--   POST /rest/v1/rpc/validate_tournament_pin {"p_token":"<real>"}  -- true
--   SELECT * FROM pin_validation_attempts                          -- permission denied
--   20 wrong guesses inside 5 minutes, then a 21st with the *correct*
--     PIN -- still returns false until the oldest failed attempt ages out.
