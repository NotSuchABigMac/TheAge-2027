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

## Security: RLS lockdown (issues #105, #106)

The Supabase publishable key ships in `scorecard-live.html`'s page source
by design — it is not a secret, so it cannot be the access control.
`supabase/migrations/001_lock_down_tournament_updates.sql` locks the table
down at the database level and **must be run manually** (Supabase
dashboard → SQL Editor) against the project in `SUPABASE_CONFIG`; nothing
client-side can apply it. After running it:

- `anon` can `SELECT` and `INSERT` (with a matching `write_token`) but not
  `UPDATE` or `DELETE` — the log is append-only from the app's perspective.
- The admin "Rollback Scores" control (issue #103) goes through a
  `rollback_tournament_updates` RPC instead of a raw `DELETE`, since anon
  `DELETE` is revoked; the RPC re-checks the token server-side.
- The app prompts once for a "Tournament PIN" (stored in
  `sessionStorage`) and sends it as `write_token` on every insert — set
  the real passphrase server-side with `ALTER DATABASE postgres SET
  app.tournament_secret = '...'` and hand it out to scorers out-of-band;
  it is never baked into the client bundle.

`update_type` values the app writes and reads, and what `field_key`/`value`
mean for each (kept in sync with `applyUpdateToState()` in `scoring.js`):

| update_type | field_key | value |
|---|---|---|
| `day1_match` | `pA` / `pB` (player assigned to the match) or `front9` / `back9` (manual result, used only when the nine has no hole-by-hole scores — see `day1_hole` below) | player id, or `'A'`\|`'T'`\|`'B'` |
| `day1_hole` | `A1`..`A18` / `B1`..`B18` (gross score for that player on that hole) | integer gross score, 1-15 |
| `day1_ntp` | `h8` / `h17` | nearest-the-pin winner's player id |
| `day2_score` | `a4` / `a3` / `b4` / `b3` (4-man / 3-man group net score to par) | integer score to par |
| `day2_ntp` | `h4` / `h16` | nearest-the-pin winner's player id |
| `day3_stableford` | — (uses `player_id`) | net stableford score |
| `day3_ntp` | `h7` / `h14` | nearest-the-pin winner's player id |
| `tiebreak` | — | `'A'` or `'B'` (sudden-death putt-off winner) |
| `team_name` | `A` / `B` | team display name |
| `team_assign` | `A` / `B` | JSON array of player ids on that team — only emitted by the "Clear Teams" reset; individual moves use `player_team` below so two concurrent moves of different players don't clobber each other |
| `player_team` | — (uses `player_id`) | `'A'` or `'B'` — the team that player was just moved to |

- **Save:** insert one row per change (no PATCH/GET logic needed).
- **Load:** `SELECT * WHERE tournament_id=X AND updated_at > last_sync_at`.
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
