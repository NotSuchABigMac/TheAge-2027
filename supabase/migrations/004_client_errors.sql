-- Wonga Cup — client_errors: a write-only error beacon (issue #202)
--
-- During the tournament, breakage on one of ~14 devices currently
-- surfaces as "the site's cooked" in the group chat with zero detail.
-- This table gives the organiser the stack trace before anyone's
-- finished typing that message: window.onerror/unhandledrejection
-- fire-and-forget an insert here (see error-beacon.js). Nobody reads it
-- back client-side, so this is locked down even tighter than
-- tournament_updates -- anon may INSERT and nothing else, not even
-- SELECT. Reading is organiser-only, via the Supabase dashboard's table
-- editor (which uses the service-role key, not RLS).
--
-- Run this manually (Supabase dashboard -> SQL Editor) after 001-003,
-- against the same project -- nothing client-side can apply it.

CREATE TABLE IF NOT EXISTS client_errors (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id text NOT NULL,
  page          text,
  message       text,
  stack_head    text,
  ua            text,
  username      text,
  write_token   text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE client_errors ENABLE ROW LEVEL SECURITY;

-- Explicit revoke before granting back, same belt-and-braces posture as
-- 001's tournament_updates lockdown: a future GRANT can't silently
-- reopen something this migration deliberately left closed.
REVOKE ALL ON client_errors FROM anon, authenticated;
GRANT INSERT ON client_errors TO anon;

-- Same gate tournament_updates uses (issue #202's own recommendation) --
-- an ungated table is a free public write target for spam. A pre-login
-- error (no token yet in this browser session) simply never gets
-- reported; that's an acceptable trade against an open write endpoint.
-- Reuses 003's internal.check_tournament_token() rather than re-deriving
-- the same check against a second exposed function.
DROP POLICY IF EXISTS anon_insert_with_token ON client_errors;
CREATE POLICY anon_insert_with_token ON client_errors
  FOR INSERT TO anon
  WITH CHECK (internal.check_tournament_token(write_token));

-- No SELECT/UPDATE/DELETE policy at all -- deliberately stricter than
-- tournament_updates (issue #202: "no SELECT/UPDATE/DELETE grants to
-- anon at all"). RLS default-denies anything without a matching policy,
-- and the REVOKE ALL above means even a future stray policy addition
-- still needs an explicit GRANT to do anything.

-- ── Verify (run as an anonymous client, e.g. via curl with only the
-- publishable key) ──
--   INSERT without a matching write_token -- fails.
--   INSERT with the correct write_token -- succeeds.
--   SELECT (any columns) -- fails (permission denied).
