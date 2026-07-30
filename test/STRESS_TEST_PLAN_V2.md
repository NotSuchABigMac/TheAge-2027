# Stress Test v2 — Plan

Follow-up to `STRESS_TEST_PLAN.md` (built as issue #176). v1 answered
*"does the sync engine survive 14 imperfect golfers?"* — yes, with one
real bug ([#212](https://github.com/NotSuchABigMac/wonga-cup/issues/212)).

v2 answers a different and more uncomfortable question:

> **How much is that green worth?**

Everything below is ordered by confidence gained per hour spent, not by
how interesting it is to build.

---

## The problem v2 exists to solve

v1 found seven harness bugs and one app bug. That ratio is genuinely
ambiguous. It is consistent with *"the app is well-hardened after 170
issues of fixes"* — which I believe is largely true — but it is equally
consistent with *"the oracles aren't sensitive enough to see what's
there."* Nothing in v1 distinguishes those two readings.

Worse, three specific coverage holes are known and self-inflicted:

| Hole | Cause | Consequence |
|---|---|---|
| Same-millisecond row timestamps never tested | v1's mock assigns strictly-increasing timestamps by design | **#111's cursor-boundary logic — the reason `gte` + `LAST_SYNC_IDS` exists — was never exercised** |
| Every device permanently foregrounded | agents are Playwright pages that never background | the app has **no lifecycle handlers at all** (verified: no `visibilitychange`/`pagehide`/`pageshow`/`online`), so real phones in pockets behave differently from anything tested |
| Restores never ran in a green run | `--skip-rollback` returns before the restore phase too | T7 untested |

So: v2 is stages A→E. **Stage A is not optional** — every later stage's
result is only meaningful once A has established that the harness can
actually see a bug when there is one.

---

## Stage A — Prove the oracles can fail (mutation testing)

**Confidence bought: the highest of anything here.** Converts "we found a
bug" (one data point) into "we detect N of M known bug classes" (a
measured rate). Without this, every green in v1 and v2 is an assertion of
faith.

**Method.** Take the app's own history. Each of these bugs was real, was
fixed, and has a known signature. Re-introduce them one at a time as a
patch applied at serve time by `server.mjs` (which already rewrites the
page — this is the same mechanism, pointed at a different string), then
run S1 and assert **the harness fails, and fails for the right reason.**

Proposed mutation set, each mapped to the oracle that must catch it:

| # | Mutation (revert the fix) | Must be caught by | Historical issue |
|---|---|---|---|
| M1 | `restoreDay2()` writes the box only when non-null | convergence | #142 |
| M2 | `applyUpdateToState` `day1_match` stops evicting from other matches | structural (double-booked) | #147 |
| M3 | `resetTeams()` emits whole-roster `team_assign` snapshots | convergence / structural | #71 |
| M4 | Sync cursor uses `gt` instead of `gte` + id de-dup | replay (needs Stage B1's colliding timestamps to bite) | #111 |
| M5 | `processUpdateRows` lets one bad row abort the batch | replay + poll-gap detector | #63 |
| M6 | `applyUpdateToState` drops its re-clamping | structural (out-of-range) | #109 |
| M7 | `UPDATE_FIELD_KEYS` whitelist removed | structural / uncaught exception | #120 |
| M8 | `flushQueue` retries past an `auth` rejection | ledger (duplicates) | #141 |
| M9 | `escapeHtml` neutered on team names | scenario XSS assertion | #58 |
| M10 | `HANDLED_ROLLBACKS_KEY` tracking removed | reload-loop detector | #153 |

**Pass condition:** every mutation is caught, by the oracle named, within
one S1 run. Any mutation that survives is a **hole in the harness** and
must be fixed there before v2 continues — that is the entire point of the
stage.

**Report the result as a number.** "10/10 known bug classes detected" is a
statement about the test suite that a green run alone can never make.

**Effort:** ~1 day. Each mutation is a one-to-three-line string
replacement; the runs are 5 minutes each and can go in parallel.

---

## Stage B — Prove the mock isn't lying (fidelity)

v1's entire green rests on `supamock.mjs` being a faithful PostgREST
stand-in. It is *my model* of Supabase, and a wrong model produces
confident green about a fiction.

### B1. Colliding timestamps (do this first — it's free)

v1 deliberately made `updated_at` strictly increasing so replay order
would be total. That was the right call for v1 and it **removed the exact
condition #111 was about.** Real Postgres `now()` is transaction-scoped:
rows inserted in the same transaction share a timestamp to the
microsecond, and poolers can compress them further.

Add `--timestamp-collisions <rate>` to the mock: with probability *p*,
reuse the previous row's `updated_at` verbatim. Run S1 at p = 0.1 and
p = 0.3. This is what makes M4 above meaningful.

**What would fail:** a device permanently dropping a row that shares a
timestamp with its cursor, or re-applying one forever.

### B2. Live Supabase (S3 from v1, still not done)

Isolated `tournament_id=wonga-stress-<runid>`, real tokens from env, no
fault injection (we don't own the wire), rollback-to-epoch as cleanup,
**strictly off `wonga-cup-2026`.**

Specifically validates what the mock can only imitate:
- the real RLS policies (`select=*` denied, `write_token` unreadable)
- the real `rollback_tournament_updates` RPC and its two-token check
- real timestamp resolution and ordering
- real latency distribution and connection behaviour

**Cheap fidelity check worth adding:** run the same scenario against both
backends with the same seed and diff the resulting row streams
structurally (types, coordinates, ordering — not timestamps). A
divergence is a mock bug, and finding those is the point.

**Effort:** half a day, plus care with secrets.

---

## Stage C — Test how phones actually behave

This is the largest realism gap and, I suspect, the most likely place a
genuine bug is still hiding.

**The app has no lifecycle handling whatsoever.** Sync is a bare
`setInterval(pollOnce, 30000)`. Chrome throttles background timers to
roughly once a minute; iOS Safari suspends them entirely when the tab is
hidden or the phone is locked. A golfer's phone spends most of a round in
a pocket. Nothing in v1 tested that, because every Playwright page was
permanently visible and awake.

### C1. Backgrounding

Give each agent a realistic attention model: foreground while scoring
their hole, backgrounded for the walk to the next tee (1–4 minutes).
Playwright can drive this properly — `page.bringToFront()` on the sibling
page to hide the other, plus CDP `Emulation.setPageScaleFactor`/
`Page.setWebLifecycleState('frozen')` for a genuine freeze.

**Questions this answers, none of which we currently know:**
- Does a frozen-then-resumed device catch up, and how long does it take?
- Does the offline banner lie during that window?
- Does a queued write survive a freeze?
- With 14 phones mostly asleep, does the board a spectator sees ever
  actually converge, or is it permanently a minute or two stale?

**Suspected finding:** a resumed tab waits up to a full 30s interval
before its first poll, with no `visibilitychange` catch-up. If confirmed,
the fix is a three-line listener and the payoff is a board that's fresh
when you look at it — which is the whole product.

### C2. Real device pass

One manual round on an actual iPhone against the live-mode tournament id,
alongside the automated run. Chromium is not Safari, and fourteen of
these fourteen will be on phones.

**Effort:** C1 ~1 day, C2 an afternoon.

---

## Stage D — Adversarial edges v1 didn't reach

Small, cheap, each independently plausible.

### D1. Clock-skew rollback (highest value in this stage)

`rollbackScores()` computes its cutoff from the **client's** `Date.now()`,
while every row timestamp comes from the **server**. An organiser whose
phone clock is 20 minutes fast deletes 20 minutes more than they asked
for; 20 minutes slow and it deletes nothing while reporting success.

Test: skew the admin context's clock (Playwright can override `Date`),
issue a "last 15 minutes" rollback, assert the deleted window matches the
*intent* rather than the skewed arithmetic. I would expect this to fail,
and the fix — derive the cutoff server-side in the RPC — is small.

### D2. Two admins at once

The Admin tab is gated on `currentUsername === 'James McIntyre'` and the
username is a **dropdown selection with no credential**. Any of the 14 can
pick that name and get Day Lock and Field History/Restore. (Rollback is
additionally gated on the admin PIN; the other two are not.)

Test: two devices both identifying as the organiser, locking/unlocking the
same day and restoring the same field concurrently. Assert convergence.

### D3. localStorage exhaustion

`saveState()` swallows quota errors silently (`catch(e) {}`). A full
store means the page silently stops persisting, looks perfectly healthy,
and loses everything on reload. Test: fill the quota mid-round, assert
either that the user is told or that nothing is silently lost.

### D4. Hostile-but-valid content

Team names and usernames at max length, RTL text, zero-width joiners,
emoji that break naive string slicing. The XSS probe passes; encoding
edges are untested.

**Effort:** ~1 day for all four.

---

## Stage E — Close the v1 gaps

Bookkeeping, but it should be finished.

- **E1.** Fix #212, then run S1 **without** `--skip-rollback` on 3 seeds.
- **E2.** Restructure the skip so it brackets only the rollback, not the
  restore/re-entry/tiebreak phases that currently ride along with it —
  T7 has never run green.
- **E3.** Volume. S1 lands at 365–403 rows, under the 500-row page cap;
  only the cranked S2 runs (509, 524) paginate at all. A real 3-day
  tournament with hole-by-hole entry will be ~2,000 rows. Add
  `--volume` to pre-seed the log so the late joiner replays 4–5 pages,
  not one.
- **E4.** One S4 soak at real pace (~3 hours) for slow leaks and cursor
  drift.

---

## Suggested order and stopping rule

```
A  (mutation)         ──▶ B1 (collisions) ──▶ C1 (backgrounding)
                          B2 (live)           D1 (clock skew)
E2, E3 alongside      ──▶ E1 once #212 is fixed
```

**Stop when:** Stage A reports ≥9/10 detection, B1 and B2 are green, C1
has either found the resume-lag bug or shown there isn't one, and D1 is
resolved. E4 is genuinely optional.

**Don't** grow the slip table or add more agents. v1 showed the marginal
return on more chaos is low — the same handful of failure modes recur.
The gaps that remain are about *coverage of conditions*, not *volume of
mischief*.

---

## One caution, learned the hard way in v1

Almost every false failure in v1 came from the harness predicting what
the app *should* do rather than modelling what actually happens. Stage C
is the most exposed to this: browser lifecycle emulation is fiddly and it
is very easy to build a "backgrounded" page that is nothing like a
backgrounded page. **Before trusting any C result, verify the emulation
does what you think** — a `probe.mjs`-style measurement that confirms
timers really are throttled — exactly as the commit probe did for
`fill()`. A stage that can't demonstrate its own mechanism should not be
allowed to report findings.
