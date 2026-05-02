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
| update_type | text | `day1_hole`, `day2_score`, `day3_stableford` |
| match_idx | int | Day 1 only — which match (0-5) |
| hole_num | int | Day 1 only — which hole (0-17) |
| player_id | int | Day 3 only — player ID |
| field_key | text | Day 2 only — e.g. `a4`, `b2` |
| value | text | The score/result value |
| updated_by | text | Username of who entered it |
| updated_at | timestamptz | When it was entered |

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
