## Summary
<!-- What changed and why, in a sentence or two. -->

## Issue
<!-- Use a closing keyword ("Closes #123", "Fixes #123", "Resolves #123")
     so the issue auto-closes the moment this PR merges into trunk.
     Only do this if the PR fully resolves the issue -- if it's partial
     work or one of several issues this PR touches, write "Part of #123"
     instead so it stays open. Multiple closes are fine on one line:
     Closes #123, Closes #124 -->
Closes #

## Test plan
- [ ] `node --test test/*.test.mjs` passes
- [ ] New/updated Playwright regression test in `test/repro-*.mjs` (if the change is UI-visible), confirmed fail-then-pass via `git stash`
- [ ] Inline `<script>` blocks syntax-checked (`new Function(...)`)
