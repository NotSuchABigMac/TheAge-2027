# Wonga Cup — Todo

## Supabase Schema Redesign (Multi-User Sync)

**Problem:** Current architecture stores entire tournament state in one record.
Multiple devices overwrite each other's changes (last-write-wins at record level).

**Solution:** Transaction log approach — store individual updates as rows.

### New Table: `tournament_updates`
| Column | Type | Description |
|--------|------|-------------|
| id | uuid (PK) | Auto-generated |
| tournament_id | text | e.g. `wonga-cup-2026` |
| update_type | text | see below |
| match_idx | int | Day 1 only — which match (0-5) |
| player_id | int | Day 3 stableford only — player ID |
| field_key | text | meaning depends on `update_type`, see below |
| value | text | The score/result/player-id value |
| updated_by | text | Username of who entered it |
| updated_at | timestamptz | When it was entered |

`update_type` values actually used by the app, and what `field_key`/`value` mean for each:

| update_type | field_key | value |
|---|---|---|
| `day1_match` | `pA` / `pB` (player assigned to the match) or `front9` / `back9` (result) | player id, or `'A'`\|`'T'`\|`'B'` |
| `day1_ntp` | `h8` / `h17` | nearest-the-pin winner's player id |
| `day2_score` | `a4` / `a3` / `b4` / `b3` (4-man / 3-man group net score to par) | integer score to par |
| `day2_ntp` | `h4` / `h16` | nearest-the-pin winner's player id |
| `day3_stableford` | — (uses `player_id`) | net stableford score |
| `day3_ntp` | `h7` / `h14` | nearest-the-pin winner's player id |
| `tiebreak` | — | `'A'` or `'B'` (sudden-death putt-off winner) |
| `team_name` | `A` / `B` | team display name |
| `team_assign` | `A` / `B` | JSON array of player ids on that team |

### How It Works
- **Save:** Insert one row per change (no PATCH/GET logic needed)
- **Load:** `SELECT * WHERE tournament_id=X AND updated_at > last_sync_at`
- **Apply:** Replay each update onto local state in timestamp order
- **No conflicts:** Last update per hole/player wins at field level, not record level

### Code Changes Needed
1. Replace `saveToSupabase()` — insert one row per change instead of full state
2. Replace `loadFromSupabase()` — fetch rows since `last_sync_at`, apply each
3. Store `last_sync_at` in localStorage per device
4. Drop old `tournament_scores` table (or keep for fallback)

### Old Table to Drop
`tournament_scores` — replace entirely with `tournament_updates`
