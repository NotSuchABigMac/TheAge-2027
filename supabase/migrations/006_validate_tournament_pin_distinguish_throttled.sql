-- Wonga Cup — distinguish a throttled answer from a confirmed-wrong PIN
--
-- 005's validate_tournament_pin() returns a bare boolean, and its lockout
-- path returns `false` -- the same value a genuinely wrong PIN gets.
-- validate_tournament_pin is granted to `anon` in the exposed `public`
-- schema, and the publishable key it's called with ships in every page's
-- source by design, so the RPC is reachable by anyone on the internet, not
-- just the ~14 real scorers. ~4 requests/minute is enough to keep the
-- 20-failures-per-5-minutes lockout permanently engaged: a trivial,
-- sustained login outage for the whole tournament, at near-zero cost to
-- the caller, because confirmUsername() (scorecard-live.html) currently
-- can't tell "the server checked and it's wrong" apart from "the server is
-- throttled and didn't check at all" -- both come back as `false` and
-- both refuse to log the scorer in.
--
-- This migration changes the return type from boolean to text so the
-- three cases are distinguishable: 'valid' | 'invalid' | 'throttled'. The
-- client (see scorecard-live.html's confirmUsername()) treats 'throttled'
-- the same way it already treats an unreachable Supabase: a provisional
-- login, with the real PIN check falling back to whatever
-- insertUpdate()'s existing 'auth' handling already does on first write.
-- This removes the DoS amplification (an attacker forcing every legitimate
-- scorer's PIN to read as "wrong") while keeping every anti-brute-force
-- property 005 added -- 'invalid' is still only returned when the token
-- was actually checked and failed, and failures still throttle exactly as
-- before.
--
-- Run this manually (Supabase dashboard -> SQL Editor) after 001-005,
-- against the same project -- nothing client-side can apply it.

-- Postgres can't change a function's return type with CREATE OR REPLACE;
-- the old boolean-returning signature has to go first.
DROP FUNCTION IF EXISTS public.validate_tournament_pin(text);

CREATE FUNCTION public.validate_tournament_pin(p_token text)
RETURNS text -- 'valid' | 'invalid' | 'throttled'
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
    RETURN 'throttled'; -- don't even check the token while throttled
  END IF;

  is_valid := internal.check_tournament_token(p_token);
  IF NOT is_valid THEN
    INSERT INTO pin_validation_attempts DEFAULT VALUES;
    RETURN 'invalid';
  END IF;

  RETURN 'valid';
END;
$$;

REVOKE ALL ON FUNCTION public.validate_tournament_pin(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_tournament_pin(text) TO anon;

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   POST /rest/v1/rpc/validate_tournament_pin {"p_token":"wrong"}   -- "invalid"
--   POST /rest/v1/rpc/validate_tournament_pin {"p_token":"<real>"}  -- "valid"
--   SELECT * FROM pin_validation_attempts                          -- permission denied
--   20 wrong guesses inside 5 minutes, then a 21st with the *correct*
--     PIN -- "throttled" (not "invalid") until the oldest failed attempt
--     ages out.
