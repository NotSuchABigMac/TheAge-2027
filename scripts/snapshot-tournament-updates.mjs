#!/usr/bin/env node
/* ─────────────────────────────────────
   WONGA CUP — NIGHTLY LOG SNAPSHOT (issue #207)

   Fetches the full tournament_updates log (anon read, the exact same
   grant every scoring device already has -- SAFE_SELECT_COLUMNS, same
   list scorecard-live.html reads) and writes it to
   snapshots/tournament-updates.json. Supabase's free tier gives ~7 days
   of point-in-time recovery at best; a scheduled commit of this file
   (.github/workflows/snapshot.yml) is a free, offsite, versioned,
   diffable backup -- and the final snapshot after the tournament *is*
   the permanent 2026 archive, since app state is a pure function of
   this log (normalizeState/applyUpdateToState in scoring.js).

   No dependencies -- fetch is a Node built-in (Node 18+).

   Usage: node scripts/snapshot-tournament-updates.mjs
   Writes snapshots/tournament-updates.json. Exits 1 on any fetch
   failure (the workflow's commit step then has nothing new anyway).
───────────────────────────────────── */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'snapshots', 'tournament-updates.json');

// Same publishable anon key/URL already shipped in scorecard-live.html's
// page source -- not a secret, RLS is the boundary (see
// supabase/migrations/). Safe to commit into this workflow file.
const SUPABASE_URL = 'https://wtyyarvyscbrrkawjcvo.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_T1z1rYbZ7yMoDdBXZMrjKw_R3aTxsrx';
const TOURNAMENT_ID = 'wonga-cup-2026';
const SAFE_SELECT_COLUMNS = 'id,tournament_id,update_type,match_idx,player_id,field_key,value,updated_by,updated_at';

// Paginates past the 500-row page cap the same way the app's own
// late-joiner path does (loadFromSupabase() in scorecard-live.html,
// issue #111): a page boundary can split rows that share the exact
// same updated_at timestamp, so re-querying from that timestamp with
// `gte` would otherwise re-include (duplicate) whichever of them the
// previous page already captured. Tracking which ids were already seen
// at the current cursor value is what makes a `gte` cursor safe to
// resume from without either skipping or double-counting a row.
export async function fetchAllRows(fetchImpl = fetch) {
  const rows = [];
  let cursor = '1970-01-01T00:00:00.000Z';
  let seenIdsAtCursor = new Set();
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/tournament_updates?select=${SAFE_SELECT_COLUMNS}&tournament_id=eq.${TOURNAMENT_ID}&updated_at=gte.${encodeURIComponent(cursor)}&order=updated_at.asc,id.asc&limit=500`;
    const resp = await fetchImpl(url, {
      headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' }
    });
    if (!resp.ok) throw new Error(`Supabase fetch failed: HTTP ${resp.status} ${await resp.text()}`);
    const page = await resp.json();
    for (const row of page) {
      if (row.updated_at === cursor && seenIdsAtCursor.has(row.id)) continue;
      rows.push(row);
    }
    if (page.length < 500) break;
    const lastTs = page[page.length - 1].updated_at;
    const idsAtLastTs = page.filter((r) => r.updated_at === lastTs).map((r) => r.id);
    seenIdsAtCursor = lastTs === cursor ? new Set([...seenIdsAtCursor, ...idsAtLastTs]) : new Set(idsAtLastTs);
    cursor = lastTs;
  }
  return rows;
}

// Stable key order (not whatever order Supabase/PostgREST happens to
// return) and one compact object per line -- appending new rows to a
// growing log then only touches the file's tail, which is what makes
// this "diffable" in any real sense across nightly commits.
export function formatSnapshot(rows) {
  const lines = rows.map((row) => JSON.stringify({
    id: row.id,
    tournament_id: row.tournament_id,
    update_type: row.update_type,
    match_idx: row.match_idx,
    player_id: row.player_id,
    field_key: row.field_key,
    value: row.value,
    updated_by: row.updated_by,
    updated_at: row.updated_at
  }));
  return lines.length === 0 ? '[\n]\n' : `[\n  ${lines.join(',\n  ')}\n]\n`;
}

async function main() {
  const rows = await fetchAllRows();
  const json = formatSnapshot(rows);
  await mkdir(path.dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, json);
  console.log(`Wrote ${rows.length} rows to ${path.relative(ROOT, OUT_PATH)}`);
}

// Only run when invoked directly (`node scripts/snapshot-tournament-updates.mjs`),
// not when imported for its exports (fetchAllRows/formatSnapshot) by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
