---
name: fix-issue
description: End-to-end workflow for resolving a numbered GitHub issue in NotSuchABigMac/wonga-cup -- fetching the issue, scoping the fix, verifying it, and opening a PR. Use this whenever the user says something like "fix #123", "fix issue 123", "work on issue 45", or gives an issue number and asks for it to be resolved, even if they don't say the word "skill" or invoke it as a slash command.
---

# Fix Issue

A checklist for resolving one numbered issue in this repo without burning
more context than the fix needs. `CLAUDE.md` already covers this repo's
general token-hygiene norms (grep over full reads, subagents for
multi-file exploration) -- read it first if this session hasn't yet. This
skill is the workflow specifically for "fix #N".

## 1. Pull the issue yourself

Fetch the issue's title, body, and comments from GitHub
(`NotSuchABigMac/wonga-cup`, issue number from the request) instead of
asking the user to paste it in -- a bare number is enough to act on.

## 2. Scope to this issue, and only this issue

Fix what the issue describes. This repo's git history is almost entirely
one-issue-per-PR; if you notice unrelated cleanup while you're in there,
leave it out of this change rather than folding it in.

## 3. Orient before reading the big files

`scorecard-live.html` (340KB) and `scoring.js` (87KB) are too large to
read start-to-finish for a targeted fix. Use `ARCHITECTURE.md` as the
map first -- its `update_type` table and Security section point straight
at the relevant function (`applyUpdateToState`, `insertUpdate`,
`loadFromSupabase`, the RLS/RPC layer, etc.) -- then grep for that
specific function or `update_type` rather than opening either file whole.

## 4. Delegate multi-file tracing

If the issue's fix plausibly spans more than one file -- e.g. a sync bug
touching `scorecard-live.html`, `scoring.js`, and a migration -- hand the
root-cause tracing to a subagent (Explore or general-purpose) and bring
back only its conclusion. That keeps a dozen exploratory reads and dead
ends out of this session's context instead of accumulating them here.

## 5. Implement, then verify before calling it done

- Run `node --test test/*.test.mjs`.
- If the change is UI-visible, add or update a `test/repro-NNN-*.mjs`
  Playwright script, and confirm it fails before the fix and passes after
  (`git stash` the fix, run the repro, `git stash pop`) -- the repo's
  existing convention for this class of change.

## 6. Branch and PR

- Branch name: `claude/<short-slug>`, matching every other branch in this
  repo's history.
- Open the PR with `.github/pull_request_template.md`, filling in
  `Closes #N` if the fix fully resolves the issue, or `Part of #N` if
  it's one of several changes needed.

Only open the PR once implementation is done and tests pass -- a PR
against `trunk` should land in a mergeable, green state, not a
work-in-progress one.
