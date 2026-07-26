# QA Audit — Deficit Inventory & Test Strategy

**Scope:** launch-readiness audit of the Wonga Cup live scorecard.
**Stack:** static site (GitHub Pages), vanilla JS. Pure scoring math in `scoring.js` (UMD, shared browser/Node), DOM + Supabase REST sync inline in `scorecard-live.html`, theme switching in `theme.js`.
**Test framework:** `node:test` + `node:assert/strict` (`test/scoring.test.mjs`, run by `.github/workflows/test.yml` on Node 22). No package.json, no dependencies — keep it that way.
**Baseline:** existing suite is green (all tests pass, fail 0).

Every "confirmed" behavior below was verified by executing `scoring.js` under Node, not inferred from reading.

---

## 1. Deficit Inventory

### F1 — CRITICAL: `computeStableford` infinite-loops on a NaN score; reachable from live sync

- **Target component:** `scoring.js` → `computeStableford()` (grouping loop, lines ~138–147) and `scorecard-live.html` → `computeDay3()` (score parsing, line ~1230).
- **Missing scenario:** a Day 3 score entry whose value is `null` or non-numeric arrives via a synced `tournament_updates` row. `applyUpdateToState('day3_stableford')` stores `null`; `computeDay3()` then computes `parseInt(null, 10)` → `NaN` (its guard only checks `!== undefined && !== ''`, so `null` slips through). `computeStableford`'s tie-grouping loop advances with `while (sorted[j].score === sorted[i].score) j++` — and since `NaN === NaN` is `false`, `j` never advances and `i = j` re-enters the same iteration **forever**.
- **Confirmed:** calling `computeStableford` with one NaN entry hangs the Node process indefinitely (a probe had to be killed after 120s).
- **Risk:** one row with `value: null` (or `'abc'`) and `update_type: 'day3_stableford'` **hard-freezes the browser tab of every device within one 30s poll cycle**. The poisoned value is saved to localStorage before render, so reload freezes again at init; clearing localStorage resets the sync cursor and re-fetches the poison row. Total, persistent outage of the scoring app mid-tournament. The `tournament_updates` table is publicly writable with the publishable key visible in page source, so this is triggerable by anyone, and also by any future code path that legitimately clears a Day 3 score.
- **Fix + prescriptive test design:** see Execution Brief 1.

### F2 — HIGH: `applyUpdateToState` applies hostile/malformed sync rows without validation

- **Target component:** `scoring.js` → `applyUpdateToState()`, `parseIntOrNull()`.
- **Missing scenarios & confirmed behavior:**
  1. `parseIntOrNull('garbage')` returns `NaN` (no isNaN guard, unlike `parseScoreToPar`). A `day1_match` row with `field_key:'pA', value:'garbage'` writes `NaN` into a match player slot.
  2. No `field_key` whitelist. Confirmed: a `day2_score` row with `field_key:'ntp'` **replaces the `state.day2.ntp` object with a string**, silently breaking Day 2 nearest-the-pin for that session; a `day1_match` row with `field_key:'type'` rewrites the match shape.
  3. Day 2 score values are clamped to ±20 only in the local input path (`day2InputState`). Synced values bypass the clamp: confirmed `day2GroupPoints(-999, 0)` yields 999 points, so one row can put a 3-day tournament beyond mathematical reach.
  4. `day1_match` `front9`/`back9` accept any string. `ninePoints('Z')` scores 0–0 (benign), but `front9 !== null` makes the match count as *decided* for `isDay1Complete()` and the win-banner logic.
- **Risk:** the sync table is the app's only trust boundary and is publicly writable. Each of these corrupts shared state on **every** device (rows replay identically everywhere), with no way to repair from the UI.
- **Fix + prescriptive test design:** see Execution Brief 2.

### F3 — MEDIUM: correct-but-unpinned edge cases (regression protection)

All confirmed correct today; none are asserted anywhere, so any refactor can silently regress them.

| # | Target | Scenario (confirmed behavior) | Risk if regressed |
|---|--------|-------------------------------|-------------------|
| 3a | `resolveOverallWinner` | Stale tiebreak with non-tied totals is ignored: `(21, 18, 'B')` → `{winner:'A', mode:'points'}` | A leftover sudden-death row from before a score correction hands the Cup to the wrong team |
| 3b | `computeStableford` | Entries beyond 14th place get 0 pts (`POS_PTS[k] \|\| 0`) | Roster growth silently mis-scores |
| 3c | `computeStableford` + `sumStablefordPoints` | All 14 players tied → 7.5 pts each, team sums 52.5/52.5 (total 105 conserved) | Tie-averaging drift changes the Cup total |
| 3d | `day2InputState` | Exact boundaries: `'20'`/`'-20'` accepted with `correction: null`; `'+5'` stores `'5'` | Off-by-one clamp regressions clobber legal scores |
| 3e | `applyUpdateToState` + `processUpdateRows` | `team_assign` with malformed JSON **throws** (`SyntaxError`) and is contained by `processUpdateRows` — batch continues, cursor advances (integration of the two is untested; only each half in isolation is) | Re-introduction of the issue #63 "wedged sync" failure |
| 3f | `reconcileMatchesAfterTeamMove` | `newTeam` of `null`/undefined → no-op, `changes: []` | Unassigning a player could wipe unrelated match results |
| 3g | `escapeHtml` | Non-string input is coerced: `escapeHtml(null)` → `'null'` | A refactor to `.replace` without `String()` throws on non-strings reaching innerHTML paths |
| 3h | `parseScoreToPar` | Partial parse accepted: `'12abc'` → `12` | Documents the contract relied on by `calcDay2` input handling |
| 3i | `sumMatchPoints` / `ntpTeamPoints` | Empty inputs → `{a:0, b:0}` | Init-order refactors crash the scoreboard before first render |

- **Test design:** see Execution Brief 3 (pure test additions, zero production-code changes).

### F4 — MEDIUM (backlog, not briefed): untestable inline logic in `scorecard-live.html`

The following critical-path logic lives inline in the page and cannot be exercised by the Node suite. Recommended follow-up: extract to `scoring.js` (same UMD pattern) with characterization tests first, then port.

- `normalizeState()` — migration/repair of stale localStorage blobs (doubles-era matches, `a2/b2` keys, missing `ntp`/`scores`). A crash here bricks the page at init.
- `pendingWrites` / `flushPendingWrites()` — the issue #66 offline retry queue. Ordering and re-queue-on-failure semantics are unpinned.
- `isDay1Complete` / `isDay2Complete` / `isDay3Complete` — gate the win banner and tiebreak UI. (`isDay3Complete` currently counts a synced `null` as "entered" — fixed as part of Brief 1.)
- `teamOf()` and `computeDay3()` parsing (partially covered by Brief 1).
- `theme.js` — theme fallback defaults and the postMessage edit-mode protocol; needs a ~20-line DOM stub, no dependency required.

**Not launch-blocking** given F1/F2/F3 land first, but should precede any further feature work on the page.

---

## 2. Test Strategy

1. **Order:** Brief 1 (fix + regression tests), then Brief 2 (hardening + tests), then Brief 3 (coverage pinning). Briefs 1 and 2 both touch `applyUpdateToState`; land 1 first, rebase 2.
2. **No new dependencies.** Everything runs under `node --test test/scoring.test.mjs` exactly as CI does today.
3. **Mocking policy:** none needed for Briefs 1–3 — all targets are pure functions. Sync rows are plain object literals shaped per `TODO.md`'s schema table; `applyFn` doubles are inline closures (the existing suite already models this — follow its patterns).
4. **Every new test must fail meaningfully:** for bug-fix tests (Briefs 1–2), first confirm the test fails/hangs against unfixed code, then apply the fix. For pinning tests (Brief 3) assert the *confirmed current* behavior listed above — if one fails, the production behavior drifted and the test caught it; do not "fix" the test to match.

Downstream execution briefs for each work item are filed as GitHub issues (and reproduced below) — each is self-contained and copy-pasteable to a junior coding model.

---

## 3. Downstream Execution Briefs

Each brief below is self-contained and copy-pasteable as a prompt to a junior coding model. Paste the named files where indicated.

### Brief 1 — Fix the NaN infinite loop in `computeStableford` (F1)

```text
You are implementing a precisely-specified bug fix plus regression tests. Follow this
brief exactly; do not refactor anything it does not name. Stack: vanilla JS, UMD module,
tests use node:test + node:assert/strict, no dependencies, run with
`node --test test/scoring.test.mjs`.

THE BUG
computeStableford() in scoring.js infinite-loops when any entry's score is NaN:
its tie-grouping loop advances with `while (j < sorted.length && sorted[j].score ===
sorted[i].score) j++;` and since NaN === NaN is false, j never advances past i, and
`i = j` repeats the same iteration forever. NaN reaches it in production because
computeDay3() in scorecard-live.html parses scores with
`parseInt(state.day3.scores[p.id], 10)` behind a guard that checks !== undefined and
!== '' but NOT !== null — and a synced day3_stableford row with a null value stores
null. Result: one bad sync row freezes every device's browser tab.

FIX — scoring.js, computeStableford()
At the top of the function, normalize every entry's score so anything that is not a
finite number becomes null, working on copies (the function must go on returning
fresh objects; do not mutate the caller's entries):
    const safe = entries.map(e => ({
      ...e,
      score: (typeof e.score === 'number' && Number.isFinite(e.score)) ? e.score : null
    }));
then sort `safe` instead of `[...entries]`. Change nothing else in the function.

FIX — scorecard-live.html, computeDay3()
Replace the score expression
    score: state.day3.scores[p.id] !== undefined && state.day3.scores[p.id] !== '' ? parseInt(state.day3.scores[p.id], 10) : null
with
    score: parseScoreToPar(state.day3.scores[p.id])
(parseScoreToPar is already destructured from WongaScoring in this file; it returns
null for null/undefined/''/non-numeric.)

FIX — scorecard-live.html, isDay3Complete()
Replace its body with
    return PLAYERS.every(p => parseScoreToPar(state.day3.scores[p.id]) !== null);
so a synced null no longer counts as an entered score for the win-banner gate.

TESTS — append to test/scoring.test.mjs, matching its existing comment/naming style
1) test('computeStableford treats a NaN score as not-entered instead of looping forever')
   entries: [{id:1,score:40,team:'A'},{id:2,score:NaN,team:'B'},{id:3,score:35,team:'B'}]
   - const sorted = computeStableford(entries)   // the call itself must terminate
   - assert.deepEqual(sorted.map(p => p.id), [1, 3, 2])   // NaN sorts last
   - assert.equal(sorted[2].pos, null); assert.equal(sorted[2].pts, 0)
   - assert.deepEqual(sumStablefordPoints(sorted), { a: 14, b: 13 })
2) test('computeStableford treats undefined and non-numeric scores as not-entered')
   entries with score: undefined and score: 'abc' → both get pos null / pts 0; a
   numeric entry in the same array still gets pos 1, pts 14.
3) test('a synced day3_stableford null value yields a null score, never NaN')
   - const state = makeState()   // reuse the existing makeState() helper
   - applyUpdateToState(state, { update_type:'day3_stableford', player_id:6, value:null })
   - assert.equal(parseScoreToPar(state.day3.scores[6]), null)
   - repeat with value:'null' (the string) — same assertion.
   (This pins the parsing contract computeDay3 now relies on.)

MOCKING: none. All targets are pure functions; sync rows are plain object literals.

VERIFICATION (do all three)
1. Before fixing, confirm test 1 hangs against the unfixed scoring.js (kill it) — proves
   the test reproduces the bug.
2. After fixing, `node --test test/scoring.test.mjs` → zero failures, including every
   pre-existing test (the copy-on-normalize change must not break them).
3. Confirm scorecard-live.html has no remaining `parseInt(state.day3.scores` call.

[PASTE scoring.js HERE]
[PASTE test/scoring.test.mjs HERE]
[PASTE the computeDay3/isDay3Complete section of scorecard-live.html HERE]
```

### Brief 2 — Validate sync rows in `applyUpdateToState` (F2)

```text
You are hardening one function against malformed/hostile rows from a publicly-writable
sync table, plus tests. Follow this brief exactly. Stack: vanilla JS UMD module, tests
use node:test + node:assert/strict, no dependencies, run with
`node --test test/scoring.test.mjs`. Land AFTER the computeStableford NaN fix.

CONFIRMED HOLES (all verified by execution)
a) parseIntOrNull('garbage') returns NaN → a day1_match row {field_key:'pA',
   value:'garbage'} writes NaN into a match player slot.
b) No field_key whitelist → a day2_score row {field_key:'ntp'} REPLACES the
   state.day2.ntp object with a string; a day1_match row {field_key:'type'} rewrites
   the match shape.
c) Day 2 scores are clamped to ±20 only in the local input path; synced values bypass
   it (a value of '-999' produces a 999-point swing via day2GroupPoints).
d) day1_match front9/back9 accept any string; 'Z' scores 0-0 but makes the match count
   as decided for completion/win-banner logic. Same class of hole for tiebreak.

FIX — scoring.js
1) parseIntOrNull: after parseInt, `return isNaN(n) ? null : n;`
2) Above applyUpdateToState add:
     const UPDATE_FIELD_KEYS = {
       day1_match: ['pA', 'pB', 'front9', 'back9'],
       day1_ntp:   ['h8', 'h17'],
       day2_score: ['a4', 'a3', 'b4', 'b3'],
       day2_ntp:   ['h4', 'h16'],
       day3_ntp:   ['h7', 'h14'],
       team_name:  ['A', 'B'],
       team_assign:['A', 'B']
     };
   First statement of applyUpdateToState:
     const allowed = UPDATE_FIELD_KEYS[row.update_type];
     if (allowed && !allowed.includes(row.field_key)) return;
   (update_types without field_key — day3_stableford, player_team, tiebreak — have no
   entry and are unaffected.)
3) day1_match result branch: coerce then whitelist —
     const val = (v === null || v === 'null') ? null : v;
     match[row.field_key] = (val === 'A' || val === 'B' || val === 'T') ? val : null;
4) day2_score case: parse and clamp, preserving the stored-as-string convention —
     const n = parseScoreToPar(v);
     state.day2[row.field_key] = n === null
       ? null
       : String(Math.max(DAY2_SCORE_MIN, Math.min(DAY2_SCORE_MAX, n)));
5) tiebreak case: `state.tiebreak = (v === 'A' || v === 'B') ? v : null;`
Do NOT change team_assign's JSON.parse throw — processUpdateRows containing it is the
documented contract (issue #63).

TESTS — append to test/scoring.test.mjs, reusing the existing makeState() helper.
Every hostile-row test asserts BOTH that the targeted field is untouched AND that the
call did not throw.
1) day1_match pA value 'garbage' → state.day1.matches[0].pA[0] stays null (assert it
   is null, and Number.isNaN(...) is false).
2) day2_score field_key 'ntp' → assert.deepEqual(state.day2.ntp, { h4:null, h16:null })
   — the object survives untouched.
3) day1_match field_key 'type' → match.type still 'singles'; field_key '__proto__' →
   no own property added, match shape unchanged.
4) day2_score value '999' → stored '20'; '-999' → '-20'; 'abc' → null; '-15' → '-15'
   (valid values still round-trip).
5) day1_match front9 value 'Z' → stored null; value 'A' still stored 'A'.
6) day1_ntp field_key 'h99' → state.day1.ntp gains no new key
   (assert.deepEqual(Object.keys(state.day1.ntp), ['h8','h17'])).
7) tiebreak value 'C' → state.tiebreak null; 'A' still works.
8) parseIntOrNull('abc') → null; parseIntOrNull('12abc') → 12 (partial parse is
   retained deliberately — pin it).

MOCKING: none; rows are object literals.

VERIFICATION
`node --test test/scoring.test.mjs` → zero failures including all pre-existing tests
(especially the applyUpdateToState suite — the whitelist must not reject any row shape
the app itself emits; cross-check emitted field_keys against the update_type table in
TODO.md).

[PASTE scoring.js HERE]
[PASTE test/scoring.test.mjs HERE]
[PASTE TODO.md HERE]
```

### Brief 3 — Pin confirmed edge-case behavior (F3)

```text
You are adding regression tests ONLY — zero production-code changes. Every behavior
below is confirmed correct in the current code; if a test fails, you have found a
regression or written the test wrong — never "fix" scoring.js to match. Stack:
node:test + node:assert/strict, no dependencies, run with
`node --test test/scoring.test.mjs`. Match the existing file's comment style
(section banners, issue references) and reuse its makeState() helper.

ADD THESE TESTS
1) resolveOverallWinner ignores a stale tiebreak when totals are not tied:
   (21, 18, 'B') → {winner:'A', mode:'points'}; (18, 21, 'A') → {winner:'B',
   mode:'points'}. Risk pinned: a leftover sudden-death row from before a score
   correction must not hand over the Cup.
2) computeStableford beyond 14 entries: 16 distinct scores → entries at index 14 and
   15 get pts 0 (POS_PTS exhausted), pos still assigned (15, 16).
3) All-14-way tie: 14 entries, same score, 7 per team → every pts === 7.5 and
   sumStablefordPoints → { a: 52.5, b: 52.5 } (105 total points conserved).
4) day2InputState exact boundaries: '20' → {changed:true, stored:'20',
   correction:null}; '-20' likewise; '+5' → {changed:true, stored:'5',
   correction:null} (plus-prefix parses, box not corrected).
5) Integration of team_assign bad JSON with processUpdateRows (issue #63 contract):
   rows = [ {update_type:'team_assign', field_key:'A', value:'{not json',
   updated_at:'...T00:00:00Z'}, {update_type:'team_name', field_key:'B', value:'X',
   updated_at:'...T00:00:01Z'} ] applied via
   processUpdateRows(rows, row => applyUpdateToState(state, row)):
   - result.failed.length === 1 and result.applied === 1
   - state.teamNameB === 'X' (the later row still applied)
   - result.lastUpdatedAt === the second row's timestamp (cursor advances)
   - state.teamA unchanged from makeState().
6) reconcileMatchesAfterTeamMove with newTeam null → returns the same matches and
   changes: [] (no result wiped when a player is unassigned rather than moved).
7) escapeHtml coerces non-strings: escapeHtml(null) === 'null',
   escapeHtml(123) === '123'.
8) parseScoreToPar partial parse: '12abc' → 12; '1e3' → 1 (parseInt semantics —
   deliberate, pin it).
9) Empty-input floors: sumMatchPoints([]) → {a:0,b:0}; ntpTeamPoints(null) → {a:0,b:0}
   (the function already guards with (holeTeams || [])).

MOCKING: none.

VERIFICATION: `node --test test/scoring.test.mjs` → all pass, zero production diffs
(`git diff --stat` must show only test/scoring.test.mjs).

[PASTE scoring.js HERE]
[PASTE test/scoring.test.mjs HERE]
```
