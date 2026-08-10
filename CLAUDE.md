# CLAUDE.md

Guidance for Claude Code sessions working in this repo. Keep this file
short — for depth, read `README.md` (what this is, running tests, deploy
mechanics, Supabase runbook, backup/restore, service-worker kill switch)
and `ARCHITECTURE.md` (data model, RLS/security design, scoring-rule
provenance). Don't duplicate that material here; link to it.

## What this is

A static site for the Wonga Cup golf tournament, with a Supabase-backed
live scorecard. Zero npm dependencies by design — no `package.json`, no
`node_modules`. Plain HTML/CSS/JS served from the repo root.

- `scorecard-live.html` — the live scorecard: score entry, sync, admin
  tools. The one page most feature work touches.
- `scoring.js`, `courses.js`, `theme.js` — DOM-free logic, `require()`-able
  from Node tests.
- `supabase/migrations/` — hand-run SQL migrations (nothing applies them
  automatically; see README's Supabase runbook before touching security
  behavior).
- `test/*.test.mjs` — fast Node test suite, runs in CI (`test.yml`) on
  every PR, and is what gates `deploy.yml`.
- `test/repro-*.mjs` — Playwright browser regression scripts, deliberately
  excluded from the `*.test.mjs` glob (need a browser). Run on their own
  schedule by `repro-scripts.yml` (issue #6) — not a required check, so a
  failure there doesn't block a PR, but it's no longer silent either.
  Run them all locally via `bash test/run-repro.sh`.

## Before you start

Read `ARCHITECTURE.md`'s relevant section instead of re-deriving the
design from the HTML/JS — especially before touching sync (`insertUpdate`/
`loadFromSupabase`/`applyUpdateToState`), RLS/tokens, or the rollback RPC.
Re-reading that file end-to-end for a small change wastes tokens; grep for
the specific `update_type` or migration number involved instead.

## Working here

- Run `node --test test/*.test.mjs` before considering a change done —
  it's fast, zero-dependency, and CI runs it on every PR.
- If the change is UI-visible, add or update a `test/repro-NNN-*.mjs`
  Playwright script and confirm fail-then-pass via `git stash` (see PR
  template's test-plan checklist).
- `test/docs-consistency.test.mjs` guards `README.md`/`ARCHITECTURE.md`
  cross-references — don't break those links or revert them to
  placeholders.
- Branch naming convention already in use: `claude/<short-slug>`. PRs use
  `.github/pull_request_template.md` — fill in the `Closes #N` /
  `Part of #N` line and the test-plan checklist rather than leaving them
  as placeholders.
- Cachebusting is handled entirely by `deploy.yml` at deploy time (`?v=
  __CACHEBUST__` → commit SHA) — never hand-edit those placeholders or
  invent your own versioning scheme in HTML/JS.
- The Supabase publishable key in `SUPABASE_CONFIG` is intentionally
  public; don't try to "fix" that or add a client-side secret. Real
  access control lives in the RLS migrations and `internal.*` RPCs — see
  ARCHITECTURE.md's Security section before changing anything
  auth-adjacent.

## Token/context hygiene for this repo

- `scorecard-live.html` and `scoring.js` are large (340KB / 87KB). Grep
  for the specific function/`update_type` you need rather than reading
  either file in full — both are organized so `applyUpdateToState()` and
  the `update_type` table in `ARCHITECTURE.md` are the entry points.
- For open-ended "where does X happen" questions, prefer a targeted grep
  or an Explore-type search over reading multiple whole files.
- For multi-file exploration (e.g. tracing a sync bug across
  `scorecard-live.html`, `scoring.js`, and a migration), delegate the
  search to a subagent and keep only its conclusion in the main session —
  don't pull 20 file reads into context just to answer one question.
- Long sessions spanning several unrelated issues: prefer starting a new
  session per issue over one long thread: this repo's history (see `git
  log`) is almost entirely one-issue-per-PR, and that maps cleanly to
  one-issue-per-session.
