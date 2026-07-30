/* Issue #207 -- unit tests for scripts/snapshot-tournament-updates.mjs.
   fetchAllRows() takes an injectable fetch implementation specifically
   so its pagination/boundary-dedup logic (mirroring the app's own
   loadFromSupabase() cursor handling, issue #111) is testable without a
   real network call; formatSnapshot() is pure string formatting. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { fetchAllRows, formatSnapshot } = await import('../scripts/snapshot-tournament-updates.mjs');

function jsonResponse(body) {
  return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
}

test('fetchAllRows: a single short page (under the 500 cap) returns exactly those rows, one request', async () => {
  const rows = [
    { id: 'a', updated_at: '2026-08-07T10:00:00Z' },
    { id: 'b', updated_at: '2026-08-07T10:00:01Z' }
  ];
  let calls = 0;
  const rows2 = await fetchAllRows(async () => { calls++; return jsonResponse(rows); });
  assert.equal(calls, 1);
  assert.deepEqual(rows2.map((r) => r.id), ['a', 'b']);
});

test('fetchAllRows: a full page (500) followed by a short page pages through both without dropping rows', async () => {
  const page1 = Array.from({ length: 500 }, (_, i) => ({ id: `p1-${i}`, updated_at: `2026-08-07T10:00:${String(i % 60).padStart(2, '0')}Z` }));
  const page2 = [{ id: 'last', updated_at: '2026-08-07T11:00:00Z' }];
  let call = 0;
  const rows = await fetchAllRows(async () => {
    call++;
    return jsonResponse(call === 1 ? page1 : page2);
  });
  assert.equal(call, 2);
  assert.equal(rows.length, 501);
  assert.equal(rows[rows.length - 1].id, 'last');
});

test('fetchAllRows: rows sharing the exact boundary timestamp across a page split are not duplicated', async () => {
  // Page 1: 500 rows, the last 3 all share timestamp T. Page 2 (queried
  // with gte=T) re-returns those same 3 plus 1 genuinely new row at a
  // later timestamp -- the 3 must be deduped, not double-counted.
  const T = '2026-08-07T10:00:00.000Z';
  const page1 = Array.from({ length: 497 }, (_, i) => ({ id: `early-${i}`, updated_at: `2026-08-07T09:${String(i % 60).padStart(2, '0')}:00.000Z` }))
    .concat([{ id: 'boundary-1', updated_at: T }, { id: 'boundary-2', updated_at: T }, { id: 'boundary-3', updated_at: T }]);
  const page2 = [
    { id: 'boundary-1', updated_at: T },
    { id: 'boundary-2', updated_at: T },
    { id: 'boundary-3', updated_at: T },
    { id: 'fresh', updated_at: '2026-08-07T10:00:01.000Z' }
  ];
  let call = 0;
  const rows = await fetchAllRows(async () => {
    call++;
    return jsonResponse(call === 1 ? page1 : page2);
  });
  const ids = rows.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `expected no duplicate ids, got ${ids.length} rows / ${new Set(ids).size} unique`);
  assert.equal(rows.length, 501); // 497 early + 3 boundary + 1 fresh, boundary counted once
  assert.ok(ids.includes('fresh'));
});

test('fetchAllRows: requests the safe column list, the real tournament_id, and sends the apikey header (never write_token)', async () => {
  let capturedUrl, capturedOpts;
  await fetchAllRows(async (url, opts) => {
    capturedUrl = url;
    capturedOpts = opts;
    return jsonResponse([]);
  });
  assert.match(capturedUrl, /^https:\/\/wtyyarvyscbrrkawjcvo\.supabase\.co\/rest\/v1\/tournament_updates\?/);
  assert.match(capturedUrl, /select=id%2Ctournament_id%2Cupdate_type%2Cmatch_idx%2Cplayer_id%2Cfield_key%2Cvalue%2Cupdated_by%2Cupdated_at|select=id,tournament_id,update_type,match_idx,player_id,field_key,value,updated_by,updated_at/);
  assert.match(capturedUrl, /tournament_id=eq\.wonga-cup-2026/);
  assert.match(capturedUrl, /order=updated_at\.asc,id\.asc/);
  assert.match(capturedUrl, /limit=500/);
  assert.ok(capturedOpts.headers.apikey, 'expected an apikey header');
  assert.doesNotMatch(JSON.stringify(capturedOpts), /write_token/i);
});

test('fetchAllRows: throws with the HTTP status on a non-ok response', async () => {
  await assert.rejects(
    () => fetchAllRows(async () => ({ ok: false, status: 500, text: async () => 'server exploded' })),
    /HTTP 500/
  );
});

test('formatSnapshot: stable key order regardless of input object key order', () => {
  const row = { updated_at: '2026-08-07T10:00:00Z', value: '4', id: 'x', field_key: 'A1', player_id: null, match_idx: 0, update_type: 'day1_hole', updated_by: 'Gary King', tournament_id: 'wonga-cup-2026' };
  const out = formatSnapshot([row]);
  const parsed = JSON.parse(out);
  assert.deepEqual(Object.keys(parsed[0]), ['id', 'tournament_id', 'update_type', 'match_idx', 'player_id', 'field_key', 'value', 'updated_by', 'updated_at']);
});

test('formatSnapshot: one compact row per line (diffable), valid JSON overall', () => {
  const rows = [
    { id: 'a', tournament_id: 't', update_type: 'team_name', match_idx: null, player_id: null, field_key: 'A', value: 'Team Beer', updated_by: 'Gary King', updated_at: '2026-08-07T10:00:00Z' },
    { id: 'b', tournament_id: 't', update_type: 'team_name', match_idx: null, player_id: null, field_key: 'B', value: 'Team Golf', updated_by: 'Gary King', updated_at: '2026-08-07T10:00:01Z' }
  ];
  const out = formatSnapshot(rows);
  const lines = out.split('\n').filter((l) => l.trim().startsWith('{'));
  assert.equal(lines.length, 2, 'expected exactly one line per row');
  const parsed = JSON.parse(out);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'a');
});

test('formatSnapshot: an empty row set still produces a valid (empty) JSON array', () => {
  const out = formatSnapshot([]);
  assert.deepEqual(JSON.parse(out), []);
});
