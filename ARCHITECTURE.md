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
| `day3_stableford` | — (uses `player_id`) | legacy manual net stableford score; no longer enterable from the UI (hole-by-hole is now the only entry path — see `day3_hole` below), kept only so a pre-existing manual score, and Admin History/Restore for it, keep working |
| `day3_hole` | `h1`..`h18` (uses `player_id` for which player) | gross score for that player on that hole, 1-15 |
| `day3_ntp` | `h7` / `h14` | nearest-the-pin winner's player id |
| `tiebreak` | — | `'A'` or `'B'` (sudden-death putt-off winner) |
| `team_name` | `A` / `B` | team display name |
| `team_assign` | `A` / `B` | JSON array of player ids on that team — only emitted by the "Clear Teams" reset; individual moves use `player_team` below so two concurrent moves of different players don't clobber each other |
| `player_team` | — (uses `player_id`) | `'A'` or `'B'` — the team that player was just moved to |
| `player_hcp` | — (uses `player_id`) | an admin-entered handicap override, or `null`/unparseable to clear it and revert to the `players.js` default (issue #206) |
| `team_lock` | — | `'true'` \| `'false'` — admin-only "Lock Teams" toggle guarding Team Setup (now in the Admin tab) against an accidental edit once the draft is final; unlocking warns in the UI first (issue #302) |
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
total. Manual 18-hole entry (the `day3_stableford` update_type) has since
been retired from the UI — hole-by-hole is now the only way to enter a Day 3
score, and the Net Stableford column on the Day 3 tab is always a read-only
display of the derived total. `day3_stableford`/`effectiveDay3ScoreFor`'s
manual-fallback branch is kept only so a score entered before that change
(and its Admin History/Restore entry) keeps working — see
`test/repro-212-rollback-race.mjs`, which still exercises the write path
directly.

**Ranking is by points per hole, not raw total.** `effectiveDay3PointsPerHoleFor()`
divides a player's points-thru-N total by holes actually played (a legacy
manual total is treated as 18 holes, the only shape it ever took) — *this*,
not the raw total, is what feeds `computeStableford()`/`sumStablefordPoints()`
(and `computeSeasonTotals()`, shared with index.html's ribbon, and tv.html's
live board). A player who's only played a few holes is ranked on pace
instead of sitting unfairly behind the field purely for having played fewer
holes so far — so the Day 3 tab's leaderboard doubles as a running
leaderboard mid-round, ordered by pace, while the "Net Stableford" and
"Pts/Hole" columns show the raw total and the average side by side.

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
Composes independently of issue #149's anthem adjustment: the anthem rule
now adds strokes straight to a group's score (`day2AnthemStrokesFor()`,
see below) rather than touching `.hcp`, so an overridden base handicap
still feeds `scrambleTeamHandicap()` unchanged and the anthem strokes are
added on top of whatever score that handicap produces.

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
with `top` set to `.masthead`'s + `.mini-sb`'s live `offsetHeight` —
read at freeze-time rather than hardcoded, so it docks directly under the
mini scoreboard with no gap or overlap. (Docks under `.mini-sb` rather than
`.scoreboard-pin` since issue #301 made `.mini-sb` the sticky bar that
follows down the page, while `.scoreboard-pin` reverted to normal document
flow — see the CSS comments on both classes in `scorecard-live.html`.) The
ordinary "Live"/"Syncing…" states are untouched, so a bar with nothing to
say never gets in the way. `test/repro-287-frozen-error-bar.mjs` covers all
of it, including that the bar's bounding rect actually stays on-screen after a
large scroll.

## Self-service full resync (issue #290)

Follow-up to #285/#287: those fixed a device that's visibly stuck offline,
but a device can also silently *diverge* while looking perfectly healthy.
Reported live: a device's sync bar showed a normal "Live Scores" state —
`isOffline`/`pendingWrites`/`authNeeded` all clean, `lastSyncedAt` seconds
old, its cursor fully caught up to the newest row in the log — yet its
computed team totals were far below every other device's. Since
`loadFromSupabase()` only ever fetches rows *newer* than its cursor, a
device whose cursor is already fully caught up has no way to recover from
an earlier silent per-row apply failure (a JS exception mid-replay, a
timing glitch — the kind `processUpdateRows()` deliberately skips rather
than retrying forever, see the `tournament_updates` section above) except
a full replay from row one; incremental sync never revisits a row once the
cursor's past it.

`resyncFromScratch()` is the one shared primitive for "wipe every locally
cached score/cursor key and reload" — `STATE_KEY`, `LAST_SYNC_KEY`,
`LAST_SYNC_IDS_KEY`, `PENDING_KEY`, and `PROVENANCE_KEY` all together, plus
resetting in-memory `pendingWrites`. It replaces two previously-separate,
inconsistent call sites:

- The rollback-marker handler in `applyUpdate()` (issue #212) already did
  exactly this inline; now it just calls the shared function.
- The corrupted-saved-data init fallback's "Reset & Reload" button (shown
  when `loadState()`/the initial render throws) used to clear only
  `STATE_KEY` — leaving the cursor intact meant the post-reload blank
  state only ever replayed rows *after* that stale cursor, permanently
  losing everything before it instead of actually starting over. This was
  a real, live bug: the most plausible mechanism for the report above.

A third call site is new: **"↻ Full Resync"**, available to any scorer
(not just the admin) since the underlying operation is purely local —
nothing on the server changes, no other device is affected.
`forceFullResync()` guards it with a `confirm()` that names exactly how
many not-yet-synced `pendingWrites` would be discarded (a full resync
only rebuilds from what the server already has, so it can't retry them)
rather than silently destroying real unsynced entries; accepting anyway
proceeds. `test/repro-290-force-resync.mjs` proves the fix end-to-end —
seeds real rows, captures the correct total from a clean load, corrupts
the device's own local state to a wrong (lower) total while leaving its
cursor fully caught up (reproducing the reported symptom exactly), forces
a resync, and confirms the total converges back to the correct one — plus
the `forceFullResync()` confirm-gating in isolation.

## Full Resync placement + a nudge for scorers stuck on Refresh (issue #293)

Follow-up to #290: the "↻ Full Resync" button originally sat in the sync
bar right next to Refresh — feedback was that it read as an everyday
control there and confused scorers who didn't need it, so it moved to a
new `.app-footer` at the bottom of the page content. `.app-footer` is a
sibling of every `.sc-panel` (not nested inside just one), so it renders
at the bottom of whichever tab happens to be open, with a one-line note
explaining what it's for.

Moving it out of the way raised a new problem: a scorer hitting exactly
the case Full Resync solves (a device whose cursor is already caught up,
so Refresh has nothing new to fetch no matter how many times it's tapped)
would have no way to discover the button unless told. `noteManualRefresh()`
tracks manual Refresh taps (`REFRESH_NUDGE_COUNT` inside
`REFRESH_NUDGE_WINDOW_MS` — 3 taps inside 5 minutes as a first guess, not
a measured constant, both named as one easy-to-retune pair) and shows a
dismissable `#resync-nudge-modal` once the threshold is crossed, wired
into the same `setupModalA11y()` focus-trap/Escape-to-close pattern every
other modal here already uses. "Not Now" dismisses without touching
anything; "Resync Now" calls `forceFullResync()` directly. The tap counter
resets the moment the nudge fires, so a single tap right after a dismissal
can't immediately re-trigger it — it takes a fresh full count.
`test/repro-293-refresh-nudge.mjs` covers the button's new placement, the
under-threshold/at-threshold/reset-after-firing counter behavior, and both
modal actions.

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
Day 3 Stableford). Each player gets an independent sang/not-sung toggle
(`state.day2.anthem`, synced via `day2_anthem`, see the `update_type`
table above) rendered in a plain list under the Day 2 tab
(`renderDay2Anthem()`/`setDay2Anthem()`) — that part is per-player, not
team-wide. But the resulting +2/-1 stroke adjustment
(`ANTHEM_STROKE_ADJUSTMENT` in `scoring.js`) reaches **both** of that
player's team's Day 2 groups (a4+a3 for Team A, b4+b3 for Team B), not
just the one group the player happens to be sitting in — a player's
anthem showing reflects on their whole team, not just their own foursome.
`day2AnthemStrokesFor(code, day2)` sums one group's own roster;
`day2TeamAnthemStrokesFor(code, day2)` — the one actually applied to a
group's score — adds that group's sum to its sibling group's sum. It's
added to the group's net-to-par *after* `scrambleTeamHandicap()`/
`groupStrokes()` have already allocated handicap strokes, in both
`effectiveDay2FieldFor()` (real score) and `projectedDay2Field()`
(projection), and applied identically whether the group's score comes from
hole-by-hole entry or the manual net-to-par fallback. This doesn't touch
the team's handicap or how strokes get allocated across holes — earlier
revisions folded the adjustment into the player's handicap before
`scrambleTeamHandicap()`, which diluted it through that group-size
percentage table and had no effect at all on a manually-entered score;
a revision after that added the adjustment to only the player's own group
rather than the whole team; see git history for both.

## Score progression "worm" charts (issues #270, #299)

Two small inline SVG line charts, no charting library, both purely visual
and purely derived from data already synced — no new writes, no new
schema, no sync changes, and neither ever feeds back into an actual point
total.

- **Per-match, Day 1 (#270):** `matchWormFor(match, players,
  day1StrokeIndexes)` (`scoring.js`) replays `holeResult()` across all 18
  holes and returns `{front9, back9}` — each nine's own cumulative
  A-minus-B lead sequence, reset to 0 at the turn, since front 9/back 9
  are each their own 1pt contest (`matchPoints()`). Returns `null` when the
  match has no hole-by-hole data at all (decided only via the manual
  `front9`/`back9` toggle) — same "hole data or nothing" precedent as
  `effectiveNines()`. Rendered by `renderDay1()` via `wormSvg()`, gated on
  the same `decided` flag (`eff.front9 !== null && eff.back9 !== null`)
  that already sets `resultClass`.
- **Whole-weekend, team-wide (#299):** `weekendWormFor(rows, players,
  courses, initialTeams)` (`scoring.js`) takes the *entire*
  `tournament_updates` history and replays it through
  `applyUpdateToState()` into a scratch state — never the live page
  state — calling `computeSeasonTotals()` after each row to track the
  team-point differential (`totalA - totalB`) over the course of the
  whole tournament. Since it's the exact same
  `applyUpdateToState()`/`computeSeasonTotals()` driving the live
  scoreboard, the worm can never disagree with it. Only records a new
  point when the differential actually changes (most rows — an
  in-progress hole score, a Day 2 group assignment — don't move a team's
  total until a nine/match/scramble round/NTP hole resolves), and returns
  `null` when there's nothing to draw: no rows, or the differential never
  once left 0. `initialTeams` seeds the scratch replay's starting
  `teamA`/`teamB`, since `normalizeState()` has no opinion on team
  membership, only on `day1`/`day2`/`day3` shape — the page passes its own
  pre-draft default roster (`DEFAULT_A`/`DEFAULT_B`).

  Before replaying, `rows` is collapsed via `lastRowPerField()` down to
  just the LAST write ever made to each distinct field (same
  `(update_type, match_idx, player_id, field_key)` coordinate identity
  `undoCoordKey()`/`describeUpdateRow()` already use elsewhere), then
  those survivors are re-sorted by each one's own `updated_at` — replay
  order comes from real timestamps, not from whatever order `rows`
  happened to arrive in. Without this, a scorer's typo-then-correction
  (or an admin's Field History restore) shows up as two spurious steps in
  the worm: one for the mistake, immediately followed by another undoing
  it once it's fixed — exactly the kind of pre-tournament testing/typo
  noise a from-scratch full-history replay is otherwise defenseless
  against, since it has no notion of "this value was superseded" the way
  the live page (which only ever sees the latest applied value per field
  anyway) does. Crediting only each field's real final value, at the time
  it was actually last set, keeps the worm reading as the tournament's
  true progression.

  Rendered in the `.scoreboard-pin` header (`#weekend-worm-slot`), fed by
  `fetchWeekendWormRows()` — a direct fetch of the *full* table,
  independent of the sync cursor, same precedent as the Admin Field
  History panel's own direct fetch. **Paginates 500 rows at a time,
  looping until a page comes back short** — the exact same cursor-based
  loop `loadFromSupabase()` already uses — rather than trusting a single
  request with a large `limit=`: a real Supabase/PostgREST response can
  cap out under whatever's asked for regardless of the `limit` param, and
  since rows are ordered oldest-first, a truncated single-request fetch
  silently keeps only the earliest rows and drops every later correction
  — which is exactly what made the worm briefly show a stale,
  already-corrected imbalance as if it were still current. Loaded once at
  boot (`loadWeekendWorm()`), on the sync bar's manual Refresh button
  (`manualRefresh()`), and via its own small refresh button on the chart
  itself — deliberately **not** wired into `pollOnce()`'s automatic 30s
  cycle, since re-fetching (and re-paginating) the entire table on every
  poll would multiply a full-table read for no benefit those three
  explicit triggers don't already cover.
