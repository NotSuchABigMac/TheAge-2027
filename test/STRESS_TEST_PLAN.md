# Wonga Cup — Full-Tournament Stress Test Plan ("14 Imperfect Golfers")

## 1. Objective

Simulate the entire 2026 tournament — 14 golfers, 3 days, ~14 phones — at
compressed timescale, using automated browser agents that behave like real
people: they mostly do the right thing, but every now and then they tap the
wrong button, fat-finger a number, lose signal walking to the 12th tee, or
reload the page mid-entry. The goal is not to prove the happy path (the unit
tests in `test/*.test.mjs` already cover the pure logic) — the goal is to
**break the sync layer** the way a real weekend would, before the real
weekend does.

The test passes if, after all the chaos, **every device converges on the
same scoreboard** and that scoreboard is exactly what you get by replaying
the server's transaction log from scratch. Golf-correctness of individual
scores is explicitly *not* the oracle — a mis-tapped 7 that nobody corrected
is a legitimate input. Consistency is the oracle.

## 2. What we are trying to break

Each of these maps to a class of bug this app has already had once (issue
numbers from TODO.md). The agents are designed to re-create the *conditions*
of those bugs, plus their untested neighbours:

| # | Target failure mode | Provoked by | History |
|---|---|---|---|
| T1 | Two devices clobber each other's fields | concurrent scoring of the same match/group from 2+ devices | #62, #71 |
| T2 | Same player assigned to two Day 1 matches / two Day 2 groups / both teams | two devices picking the same player within one 30s poll window | #147, #71 |
| T3 | Remote clear undone by stale input box | one device clears a manual score while another has the box rendered | #142 |
| T4 | Focus/keyboard lost mid-entry, or `<details>` slammed shut by a poll | typing hole scores continuously across poll boundaries | #143, #148 |
| T5 | Offline queue loses/duplicates/reorders writes | airplane-mode stretches, then reconnect floods; wrong PIN mixed in | #66, #141 |
| T6 | Rollback divergence / infinite reload loop | admin rollback while other devices are mid-write and mid-poll | #140, #153, #154 |
| T7 | Restore resurrects stale state | admin restores an old row over newer deltas | #132, #71 |
| T8 | Sync cursor wedged by a bad row | forged/malformed rows injected directly into the log | #63, #109, #120 |
| T9 | Manual-vs-hole-data precedence flapping | manual front9/back9 set, then hole scores arrive, then holes cleared | #124 |
| T10 | Day lock races | admin locks a day while scorers have queued writes for it | #168 |
| T11 | Slow client / from-epoch replay divergence | a fresh device joining late on Day 3 must replay ~2,000 rows and match everyone | design invariant |
| T12 | localStorage state corrupted by any of the above surviving a reload | every agent reloads periodically | #166 |

## 3. Test architecture

```
test/stress/
  PLAN.md            (this file, or leave plan at test/STRESS_TEST_PLAN.md)
  run.mjs            orchestrator: spawns server + agents, runs scenario, runs oracles
  server.mjs         static server for the repo, serving a per-run patched scorecard-live.html
  supamock.mjs       PostgREST-subset mock of Supabase (default backend) + fault injection
  persona.mjs        the imperfect-agent behaviour model (seeded RNG)
  scenario.mjs       the 3-day timeline script (§6)
  oracles.mjs        invariant checks (§7)
  ledger/            JSONL action ledgers + captured state per run
```

- **Runner:** Playwright with the pre-installed Chromium. **14 isolated
  browser contexts** (one per golfer's phone), each with its own
  localStorage/sessionStorage, all pointed at the local server. Contexts are
  cheap; 14 in one browser process is fine. Mobile viewport (390×844) so we
  exercise the same layout real phones use.
- **App under test:** the real `scorecard-live.html`, byte-for-byte except
  one substitution at serve time: `SUPABASE_CONFIG.apiUrl` → the local mock,
  and `tournamentId` → `wonga-stress-<runid>`. No test hooks are added to
  the page — agents interact only through the DOM, like thumbs do.
- **Backend, default mode — `supamock.mjs`:** a ~150-line Node server
  implementing exactly the surface the app uses:
  - `POST /rest/v1/tournament_updates` (validates `write_token`, honours
    `Prefer: return=representation` + `select=id` for the rollback marker)
  - `GET /rest/v1/tournament_updates` with `select=`, `tournament_id=eq.`,
    `updated_at=gte.`, `order=`, `limit=` (including the 500-row page cap —
    T11 depends on pagination being real)
  - `POST /rest/v1/rpc/rollback_tournament_updates` (both-token check,
    delete-after-cutoff)
  - refuses `select=*` and any read of `write_token`, mirroring the RLS
    column grants, so a regression that reintroduces `select=*` fails loudly
  - **fault injection knobs** (driven by the scenario): per-request added
    latency (0–8s), probabilistic 500s, dropped responses (request lands,
    response never returned — the nastiest case for the retry queue),
    and 401s to simulate token trouble.
- **Backend, live mode (optional second pass):** the real Supabase project
  with `tournamentId=wonga-stress-<runid>` and real tokens from env vars
  (`WONGA_TEST_WRITE_TOKEN`, `WONGA_TEST_ADMIN_TOKEN`). Same scenario, no
  fault injection (we don't own the wire), rollback-to-epoch as cleanup.
  This validates the mock's fidelity and real RLS behaviour, and stays
  **strictly off** `wonga-cup-2026`.
- **Clock compression:** none needed in the app — the 30s poll and the
  scenario run in real time, compressed by playing holes faster than golfers
  do (§6). No app code is modified for the test.

## 4. The 14 imperfect agents

One agent per player in `PLAYERS` (ids 0–13), each a Playwright context plus
a persona. Roles reflect how the weekend actually works — not everyone
scores:

| Role | Count | Behaviour |
|---|---|---|
| **Scorer** | 6 (one per Day 1 match; 4 on Days 2–3, one per group) | Enters hole-by-hole scores for their match/group at the cadence in §6 |
| **Backseat scorer** | 2 | *Also* scores a match/group that already has a scorer, slightly out of sync — deliberate double-entry (T1) |
| **Kibitzer** | 5 | Browses tabs, opens/closes `<details>` grids, occasionally "helpfully" fixes a score or NTP — sometimes wrongly |
| **Admin** | 1 (James, id 3) | Everything a kibitzer does, plus team moves, group moves, day locks, field-history restores, and the rollback finale |

All 14 log in with the shared write token (one of them typos it first — §5).

### 4.1 The imperfection model (`persona.mjs`)

Every agent action goes through one function: `intend(action) → perform(maybeMutated(action))`.
A **seeded PRNG** (seed printed at run start, settable via `--seed`) drives
all mutation, so any failing run replays exactly. Per-action mutation table:

| Slip | Probability | Mechanics |
|---|---|---|
| Adjacent-cell tap | 4% | score meant for hole *n* goes into hole *n±1* (same row) |
| Wrong row | 2% | score goes to the other player's row (A↔B) in the same match |
| Wrong card | 1% | score goes to the same hole in a *different* match/group |
| Fat-finger digit | 3% | value ±1, or doubled digit ("5"→"55", exercising the clamp) |
| Accidental clear | 1.5% | select-all + delete on a field that had a value |
| Wrong dropdown pick | 3% of dropdown uses | picks the alphabetically-adjacent player, e.g. the wrong Freestun (T2, #147 eviction) |
| Premature manual result | once per scorer per day | sets the manual front9/back9 or Day 2 manual score even though hole entry is underway (T9) |
| Double-tap | 5% of taps | the same button/commit fired twice within 300ms |
| Mid-entry reload | 0.5% per action | reloads the page while a field has uncommitted text |
| Tab-sleep | per §6 schedule | context goes `setOffline(true)` for 1–6 min, keeps scoring into the queue, then reconnects (T5) |
| Notices & corrects | 65% of own slips | after 5–40s, the agent re-enters the value it meant — so the ledger contains realistic mistake→correction row pairs; the other 35% are never fixed and must simply stay consistent |

Every performed action — including the slips — is appended to a JSONL
**action ledger**: `{ts, agent, intent, performed, slipType, seedState}`.
The ledger is the ground truth for triage: when an oracle fails, we can say
"the divergence first appears after ledger line 1,207, which was Cayden's
wrong-row tap during Steve's offline window", and replay from the seed.

## 5. Login & setup phase (t = 0–3 min)

1. All 14 contexts open the page. One agent enters a **wrong write token**
   first (expects the modal to reopen per #141 — assert it does, and that
   `flushPendingWrites` doesn't hammer the bad token), then logs in
   correctly.
2. Admin sets both team names — one containing `<img src=x onerror=…>` and
   an emoji (standing XSS/escaping probe, #58). Assert it renders inert
   everywhere.
3. Admin runs the Captain's Draft: assigns all 14 players via `player_team`
   moves. Two kibitzers "help" simultaneously, moving players the admin just
   moved (T2). One player is moved A→B *after* being placed in a Day 1
   match slot (must trigger the #65 cascade clear on every device).

## 6. The three compressed days (~75 min total)

### Day 1 — Murray, 6 singles matches, hole-by-hole (~25 min)
- 12 players in matches (the two `friday:false` players are kibitzers today).
- 6 scorers enter 18 holes at **60–80s per hole** (jittered per group so
  poll cycles interleave differently every run).
- Both backseat scorers shadow-score matches 2 and 5, lagging 1–3 holes
  behind, occasionally disagreeing with the primary scorer on a hole — last
  write must win everywhere (T1).
- At hole 6: one scorer's device goes offline for 4 minutes mid-round (T5).
- At hole 9: admin sets a **manual back9 result** on a match that then gets
  back-nine hole scores (T9 precedence, then the "clear hole scores" escape
  hatch is used at hole 14).
- At hole 12: `supamock` turns on 20% dropped-responses for 90s (T5 — the
  app must neither lose nor duplicate those writes once the wire heals).
- Holes 8/17 NTP set by kibitzers; one sets the wrong player then corrects.
- End of day: admin locks Day 1 (T10) *while* one backseat scorer still has
  two queued writes for it — observe and record what wins (this is a
  known-unknown; whatever happens must at least be *consistent* across
  devices).

### Day 2 — Black Bull, 4-group Ambrose (~25 min)
- Admin builds groups (a4/a3/b4/b3); a kibitzer concurrently moves a player
  between groups mid-build (T2 for `day2_group`).
- 4 scorers enter scramble hole scores at 60–80s/hole; one group's scorer is
  a *rotating* duty — the device handoff is simulated by the old scorer
  going idle and a different agent's context taking over that group's grid.
- Anthem toggles: all 14 get set (some `true`, some `false`), two get
  toggled twice by different agents within one poll window, one is set on
  the wrong player and corrected (the handicap must re-derive everywhere).
- At hole 7: `supamock` adds 5s latency to all reads for 2 min — slow-client
  divergence (T11 in miniature): assert no device wedges or double-applies.
- At hole 13: one group's manual `day2_score` is typed by a kibitzer while
  hole entry continues (T9 — hole data must win once 18 holes complete).
- One agent force-reloads mid-word while typing a score (T4/T12).

### Day 3 — Lake, individual Stableford + the chaos finale (~25 min)
- All 14 stableford scores entered in a burst window (everyone finishes
  around the same time in reality). Three deliberate ties, including a tie
  spanning positions with fractional shared points; two scores entered as
  out-of-range ("75", "-3") to hit both clamps.
- **Late joiner (T11):** a 15th context with empty storage opens the page
  now and must replay the entire log (paginated) to an identical scoreboard.
- **Forged-row probe (T8):** the harness POSTs directly to the backend (not
  through any page) a batch of hostile rows — `field_key: "__proto__"`,
  `day2_score`/`field_key:"ntp"`, `match_idx: 99`, `value: "NaN"`, an
  unknown `update_type` — all with the valid token (any phone-holder could).
  Every device must skip them, keep polling, and stay converged (#63/#109/#120).
- **Rollback finale (T6, #153):** admin rolls back to a cutoff 10 min ago —
  *while* one device is offline holding queued writes and another is
  mid-poll. Assert: every online device wipes + reloads exactly once (no
  reload loop — watch for repeated `rollback` handling in console logs), the
  offline device does whatever it does *and then converges after reconnect*,
  and the admin's own pre-rollback queue does not resurrect deleted scores.
- Admin then **restores** three rows via Field History, including a
  `player_team` row (cascade warning path, T7). Assert `team_assign`
  restore is impossible (button absent/disabled).
- Re-enter the 10 minutes of rolled-back Day 3 scores; set the tiebreak if
  totals tie (the scenario seeds scores so roughly 1 run in 4 needs it).

## 7. Oracles (run at end of each day and at final quiescence)

Quiescence = all agents stopped, all pending queues empty (asserted via
localStorage `wongaCup2026_pendingWrites` on every context), plus two full
30s poll cycles.

1. **Cross-device convergence:** for each of the 14 (+1 late-joiner)
   contexts, read `localStorage.wongaCup2026`, run it through
   `normalizeState`, and deep-compare. All 15 must be identical (team Sets
   compared as sorted arrays).
2. **Replay oracle:** fetch the full server log, fold it through
   `applyUpdateToState` in Node (importing the real `scoring.js` — the same
   code the page runs), and deep-compare with the converged device state.
   Incremental replay ≡ from-epoch replay is this app's core contract.
3. **Displayed-total oracle:** scrape the rendered scoreboard totals from 3
   sampled devices and compare against Node-side recomputation
   (`sumMatchPoints` + `calcDay2` + `computeStableford`/`sumStablefordPoints`
   + `ntpTeamPoints` + `resolveOverallWinner`) from the converged state.
4. **Structural invariants:** no player in both teams (`dedupeTeams` finds
   zero dupes), in >1 Day 1 match, or >1 Day 2 group; every hole score
   within its clamp range; every `day3` score within 0–60.
5. **No lost/duplicated writes:** server row count == accepted-insert count
   from the action ledger (± rollback deletions, exactly once each). Dropped-
   response writes must appear **exactly once**.
6. **Client health:** zero uncaught exceptions / unhandled rejections on any
   page (Playwright `pageerror` listeners run for the whole session); no
   context reloaded more than once per rollback (T6 loop detector); no poll
   gap > 90s on any online device (cursor-wedge detector, T8).
7. **Log hygiene:** every row in the server log has a valid shape; cursor
   monotonicity — no device ever applied a row twice (checked via a
   mock-side per-device fetch journal cross-referenced with
   `wongaCup2026_lastSyncIds`).

Any oracle failure ⇒ run fails; artifacts saved: seed, full ledger, server
log dump, every context's localStorage, and a Playwright trace of the
divergent context.

## 8. Staged execution

| Stage | What | Duration | When |
|---|---|---|---|
| S0 smoke | 3 agents, Day 1 only, no slips (probabilities zeroed) | ~10 min | while building the harness — proves harness ≠ source of flakes |
| S1 full | the scenario above, mock backend, default slip rates | ~80 min | main development loop; run ≥5 different seeds |
| S2 cranked | slip probabilities ×3, fault injection ×2, poll jitter ±10s | ~80 min | after S1 is green on 5 seeds |
| S3 live | S1 scenario, real Supabase, isolated tournament_id, no wire faults | ~80 min | once, before the trip; validates real RLS + rollback RPC |
| S4 soak (optional) | S1 at half speed, 3 real hours | 3 h | overnight, catches slow leaks / cursor drift |

Not wired into CI push builds (an 80-minute Playwright run doesn't belong
there); expose as `npm run stress` locally and a manual
`workflow_dispatch` GitHub Action for S1.

## 9. Explicit non-goals

- **Golf-rule correctness of individual entries** — covered by unit tests;
  here, a wrong score that stays consistent everywhere is a pass.
- **Load testing Supabase** — 14 phones polling every 30s is ~0.5 req/s;
  Supabase does not care. The stress here is *concurrency semantics*, not
  volume.
- **Testing on real iOS Safari** — Playwright Chromium only. One manual
  phone pass during S3 is the pragmatic stand-in.
- **Auth brute-force / security pen-testing** — the forged-row probe (T8)
  uses the valid token deliberately; RLS itself is covered by the migration
  design notes and a couple of S3 spot checks (`select=*` must 401/403,
  `write_token` unreadable).

## 10. Build order (when implementation starts)

1. `supamock.mjs` + contract test replaying `test/scoring.test.mjs`-style
   fixtures through real HTTP (half a day — and immediately reusable for
   local dev of the page itself).
2. `server.mjs` (config-patching static server) + one Playwright context
   logging in and entering one score end-to-end (the walking skeleton).
3. `oracles.mjs` — convergence + replay oracles first; they're the payoff.
4. `persona.mjs` slips + ledger; zero probabilities = S0.
5. `scenario.mjs` Day 1 → S1 for Day 1 only; then Days 2–3; then the
   rollback finale last (it needs everything else working to be meaningful).

---

## 11. Implementation notes (added after building it — issue #176)

The harness is built and lives in `test/stress/`. Things learned in the
build that the plan above got wrong or didn't anticipate, recorded here
because every one of them cost real time and would cost it again:

### The harness must model the gesture, not the intent

Four separate false failures all had the same root cause — the harness
predicting what the app *should* do instead of modelling what a person
actually does:

- **`fill()` does not fire `change`.** The Day 1/Day 2 hole grids commit
  on `change`, so a fill alone wrote nothing and 18 holes produced 17
  writes, each one gesture late. `commitOnce()` fills and explicitly
  blurs. `probe.mjs` measures this against the live page and should be
  run before any full run — it is the tripwire for the app's commit
  semantics changing under the test.
- **One agent is one pair of thumbs.** Running an agent's own actions
  concurrently (the obvious reading of `Promise.all` over a scenario
  step) is impossible for a real person, and it manufactured
  spectacular-looking sync bugs: one player's score written under
  another player's id, and digits concatenated into a value that clamped
  to 60. Per-agent gestures are serialised; concurrency *between*
  devices is the thing under test and is untouched.
- **The app clamps.** A fat-fingered `88` is stored as `15`. A ledger
  keyed on what was typed matches no row and reads as a lost write.
- **Re-entering a value a field already holds writes nothing**, so it
  must not be recorded as a commit.

### Quiescence is a property, not a duration

"Agents stopped + N poll cycles" is not enough. The app flushed a queued
write 37s after the last agent action, and two devices hadn't polled in
the 29s that remained — the oracle reported a one-cell divergence that
was only the clock running out. Quiescence is now: every device's sync
cursor has reached the newest row, and no queue is non-empty. A device
that genuinely cannot catch up is a reported finding rather than
something silently waited out.

### One action ≠ one row, and totals can't be made exact

Clearing a nine writes one null per scored hole; "Save Names" rewrites
both `team_name` rows; the nine-result control is a *toggle*, so a
double-tap sets and then clears. Ledger lines therefore declare
`expectedValueRows` (`null` = unpredictable) rather than being counted
one-per-gesture.

More fundamentally, **totals are timing-dependent and cannot be made
exact**: a write whose response was dropped lands once if the client
never retried within the run and twice if it did. The write oracle is
therefore per-content-key, asking two separate questions — did every
gesture produce a row, and did any content appear more often than the
agent performed it beyond what a recorded ghost explains. This is also
sharper than a total, which can be cancelled out by a loss and a
duplicate in the same run.

### A device that has never seen a row is not empty

`scorecard-live.html` seeds `teamA`/`teamB` from `DEFAULT_A` and names
the teams client-side, with no rows in the log behind it. From-epoch
replay must start from that same seed. Worth knowing independently: with
no `player_team` rows in the log, **team membership is whatever the
shipped bundle says**, so two phones on different app versions would
disagree with no log evidence explaining it.

### Cross-device agreement is not sufficient on its own

In the run that found #212, the convergence oracle **passed** — all 15
devices agreed. They were uniformly wrong. The from-epoch replay oracle
is what caught it. Keep both.

## 12. Findings

| # | Finding | Status |
|---|---|---|
| [#212](https://github.com/NotSuchABigMac/wonga-cup/issues/212) | Rollback does not clear other devices: `location.reload()` doesn't stop the JS that immediately restores every key just deleted, so every device except the organiser's keeps the rolled-back scores | open; `repro-rollback.mjs` exits non-zero while present |

`--skip-rollback` exists so the rest of the suite stays useful while #212
is open. It is not a suppression — without it, the run correctly fails.
