import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  escapeHtml,
  ninePoints, matchPoints, sumMatchPoints,
  DAY1_GROSS_MIN, DAY1_GROSS_MAX,
  matchStrokes, holeResult, nineFromHoles, nineStatus, effectiveNines,
  ntpTeamPoints,
  parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2, day2InputState,
  DAY2_HOLE_GROSS_MIN, DAY2_HOLE_GROSS_MAX,
  scrambleTeamHandicap, groupStrokes, scrambleNetToParThru, scrambleRoundComplete, applyPlayerGroupMove,
  ANTHEM_STROKE_ADJUSTMENT, anthemAdjustedHandicap,
  POS_PTS, computeStableford, sumStablefordPoints,
  resolveOverallWinner,
  applyPlayerTeamMove, dedupeTeams, reconcileMatchesAfterTeamMove, processUpdateRows,
  parseIntOrNull, applyUpdateToState,
  UPDATE_TYPE_DESCRIPTORS, describeUpdateRow, isRestorable, buildRestoreRow
} = require('../scoring.js');

/* ── HTML Escaping (issue #58 — stored XSS via team names) ── */

test('escapeHtml neutralizes all five HTML-significant characters', () => {
  assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
});

test('escapeHtml defuses the classic <img onerror> XSS payload', () => {
  const payload = '<img src=x onerror=alert(1)>';
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes('<img'), 'no raw tag should survive escaping');
  assert.equal(escaped, '&lt;img src=x onerror=alert(1)&gt;');
});

test('escapeHtml leaves ordinary team names untouched', () => {
  assert.equal(escapeHtml('Team Beer'), 'Team Beer');
});

test('escapeHtml coerces non-string input instead of throwing (issue #121, finding F3 case 7)', () => {
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(123), '123');
});

test('escapeHtml defuses an attribute-breakout payload (issue #116)', () => {
  const payload = '" autofocus onfocus="window.__pwned=1';
  const escaped = escapeHtml(payload);
  assert.ok(!escaped.includes('"'), 'no raw quote should survive escaping');
  assert.equal(escaped, '&quot; autofocus onfocus=&quot;window.__pwned=1');
});

/* ── Day 1 — Match Play ── */

test('ninePoints awards 1pt to the winning team, 0.5 each on a tie', () => {
  assert.deepEqual(ninePoints('A'), { a: 1, b: 0 });
  assert.deepEqual(ninePoints('B'), { a: 0, b: 1 });
  assert.deepEqual(ninePoints('T'), { a: 0.5, b: 0.5 });
  assert.deepEqual(ninePoints(null), { a: 0, b: 0 });
});

test('matchPoints sums front9 + back9', () => {
  assert.deepEqual(matchPoints({ front9: 'A', back9: 'B' }), { a: 1, b: 1 });
  assert.deepEqual(matchPoints({ front9: 'A', back9: 'A' }), { a: 2, b: 0 });
  assert.deepEqual(matchPoints({ front9: 'T', back9: 'T' }), { a: 1, b: 1 });
});

test('sumMatchPoints totals 6 singles matches (12 points up for grabs)', () => {
  const matches = Array.from({ length: 6 }, () => ({ front9: 'A', back9: 'B' }));
  const totals = sumMatchPoints(matches);
  assert.deepEqual(totals, { a: 6, b: 6 });
});

test('ntpTeamPoints counts one point per resolved hole, ignores unset holes', () => {
  assert.deepEqual(ntpTeamPoints(['A', 'B']), { a: 1, b: 1 });
  assert.deepEqual(ntpTeamPoints(['A', 'A']), { a: 2, b: 0 });
  assert.deepEqual(ntpTeamPoints([null, 'B']), { a: 0, b: 1 });
  assert.deepEqual(ntpTeamPoints([]), { a: 0, b: 0 });
});

// Empty-input floors (issue #121, finding F3 case 9) -- neither function
// should throw or return anything other than a zeroed totals object.
test('sumMatchPoints floors to zero totals on an empty match list', () => {
  assert.deepEqual(sumMatchPoints([]), { a: 0, b: 0 });
});

test('ntpTeamPoints floors to zero totals when passed null', () => {
  assert.deepEqual(ntpTeamPoints(null), { a: 0, b: 0 });
});

/* ── Day 2 — Team Scramble ── */

test('parseScoreToPar treats blank/invalid input as not-yet-entered', () => {
  assert.equal(parseScoreToPar(''), null);
  assert.equal(parseScoreToPar(null), null);
  assert.equal(parseScoreToPar('abc'), null);
  assert.equal(parseScoreToPar('-15'), -15);
  assert.equal(parseScoreToPar('3'), 3);
});

test('day2GroupPoints: worked example from the rules (A -15 vs B -12 -> A wins 3)', () => {
  assert.deepEqual(day2GroupPoints(-15, -12), { a: 3, b: 0 });
});

test('day2GroupPoints: reverse case awards the other team', () => {
  assert.deepEqual(day2GroupPoints(-4, -9), { a: 0, b: 5 });
});

test('day2GroupPoints: exact tie awards nothing', () => {
  assert.deepEqual(day2GroupPoints(-10, -10), { a: 0, b: 0 });
});

test('day2GroupPoints: incomplete entry awards nothing', () => {
  assert.deepEqual(day2GroupPoints(null, -10), { a: 0, b: 0 });
});

test('day2Bonus: lower combined total gets the flat 5pt bonus', () => {
  assert.deepEqual(day2Bonus(-19, -18), { a: 5, b: 0 });
  assert.deepEqual(day2Bonus(-18, -19), { a: 0, b: 5 });
  assert.deepEqual(day2Bonus(-19, -19), { a: 0, b: 0 });
});

test('calcDay2: combines group differentials + outright bonus once all four scores are in', () => {
  // Team A: 4-group -15, 3-group -4 (combined -19)
  // Team B: 4-group -12, 3-group -6 (combined -18)
  const result = calcDay2({ a4: '-15', a3: '-4', b4: '-12', b3: '-6' });
  assert.deepEqual(result.four, { a: 3, b: 0 }); // |-15 - -12| = 3, A better
  assert.deepEqual(result.three, { a: 0, b: 2 }); // |-4 - -6| = 2, B better
  assert.deepEqual(result.bonus, { a: 5, b: 0 }); // -19 < -18, A better combined
  assert.equal(result.a, 3 + 0 + 5);
  assert.equal(result.b, 0 + 2 + 0);
  assert.equal(result.complete, true);
});

test('calcDay2: no bonus awarded while any of the four scores is still missing', () => {
  const result = calcDay2({ a4: '-15', a3: '', b4: '-12', b3: '-6' });
  assert.deepEqual(result.bonus, { a: 0, b: 0 });
  assert.equal(result.complete, false);
});

/* ── Day 2 score input (issue #59 — leading "-" was stripped while typing) ── */

test('day2InputState: a lone "-" is left alone, not clobbered, while the user is still typing', () => {
  const r = day2InputState('-');
  assert.equal(r.changed, false, 'the in-progress state itself must not be stored yet');
  assert.equal(r.correction, null, 'the box must not be rewritten mid-keystroke');
});

test('day2InputState: a complete negative number is accepted as-is', () => {
  assert.deepEqual(day2InputState('-15'), { changed: true, stored: '-15', correction: null });
  assert.deepEqual(day2InputState('-5'), { changed: true, stored: '-5', correction: null });
});

test('day2InputState: clearing the box stores null without touching the input', () => {
  assert.deepEqual(day2InputState(''), { changed: true, stored: null, correction: null });
});

test('day2InputState: out-of-range numbers are clamped and the box corrected', () => {
  assert.deepEqual(day2InputState('45'), { changed: true, stored: '20', correction: '20' });
  assert.deepEqual(day2InputState('-45'), { changed: true, stored: '-20', correction: '-20' });
});

test('day2InputState: non-numeric garbage is left alone rather than wiped', () => {
  assert.deepEqual(day2InputState('abc'), { changed: false, stored: null, correction: null });
});

// Exact clamp boundaries and the plus-prefix case (issue #121, finding F3
// case 4) -- pinned separately from the out-of-range clamp test above,
// since being exactly on the boundary must NOT count as a correction.
test('day2InputState: exact +/-20 boundaries round-trip without a correction', () => {
  assert.deepEqual(day2InputState('20'), { changed: true, stored: '20', correction: null });
  assert.deepEqual(day2InputState('-20'), { changed: true, stored: '-20', correction: null });
});

test('day2InputState: a plus-prefixed number parses without triggering a correction', () => {
  assert.deepEqual(day2InputState('+5'), { changed: true, stored: '5', correction: null });
});

test('parseScoreToPar retains a deliberate partial parse (issue #121, finding F3 case 8)', () => {
  assert.equal(parseScoreToPar('12abc'), 12);
  assert.equal(parseScoreToPar('1e3'), 1);
});

/* ── Day 3 — Individual Stableford ── */

test('POS_PTS runs 1st=14pts down to 14th=1pt (no skipped values, no 0 for last place)', () => {
  assert.deepEqual(POS_PTS, [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('computeStableford assigns positions/points in descending score order', () => {
  const entries = [
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: 38, team: 'B' },
    { id: 3, score: 36, team: 'A' }
  ];
  const sorted = computeStableford(entries);
  assert.deepEqual(sorted.map(p => p.id), [1, 2, 3]);
  assert.deepEqual(sorted.map(p => p.pos), [1, 2, 3]);
  assert.deepEqual(sorted.map(p => p.pts), [14, 13, 12]);
});

test('computeStableford averages points across a tie', () => {
  const entries = [
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: 38, team: 'B' },
    { id: 3, score: 38, team: 'A' },
    { id: 4, score: 35, team: 'B' }
  ];
  const sorted = computeStableford(entries);
  const tied = sorted.filter(p => p.score === 38);
  assert.equal(tied.length, 2);
  // 2nd + 3rd place points averaged: (13 + 12) / 2 = 12.5
  tied.forEach(p => assert.equal(p.pts, 12.5));
});

test('computeStableford puts unentered scores last with 0 points', () => {
  const entries = [
    { id: 1, score: null, team: 'A' },
    { id: 2, score: 30, team: 'B' }
  ];
  const sorted = computeStableford(entries);
  assert.equal(sorted[0].id, 2);
  assert.equal(sorted[1].id, 1);
  assert.equal(sorted[1].pts, 0);
  assert.equal(sorted[1].pos, null);
});

test('computeStableford treats a NaN score as not-entered instead of looping forever', () => {
  const entries = [
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: NaN, team: 'B' },
    { id: 3, score: 35, team: 'B' }
  ];
  const sorted = computeStableford(entries); // must terminate
  assert.deepEqual(sorted.map(p => p.id), [1, 3, 2]);
  assert.equal(sorted[2].pos, null);
  assert.equal(sorted[2].pts, 0);
  assert.deepEqual(sumStablefordPoints(sorted), { a: 14, b: 13 });
});

test('computeStableford treats undefined and non-numeric scores as not-entered', () => {
  const entries = [
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: undefined, team: 'B' },
    { id: 3, score: 'abc', team: 'B' }
  ];
  const sorted = computeStableford(entries);
  const first = sorted.find(p => p.id === 1);
  assert.equal(first.pos, 1);
  assert.equal(first.pts, 14);
  sorted.filter(p => p.id !== 1).forEach(p => {
    assert.equal(p.pos, null);
    assert.equal(p.pts, 0);
  });
});

test('a synced day3_stableford null value yields a null score, never NaN', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: null });
  assert.equal(parseScoreToPar(state.day3.scores[6]), null);
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: 'null' });
  assert.equal(parseScoreToPar(state.day3.scores[6]), null);
});

test('sumStablefordPoints totals points by team', () => {
  const sorted = computeStableford([
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: 38, team: 'B' },
    { id: 3, score: 36, team: 'A' }
  ]);
  assert.deepEqual(sumStablefordPoints(sorted), { a: 14 + 12, b: 13 });
});

test('sumStablefordPoints does not credit either team for a player not yet assigned to one', () => {
  const sorted = computeStableford([
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: 39, team: null }, // hasn't been through the Captain's Draft yet
    { id: 3, score: 38, team: 'B' }
  ]);
  // 1st=14pts (team A), 2nd=13pts (unassigned — must be dropped, not given to B), 3rd=12pts (team B)
  assert.deepEqual(sumStablefordPoints(sorted), { a: 14, b: 12 });
});

// issue #121, finding F3 case 2: POS_PTS only has 14 entries -- beyond
// that, points must fall to 0 rather than reading undefined off the end
// of the array (POS_PTS[k] || 0 already guards this; pin it).
test('computeStableford exhausts POS_PTS beyond 14 entries (positions 15/16 score 0)', () => {
  const entries = Array.from({ length: 16 }, (_, i) => ({ id: i, score: 100 - i, team: 'A' }));
  const sorted = computeStableford(entries);
  assert.equal(sorted[14].pos, 15);
  assert.equal(sorted[14].pts, 0);
  assert.equal(sorted[15].pos, 16);
  assert.equal(sorted[15].pts, 0);
});

// issue #121, finding F3 case 3: every player tied conserves the full
// 105-point pool (sum of POS_PTS) split evenly across all 14.
test('computeStableford splits the full 105-point pool evenly on an all-14-way tie', () => {
  const entries = Array.from({ length: 14 }, (_, i) => ({ id: i, score: 30, team: i < 7 ? 'A' : 'B' }));
  const sorted = computeStableford(entries);
  sorted.forEach(p => assert.equal(p.pts, 7.5));
  assert.deepEqual(sumStablefordPoints(sorted), { a: 52.5, b: 52.5 });
});

/* ── Tiebreak ── */

test('resolveOverallWinner declares the higher total the winner', () => {
  assert.deepEqual(resolveOverallWinner(21, 18, null), { winner: 'A', mode: 'points' });
  assert.deepEqual(resolveOverallWinner(18, 21, null), { winner: 'B', mode: 'points' });
});

// issue #121, finding F3 case 1: the highest-stakes unasserted behavior --
// a leftover sudden-death row from before a score correction must not
// hand the Cup to the wrong team once the totals are no longer tied.
test('resolveOverallWinner ignores a stale tiebreak when totals are not tied', () => {
  assert.deepEqual(resolveOverallWinner(21, 18, 'B'), { winner: 'A', mode: 'points' });
  assert.deepEqual(resolveOverallWinner(18, 21, 'A'), { winner: 'B', mode: 'points' });
});

test('resolveOverallWinner falls to the sudden-death result on a tie', () => {
  assert.deepEqual(resolveOverallWinner(20, 20, null), { winner: null, mode: 'tied-pending-tiebreak' });
  assert.deepEqual(resolveOverallWinner(20, 20, 'A'), { winner: 'A', mode: 'tiebreak' });
  assert.deepEqual(resolveOverallWinner(20, 20, 'B'), { winner: 'B', mode: 'tiebreak' });
});

/* ── Team assignment sync (issue #62 — whole-array sync lost concurrent moves) ── */

test('applyPlayerTeamMove moves only the named player, leaving everyone else put', () => {
  const teamA = new Set([0, 2, 4]);
  const teamB = new Set([1, 3, 5]);
  const result = applyPlayerTeamMove(teamA, teamB, 4, 'B');
  assert.deepEqual([...result.teamA].sort(), [0, 2]);
  assert.deepEqual([...result.teamB].sort(), [1, 3, 4, 5]);
});

test('applyPlayerTeamMove does not mutate the sets it was given', () => {
  const teamA = new Set([0, 2, 4]);
  const teamB = new Set([1, 3, 5]);
  applyPlayerTeamMove(teamA, teamB, 4, 'B');
  assert.deepEqual([...teamA].sort(), [0, 2, 4], 'original teamA must be untouched');
  assert.deepEqual([...teamB].sort(), [1, 3, 5], 'original teamB must be untouched');
});

test('applyPlayerTeamMove: two concurrent moves of DIFFERENT players compose instead of one clobbering the other', () => {
  // This is exactly the scenario that used to lose data (#62) when team
  // assignment synced as a whole-roster snapshot: two devices each moving
  // a different player, applied in sequence as their sync rows arrive.
  let teamA = new Set([0, 2, 4]);
  let teamB = new Set([1, 3, 5]);
  ({ teamA, teamB } = applyPlayerTeamMove(teamA, teamB, 4, 'B')); // device 1: move player 4 -> B
  ({ teamA, teamB } = applyPlayerTeamMove(teamA, teamB, 1, 'A')); // device 2: move player 1 -> A
  assert.deepEqual([...teamA].sort(), [0, 1, 2]);
  assert.deepEqual([...teamB].sort(), [3, 4, 5]);
});

/* ── Team dedupe (issue #71 — a stale whole-roster snapshot landing out of
   order after a delta move could leave a player in both teams at once) ── */

test('dedupeTeams is a no-op when no player appears in both sets', () => {
  const teamA = new Set([0, 2, 4]);
  const teamB = new Set([1, 3, 5]);
  const result = dedupeTeams(teamA, teamB);
  assert.deepEqual([...result.teamA].sort(), [0, 2, 4]);
  assert.deepEqual([...result.teamB].sort(), [1, 3, 5]);
  assert.deepEqual(result.dupes, []);
});

test('dedupeTeams keeps a duplicated player in Team A and drops them from Team B', () => {
  const teamA = new Set([0, 1, 4]);
  const teamB = new Set([1, 3, 5]); // player 1 stuck in both
  const result = dedupeTeams(teamA, teamB);
  assert.deepEqual([...result.teamA].sort(), [0, 1, 4]);
  assert.deepEqual([...result.teamB].sort(), [3, 5]);
  assert.deepEqual(result.dupes, [1]);
});

test('dedupeTeams resolves multiple duplicates at once', () => {
  const teamA = new Set([0, 1, 2]);
  const teamB = new Set([1, 2, 3]);
  const result = dedupeTeams(teamA, teamB);
  assert.deepEqual([...result.teamB].sort(), [3]);
  assert.deepEqual(result.dupes.sort(), [1, 2]);
});

test('dedupeTeams does not mutate the input sets', () => {
  const teamA = new Set([0, 1]);
  const teamB = new Set([1, 2]);
  dedupeTeams(teamA, teamB);
  assert.deepEqual([...teamA].sort(), [0, 1]);
  assert.deepEqual([...teamB].sort(), [1, 2]);
});

/* ── Match/team reconciliation (issue #65 — moving a player after they're
   slotted into a Day 1 match left a stale reference that silently blanked
   the dropdown yet kept counting the result, and wiped it on "fix") ── */

test('reconcileMatchesAfterTeamMove clears a match slot left pointing at a player who moved to the OTHER team', () => {
  const matches = [
    { type: 'singles', pA: [7], pB: [1], front9: 'A', back9: 'A' },
    { type: 'singles', pA: [null], pB: [null], front9: null, back9: null }
  ];
  const result = reconcileMatchesAfterTeamMove(matches, 7, 'B');
  assert.deepEqual(result.matches[0].pA, [null]);
  assert.equal(result.matches[0].front9, null);
  assert.equal(result.matches[0].back9, null);
  assert.deepEqual(result.matches[1], matches[1], 'untouched match must be unaffected');
});

test('reconcileMatchesAfterTeamMove clears the pB slot when the player moved to Team A', () => {
  const matches = [{ type: 'singles', pA: [3], pB: [9], front9: null, back9: null }];
  const result = reconcileMatchesAfterTeamMove(matches, 9, 'A');
  assert.deepEqual(result.matches[0].pB, [null]);
  assert.deepEqual(result.matches[0].pA, [3], 'the other slot is untouched');
});

test('reconcileMatchesAfterTeamMove reports every field it cleared, for syncing to other devices', () => {
  const matches = [{ type: 'singles', pA: [7], pB: [1], front9: 'A', back9: 'T' }];
  const result = reconcileMatchesAfterTeamMove(matches, 7, 'B');
  assert.deepEqual(result.changes, [
    { matchIdx: 0, field: 'pA', value: null },
    { matchIdx: 0, field: 'front9', value: null },
    { matchIdx: 0, field: 'back9', value: null }
  ]);
});

test('reconcileMatchesAfterTeamMove is a no-op when the player never appears on the stale side', () => {
  const matches = [{ type: 'singles', pA: [7], pB: [1], front9: 'A', back9: 'A' }];
  const result = reconcileMatchesAfterTeamMove(matches, 42, 'B');
  assert.deepEqual(result.matches, matches);
  assert.deepEqual(result.changes, []);
});

test('reconcileMatchesAfterTeamMove does not mutate the input matches array', () => {
  const matches = [{ type: 'singles', pA: [7], pB: [1], front9: 'A', back9: 'A' }];
  reconcileMatchesAfterTeamMove(matches, 7, 'B');
  assert.deepEqual(matches[0].pA, [7], 'original match object must be untouched');
});

// issue #121, finding F3 case 6: newTeam null means "unassigned," not a
// move to either side -- there's no stale slot to clear, so nothing
// should be wiped.
test('reconcileMatchesAfterTeamMove is a no-op when newTeam is null (player unassigned, not moved)', () => {
  const matches = [{ type: 'singles', pA: [7], pB: [1], front9: 'A', back9: 'A' }];
  const result = reconcileMatchesAfterTeamMove(matches, 7, null);
  assert.deepEqual(result.matches, matches);
  assert.deepEqual(result.changes, []);
});

/* ── Live sync row processing (issue #63 — one bad row wedged all future polls) ── */

test('processUpdateRows applies every row when none of them fail', () => {
  const applied = [];
  const rows = [
    { id: 1, updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, updated_at: '2026-01-01T00:00:01Z' }
  ];
  const result = processUpdateRows(rows, row => applied.push(row.id));
  assert.deepEqual(applied, [1, 2]);
  assert.equal(result.applied, 2);
  assert.deepEqual(result.failed, []);
  assert.equal(result.lastUpdatedAt, '2026-01-01T00:00:01Z');
});

test('processUpdateRows skips a row that throws but still applies the rest of the batch', () => {
  const applied = [];
  const rows = [
    { id: 1, updated_at: '2026-01-01T00:00:00Z' },
    { id: 2, updated_at: '2026-01-01T00:00:01Z', broken: true }, // e.g. bad JSON in a team_assign value
    { id: 3, updated_at: '2026-01-01T00:00:02Z' }
  ];
  const result = processUpdateRows(rows, row => {
    if (row.broken) throw new Error('malformed row');
    applied.push(row.id);
  });
  assert.deepEqual(applied, [1, 3], 'the row after the broken one must still be applied');
  assert.equal(result.applied, 2);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].row.id, 2);
});

test('processUpdateRows always reports the last row\'s timestamp, even when that row (or an earlier one) failed', () => {
  // This is the crux of the fix: the sync cursor must advance past a bad
  // row, or every future poll re-fetches and re-fails on the exact same
  // row forever, permanently wedging live sync for every client.
  const rows = [
    { id: 1, updated_at: '2026-01-01T00:00:00Z', broken: true },
    { id: 2, updated_at: '2026-01-01T00:00:01Z' }
  ];
  const result = processUpdateRows(rows, row => { if (row.broken) throw new Error('bad row'); });
  assert.equal(result.lastUpdatedAt, '2026-01-01T00:00:01Z');
});

// issue #121, finding F3 case 5: the #63 contract (a bad team_assign row
// throws but doesn't wedge the batch) end-to-end through
// applyUpdateToState, not just each half in isolation.
test('processUpdateRows + applyUpdateToState: a bad team_assign row is skipped but the later row still applies', () => {
  const state = makeState();
  const rows = [
    { update_type: 'team_assign', field_key: 'A', value: '{not json', updated_at: '2026-01-01T00:00:00Z' },
    { update_type: 'team_name', field_key: 'B', value: 'X', updated_at: '2026-01-01T00:00:01Z' }
  ];
  const result = processUpdateRows(rows, row => applyUpdateToState(state, row));
  assert.equal(result.failed.length, 1);
  assert.equal(result.applied, 1);
  assert.equal(state.teamNameB, 'X');
  assert.equal(result.lastUpdatedAt, '2026-01-01T00:00:01Z');
  assert.deepEqual([...state.teamA].sort(), [...makeState().teamA].sort());
});

test('processUpdateRows on an empty batch reports no timestamp', () => {
  const result = processUpdateRows([], () => {});
  assert.equal(result.lastUpdatedAt, null);
  assert.equal(result.applied, 0);
});

/* ── parseIntOrNull ── */

test('parseIntOrNull treats null, undefined, the string "null", and empty string as null', () => {
  assert.equal(parseIntOrNull(null), null);
  assert.equal(parseIntOrNull(undefined), null);
  assert.equal(parseIntOrNull('null'), null);
  assert.equal(parseIntOrNull(''), null);
});

test('parseIntOrNull parses a numeric string', () => {
  assert.equal(parseIntOrNull('7'), 7);
  assert.equal(parseIntOrNull('0'), 0);
});

/* ── applyUpdateToState — replaying a synced tournament_updates row onto
   local state, one update_type at a time. Mirrors what scorecard-live.html's
   applyUpdate() used to do inline (issues #58, #60-#63, #65, #66, #71 all
   involve this code path). ── */

function makeState() {
  return {
    teamNameA: 'Team Beer',
    teamNameB: 'Team Golf',
    teamA: new Set([0, 2, 4]),
    teamB: new Set([1, 3, 5]),
    day1: {
      matches: [
        { type: 'singles', pA: [null], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) },
        { type: 'singles', pA: [null], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) }
      ],
      ntp: { h8: null, h17: null }
    },
    day2: {
      a4: null, a3: null, b4: null, b3: null, ntp: { h4: null, h16: null },
      groups: { a4: [], a3: [], b4: [], b3: [] },
      holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
      anthem: {}
    },
    day3: { scores: {}, ntp: { h7: null, h14: null } },
    tiebreak: null
  };
}

test('applyUpdateToState: day1_match assigns a player into the pA/pB slot', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '3' });
  assert.equal(state.day1.matches[0].pA[0], 3);
});

test('applyUpdateToState: day1_match records and clears a front9/back9 result', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'front9', value: 'A' });
  assert.equal(state.day1.matches[1].front9, 'A');
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'front9', value: 'null' });
  assert.equal(state.day1.matches[1].front9, null);
});

test('applyUpdateToState: day1_match on an out-of-range match_idx is a no-op, not a throw', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'day1_match', match_idx: 99, field_key: 'front9', value: 'A' });
  });
});

test('applyUpdateToState: day1_match assigning a player already in another match evicts them there (issue #147)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '2' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'A' });
  state.day1.matches[0].holesA[0] = 4;
  // Two devices race to slot the same not-yet-used player into different
  // matches; the later row (in log order) wins and the earlier match's
  // stale assignment + any result recorded against it is cleared.
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pA', value: '2' });
  assert.equal(state.day1.matches[1].pA[0], 2);
  assert.equal(state.day1.matches[0].pA[0], null);
  assert.equal(state.day1.matches[0].front9, null);
  assert.equal(state.day1.matches[0].holesA[0], null);
});

test('applyUpdateToState: day1_match player eviction only touches the other match holding that exact id', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '5' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pA', value: '2' });
  assert.equal(state.day1.matches[0].pB[0], 5);
  assert.equal(state.day1.matches[1].pA[0], 2);
});

test('applyUpdateToState: day1_ntp sets the nearest-the-pin winner for a hole', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_ntp', field_key: 'h8', value: '5' });
  assert.equal(state.day1.ntp.h8, 5);
});

test('applyUpdateToState: day2_score sets and clears a group score to par', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: '-3' });
  assert.equal(state.day2.a4, '-3');
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: 'null' });
  assert.equal(state.day2.a4, null);
});

test('applyUpdateToState: day2_ntp sets the nearest-the-pin winner for a hole', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_ntp', field_key: 'h4', value: '9' });
  assert.equal(state.day2.ntp.h4, 9);
});

test('applyUpdateToState: day2_anthem records and clears a player\'s sung/not-sung flag (issue #149)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_anthem', player_id: 3, value: 'true' });
  assert.equal(state.day2.anthem[3], true);
  applyUpdateToState(state, { update_type: 'day2_anthem', player_id: 3, value: 'false' });
  assert.equal(state.day2.anthem[3], false);
  applyUpdateToState(state, { update_type: 'day2_anthem', player_id: 3, value: null });
  assert.equal(state.day2.anthem[3], undefined);
});

test('applyUpdateToState: day2_anthem rejects an out-of-range player_id without throwing', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'day2_anthem', player_id: 99, value: 'true' });
  });
  assert.deepEqual(state.day2.anthem, {});
});

test('applyUpdateToState: day3_stableford sets and clears a player\'s net score', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: '38' });
  assert.equal(state.day3.scores[6], '38');
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: 'null' });
  assert.equal(state.day3.scores[6], null);
});

test('applyUpdateToState: day3_stableford with no player_id is a no-op', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_stableford', value: '38' });
  assert.deepEqual(state.day3.scores, {});
});

test('applyUpdateToState: day3_ntp sets the nearest-the-pin winner for a hole', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_ntp', field_key: 'h7', value: '2' });
  assert.equal(state.day3.ntp.h7, 2);
});

test('applyUpdateToState: tiebreak sets and clears the sudden-death winner', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'tiebreak', value: 'B' });
  assert.equal(state.tiebreak, 'B');
  applyUpdateToState(state, { update_type: 'tiebreak', value: 'null' });
  assert.equal(state.tiebreak, null);
});

test('applyUpdateToState: team_name renames the given side only', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'team_name', field_key: 'A', value: 'The Mulligans' });
  assert.equal(state.teamNameA, 'The Mulligans');
  assert.equal(state.teamNameB, 'Team Golf');
});

test('applyUpdateToState: team_assign replaces a whole team roster from a JSON snapshot', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'team_assign', field_key: 'B', value: JSON.stringify([1, 3, 5, 7]) });
  assert.deepEqual([...state.teamB].sort(), [1, 3, 5, 7]);
});

test('applyUpdateToState: player_team moves a player between team sets', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'player_team', player_id: 2, value: 'B' });
  assert.equal(state.teamA.has(2), false);
  assert.equal(state.teamB.has(2), true);
});

test('applyUpdateToState: player_team also clears a Day 1 match slot left pointing at the player\'s old team (issue #65)', () => {
  const state = makeState();
  state.day1.matches[0].pA = [2];
  state.day1.matches[0].front9 = 'A';
  applyUpdateToState(state, { update_type: 'player_team', player_id: 2, value: 'B' });
  assert.equal(state.day1.matches[0].pA[0], null);
  assert.equal(state.day1.matches[0].front9, null);
  assert.equal(state.teamB.has(2), true);
});

test('applyUpdateToState: player_team with an invalid value is a no-op', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'player_team', player_id: 2, value: 'C' });
  assert.equal(state.teamA.has(2), true);
  assert.equal(state.teamB.has(2), false);
});

test('applyUpdateToState: an unrecognized update_type is a no-op, not a throw', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'something_new', value: 'x' });
  });
});

/* ── applyUpdateToState hardening (issues #109, #120) --
   the tournament_updates table is publicly writable, so a forged row's
   field_key, ids, and values must never be trusted verbatim. ── */

test('applyUpdateToState: day1_match pA with a non-numeric value stores null, not NaN', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: 'garbage' });
  assert.equal(state.day1.matches[0].pA[0], null);
  assert.equal(Number.isNaN(state.day1.matches[0].pA[0]), false);
});

test('applyUpdateToState: day2_score rejects an unlisted field_key (state.day2.ntp survives untouched)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'ntp', value: 'garbage' });
  assert.deepEqual(state.day2.ntp, { h4: null, h16: null });
});

test('applyUpdateToState: day1_match rejects field_key "type" and "__proto__" (match shape untouched)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'doubles' });
  assert.equal(state.day1.matches[0].type, 'singles');
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: '__proto__', value: '{}' });
  assert.deepEqual(Object.keys(state.day1.matches[0]).sort(), ['back9', 'front9', 'holesA', 'holesB', 'pA', 'pB', 'type'].sort());
});

test('applyUpdateToState: day2_score clamps synced values to +/-20 the same as local input', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: '999' });
  assert.equal(state.day2.a4, '20');
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: '-999' });
  assert.equal(state.day2.a4, '-20');
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: 'abc' });
  assert.equal(state.day2.a4, null);
  applyUpdateToState(state, { update_type: 'day2_score', field_key: 'a4', value: '-15' });
  assert.equal(state.day2.a4, '-15');
});

test('applyUpdateToState: day1_match front9 rejects a non-A/B/T value', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'Z' });
  assert.equal(state.day1.matches[0].front9, null);
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'A' });
  assert.equal(state.day1.matches[0].front9, 'A');
});

test('applyUpdateToState: day1_ntp rejects an unlisted hole key (no new key added)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_ntp', field_key: 'h99', value: '3' });
  assert.deepEqual(Object.keys(state.day1.ntp).sort(), ['h17', 'h8'].sort());
});

test('applyUpdateToState: tiebreak rejects any value other than A/B', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'tiebreak', value: 'C' });
  assert.equal(state.tiebreak, null);
  applyUpdateToState(state, { update_type: 'tiebreak', value: 'A' });
  assert.equal(state.tiebreak, 'A');
});

test('applyUpdateToState: day3_stableford clamps synced values to 0-60', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: '999' });
  assert.equal(state.day3.scores[6], '60');
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 6, value: '-50' });
  assert.equal(state.day3.scores[6], '0');
});

test('applyUpdateToState: day3_stableford rejects an out-of-range player_id', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: 14, value: '38' });
  assert.deepEqual(state.day3.scores, {});
  applyUpdateToState(state, { update_type: 'day3_stableford', player_id: -1, value: '38' });
  assert.deepEqual(state.day3.scores, {});
});

test('applyUpdateToState: day1_match rejects an out-of-range match_idx without throwing', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'day1_match', match_idx: -1, field_key: 'front9', value: 'A' });
  });
});

test('parseIntOrNull returns null for non-numeric text but keeps a deliberate partial parse', () => {
  assert.equal(parseIntOrNull('abc'), null);
  assert.equal(parseIntOrNull('12abc'), 12);
});

/* ── DAY 1 — AUTOMATIC HOLE-BY-HOLE SCORING (issue #124) ──
   matchStrokes/holeResult/nineFromHoles/nineStatus/effectiveNines are pure
   and course-data-free -- stroke indexes are passed in, never imported
   from courses.js, so these tests use arbitrary SI arrays. ── */

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1); // hole i -> SI i+1

test('matchStrokes: equal handicaps receive no strokes', () => {
  const result = matchStrokes('12.0', '12.0', SI_ASCENDING);
  assert.equal(result.receiver, null);
  assert.deepEqual(result.a, Array(18).fill(0));
  assert.deepEqual(result.b, Array(18).fill(0));
});

test('matchStrokes: 8.0 v 19.0 gives the higher handicap 11 strokes on SI 1-11 only', () => {
  const result = matchStrokes('8.0', '19.0', SI_ASCENDING);
  assert.equal(result.receiver, 'B');
  assert.deepEqual(result.a, Array(18).fill(0));
  assert.deepEqual(result.b, SI_ASCENDING.map(si => (si <= 11 ? 1 : 0)));
});

test('matchStrokes: receiver flips when the handicaps are swapped', () => {
  const result = matchStrokes('19.0', '8.0', SI_ASCENDING);
  assert.equal(result.receiver, 'A');
  assert.deepEqual(result.b, Array(18).fill(0));
  assert.deepEqual(result.a, SI_ASCENDING.map(si => (si <= 11 ? 1 : 0)));
});

test('matchStrokes: a fractional difference rounds to the nearest whole stroke (0.5 rounds up)', () => {
  const result = matchStrokes('8.0', '10.5', SI_ASCENDING);
  assert.equal(result.receiver, 'B');
  // |10.5 - 8| = 2.5 -> rounds to 3
  assert.deepEqual(result.b, SI_ASCENDING.map(si => (si <= 3 ? 1 : 0)));
});

test('matchStrokes: a difference over 18 wraps around (8.0 v 39.0 -> diff 31 -> 2 strokes on SI 1-13, 1 on SI 14-18)', () => {
  const result = matchStrokes('8.0', '39.0', SI_ASCENDING);
  assert.equal(result.receiver, 'B');
  assert.deepEqual(result.b, SI_ASCENDING.map(si => (si <= 13 ? 2 : 1)));
  assert.equal(result.b.reduce((s, n) => s + n, 0), 31);
});

test('holeResult: lower gross wins when neither player receives a stroke', () => {
  assert.equal(holeResult(4, 5, 0, 0), 'A');
  assert.equal(holeResult(5, 4, 0, 0), 'B');
});

test('holeResult: a stroke received can flip a gross loss into a net win', () => {
  assert.equal(holeResult(5, 5, 0, 1), 'B');
  assert.equal(holeResult(6, 5, 1, 0), 'T');
});

test('holeResult: equal net scores halve the hole', () => {
  assert.equal(holeResult(4, 4, 0, 0), 'T');
});

test('holeResult: a missing gross score on either side is null, not a guess', () => {
  assert.equal(holeResult(null, 4, 0, 0), null);
  assert.equal(holeResult(4, null, 0, 0), null);
  assert.equal(holeResult(null, null, 0, 0), null);
});

test('nineFromHoles: a 9-0 sweep is decided with the sweeping side as the result', () => {
  const nine = Array(9).fill('A');
  const result = nineFromHoles(nine);
  assert.deepEqual(result, { result: 'A', decided: true, wonA: 9, wonB: 0, played: 9 });
});

test('nineFromHoles: a 5-4 split over a full nine is decided in the leader\'s favour', () => {
  const nine = ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B'];
  const result = nineFromHoles(nine);
  assert.deepEqual(result, { result: 'A', decided: true, wonA: 5, wonB: 4, played: 9 });
});

test('nineFromHoles: a fully played 4-4 nine with one halved hole is a decided tie', () => {
  const nine = ['A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'T'];
  const result = nineFromHoles(nine);
  assert.deepEqual(result, { result: 'T', decided: true, wonA: 4, wonB: 4, played: 9 });
});

test('nineFromHoles: an incomplete nine with the lead still catchable is undecided (null result)', () => {
  const nine = ['A', 'A', 'A', 'B', 'B', null, null, null, null];
  const result = nineFromHoles(nine);
  assert.equal(result.decided, false);
  assert.equal(result.result, null);
  assert.equal(result.played, 5);
});

test('nineFromHoles: a lead that mathematically can\'t be caught is decided early ("5UP thru 7")', () => {
  const nine = ['A', 'A', 'A', 'A', 'A', 'A', 'B', null, null];
  const result = nineFromHoles(nine);
  assert.equal(result.decided, true);
  assert.equal(result.result, 'A');
  assert.equal(result.played, 7);
});

test('nineFromHoles: dormie (lead exactly equals holes remaining) is NOT decided -- trailing side can still halve', () => {
  const nine = ['A', 'A', 'A', 'A', 'B', 'B', 'T', null, null];
  const result = nineFromHoles(nine); // wonA=4, wonB=2, lead=2, remaining=2
  assert.equal(result.decided, false);
  assert.equal(result.result, null);
});

test('effectiveNines: hole data overrides a stale manual front9/back9 value', () => {
  const match = {
    front9: 'B', back9: null,
    holesA: [4, 4, 4, 4, 4, 4, 4, 4, 4, ...Array(9).fill(null)],
    holesB: [5, 5, 5, 5, 5, 5, 5, 5, 5, ...Array(9).fill(null)]
  };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  const result = effectiveNines(match, strokes);
  assert.equal(result.front9, 'A'); // derived from holes, ignoring the stale 'B'
  assert.equal(result.back9, null); // no back9 hole data -> falls back to manual (null)
});

test('effectiveNines: the manual value is honoured when a nine has no hole data at all', () => {
  const match = { front9: 'A', back9: 'T', holesA: Array(18).fill(null), holesB: Array(18).fill(null) };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  const result = effectiveNines(match, strokes);
  assert.equal(result.front9, 'A');
  assert.equal(result.back9, 'T');
});

test('effectiveNines: an undecided derived nine yields null even if a manual value is set underneath', () => {
  const match = {
    front9: 'A', back9: null, // stale manual value that must NOT leak through
    holesA: [4, 4, 4, null, null, null, null, null, null, ...Array(9).fill(null)],
    holesB: [5, 5, 5, null, null, null, null, null, null, ...Array(9).fill(null)]
  };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  const result = effectiveNines(match, strokes);
  assert.equal(result.front9, null);
});

test('effectiveNines + matchPoints: a derived result produces identical points to the same result entered manually (Day 1 totals unaffected)', () => {
  const derivedMatch = {
    front9: 'B', back9: 'B', // stale manual values that must be fully overridden
    holesA: [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    holesB: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]
  };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  const derived = effectiveNines(derivedMatch, strokes); // front9 all-B-win -> 'B', back9 all-halved -> 'T'
  const manualMatch = { front9: derived.front9, back9: derived.back9 };
  assert.deepEqual(matchPoints({ front9: derived.front9, back9: derived.back9 }), matchPoints(manualMatch));
  assert.deepEqual(matchPoints({ front9: derived.front9, back9: derived.back9 }), { a: 0.5, b: 1.5 });
});

test('nineStatus: all square partway through reports lead 0, no leader, not dormie', () => {
  const nine = ['A', 'B', 'A', 'B', null, null, null, null, null];
  const status = nineStatus(nine);
  assert.deepEqual(status, { lead: 0, leader: null, thru: 4, dormie: false, decided: false, margin: null });
});

test('nineStatus: an in-progress lead ("2UP thru 6") is not decided and not dormie', () => {
  const nine = ['A', 'A', 'B', 'A', 'A', 'B', null, null, null];
  const status = nineStatus(nine); // wonA=4, wonB=2, lead=2, thru=6, remaining=3
  assert.deepEqual(status, { lead: 2, leader: 'A', thru: 6, dormie: false, decided: false, margin: null });
});

test('nineStatus: dormie when the lead exactly equals the holes remaining', () => {
  const nine = ['A', 'A', 'A', 'A', 'B', 'B', 'T', null, null]; // wonA=4, wonB=2, lead=2, remaining=2
  const status = nineStatus(nine);
  assert.equal(status.dormie, true);
  assert.equal(status.decided, false);
});

test('nineStatus: a lead that beats the holes remaining is decided early, with margin = holes remaining ("3&2")', () => {
  const nine = ['A', 'A', 'A', 'A', 'A', 'B', 'B', null, null]; // wonA=5, wonB=2, lead=3, thru=7, remaining=2
  const status = nineStatus(nine);
  assert.deepEqual(status, { lead: 3, leader: 'A', thru: 7, dormie: false, decided: true, margin: 2 });
});

test('nineStatus: a fully played nine with a lead is decided with no margin ("2UP", not "&"-suffixed)', () => {
  const nine = ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'T']; // wonA=5, wonB=3, lead=2, thru=9
  const status = nineStatus(nine);
  assert.deepEqual(status, { lead: 2, leader: 'A', thru: 9, dormie: false, decided: true, margin: null });
});

test('applyUpdateToState: day1_hole sets and clears one gross score cell', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '5' });
  assert.equal(state.day1.matches[0].holesA[0], 5);
  applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: 'null' });
  assert.equal(state.day1.matches[0].holesA[0], null);
  applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: 'B18', value: '4' });
  assert.equal(state.day1.matches[0].holesB[17], 4);
});

test('applyUpdateToState: day1_hole clamps to DAY1_GROSS_MIN/MAX', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: 'A5', value: '999' });
  assert.equal(state.day1.matches[0].holesA[4], DAY1_GROSS_MAX);
  applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: 'A5', value: '-3' });
  assert.equal(state.day1.matches[0].holesA[4], DAY1_GROSS_MIN);
});

test('applyUpdateToState: day1_hole rejects a malformed field_key without throwing or writing anything', () => {
  const state = makeState();
  const before = JSON.stringify(state.day1.matches[0]);
  ['C1', 'A19', 'A0', 'AB1', 'A', 'front9'].forEach(key => {
    assert.doesNotThrow(() => {
      applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 0, field_key: key, value: '5' });
    });
  });
  assert.equal(JSON.stringify(state.day1.matches[0]), before);
});

test('applyUpdateToState: day1_hole rejects an out-of-range match_idx', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'day1_hole', match_idx: 99, field_key: 'A1', value: '5' });
  });
});

test('applyUpdateToState: player_team reassignment also clears any per-hole gross scores already entered', () => {
  const state = makeState();
  state.day1.matches[0].pA = [2];
  state.day1.matches[0].holesA[0] = 5;
  state.day1.matches[0].holesA[3] = 4;
  applyUpdateToState(state, { update_type: 'player_team', player_id: 2, value: 'B' });
  assert.deepEqual(state.day1.matches[0].holesA, Array(18).fill(null));
});

test('reconcileMatchesAfterTeamMove clears entered per-hole gross scores and reports each as a change', () => {
  const matches = [{
    type: 'singles', pA: [7], pB: [1], front9: null, back9: null,
    holesA: [5, null, ...Array(16).fill(null)],
    holesB: [4, null, ...Array(16).fill(null)]
  }];
  const result = reconcileMatchesAfterTeamMove(matches, 7, 'B');
  assert.deepEqual(result.matches[0].holesA, Array(18).fill(null));
  assert.deepEqual(result.matches[0].holesB, Array(18).fill(null));
  assert.ok(result.changes.some(c => c.field === 'A1' && c.value === null));
  assert.ok(result.changes.some(c => c.field === 'B1' && c.value === null));
});

/* ── DAY 2 — AUTOMATIC HOLE-BY-HOLE SCRAMBLE SCORING (issue #128) ──
   Golf Australia divisors confirmed by issue #136; team handicap rounds
   to the nearest whole number and is allocated per hole via stroke index
   (both confirmed decisions for issue #128). ── */

test('scrambleTeamHandicap: a 4-player group applies the 25/20/15/10 divisors, lowest handicap first', () => {
  // hcps sorted ascending: 8, 16, 19, 30 -> 8*.25 + 16*.20 + 19*.15 + 30*.10 = 2 + 3.2 + 2.85 + 3 = 11.05 -> rounds to 11
  const result = scrambleTeamHandicap(['19.0', '8.0', '30.0', '16.0']);
  assert.equal(result, 11);
});

test('scrambleTeamHandicap: a 3-player group applies the 30/20/10 divisors', () => {
  // sorted ascending: 8, 18, 26 -> 8*.30 + 18*.20 + 26*.10 = 2.4 + 3.6 + 2.6 = 8.6 -> rounds to 9
  const result = scrambleTeamHandicap(['26.0', '8.0', '18.0']);
  assert.equal(result, 9);
});

test('scrambleTeamHandicap: a 2-player group applies the 35/15 divisors', () => {
  // sorted ascending: 10, 20 -> 10*.35 + 20*.15 = 3.5 + 3 = 6.5 -> rounds to 7 (0.5 rounds up)
  const result = scrambleTeamHandicap(['20.0', '10.0']);
  assert.equal(result, 7);
});

test('scrambleTeamHandicap: an unsupported group size (not 2, 3, or 4) returns null rather than guessing', () => {
  assert.equal(scrambleTeamHandicap(['8.0']), null);
  assert.equal(scrambleTeamHandicap(['8.0', '9.0', '10.0', '11.0', '12.0']), null);
});

test('anthemAdjustedHandicap: -1 for sang, +2 for not sung, unchanged when no adjustment recorded (issue #149)', () => {
  assert.equal(anthemAdjustedHandicap('19.0', true), 18);
  assert.equal(anthemAdjustedHandicap('19.0', false), 21);
  assert.equal(anthemAdjustedHandicap('19.0', undefined), 19);
  assert.equal(anthemAdjustedHandicap('19.0', null), 19);
});

test('anthemAdjustedHandicap: feeds into scrambleTeamHandicap per player, not as a flat team adjustment', () => {
  // Same 4 hcps as the divisor test above (19, 8, 30, 16), but the 8.0
  // player didn't sing (+2 -> 10.0) and the 30.0 player sang (-1 -> 29.0).
  // Sorted ascending becomes 10, 16, 19, 29 -> 10*.25+16*.20+19*.15+29*.10
  // = 2.5 + 3.2 + 2.85 + 2.9 = 11.45 -> rounds to 11.
  const hcps = [
    anthemAdjustedHandicap('19.0', undefined),
    anthemAdjustedHandicap('8.0', false),
    anthemAdjustedHandicap('30.0', true),
    anthemAdjustedHandicap('16.0', undefined)
  ];
  assert.equal(scrambleTeamHandicap(hcps), 11);
});

test('groupStrokes: allocates the base stroke to every hole plus one extra on the lowest-SI holes', () => {
  // handicap 11 over 18 holes -> base 0, extra 11 -> 1 stroke on SI 1-11, 0 on SI 12-18
  const result = groupStrokes(11, SI_ASCENDING);
  assert.deepEqual(result, SI_ASCENDING.map(si => (si <= 11 ? 1 : 0)));
});

test('groupStrokes: a handicap over 18 wraps around (handicap 22 -> 1 stroke everywhere, 2 on SI 1-4)', () => {
  const result = groupStrokes(22, SI_ASCENDING);
  assert.deepEqual(result, SI_ASCENDING.map(si => (si <= 4 ? 2 : 1)));
  assert.equal(result.reduce((s, n) => s + n, 0), 22);
});

test('scrambleNetToParThru: sums net-to-par only over holes actually played', () => {
  const pars = Array(9).fill(4); // 9 holes, par 4 each -> par 36
  const strokes = Array(9).fill(1); // 1 stroke per hole
  const gross = [4, 4, 4, null, null, null, null, null, null]; // 3 holes played, gross 4 each
  const result = scrambleNetToParThru(gross, strokes, pars);
  // net per played hole = 4 - 1 = 3; 3 holes -> net 9, par played = 12 -> net-to-par = -3
  assert.deepEqual(result, { netToPar: -3, played: 3 });
});

test('scrambleNetToParThru: no holes played yet returns null, not zero', () => {
  const result = scrambleNetToParThru(Array(18).fill(null), Array(18).fill(0), Array(18).fill(4));
  assert.deepEqual(result, { netToPar: null, played: 0 });
});

test('scrambleRoundComplete: true only once every one of the 18 holes has a gross score', () => {
  assert.equal(scrambleRoundComplete(Array(18).fill(4)), true);
  const partial = Array(18).fill(4); partial[17] = null;
  assert.equal(scrambleRoundComplete(partial), false);
});

test('applyPlayerGroupMove: moves a player into a group, removing them from any other group first', () => {
  const groups = { a4: [1, 2], a3: [3], b4: [], b3: [] };
  const result = applyPlayerGroupMove(groups, 3, 'a4');
  assert.deepEqual(result.a4.sort(), [1, 2, 3]);
  assert.deepEqual(result.a3, []);
});

test('applyPlayerGroupMove: a null groupCode removes the player from every group without reassigning', () => {
  const groups = { a4: [1, 2], a3: [], b4: [], b3: [] };
  const result = applyPlayerGroupMove(groups, 1, null);
  assert.deepEqual(result.a4, [2]);
  assert.deepEqual(result.a3, []);
});

test('applyUpdateToState: day2_hole sets and clears one group\'s gross score for one hole', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_hole', field_key: 'a4_7', value: '5' });
  assert.equal(state.day2.holes.a4[6], 5);
  applyUpdateToState(state, { update_type: 'day2_hole', field_key: 'a4_7', value: 'null' });
  assert.equal(state.day2.holes.a4[6], null);
});

test('applyUpdateToState: day2_hole clamps to DAY2_HOLE_GROSS_MIN/MAX', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_hole', field_key: 'b3_1', value: '999' });
  assert.equal(state.day2.holes.b3[0], DAY2_HOLE_GROSS_MAX);
  applyUpdateToState(state, { update_type: 'day2_hole', field_key: 'b3_1', value: '-5' });
  assert.equal(state.day2.holes.b3[0], DAY2_HOLE_GROSS_MIN);
});

test('applyUpdateToState: day2_hole rejects a malformed field_key without throwing or writing anything', () => {
  const state = makeState();
  const before = JSON.stringify(state.day2.holes);
  ['c4_7', 'a4_19', 'a4_0', 'a4', 'front9'].forEach(key => {
    assert.doesNotThrow(() => {
      applyUpdateToState(state, { update_type: 'day2_hole', field_key: key, value: '5' });
    });
  });
  assert.equal(JSON.stringify(state.day2.holes), before);
});

test('applyUpdateToState: day2_group assigns and reassigns a player between groups', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_group', player_id: 2, value: 'a4' });
  assert.deepEqual(state.day2.groups.a4, [2]);
  applyUpdateToState(state, { update_type: 'day2_group', player_id: 2, value: 'a3' });
  assert.deepEqual(state.day2.groups.a4, []);
  assert.deepEqual(state.day2.groups.a3, [2]);
});

test('applyUpdateToState: day2_group rejects an out-of-range player_id and an invalid group code', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day2_group', player_id: 14, value: 'a4' });
  assert.deepEqual(state.day2.groups, { a4: [], a3: [], b4: [], b3: [] });
  applyUpdateToState(state, { update_type: 'day2_group', player_id: 2, value: 'c9' });
  assert.deepEqual(state.day2.groups, { a4: [], a3: [], b4: [], b3: [] });
});

/* ── ADMIN: FIELD HISTORY + RESTORE (issues #129, #132) ── */

const TEST_PLAYERS = [
  { id: 0, name: 'Alice Anderson', short: 'A. Anderson' },
  { id: 1, name: 'Bob Baker', short: 'B. Baker' }
];
const TEST_TEAM_NAMES = { A: 'Team Beer', B: 'Team Golf' };

test('describeUpdateRow: day1_match decodes pA/front9 into human labels, including cleared values', () => {
  const pA = describeUpdateRow({ update_type: 'day1_match', match_idx: 2, field_key: 'pA', value: '0' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(pA.fieldLabel, 'Match 3 · Team A slot');
  assert.equal(pA.valueLabel, 'A. Anderson');
  const front9 = describeUpdateRow({ update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: null }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(front9.fieldLabel, 'Match 1 · Front 9');
  assert.equal(front9.valueLabel, '(cleared)');
  const tie = describeUpdateRow({ update_type: 'day1_match', match_idx: 0, field_key: 'back9', value: 'T' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(tie.valueLabel, 'Tie');
});

test('describeUpdateRow: day1_hole decodes the hole/team from the field_key', () => {
  const result = describeUpdateRow({ update_type: 'day1_hole', match_idx: 4, field_key: 'B7', value: '5' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(result.fieldLabel, 'Match 5 · Hole 7 (Team B slot)');
  assert.equal(result.valueLabel, '5');
});

test('describeUpdateRow: day2_group and player_team decode the team name and player name', () => {
  const group = describeUpdateRow({ update_type: 'day2_group', player_id: 1, value: 'a4' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(group.fieldLabel, 'Day 2 Group · B. Baker');
  assert.equal(group.valueLabel, 'A4');
  const move = describeUpdateRow({ update_type: 'player_team', player_id: 0, value: 'B' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(move.fieldLabel, 'Player Team · A. Anderson');
  assert.equal(move.valueLabel, 'Team Golf');
});

test('describeUpdateRow: day2_anthem decodes sang/didn\'t-sing/cleared for a player', () => {
  const sang = describeUpdateRow({ update_type: 'day2_anthem', player_id: 1, value: 'true' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(sang.fieldLabel, 'Day 2 Anthem · B. Baker');
  assert.equal(sang.valueLabel, 'Sang (-1)');
  const notSung = describeUpdateRow({ update_type: 'day2_anthem', player_id: 1, value: 'false' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(notSung.valueLabel, "Didn't sing (+2)");
  const cleared = describeUpdateRow({ update_type: 'day2_anthem', player_id: 1, value: null }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(cleared.valueLabel, '(cleared)');
});

test('describeUpdateRow: an unknown player_id renders a safe fallback instead of throwing', () => {
  const result = describeUpdateRow({ update_type: 'day3_stableford', player_id: 99, value: '38' }, TEST_PLAYERS, TEST_TEAM_NAMES);
  assert.equal(result.fieldLabel, 'Day 3 Stableford · Player #99');
  assert.equal(result.valueLabel, '38');
});

test('describeUpdateRow: an unrecognized update_type renders raw info instead of crashing', () => {
  assert.doesNotThrow(() => {
    const result = describeUpdateRow({ update_type: 'some_future_type', value: 'x' }, TEST_PLAYERS, TEST_TEAM_NAMES);
    assert.match(result.fieldLabel, /some_future_type/);
    assert.equal(result.valueLabel, 'x');
  });
});

test('describeUpdateRow: covers every update_type in UPDATE_TYPE_DESCRIPTORS without throwing', () => {
  Object.keys(UPDATE_TYPE_DESCRIPTORS).forEach(type => {
    assert.doesNotThrow(() => {
      describeUpdateRow({ update_type: type, match_idx: 0, player_id: 0, field_key: 'pA', value: '0' }, TEST_PLAYERS, TEST_TEAM_NAMES);
    });
  });
});

test('isRestorable: every update_type is restorable except the legacy team_assign snapshot', () => {
  Object.keys(UPDATE_TYPE_DESCRIPTORS).forEach(type => {
    assert.equal(isRestorable(type), type !== 'team_assign');
  });
  assert.equal(isRestorable('not_a_real_type'), false);
});

test('buildRestoreRow: preserves field coordinates and value, dropping identity/authorship fields', () => {
  const historic = { id: 'uuid-123', update_type: 'day1_match', match_idx: 2, field_key: 'front9', value: 'A', updated_by: 'Old Author', updated_at: '2020-01-01T00:00:00Z' };
  const restored = buildRestoreRow(historic);
  assert.deepEqual(restored, { update_type: 'day1_match', match_idx: 2, player_id: null, field_key: 'front9', value: 'A' });
  assert.equal('id' in restored, false);
  assert.equal('updated_by' in restored, false);
  assert.equal('updated_at' in restored, false);
});

test('buildRestoreRow: preserves a null value (restoring to "cleared" is legitimate)', () => {
  const historic = { update_type: 'day1_ntp', field_key: 'h8', value: null, updated_by: 'x', updated_at: 'y' };
  const restored = buildRestoreRow(historic);
  assert.equal(restored.value, null);
});

test('replay sequence: apply original, apply overwrite, apply restore -> state matches the original value', () => {
  const state = makeState();
  const original = { update_type: 'day1_match', match_idx: 1, field_key: 'front9', value: 'A' };
  applyUpdateToState(state, original);
  assert.equal(state.day1.matches[1].front9, 'A');

  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'front9', value: 'B' });
  assert.equal(state.day1.matches[1].front9, 'B');

  const restoreRow = buildRestoreRow(original);
  applyUpdateToState(state, restoreRow);
  assert.equal(state.day1.matches[1].front9, 'A');
});
