# Wonga Cup — Data Model Notes

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

`update_type` values the app writes and reads, and what `field_key`/`value`
mean for each (kept in sync with `applyUpdateToState()` in `scoring.js`):

| update_type | field_key | value |
|---|---|---|
| `day1_match` | `pA` / `pB` (player assigned to the match) or `front9` / `back9` (manual result, used only when the nine has no hole-by-hole scores — see `day1_hole` below) | player id, or `'A'`\|`'T'`\|`'B'` |
| `day1_hole` | `A1`..`A18` / `B1`..`B18` (gross score for that player on that hole) | integer gross score, 1-15 |
| `day1_ntp` | `h8` / `h17` | nearest-the-pin winner's player id |
| `day2_score` | `a4` / `a3` / `b4` / `b3` (manual net score to par, used only when the group has no hole-by-hole scores — see `day2_hole` below) | integer score to par |
| `day2_hole` | `a4_1`..`a4_18` / `a3_1`..`a3_18` / `b4_1`..`b4_18` / `b3_1`..`b3_18` (gross scramble score for that group on that hole) | integer gross score, 1-15 |
| `day2_group` | — (uses `player_id`) | `'a4'` \| `'a3'` \| `'b4'` \| `'b3'` \| `null` — the scramble group that player was just moved to (or removed from all groups) |
| `day2_ntp` | `h4` / `h16` | nearest-the-pin winner's player id |
| `day2_anthem` | — (uses `player_id`) | `'true'` (sang) \| `'false'` (didn't sing) \| `null` (no adjustment) — national anthem house rule, issue #149 |
| `day3_stableford` | — (uses `player_id`) | net stableford score |
| `day3_ntp` | `h7` / `h14` | nearest-the-pin winner's player id |
| `tiebreak` | — | `'A'` or `'B'` (sudden-death putt-off winner) |
| `team_name` | `A` / `B` | team display name |
| `team_assign` | `A` / `B` | JSON array of player ids on that team — only emitted by the "Clear Teams" reset; individual moves use `player_team` below so two concurrent moves of different players don't clobber each other |
| `player_team` | — (uses `player_id`) | `'A'` or `'B'` — the team that player was just moved to |
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
