# Wonga Cup — Architecture Notes

See `README.md` for what this is, how to run tests, and how deploys work.
This file covers the data model, the Supabase/RLS setup, and the
provenance of each scoring rule.

## Supabase Schema: `tournament_updates` (transaction log)

Live sync is a per-change transaction log, not a single overwritten record —
each change is inserted as its own row, so two devices editing different
fields at the same time compose instead of one clobbering the other. This
is fully implemented in `scorecard-live.html`: `insertUpdate()` writes rows,
`loadFromSupabase()` fetches rows newer than the last sync and replays them
in order via `applyUpdateToState()` (`scoring.js`).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Auto-generated |
| tournament_id | text | e.g. `wonga-cup-2026` |
| update_type | text | see below |
| match_idx | int | Day 1 only — which match (0-5) |
| player_id | int | Day 3 stableford and `player_team` only — player ID |
| field_key | text | meaning depends on `update_type`, see below |
| value | text | The score/result/player-id value |
| updated_by | text | Username of who entered it |
| write_token | text | Shared passphrase required by RLS on insert (see below) |
| updated_at | timestamptz | When it was entered |

## Security: RLS lockdown (issues #105, #106, #145, #146, #151)

The Supabase publishable key ships in `scorecard-live.html`'s page source
by design — it is not a secret, so it cannot be the access control.
`supabase/migrations/001_lock_down_tournament_updates.sql`,
`002_restrict_write_token_column_and_admin_secret.sql`, and
`003_move_secrets_off_database_guc.sql` lock the table down at the
database level and **must all be run manually, in order**
(Supabase dashboard → SQL Editor) against the project in
`SUPABASE_CONFIG`; nothing client-side can apply them. After running all
three:

- `anon` can `SELECT` only the non-secret columns (see `SAFE_SELECT_COLUMNS`
  in `scorecard-live.html`) and `INSERT` (with a matching `write_token`),
  but not `UPDATE` or `DELETE` — the log is append-only from the app's
  perspective. `write_token` itself is excluded from anon's column-level
  `SELECT` grant (issue #105 reopened) — RLS only controls row visibility,
  not columns, so the original migration's `anon_select` policy let anyone
  read the shared secret straight back out via a plain GET and forge writes
  with the real token instead of none at all. Every read in the app now
  passes an explicit `select=` column list rather than the default `*`.
- The admin "Rollback Scores" control (issue #103) goes through a
  `rollback_tournament_updates` RPC instead of a raw `DELETE`, since anon
  `DELETE` is revoked; the RPC re-checks **two** tokens server-side (issue
  #146): the shared scoring `write_token` (same one all ~14 scorers hold)
  and a separate `p_admin_token` — handed only to the organiser, prompted
  for once client-side and cached in `sessionStorage`
  (`requireAdminToken()`) — so a destructive tournament-wide rollback no
  longer succeeds on the strength of the same token every scorer already
  has. The function also pins `search_path` (issue #145) against the
  classic `SECURITY DEFINER` privilege-escalation vector.
- **The two secrets live in a locked-down `app_secrets` table, not
  database GUCs (issue #151 / migration 003).** 001/002 originally set
  them via `ALTER DATABASE postgres SET app.tournament_secret = '...'` —
  this turned out to never actually work: Supabase's hosted `postgres`
  role isn't a true superuser, so that statement fails outright with
  `permission denied to set parameter`. Even where a platform did allow
  it, a GUC is readable by anyone with catalog access (`SHOW
  app.tournament_secret`) and some poolers echo GUC startup parameters to
  other sessions — RLS/GRANT can't restrict a GUC's visibility the way
  they can restrict a table. Migration 003 replaces both with a table
  (`app_secrets`, RLS-locked, zero grants to `anon`/`authenticated`) read
  only by two `SECURITY DEFINER` functions in a non-exposed `internal`
  schema — `internal.check_tournament_token(token)` /
  `internal.check_admin_token(token)` — that return a match boolean, never
  the stored value, and live outside `public` specifically so PostgREST
  never auto-publishes them as a standalone brute-force-able RPC. Set the
  real passphrases via `UPDATE app_secrets SET value = '...' WHERE key =
  'tournament_secret' | 'admin_secret'` and hand them out out-of-band;
  neither is ever baked into the client bundle.
- A wrong `write_token` is distinguished from a dropped connection
  (issue #141): `sendUpdateRow()` classifies the result as `'ok'` / `'auth'`
  / `'network'`, an `'auth'` result reopens the login modal instead of
  silently queuing the write as if offline, and `flushPendingWrites()`
  stops at the first `'auth'` rejection rather than re-failing the same
  wrong PIN against every queued write forever.
- **The login modal itself validates the PIN, instead of accepting it
  unchecked (migration `005_validate_tournament_pin_rpc.sql`).**
  Previously `confirmUsername()` never checked the PIN at all — it closed
  the modal on any non-empty input, and a wrong PIN was only ever
  discovered later, on the first score write's RLS rejection, by which
  point the user looked fully logged in. `confirmUsername()` now `await`s
  a `validate_tournament_pin` RPC before closing the modal: a confirmed
  wrong PIN clears the field and reopens/stays on the modal with an inline
  error instead of letting the user in. Since `internal.check_tournament_token`
  is deliberately not exposed as a public RPC (see above — a bare boolean
  check is a brute-force oracle), `validate_tournament_pin` wraps it with a
  rate limit: after 20 failed guesses inside a 5-minute window (tracked in
  `pin_validation_attempts`, itself RLS-locked with zero grants) it stops
  checking the token at all and just returns `false` until the window
  clears. The limit is global rather than per-caller since there's no
  trustworthy client identity to key it on for an anon PostgREST request —
  an acceptable trade for a single-tournament tool with ~14 known scorers.
  If the RPC can't be reached at all (offline/timeout on course wifi) the
  login proceeds provisionally rather than blocking a scorer with no
  signal — the existing write-time `'auth'` handling above is still the
  backstop that catches a genuinely wrong PIN once a real write is
  attempted.

## Supabase Schema: `client_errors` (write-only error beacon, issue #202)

`error-beacon.js` (loaded on all six pages) fire-and-forget inserts a row
here on every uncaught `error`/`unhandledrejection`, gated client-side by
a per-session cap, a dedupe set, and an ignore-list for known-benign
noise (`error-beacon.js`'s `shouldReport()`).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Auto-generated |
| tournament_id | text | e.g. `wonga-cup-2026` |
| page | text | Filename the error happened on |
| message | text | Truncated to 500 chars |
| stack_head | text | Truncated to 500 chars |
| ua | text | `navigator.userAgent` |
| username | text | From `sessionStorage`, if set |
| write_token | text | Same shared PIN as `tournament_updates`, gates the insert |
| created_at | timestamptz | Auto-generated |

Locked down tighter than `tournament_updates` (`supabase/migrations/
004_client_errors.sql`): `anon` gets `INSERT` only, gated by the same
`internal.check_tournament_token()` — no `SELECT`/`UPDATE`/`DELETE` grant
at all, since nothing client-side ever reads this back. Reading error
reports is organiser-only, via the Supabase dashboard's table editor
(service-role access, not subject to RLS). A pre-login error (no
`write_token` yet in this browser session) is simply never reported —
an accepted trade against leaving the table open to public spam writes.

`update_type` values the app writes and reads, and what `field_key`/`value`
mean for each (kept in sync with `applyUpdateToState()` in `scoring.js`):

| update_type | field_key | value |
|---|---|---|
| `day1_match` | `pA` / `pB` (player assigned to the match), `pA2` / `pB2` (Captain's Challenge 2nd/back-9 opponent slot on whichever side is `challengeSide`, issue #256), `type` (`'singles'` \| `'challenge'`), `challengeSide` (`'A'` \| `'B'` \| `null` — which side supplies the Challenge's 2 opponents), or `front9` / `back9` (manual result, used only when the nine has no hole-by-hole scores — see `day1_hole` below) | player id, `'singles'`\|`'challenge'`, `'A'`\|`'B'`, or `'A'`\|`'T'`\|`'B'` |
| `day1_hole` | `A1`..`A18` / `B1`..`B18` (gross score for that player on that hole) | integer gross score, 1-15 |
| `day1_ntp` | `h8` / `h17` | nearest-the-pin winner's player id |
| `day2_score` | `a4` / `a3` / `b4` / `b3` (manual net score to par, used only when the group has no hole-by-hole scores — see `day2_hole` below) | integer score to par |
| `day2_hole` | `a4_1`..`a4_18` / `a3_1`..`a3_18` / `b4_1`..`b4_18` / `b3_1`..`b3_18` (gross scramble score for that group on that hole) | integer gross score, 1-15 |
| `day2_group` | — (uses `player_id`) | `'a4'` \| `'a3'` \| `'b4'` \| `'b3'` \| `null` — the scramble group that player was just moved to (or removed from all groups) |
| `day2_ntp` | `h4` / `h16` | nearest-the-pin winner's player id |
| `day2_anthem` | — (uses `player_id`) | `'true'` (sang) \| `'false'` (didn't sing) \| `null` (no adjustment) — national anthem house rule, issue #149 |
| `day3_stableford` | — (uses `player_id`) | manual net stableford score, used only when that player has no hole-by-hole scores — see `day3_hole` below (issue #188) |
| `day3_hole` | `h1`..`h18` (uses `player_id` for which player) | gross score for that player on that hole, 1-15 |
| `day3_ntp` | `h7` / `h14` | nearest-the-pin winner's player id |
| `tiebreak` | — | `'A'` or `'B'` (sudden-death putt-off winner) |
| `team_name` | `A` / `B` | team display name |
| `team_assign` | `A` / `B` | JSON array of player ids on that team — only emitted by the "Clear Teams" reset; individual moves use `player_team` below so two concurrent moves of different players don't clobber each other |
| `player_team` | — (uses `player_id`) | `'A'` or `'B'` — the team that player was just moved to |
| `player_hcp` | — (uses `player_id`) | an admin-entered handicap override, or `null`/unparseable to clear it and revert to the `players.js` default (issue #206) |
| `rollback` | — | ISO timestamp of the rollback cutoff — a synced marker (issue #140, page-layer-only, not in `applyUpdateToState`) telling every device to wipe its local cache and reload after an admin rollback, since a server-side `DELETE` alone produces no sync signal a normal replay could act on |

- **Save:** insert one row per change (no PATCH/GET logic needed).
- **Load:** `SELECT <safe columns> WHERE tournament_id=X AND updated_at > last_sync_at`.
- **Apply:** replay each update onto local state in timestamp order.
- **Conflicts:** last update per field wins, not per record — so two
  devices editing different fields never clobber each other.

The old single-record `tournament_scores` table is no longer referenced by
the app anywhere; it can be dropped from Supabase whenever convenient.

## Course data (issue #122)

`courses.js` is a static, DOM-free data module (same UMD pattern as
`scoring.js`) holding the official scorecards — par, stroke index, and
distance per hole, transcribed from the physical club cards — for the three
courses in play:

| Day | Course | `COURSES` key |
|---|---|---|
| 1 (Fri) | Murray | `1` |
| 2 (Sat) | Black Bull | `2` |
| 3 (Sun) | Lake | `3` |

Each entry's `holes` array sums to the card's own printed OUT/IN/TOTAL
figures (asserted in `test/courses.test.mjs` as an independent check on the
transcription), and `NTP_HOLES` mirrors the hardcoded NTP hole numbers
already used in `scorecard-live.html`. `scorecard-live.html` renders this
once at init via `renderCourseCard(day)` — it's static for the whole
tournament, so it deliberately stays out of the 30s poll/`refreshAllDays()`
cycle.

## Player roster + season totals (issue #203)

`players.js` is the static roster (name, handicap, seed) as its own
UMD module, same pattern as `courses.js` — extracted out of
`scorecard-live.html`'s own inline `PLAYERS` constant so a second page
(`index.html`'s live-score ribbon) can read the exact same handicaps
the live scorecard scores against, rather than risk a second, driftable
copy.

The glue that turns raw synced state into team points — which player
has which handicap, a Day 1 match's/Day 2 scramble group's *effective*
result once hole-by-hole data exists on top of (or instead of) a manual
entry — used to live only as page-local functions in
`scorecard-live.html`, closing over its own `PLAYERS`/`COURSES`/`state`
globals. `scoring.js` now exports parameterized versions of the same
chain (`day1StrokeIndexesFor`, `matchStrokesForPlayers`,
`effectiveMatchFor`, `teamOfSets`, `ntpPointsFor`, `day2CourseHolesFor`,
`day2GroupHandicapFor`, `effectiveDay2FieldFor`, `effectiveDay2StateFor`,
and the top-level `computeSeasonTotals(state, players, courses)`) —
`scorecard-live.html`'s own same-named local functions are now thin
wrappers passing this page's `PLAYERS`/`COURSES`/`state`, and
`index.html` calls `computeSeasonTotals` directly. One set of functions,
one set of tests (`test/scoring-season-totals.test.mjs`), both pages
guaranteed to agree on what the score actually is.

`index.html`'s ribbon (`ribbon-status.js`) drives three date-based
phases via `WongaScoring.phaseFor()`/`daysUntilDay1()` (Melbourne-local,
same `TOURNAMENT_DAY_DATES` `defaultDay()` already keys off): a
countdown before 7 Aug, a live score (fresh full read of
`tournament_updates` each render/poll, replayed via the same
`normalizeState`/`applyUpdateToState`/`processUpdateRows` the live
scorecard uses, then `computeSeasonTotals`) during the tournament, and a
frozen result after. It's read-only forever — no login, no writes, no
`localStorage` sync-cursor machinery — and degrades to the ribbon's
shipped static content on any fetch/parse failure rather than showing a
spinner or error state.

## Day 1 automatic hole-by-hole scoring (issue #124)

Each Day 1 match optionally carries per-hole gross scores (`holesA`/`holesB`,
18 entries each, synced via `day1_hole` above). `scoring.js` exports the pure
functions this is built on — `matchStrokes` (handicap allocation using the
Murray Course stroke index from `courses.js`), `holeResult`, `nineFromHoles`,
`nineStatus`, and `effectiveNines` (the precedence rule between hole data and
the manual `front9`/`back9` toggle). As soon as any hole in a nine has a
score, that nine's result is derived from the hole data and the manual toggle
for it is disabled (with a "clear the hole scores" escape hatch); a nine with
no hole data at all keeps using the manual toggle exactly as before. Either
way, the result feeds the same unchanged `matchPoints()`, so Day 1 point
totals are unaffected by which entry method was used.

## Day 2 automatic hole-by-hole scramble scoring (issue #128)

Each Day 2 scramble group (`a4`/`a3`/`b4`/`b3`) optionally carries player
group assignments (`state.day2.groups`, synced via `day2_group`) and per-hole
gross scores (`state.day2.holes`, 18 entries per group, synced via
`day2_hole`). `scoring.js` exports the pure functions this is built on:

- `scrambleTeamHandicap(hcps)` — standard Australian Ambrose divisors
  (confirmed by issue #136: 25/20/15/10 for a 4-player group, 30/20/10 for a
  3-player group, 35/15 for a 2-player group, applied lowest-handicap-first),
  rounded to the nearest whole number.
- `groupStrokes(handicap, strokeIndexes)` — allocates that single team
  handicap across 18 holes via the Black Bull stroke index (`courses.js`),
  chosen over a whole-round-only handicap so a partial round's net-to-par is
  meaningful thru N holes, not just at 18 (confirmed decision for #128).
- `scrambleNetToParThru`/`scrambleRoundComplete` — net-to-par summed over
  only the holes actually played, and a check that all 18 are in.

A group's net-to-par is only derived (and fed into the unchanged
`day2GroupPoints()`/`day2Bonus()`) once its 18 holes are complete — an
incomplete round falls back to the manual `day2_score` aggregate exactly like
before, per the confirmed "manual fallback only" decision for an
abandoned/unfinished round.

## Day 3 automatic hole-by-hole Stableford scoring (issue #188)

Each player optionally carries per-hole gross scores (`state.day3.holes`,
sparse — an 18-entry array keyed by player id, created lazily on that
player's first hole entry rather than pre-populated for all 14, unlike Day
2's fixed `a4`/`a3`/`b4`/`b3` keys — synced via `day3_hole`, addressed by the
native `player_id` column plus `field_key: 'h1'..'h18'`). `scoring.js` exports
the pure functions this is built on:

- `stablefordPoints(gross, par, strokes)` — `max(0, 2 + par + strokes -
  gross)`: 2 = net par, +1 per stroke better, floored at 0, never negative.
- `day3HolePoints(grossHoles, strokes, pars)` — the per-hole points array
  (nullable), feeding the sortable points-per-hole table on the Day 3 tab.
- `day3PointsThru(grossHoles, strokes, pars)` — running total + holes played.
- `day3CourseHolesFor(courses)` — Lake Course par/stroke index, same
  degrade-gracefully fallback as `day1CourseHolesFor`/`day2CourseHolesFor`.

Unlike Day 2's net-to-par (which needs a complete 18-hole round before
`scrambleRoundComplete()` lets the derived value override the manual
fallback), Day 3's derived total has **no completeness gate** for display —
confirmed scope for #188, since Stableford points are inherently additive
per hole rather than needing the full round to be meaningful. As soon as any
hole has a score, `effectiveDay3ScoreFor()` returns a live points-thru-N
total that immediately feeds the same unchanged `computeStableford()`/
`sumStablefordPoints()` (and `computeSeasonTotals()`, shared with index.html's
ribbon) — so the Day 3 ranking table doubles as a running leaderboard mid-round.
The manual `day3_stableford` box is only ever read as the no-hole-data
fallback, same manual-vs-derived precedent as Day 1/Day 2.

The **whole-tournament-complete** gate (`isDay3Complete()`, which decides
when the overall-winner banner/tiebreak control can appear) is deliberately
a *different, stricter* check than the live leaderboard above: a player
using hole-by-hole entry only counts once `scrambleRoundComplete()` confirms
all 18 holes are in, not the moment they enter their first hole — conflating
the two would have ended the tournament as soon as all 14 players had played
just one hole each.

## Admin-editable player handicaps (issue #206)

`players.js` ships each player's handicap as of when the roster was built —
a value that occasionally needs correcting later (a late card, a data-entry
fix) without a code deploy. `state.hcp` is a sparse object keyed by player
id (synced via `player_hcp`, `addressing: 'player'` like `day2_anthem`/
`player_team`, so it gets Admin History/Restore for free); an entry there
overrides that player's `players.js` handicap everywhere, an absent/cleared
entry falls back to the shipped default.

The one substitution point is `playersWithOverrides(players, hcpOverrides)`
in `scoring.js` — a pure function that returns a players array with any
overridden `.hcp` values swapped in. Every match/scramble/Stableford
calculation already just reads `.hcp` off whatever players array it's
handed (`matchStrokesForPlayers`, `effectiveMatchFor`, `day2GroupHandicapFor`,
`effectiveDay3ScoreFor`, and `computeSeasonTotals` itself), so overrides
reach all of them by passing `playersWithOverrides(PLAYERS, state.hcp)`
(scorecard-live.html's `currentPlayers()` helper) in place of the raw
roster at each call site, rather than threading a new parameter through
scoring.js's function signatures. `ribbon-status.js` does the same after
replaying `state.hcp` from the transaction log, so index.html's live score
never silently disagrees with the scorecard over a corrected handicap.
Composes correctly with issue #149's anthem adjustment: `anthemAdjustedHandicap()`
is applied to whatever `.hcp` value it's given, override or not, so an
overridden base handicap still gets its per-round anthem nudge on top.

## Fetch timeout on every Supabase call (issue #285)

Reported as "scores desynced after everyone entered the tournament PIN" —
other devices showing the live total, one device stuck on a stale one with
no offline banner, just the subtle "Syncing…" sync-bar text. Root cause:
none of `scorecard-live.html`'s or `ribbon-status.js`'s `fetch()` calls
carried a timeout, so a stalled connection (flaky course wifi/cell) could
hang a request indefinitely instead of failing it.

`pollOnce()` sets `syncInFlight = true`, awaits `loadFromSupabase()`, and
only resets `syncInFlight` — and flips `syncStatus` to `'offline'`, which is
what makes the loud red `#offline-banner` appear via `updateOfflineIndicator()`
— in its `finally` block, once that await settles. A `fetch` that never
settles means `syncInFlight` never clears, and every subsequent 30s tick's
`pollOnce()` early-returns on `if (syncInFlight) return`, permanently
wedging that device's sync while every other device on a working connection
keeps updating normally. `ribbon-status.js`'s `schedulePoll()` has the same
shape of bug: it only re-arms its next `setTimeout` after its own
`await renderLive()` settles.

`fetchWithTimeout()` (one copy in each file, `FETCH_TIMEOUT_MS = 15000`)
wraps every Supabase-hitting `fetch` with an `AbortController` timeout —
comfortably under the 30s poll cadence — so a hang becomes an ordinary
failed request instead. The existing offline handling already does the
right thing with that: `isOffline` gets set, the red banner appears, and
the write/read queue retries exactly as it does for any other network
failure. `test/repro-285-fetch-timeout.mjs` hangs a mocked GET (never
fulfilled, never aborted — a stalled connection never resolves either) and
asserts the device recovers (`syncInFlight` resets, `isOffline` flips true,
the banner becomes visible) and that the very next poll against a working
connection succeeds normally.

## Frozen red sync-bar on an actual error (issue #287)

Follow-up to #285: even a correctly-detected error was easy to miss, because
the sync-bar (the "Live Scores"/"Syncing…"/"Offline" pill just under the
scoreboard) sits in normal document flow — it scrolls out of view the
moment a scorer scrolls down into the entry grids to actually score a hole,
exactly when a sync problem most needs to be seen.

`renderSyncBar()` now computes a `needsAttention` boolean (true for the
`authNeeded` and `isOffline`/`pendingWrites.length > 0` branches — the same
conditions that already colour the dot red) and passes it to
`setSyncBarFrozen()`, which toggles a `.sync-frozen` class (solid red,
white blinking dot, bold text) and switches the bar to `position: sticky`
with `top` set to `.masthead`'s + `.scoreboard-pin`'s live `offsetHeight` —
read at freeze-time rather than hardcoded, so it docks directly under the
scoreboard with no gap or overlap regardless of which day chips/tiebreak
row/win banner happen to be showing. The ordinary "Live"/"Syncing…" states
are untouched, so a bar with nothing to say never gets in the way.
`test/repro-287-frozen-error-bar.mjs` covers all of it, including that the
bar's bounding rect actually stays on-screen after a large scroll.

Editing is gated behind the Admin tab (organiser-only) *and* the same
admin-PIN prompt (`requireAdminToken()`) Rollback Scores uses — a bad
handicap silently changes every derived score rather than failing loudly
like a bad hole score would, so it gets the stronger gate even though it
isn't destructive.

**Mid-tournament change semantics** (a question the issue left open,
resolved here rather than blocked on, per the organiser's explicit go-ahead
to pick a default and document it): there's no reliable way to *block* an
edit once Day 1 has teed off — the organiser is the only actor who could
enforce that, and a genuine late correction should still be possible even
mid-tournament. Instead, `renderAdminHandicaps()` swaps in a stronger
warning (rather than disabling the field) once `daysUntilDay1(new Date())
<= 0` — the same calendar-day granularity `phaseFor()`/`defaultDay()`
already use elsewhere, not the exact tee time. This is the "simplest
honest rule" the issue itself suggested: allow it, but make the organiser
stop and think before saving a retroactive change.

## Admin: field history + restore (issues #129, #132)

The Admin tab's "Field History" section is a read-only lookup of a field's
full change history (who set what, when) plus a per-row Restore. Both are
built on the transaction log's existing shape rather than anything new:

- `UPDATE_TYPE_DESCRIPTORS` (`scoring.js`) is one small table describing, per
  `update_type`: a human label, how it's addressed (which selector(s) the
  Admin picker needs — a match, a player, a fixed field key, a match+hole, a
  group+hole, or nothing), whether it's restorable, and an optional cascade
  warning. A new `update_type` gets history + restore support by adding one
  entry here, not new UI code.
- `describeUpdateRow(row, players, teamNames)` decodes one raw row into
  `{fieldLabel, valueLabel}` — player ids to names, `'A'`/`'B'`/`'T'` to team
  names/"Tie", `null` to `"(cleared)"`. It's the read-side mirror of
  `applyUpdateToState()` and must be kept in sync with it.
- History is fetched directly (`GET .../tournament_updates?...&order=updated_at.desc&limit=200`),
  entirely independent of `LAST_SYNC_KEY`/the sync cursor/local state, so
  viewing it never disturbs live scoring. Rows already removed by a rollback
  are gone from history too — that's inherent to the log-based design.
- `buildRestoreRow(historicRow)` copies a historic row's coordinates and
  value, dropping `id`/`updated_at`/`updated_by` so the restore gets a fresh
  timestamp and is attributed to whoever restored it, not the original
  author. The restore is inserted as a **new row** via the normal
  `insertUpdate()` path (so it queues offline like any other write) and
  applied locally right away via `applyUpdateToState()`, inheriting whatever
  defensive cascade its `update_type` carries (e.g. `player_team`'s stale
  Day 1 slot cleanup).
- `team_assign` rows are the one deliberate exclusion (`isRestorable()`
  returns `false`) — they're legacy whole-roster snapshots, and re-imposing
  one over later per-player deltas is exactly the corruption pattern issue
  #71 was about. Restoring team membership goes through individual
  `player_team` rows instead.

## Admin rollback: cross-device sync + separate secret (issues #140, #146, #153, #154)

Rollback previously deleted rows server-side and only reset the admin
device's own cache — every other device had no way to learn the deleted
rows were gone, since a `DELETE` produces no row for a normal poll to
replay. `rollbackScores()` now inserts a `rollback` marker row (see the
`update_type` table above) after the delete succeeds; every device's
`applyUpdate()` page-layer wrapper (not `applyUpdateToState()`, which needs
to keep ignoring unknown types for older clients) treats that one type
specially — wipe `wongaCup2026`/`LAST_SYNC_KEY`/`LAST_SYNC_IDS_KEY`/
`PENDING_KEY` and reload, so every client rebuilds state from only the
surviving rows. The admin device clears the same keys itself (plus resets
`pendingWrites` in memory) so a write queued right before the rollback
can't resurrect a just-deleted score after the reload. Rollback is also
gated on a second `p_admin_token` distinct from the shared scoring
`write_token` (`requireAdminToken()`, prompted once and cached in
`sessionStorage`, and — since #154 — rehydrated from `sessionStorage` on
subsequent loads the same way the username/write-token pair already was)
— see the RLS section above.

**#153 (critical follow-up):** the marker row above lives in the log
forever, and wiping the sync cursor forces the reloaded page into a
from-epoch replay whose final page contains that same marker — without
tracking that it's already been actioned, every device (including the
admin's own, right after its own post-rollback reload) hit it again on
load, wiped again, reloaded again, forever. `HANDLED_ROLLBACKS_KEY`
(`localStorage`, survives the reload that's the whole point of this
handler) now tracks marker ids already actioned on this device, so
`applyUpdate()` skips a marker it's already handled instead of
wipe-and-reloading again. The admin device marks its own marker's id
handled (via a dedicated `insertRollbackMarker()` that requests
`Prefer: return=representation` with `select=id` — the only column that
insert can ask for `RETURNING`, given #105's column-level grant) *before*
its own reload, so its own from-epoch replay doesn't re-trigger. If that
marker insert itself fails, the delete already happened server-side, so
silently giving up would leave every other device diverged forever with no
visible symptom — instead the marker is queued through the normal
`pendingWrites` retry path (replacing any pre-rollback queue, since those
writes refer to now-deleted data) and reaches every device, including this
one, on the next successful sync.

## Practice mode (issue #208)

`scorecard-live.html?demo=1` runs the exact same app against a
completely separate sandbox: `SUPABASE_CONFIG.tournamentId`/`sessionKey`
switch to `wonga-demo-2026`, and every localStorage/sessionStorage key
this page touches (`STATE_KEY`, `LAST_SYNC_KEY`, `LAST_SYNC_IDS_KEY`,
`ACTIVE_TAB_KEY`, `PENDING_KEY`, `HANDLED_ROLLBACKS_KEY`,
`PROVENANCE_KEY`, and the `SS_*` sessionStorage auth keys) gets a
`demo_` prefix (`KEY_PREFIX`, computed once at the very top of the
script, before any of those consts are declared). No backend changes —
segregation is purely by `tournament_id`, which every existing read and
write already filters on; the same table, RLS, and shared `write_token`
serve both. `musicConsented` is deliberately left unprefixed (it's a
cosmetic audio preference, not tournament data — no reason to re-nag
someone for being in practice mode).

The mode is sticky for the rest of the browser tab's session
(`DEMO_SESSION_KEY`, itself deliberately unprefixed — it's what decides
the prefix), so it survives navigating to another page and back without
every internal link needing `?demo=1` appended by hand; the banner's
"Exit" link clears it. The persistent caution-tape banner is loud by
design (a solid color bar, not a subtle theme retint) so a screenshot or
a glance can never mistake it for the real tournament.

The Admin tab gains a "Seed Sample Data" section, visible only when
both `isAdmin()` and `isDemoMode` are true (re-checked on every
login/logout in `updateAdminVisibility()`, not just once at load) — it
writes sample teams/a match/a few holes of scores through the same
`insertUpdate()` path every real write goes through, so seeded rows are
indistinguishable from a scorer's own entries. "Rollback Scores"
doubles as the sandbox's reset button unchanged, since it's already
scoped to `SUPABASE_CONFIG.tournamentId`.

## Day 1/Day 2 live-entry render fixes (issues #142, #143, #147, #148)

A handful of correctness/UX bugs surfaced by re-review of the #124/#128
hole-by-hole entry work, all in `scorecard-live.html`:

- **`restoreDay2()` (#142):** used to only write `state.day2[id]` into its
  input box when the value was non-null, so a remote clear (another device
  sets a manual score to `null`) left the box showing stale text — which
  `_doUpdateDay2()` then read straight back into state, undoing the clear
  on the very poll that delivered it. Now mirrors state into the box
  unconditionally (`state.day2[id] ?? ''`); `safeSetInput()`'s focus guard
  still protects a box mid-typing.
- **Hole-grid commits patch instead of rebuild (#143):** `setDay2HoleScore()`
  only does a full `renderDay2GroupCard()` (which replaces `gridEl.innerHTML`
  and would otherwise drop focus/close the keyboard every hole) when the
  grid doesn't currently have focus; otherwise it calls the new
  `renderDay2Derived()` — split out of `renderDay2GroupCard()` — which
  updates only the net-to-par line, never touching the grid. Day 1's
  `setHoleScore()` gained a `patchDay1HoleFeedback()` that updates the
  clamped input value, match-header points, card win-class, and the
  relevant nine-status-line span directly by id, regardless of focus,
  falling back to a full `renderDay1()` only when this nine's status line
  doesn't exist yet (i.e. it's still showing the manual toggle — a
  structural swap a text patch can't express) or focus has moved on.
- **`<details>` open state preserved across rebuilds (#148):** both
  `renderDay1()` and `renderDay2GroupCard()` read the previous hole-grid
  `<details>` element's `open` state before replacing it and carry it
  forward onto the new one — a brand-new `<details>` always starts closed
  otherwise, so any full rebuild (poll-triggered, or the no-focus fallback
  above) would slam an in-progress scorer's open panel shut.
- **Cross-match player double-booking (#147):** `playerOptions()` now adds
  a `title` attribute to a disabled option naming which match the player is
  already in. More substantively, `applyUpdateToState()`'s `day1_match`
  case now evicts a player from any *other* match when a `pA`/`pB` row
  assigns them somewhere new — the client-side disabled-option check alone
  only prevents this on one device at a time; two devices independently
  assigning the same not-yet-used player to different matches within a
  poll cycle previously both succeeded. Since every device replays the
  same ordered log through the same eviction logic, this is a pure
  function of the update stream — whichever assignment is latest in log
  order wins, with no extra sync write needed.

## National anthem house rule (issue #149)

Day 2 only (scope confirmed via issue comment — not Day 1 match play or
Day 3 Stableford), and per-player rather than team-wide: each player gets
an independent sang/not-sung toggle (`state.day2.anthem`, synced via
`day2_anthem`, see the `update_type` table above) rendered in a plain list
under the Day 2 tab (`renderDay2Anthem()`/`setDay2Anthem()`). The +2/-1
adjustment (`ANTHEM_STROKE_ADJUSTMENT` in `scoring.js`) is applied to that
player's own handicap via `anthemAdjustedHandicap(hcp, sang)` *before* it
goes into `scrambleTeamHandicap()` in `day2GroupHandicap()` — so it rides
the same lowest-handicap-first divisor logic unchanged, and reflects the
confirmed "individual" scope rather than a flat adjustment to the team's
final handicap number.
