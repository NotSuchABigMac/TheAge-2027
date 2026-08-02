import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  escapeHtml,
  defaultDay,
  ninePoints, matchPoints, sumMatchPoints,
  DAY1_GROSS_MIN, DAY1_GROSS_MAX,
  matchStrokes, holeResult, nineFromHoles, nineStatus, effectiveNines,
  day1CourseHolesFor, day1StrokeIndexesFor, scoreToParSymbol,
  matchStrokesForPlayers, effectiveMatchFor,
  REACTION_EMOJI, holeScoreReaction, stablefordTotalReaction,
  ntpTeamPoints,
  parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2, day2InputState,
  DAY2_HOLE_GROSS_MIN, DAY2_HOLE_GROSS_MAX,
  scrambleTeamHandicap, groupStrokes, scrambleNetToParThru, scrambleRoundComplete, applyPlayerGroupMove,
  ANTHEM_STROKE_ADJUSTMENT, anthemAdjustedHandicap, HCP_MIN, HCP_MAX, playersWithOverrides,
  POS_PTS, computeStableford, sumStablefordPoints,
  DAY3_HOLE_GROSS_MIN, DAY3_HOLE_GROSS_MAX,
  resolveOverallWinner,
  applyPlayerTeamMove, dedupeTeams, reconcileMatchesAfterTeamMove, processUpdateRows,
  parseIntOrNull, applyUpdateToState,
  UPDATE_TYPE_DESCRIPTORS, describeUpdateRow, isRestorable, buildRestoreRow,
  normalizeState, flushQueue,
  day1SeatKind, day1SeatsCompatible
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

// Issue #256: a Captain's Challenge match's 2-opponent side has 2 slots --
// moving one of those two opponents must only clear THEIR slot, leaving
// the other opponent (and the lone player on the far side) untouched.
test('reconcileMatchesAfterTeamMove: a challenge side\'s back-9 opponent (slot 1) moving away clears only slot 1', () => {
  const matches = [{ type: 'challenge', challengeSide: 'A', pA: [7, 9], pB: [1], front9: 'A', back9: 'A' }];
  const result = reconcileMatchesAfterTeamMove(matches, 9, 'B');
  assert.deepEqual(result.matches[0].pA, [7, null]);
  assert.deepEqual(result.changes, [
    { matchIdx: 0, field: 'pA2', value: null },
    { matchIdx: 0, field: 'front9', value: null },
    { matchIdx: 0, field: 'back9', value: null }
  ]);
});

test('reconcileMatchesAfterTeamMove: the challenge side\'s front-9 opponent (slot 0) moving away clears only slot 0', () => {
  const matches = [{ type: 'challenge', challengeSide: 'A', pA: [7, 9], pB: [1], front9: null, back9: null }];
  const result = reconcileMatchesAfterTeamMove(matches, 7, 'B');
  assert.deepEqual(result.matches[0].pA, [null, 9]);
  assert.deepEqual(result.changes, [{ matchIdx: 0, field: 'pA', value: null }]);
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
      ntp: { h8: null, h17: null },
      locked: false
    },
    day2: {
      a4: null, a3: null, b4: null, b3: null, ntp: { h4: null, h16: null },
      groups: { a4: [], a3: [], b4: [], b3: [] },
      holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
      anthem: {},
      locked: false
    },
    day3: { scores: {}, ntp: { h7: null, h14: null }, locked: false },
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

test('applyUpdateToState: day_lock locks and unlocks the named day', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day_lock', field_key: 'day2', value: 'true' });
  assert.equal(state.day2.locked, true);
  assert.equal(state.day1.locked, false);
  applyUpdateToState(state, { update_type: 'day_lock', field_key: 'day2', value: 'false' });
  assert.equal(state.day2.locked, false);
});

test('applyUpdateToState: day_lock with a forged field_key is a no-op (issue #120-style whitelist)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day_lock', field_key: 'tiebreak', value: 'true' });
  assert.equal(state.tiebreak, null);
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

test('applyUpdateToState: day1_match rejects field_key "__proto__" (match shape untouched)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: '__proto__', value: '{}' });
  assert.deepEqual(Object.keys(state.day1.matches[0]).sort(), ['back9', 'front9', 'holesA', 'holesB', 'pA', 'pB', 'type'].sort());
});

// Issue #256: 'type'/'challengeSide' are legitimate day1_match fields (the
// Captain's Challenge toggle), unlike the historical 'doubles' era -- any
// value other than the one recognized type still coerces safely rather
// than being accepted verbatim.
test('applyUpdateToState: day1_match "type" accepts "challenge", coerces anything else to "singles"', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'challenge' });
  assert.equal(state.day1.matches[0].type, 'challenge');
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'doubles' });
  assert.equal(state.day1.matches[0].type, 'singles');
});

test('applyUpdateToState: day1_match "challengeSide" accepts A/B, coerces anything else to null', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'challengeSide', value: 'A' });
  assert.equal(state.day1.matches[0].challengeSide, 'A');
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'challengeSide', value: 'zz' });
  assert.equal(state.day1.matches[0].challengeSide, null);
});

test('applyUpdateToState: day1_match pA2/pB2 assign the 2nd (back-9 opponent) slot without touching slot 0', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '2' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA2', value: '4' });
  assert.deepEqual(state.day1.matches[0].pA, [2, 4]);
});

test('applyUpdateToState: assigning a player via pA2 evicts them from another match\'s any slot (issue #256)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pB2', value: '9' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA2', value: '9' });
  assert.equal(state.day1.matches[0].pA[1], 9);
  assert.equal(state.day1.matches[1].pB[1], null);
});

test('day1SeatKind classifies ordinary, double, and lone seats correctly', () => {
  const singles = { type: 'singles', challengeSide: null };
  const challengeA = { type: 'challenge', challengeSide: 'A' };
  assert.equal(day1SeatKind(singles, 'pA'), 'ordinary');
  assert.equal(day1SeatKind(singles, 'pB'), 'ordinary');
  assert.equal(day1SeatKind(challengeA, 'pA'), 'double');
  assert.equal(day1SeatKind(challengeA, 'pB'), 'lone');
});

test('day1SeatsCompatible only allows an ordinary+double pairing', () => {
  assert.equal(day1SeatsCompatible('ordinary', 'double'), true);
  assert.equal(day1SeatsCompatible('double', 'ordinary'), true);
  assert.equal(day1SeatsCompatible('ordinary', 'ordinary'), false);
  assert.equal(day1SeatsCompatible('double', 'double'), false);
  assert.equal(day1SeatsCompatible('lone', 'double'), false);
  assert.equal(day1SeatsCompatible('lone', 'ordinary'), false);
});

test('applyUpdateToState: an ordinary singles seat and a Captain\'s Challenge opponent seat may be held by the same player at once (issue #328)', () => {
  const state = makeState();
  // Match 0: ordinary singles, player 2 as pA.
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '2' });
  // Match 1: flipped to a Challenge with team A as the 2-opponent (double) side.
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'type', value: 'challenge' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'challengeSide', value: 'A' });
  // The same player is also picked as match 1's front-9 opponent -- must
  // NOT evict them from their match-0 singles seat, and vice versa.
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pA', value: '2' });
  assert.equal(state.day1.matches[0].pA[0], 2, 'ordinary singles seat must survive');
  assert.equal(state.day1.matches[1].pA[0], 2, 'Challenge opponent seat must be set');
});

test('applyUpdateToState: assigning the Challenge opponent seat first, then the ordinary singles seat, is also non-evicting (issue #328)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'challenge' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'challengeSide', value: 'B' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pB2', value: '5' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pB', value: '5' });
  assert.equal(state.day1.matches[0].pB[1], 5, 'Challenge opponent seat must survive');
  assert.equal(state.day1.matches[1].pB[0], 5, 'ordinary singles seat must be set');
});

test('applyUpdateToState: the Captain\'s Challenge lone/single side keeps the strict one-seat rule (issue #328)', () => {
  const state = makeState();
  // Match 0: Challenge, team A double (opponents), team B lone (spare player 9).
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'challenge' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'challengeSide', value: 'A' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pB', value: '9' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'front9', value: 'A' });
  state.day1.matches[0].holesB[0] = 4;
  // Assigning the same player into an ordinary singles match elsewhere must
  // still evict them from the Challenge's lone seat -- that seat is
  // deliberately excluded from the new dual-seat exception.
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pB', value: '9' });
  assert.equal(state.day1.matches[1].pB[0], 9);
  assert.equal(state.day1.matches[0].pB[0], null);
  assert.equal(state.day1.matches[0].front9, null);
  assert.equal(state.day1.matches[0].holesB[0], null);
});

test('applyUpdateToState: two Captain\'s Challenge opponent seats on different matches still evict each other (issue #328)', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'type', value: 'challenge' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'challengeSide', value: 'A' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'type', value: 'challenge' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'challengeSide', value: 'A' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 0, field_key: 'pA', value: '7' });
  applyUpdateToState(state, { update_type: 'day1_match', match_idx: 1, field_key: 'pA', value: '7' });
  assert.equal(state.day1.matches[1].pA[0], 7);
  assert.equal(state.day1.matches[0].pA[0], null);
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

test('matchStrokes: a non-numeric handicap yields no strokes for anyone, never NaN (issue #164)', () => {
  const r = matchStrokes('abc', '10.0', [1, 2, 3]);
  assert.equal(r.receiver, null);
  assert.deepEqual(r.a, [0, 0, 0]);
  assert.deepEqual(r.b, [0, 0, 0]);
  assert.equal(matchStrokes(undefined, '10.0', [1, 2, 3]).receiver, null);
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

test('nineFromHoles: an empty nine reports a decided tie (pin of current behavior -- real callers always pass 9 entries, issue #164)', () => {
  assert.deepEqual(nineFromHoles([]), { result: 'T', decided: true, wonA: 0, wonB: 0, played: 0 });
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

test('effectiveNines: a match without hole arrays falls back to the manual nine values instead of throwing (issue #164)', () => {
  const match = { pA: [1], pB: [2], front9: 'A', back9: null }; // no holesA/holesB
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  assert.deepEqual(effectiveNines(match, strokes), { front9: 'A', back9: null });
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

/* ── matchStrokesForPlayers / effectiveMatchFor (issue #256 — Captain's
   Challenge: a match's 2-opponent side can face a different opponent each
   nine, so strokes are now computed per-nine rather than once across all
   18 holes). ── */

const CHALLENGE_SI = Array.from({ length: 18 }, (_, i) => i + 1); // hole i -> SI i+1
const CHALLENGE_PLAYERS = [
  { id: 1, hcp: '8.0' },
  { id: 2, hcp: '19.0' },
  { id: 3, hcp: '12.0' }
];

test('matchStrokesForPlayers: an ordinary singles match is unaffected by the per-nine refactor (equivalence check)', () => {
  const match = { type: 'singles', pA: [1], pB: [2] };
  const result = matchStrokesForPlayers(match, CHALLENGE_PLAYERS, CHALLENGE_SI);
  // Same worked example as the direct matchStrokes() test above: |19-8|=11,
  // extra=11, so B receives a stroke on every hole whose SI is <= 11.
  assert.deepEqual(result.a, Array(18).fill(0));
  assert.deepEqual(result.b, CHALLENGE_SI.map(si => (si <= 11 ? 1 : 0)));
});

test('matchStrokesForPlayers: missing player(s) on a plain singles match yields all-zero strokes, not a throw', () => {
  const result = matchStrokesForPlayers({ type: 'singles', pA: [null], pB: [2] }, CHALLENGE_PLAYERS, CHALLENGE_SI);
  assert.deepEqual(result.a, Array(18).fill(0));
  assert.deepEqual(result.b, Array(18).fill(0));
});

test('matchStrokesForPlayers: a Captain\'s Challenge match computes each nine against ITS OWN opponent', () => {
  // Team A fields 2 opponents (challengeSide 'A'): player 1 (hcp 8) plays
  // the front 9, player 3 (hcp 12) plays the back 9, both against the lone
  // player 2 (hcp 19) on Team B.
  const match = { type: 'challenge', challengeSide: 'A', pA: [1, 3], pB: [2] };
  const result = matchStrokesForPlayers(match, CHALLENGE_PLAYERS, CHALLENGE_SI);
  // Front 9 (SI 1-9): |19-8|=11 -> every front-9 hole (SI 1-9, all <= 11) gets a stroke.
  assert.deepEqual(result.b.slice(0, 9), Array(9).fill(1));
  assert.deepEqual(result.a.slice(0, 9), Array(9).fill(0));
  // Back 9 (SI 10-18): |19-12|=7 -> no back-9 hole has SI <= 7, so zero strokes either way
  assert.deepEqual(result.b.slice(9), Array(9).fill(0));
  assert.deepEqual(result.a.slice(9), Array(9).fill(0));
});

test('matchStrokesForPlayers: without a back-9 opponent assigned yet, the challenge side falls back to its front-9 player for both nines', () => {
  const match = { type: 'challenge', challengeSide: 'A', pA: [1], pB: [2] }; // no pA[1] yet
  const withFallback = matchStrokesForPlayers(match, CHALLENGE_PLAYERS, CHALLENGE_SI);
  const plainSingles = matchStrokesForPlayers({ type: 'singles', pA: [1], pB: [2] }, CHALLENGE_PLAYERS, CHALLENGE_SI);
  assert.deepEqual(withFallback, plainSingles);
});

test('matchStrokesForPlayers: the lone-opponent side of a challenge match still uses the same player for both nines', () => {
  // challengeSide 'B' -- Team B fields 2 opponents, Team A has the lone player.
  const match = { type: 'challenge', challengeSide: 'B', pA: [2], pB: [1, 3] };
  const result = matchStrokesForPlayers(match, CHALLENGE_PLAYERS, CHALLENGE_SI);
  assert.deepEqual(result.a.slice(0, 9), Array(9).fill(1)); // front: |19-8|=11
  assert.deepEqual(result.a.slice(9), Array(9).fill(0));    // back: |19-12|=7, none of SI 10-18 <= 7
});

test('effectiveMatchFor: a Captain\'s Challenge match still resolves each nine\'s winner from its own strokes', () => {
  const match = {
    type: 'challenge', challengeSide: 'A', pA: [1, 3], pB: [2],
    front9: null, back9: null,
    // Front 9: B (hcp 19) receives a stroke on every hole (SI 1-9 all <= 11)
    // -- both gross 5, so B's net (5-1=4) beats A's net (5-0=5) every hole.
    holesA: [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    holesB: [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4]
  };
  const eff = effectiveMatchFor(match, CHALLENGE_PLAYERS, CHALLENGE_SI);
  assert.equal(eff.front9, 'B'); // B wins every front-9 hole on strokes received
  assert.equal(eff.back9, 'T');  // back 9: no strokes either way (|19-12|=7, none of SI10-18 <=7), all-square holes
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

test('scrambleTeamHandicap: a non-numeric handicap in the group returns null, never NaN (issue #164)', () => {
  assert.equal(scrambleTeamHandicap(['abc', '10']), null);
  assert.equal(scrambleTeamHandicap(['8.0', undefined, '20.0']), null);
  assert.equal(typeof scrambleTeamHandicap(['8.0', '16.0', '19.0', '23.0']), 'number');
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

/* ── Admin handicap overrides (issue #206) ── */

test('playersWithOverrides: with no overrides object, returns the exact same array (fallback to players.js default)', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '8.0' }];
  assert.equal(playersWithOverrides(players, undefined), players);
  assert.equal(playersWithOverrides(players, null), players);
});

test('playersWithOverrides: an override replaces just that player\'s hcp, leaving others and other fields untouched', () => {
  const players = [{ id: 0, hcp: '10.0', name: 'Brendan' }, { id: 1, hcp: '8.0', name: 'Gary' }];
  const result = playersWithOverrides(players, { 1: '5.5' });
  assert.equal(result[0].hcp, '10.0');
  assert.equal(result[1].hcp, '5.5');
  assert.equal(result[1].name, 'Gary'); // untouched
  assert.equal(result[0], players[0]); // untouched player object identity preserved
});

test('playersWithOverrides: undefined/null/empty-string entries in the overrides map fall back to the default, not blank the handicap', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  assert.equal(playersWithOverrides(players, { 0: undefined })[0].hcp, '10.0');
  assert.equal(playersWithOverrides(players, { 0: null })[0].hcp, '10.0');
  assert.equal(playersWithOverrides(players, { 0: '' })[0].hcp, '10.0');
});

test('playersWithOverrides: an override composes correctly with anthemAdjustedHandicap/scrambleTeamHandicap (issue #149 + #206 together)', () => {
  // Same 4-player group as the anthem composition test above, but player
  // with hcp 8.0 has an admin override down to 5.0 -- the anthem
  // adjustment (didn't sing, +2) must apply on top of the OVERRIDDEN base
  // (5.0 -> 7.0), not the original roster value (8.0 -> 10.0).
  const players = [
    { id: 0, hcp: '19.0' }, { id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }, { id: 3, hcp: '16.0' }
  ];
  const resolved = playersWithOverrides(players, { 1: '5.0' });
  const hcps = [
    anthemAdjustedHandicap(resolved[0].hcp, undefined),
    anthemAdjustedHandicap(resolved[1].hcp, false),
    anthemAdjustedHandicap(resolved[2].hcp, true),
    anthemAdjustedHandicap(resolved[3].hcp, undefined)
  ];
  assert.deepEqual(hcps, [19, 7, 29, 16]);
  // Sorted ascending: 7, 16, 19, 29 -> 7*.25 + 16*.20 + 19*.15 + 29*.10 = 1.75+3.2+2.85+2.9 = 10.7 -> 11
  assert.equal(scrambleTeamHandicap(hcps), 11);
});

test('applyUpdateToState: player_hcp sets and clears a player\'s handicap override', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'player_hcp', player_id: 4, value: '15.5' });
  assert.equal(state.hcp[4], '15.5');
  applyUpdateToState(state, { update_type: 'player_hcp', player_id: 4, value: null });
  assert.equal(state.hcp[4], undefined);
  assert.equal(4 in state.hcp, false);
});

test('applyUpdateToState: player_hcp clamps to HCP_MIN/HCP_MAX', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'player_hcp', player_id: 0, value: '999' });
  assert.equal(state.hcp[0], String(HCP_MAX));
  applyUpdateToState(state, { update_type: 'player_hcp', player_id: 1, value: '-5' });
  assert.equal(state.hcp[1], String(HCP_MIN));
});

test('applyUpdateToState: player_hcp rejects an out-of-range player_id or a non-numeric value without throwing', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'player_hcp', player_id: 99, value: '10' });
  });
  assert.equal(state.hcp, undefined); // rejected before touching state at all
  applyUpdateToState(state, { update_type: 'player_hcp', player_id: 0, value: 'not-a-number' });
  assert.equal(0 in state.hcp, false);
});

test('normalizeState: state.hcp missing initializes to {}, and non-numeric entries are dropped on repair', () => {
  const missing = makeState();
  delete missing.hcp;
  normalizeState(missing);
  assert.deepEqual(missing.hcp, {});

  const malformed = makeState();
  malformed.hcp = { 0: '15.5', 1: 'garbage', 2: { not: 'a string' }, 3: '8' };
  normalizeState(malformed);
  assert.deepEqual(malformed.hcp, { 0: '15.5', 3: '8' });
});

test('applyUpdateToState replay: player_hcp rows converge to the same final state regardless of arrival order (offline queue reordering)', () => {
  const rowsInOrder = [
    { update_type: 'player_hcp', player_id: 2, value: '12.0' },
    { update_type: 'player_hcp', player_id: 2, value: '11.5' },
    { update_type: 'player_hcp', player_id: 5, value: '20.0' }
  ];
  const forward = makeState();
  rowsInOrder.forEach(r => applyUpdateToState(forward, r));
  // A processUpdateRows-style replay of the exact same rows (not reordered,
  // since applyUpdateToState has no timestamp to sort by on its own --
  // this proves idempotent re-application converges, the actual ordering
  // guarantee lives in processUpdateRows()/the updated_at sort upstream)
  // applied twice lands on the same final values either way.
  const replayed = makeState();
  rowsInOrder.concat(rowsInOrder).forEach(r => applyUpdateToState(replayed, r));
  assert.deepEqual(forward.hcp, replayed.hcp);
  assert.equal(forward.hcp[2], '11.5');
  assert.equal(forward.hcp[5], '20'); // clamping re-stringifies via parseFloat, so trailing .0 is dropped
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

test('applyUpdateToState: day3_hole sets and clears one player\'s gross score for one hole, creating the holes array lazily', () => {
  const state = makeState();
  assert.equal(state.day3.holes, undefined); // not pre-populated (issue #188 -- sparse, unlike Day 2's fixed keys)
  applyUpdateToState(state, { update_type: 'day3_hole', player_id: 2, field_key: 'h7', value: '5' });
  assert.equal(state.day3.holes[2][6], 5);
  applyUpdateToState(state, { update_type: 'day3_hole', player_id: 2, field_key: 'h7', value: 'null' });
  assert.equal(state.day3.holes[2][6], null);
});

test('applyUpdateToState: day3_hole clamps to DAY3_HOLE_GROSS_MIN/MAX', () => {
  const state = makeState();
  applyUpdateToState(state, { update_type: 'day3_hole', player_id: 0, field_key: 'h1', value: '999' });
  assert.equal(state.day3.holes[0][0], DAY3_HOLE_GROSS_MAX);
  applyUpdateToState(state, { update_type: 'day3_hole', player_id: 0, field_key: 'h1', value: '-5' });
  assert.equal(state.day3.holes[0][0], DAY3_HOLE_GROSS_MIN);
});

test('applyUpdateToState: day3_hole rejects an out-of-range player_id or malformed field_key without throwing or writing anything', () => {
  const state = makeState();
  assert.doesNotThrow(() => {
    applyUpdateToState(state, { update_type: 'day3_hole', player_id: 99, field_key: 'h1', value: '5' });
    applyUpdateToState(state, { update_type: 'day3_hole', player_id: -1, field_key: 'h1', value: '5' });
    applyUpdateToState(state, { update_type: 'day3_hole', player_id: 0, field_key: 'h19', value: '5' });
    applyUpdateToState(state, { update_type: 'day3_hole', player_id: 0, field_key: 'a1', value: '5' });
  });
  assert.equal(state.day3.holes, undefined);
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

// UPDATE_TYPE_DESCRIPTORS (exported, drives the Admin history picker) and
// UPDATE_FIELD_KEYS (not exported, drives applyUpdateToState's field_key
// whitelist) are two hand-maintained lists that must agree -- a future
// update_type added to one and not the other fails silently (issue #163):
// either the admin picker offers a field every apply call rejects, or the
// whitelist accepts a field the picker can't address. Tested behaviorally
// through applyUpdateToState since UPDATE_FIELD_KEYS isn't exported.
function validValueFor(updateType, fieldKey) {
  if (updateType === 'day1_match') {
    if (fieldKey === 'pA' || fieldKey === 'pB' || fieldKey === 'pA2' || fieldKey === 'pB2') return '3';
    if (fieldKey === 'type') return 'challenge';
    if (fieldKey === 'challengeSide') return 'A';
    return 'A'; // front9/back9
  }
  if (updateType === 'day1_ntp' || updateType === 'day2_ntp' || updateType === 'day3_ntp') return '3';
  if (updateType === 'day2_score') return '-5';
  if (updateType === 'team_name') return 'Test Name';
  if (updateType === 'day_lock') return 'true';
  throw new Error(`validValueFor: no case for update_type "${updateType}" -- add one alongside its UPDATE_FIELD_KEYS entry`);
}
function assertFieldAccepted(state, updateType, fieldKey) {
  if (updateType === 'day1_match') {
    if (fieldKey === 'pA') { assert.equal(state.day1.matches[0].pA[0], 3, `${updateType}/${fieldKey} should be accepted`); return; }
    if (fieldKey === 'pB') { assert.equal(state.day1.matches[0].pB[0], 3, `${updateType}/${fieldKey} should be accepted`); return; }
    if (fieldKey === 'pA2') { assert.equal(state.day1.matches[0].pA[1], 3, `${updateType}/${fieldKey} should be accepted`); return; }
    if (fieldKey === 'pB2') { assert.equal(state.day1.matches[0].pB[1], 3, `${updateType}/${fieldKey} should be accepted`); return; }
    if (fieldKey === 'type') { assert.equal(state.day1.matches[0].type, 'challenge', `${updateType}/${fieldKey} should be accepted`); return; }
    if (fieldKey === 'challengeSide') { assert.equal(state.day1.matches[0].challengeSide, 'A', `${updateType}/${fieldKey} should be accepted`); return; }
    assert.equal(state.day1.matches[0][fieldKey], 'A', `${updateType}/${fieldKey} should be accepted`);
    return;
  }
  if (updateType === 'day1_ntp' || updateType === 'day2_ntp' || updateType === 'day3_ntp') {
    const dayKey = updateType.split('_')[0];
    assert.equal(state[dayKey].ntp[fieldKey], 3, `${updateType}/${fieldKey} should be accepted`);
    return;
  }
  if (updateType === 'day2_score') {
    assert.equal(state.day2[fieldKey], '-5', `${updateType}/${fieldKey} should be accepted`);
    return;
  }
  if (updateType === 'team_name') {
    assert.equal(state[fieldKey === 'A' ? 'teamNameA' : 'teamNameB'], 'Test Name', `${updateType}/${fieldKey} should be accepted`);
    return;
  }
  if (updateType === 'day_lock') {
    assert.equal(state[fieldKey].locked, true, `${updateType}/${fieldKey} should be accepted`);
    return;
  }
  throw new Error(`assertFieldAccepted: no case for update_type "${updateType}"`);
}
// Sets don't survive JSON.stringify, so teamA/teamB are sorted into arrays
// first; everything else round-trips through JSON, same approach the
// makeState()-based tests elsewhere in this file already use.
function stateSnapshot(state) {
  return JSON.stringify({
    teamNameA: state.teamNameA, teamNameB: state.teamNameB,
    teamA: [...state.teamA].sort((a, b) => a - b), teamB: [...state.teamB].sort((a, b) => a - b),
    day1: state.day1, day2: state.day2, day3: state.day3, tiebreak: state.tiebreak
  });
}

test('applyUpdateToState: every admin-descriptor fieldKey is accepted', () => {
  Object.entries(UPDATE_TYPE_DESCRIPTORS).forEach(([updateType, desc]) => {
    if (!desc.fieldKeys || updateType === 'team_assign') return;
    desc.fieldKeys.forEach(fieldKey => {
      const state = makeState();
      applyUpdateToState(state, { update_type: updateType, match_idx: 0, field_key: fieldKey, value: validValueFor(updateType, fieldKey) });
      assertFieldAccepted(state, updateType, fieldKey);
    });
  });

  // team_assign is addressed differently (a JSON roster snapshot, not a
  // scalar), so it gets its own explicit case rather than validValueFor.
  const assigned = makeState();
  applyUpdateToState(assigned, { update_type: 'team_assign', field_key: 'A', value: JSON.stringify([1, 2]) });
  assert.deepEqual([...assigned.teamA].sort((a, b) => a - b), [1, 2]);
  const rejectedAssign = makeState();
  applyUpdateToState(rejectedAssign, { update_type: 'team_assign', field_key: 'zz', value: JSON.stringify([1, 2]) });
  assert.deepEqual([...rejectedAssign.teamA].sort((a, b) => a - b), [...makeState().teamA].sort((a, b) => a - b));
});

test('applyUpdateToState: a field_key outside the descriptor list is rejected for every whitelisted update_type', () => {
  const fresh = stateSnapshot(makeState());
  Object.entries(UPDATE_TYPE_DESCRIPTORS).forEach(([updateType, desc]) => {
    if (!desc.fieldKeys) return;
    const state = makeState();
    applyUpdateToState(state, { update_type: updateType, match_idx: 0, field_key: 'zz', value: 'x' });
    assert.equal(stateSnapshot(state), fresh, `${updateType}: state changed on a bogus field_key`);
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

/* ── normalizeState + flushQueue (issue #166) ──
   Extracted from scorecard-live.html with no behavior change --
   normalizeState() runs on every page load against whatever's in
   localStorage and repairs a wrong-shaped or stale-format payload before
   anything else touches it; flushQueue() is the queue-walking core of the
   offline retry queue (issue #66). Characterization tests: they encode
   what the extracted code does today. */

test('normalizeState: missing/malformed day1 is replaced and padded to 6 singles matches', () => {
  const state = { day1: { matches: 'not-an-array' }, day2: {}, day3: {} };
  normalizeState(state);
  assert.equal(state.day1.matches.length, 6);
  state.day1.matches.forEach(m => {
    assert.deepEqual(m, { type: 'singles', challengeSide: null, pA: [null], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) });
  });
  assert.deepEqual(state.day1.ntp, { h8: null, h17: null });
  assert.equal(state.day1.locked, false);
});

test('normalizeState: a doubles-era match is coerced to singles, keeping only slot 0', () => {
  const state = {
    day1: { matches: [{ type: 'doubles', pA: [3, 5], pB: [2, 4], front9: 'A', back9: null }] },
    day2: {}, day3: {}
  };
  normalizeState(state);
  const m = state.day1.matches[0];
  assert.equal(m.type, 'singles');
  assert.equal(m.challengeSide, null);
  assert.deepEqual(m.pA, [3]);
  assert.deepEqual(m.pB, [2]);
  assert.equal(m.front9, 'A');
  assert.equal(m.back9, null);
  assert.equal(m.holesA.length, 18);
  assert.equal(m.holesB.length, 18);
});

// Issue #256: a genuine 'challenge' match keeps its 2nd slot, but only on
// the side named by challengeSide -- the other side (the lone opponent)
// stays a normal 1-slot side, same shape as any singles match.
test('normalizeState: a challenge match keeps its 2nd slot only on challengeSide; garbage challengeSide coerces to null and drops it', () => {
  const good = {
    day1: { matches: [{ type: 'challenge', challengeSide: 'A', pA: [3, 5], pB: [2], front9: null, back9: null }] },
    day2: {}, day3: {}
  };
  normalizeState(good);
  const m = good.day1.matches[0];
  assert.equal(m.type, 'challenge');
  assert.equal(m.challengeSide, 'A');
  assert.deepEqual(m.pA, [3, 5]);
  assert.deepEqual(m.pB, [2]);

  const badSide = {
    day1: { matches: [{ type: 'challenge', challengeSide: 'zz', pA: [3, 5], pB: [2, 4], front9: null, back9: null }] },
    day2: {}, day3: {}
  };
  normalizeState(badSide);
  const m2 = badSide.day1.matches[0];
  assert.equal(m2.type, 'challenge');
  assert.equal(m2.challengeSide, null);
  assert.deepEqual(m2.pA, [3], 'no valid challengeSide means neither side keeps a 2nd slot');
  assert.deepEqual(m2.pB, [2]);
});

test('normalizeState: a wrong-length/garbage holesA array is repaired to 18 clamped entries', () => {
  const state = {
    day1: { matches: [{ type: 'singles', pA: [1], pB: [2], front9: null, back9: null, holesA: ['4', 99, 'x'], holesB: [] }] },
    day2: {}, day3: {}
  };
  normalizeState(state);
  const holesA = state.day1.matches[0].holesA;
  assert.equal(holesA.length, 18);
  assert.equal(holesA[0], 4);
  assert.equal(holesA[1], DAY1_GROSS_MAX); // 99 clamped
  assert.equal(holesA[2], null); // 'x' isn't a number
  assert.deepEqual(holesA.slice(3), Array(15).fill(null));
});

test('normalizeState: a missing day2 gets the full default shape, including groups/holes for all four codes', () => {
  const state = { day1: { matches: [] }, day3: {} };
  normalizeState(state);
  assert.deepEqual(state.day2.groups, { a4: [], a3: [], b4: [], b3: [] });
  ['a4', 'a3', 'b4', 'b3'].forEach(code => {
    assert.deepEqual(state.day2.holes[code], Array(18).fill(null));
  });
  assert.equal(state.day2.a4, null);
  assert.deepEqual(state.day2.ntp, { h4: null, h16: null });
  assert.equal(state.day2.locked, false);
});

test('normalizeState: legacy day2.a2/b2 keys are renamed to a3/b3 only when a3/b3 are absent', () => {
  const renamed = { day1: { matches: [] }, day2: { a2: '-8', b2: '-4' }, day3: {} };
  normalizeState(renamed);
  assert.equal(renamed.day2.a3, '-8');
  assert.equal(renamed.day2.b3, '-4');
  assert.equal('a2' in renamed.day2, false);
  assert.equal('b2' in renamed.day2, false);

  const notClobbered = { day1: { matches: [] }, day2: { a2: '-8', a3: '-99' }, day3: {} };
  normalizeState(notClobbered);
  assert.equal(notClobbered.day2.a3, '-99');
  assert.equal('a2' in notClobbered.day2, false);
});

test('normalizeState: a player in two day2 groups keeps only the first (a4/a3/b4/b3 order); non-numeric ids drop', () => {
  const state = {
    day1: { matches: [] },
    day2: { groups: { a4: [1, 2], a3: [2, 3, 'x'], b4: [], b3: [] } },
    day3: {}
  };
  normalizeState(state);
  assert.deepEqual(state.day2.groups.a4, [1, 2]);
  assert.deepEqual(state.day2.groups.a3, [3]);
});

test('normalizeState: a bare day3 scores map (pre-refactor shape) becomes {scores, ntp}', () => {
  const state = { day1: { matches: [] }, day2: {}, day3: { '0': '38', '1': '40' } };
  normalizeState(state);
  assert.deepEqual(state.day3.scores, { '0': '38', '1': '40' });
  assert.deepEqual(state.day3.ntp, { h7: null, h14: null });
  assert.equal(state.day3.locked, false);
});

test('normalizeState: a missing day3.holes becomes an empty object (sparse, not pre-populated per player)', () => {
  const state = { day1: { matches: [] }, day2: {}, day3: { scores: {} } };
  normalizeState(state);
  assert.deepEqual(state.day3.holes, {});
});

test('normalizeState: an existing day3.holes entry is repaired to 18 clamped entries, same as Day 1/Day 2 hole arrays', () => {
  const state = { day1: { matches: [] }, day2: {}, day3: { scores: {}, holes: { 3: ['4', 99, 'x'] } } };
  normalizeState(state);
  const holes3 = state.day3.holes[3];
  assert.equal(holes3.length, 18);
  assert.equal(holes3[0], 4);
  assert.equal(holes3[1], DAY3_HOLE_GROSS_MAX); // 99 clamped
  assert.equal(holes3[2], null); // 'x' isn't a number
  assert.deepEqual(holes3.slice(3), Array(15).fill(null));
});

test('normalizeState: an already-normal state passes through unchanged', () => {
  const normal = {
    day1: {
      matches: Array.from({ length: 6 }, () => ({ type: 'singles', challengeSide: null, pA: [null], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) })),
      ntp: { h8: null, h17: null }, locked: false
    },
    day2: {
      a4: null, a3: null, b4: null, b3: null, ntp: { h4: null, h16: null },
      groups: { a4: [], a3: [], b4: [], b3: [] },
      holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
      anthem: {}, locked: false
    },
    day3: { scores: {}, ntp: { h7: null, h14: null }, locked: false, holes: {} },
    hcp: {}
  };
  const before = JSON.stringify(normal);
  normalizeState(normal);
  assert.equal(JSON.stringify(normal), before);
});

test('flushQueue: every item sending "ok" empties the queue, calling sendFn once per item in order', async () => {
  const calls = [];
  const sendFn = async (w) => { calls.push(w); return 'ok'; };
  const result = await flushQueue([{ id: 1 }, { id: 2 }, { id: 3 }], sendFn);
  assert.deepEqual(result, []);
  assert.deepEqual(calls, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('flushQueue: a "network" failure in the middle is requeued, later items are still attempted', async () => {
  const calls = [];
  const sendFn = async (w) => { calls.push(w.id); return w.id === 2 ? 'network' : 'ok'; };
  const result = await flushQueue([{ id: 1 }, { id: 2 }, { id: 3 }], sendFn);
  assert.deepEqual(result, [{ id: 2 }]);
  assert.deepEqual(calls, [1, 2, 3]);
});

test('flushQueue: an "auth" result stops the pass immediately and requeues every remaining item, including itself (issue #141 semantics)', async () => {
  const calls = [];
  const sendFn = async (w) => { calls.push(w.id); return w.id === 2 ? 'auth' : 'ok'; };
  const result = await flushQueue([{ id: 1 }, { id: 2 }, { id: 3 }], sendFn);
  assert.deepEqual(result, [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(calls, [1, 2]); // item 3 was never even attempted this pass
});

/* ── defaultDay (issue #193 — tab-by-date default) ── */
test('defaultDay: maps each tournament date to its day tab, pinned to Australia/Melbourne local time', () => {
  assert.equal(defaultDay(new Date('2026-08-07T00:00:00Z')), 'day1'); // 10:00 AEST 7 Aug
  assert.equal(defaultDay(new Date('2026-08-08T00:00:00Z')), 'day2'); // 10:00 AEST 8 Aug
  assert.equal(defaultDay(new Date('2026-08-09T00:00:00Z')), 'day3'); // 10:00 AEST 9 Aug
});

test('defaultDay: a UTC instant that has already rolled into the next Melbourne day picks the Melbourne day, not the UTC one', () => {
  // 2026-08-06T14:00:00Z is midnight AEST on 7 Aug -- a naive UTC-date
  // check would still see "6 Aug" and wrongly return null/day-before.
  assert.equal(defaultDay(new Date('2026-08-06T14:00:00Z')), 'day1');
  // Conversely, 2026-08-09T13:59:00Z is still 23:59 AEST on 9 Aug.
  assert.equal(defaultDay(new Date('2026-08-09T13:59:00Z')), 'day3');
  // and 2026-08-09T14:00:00Z has rolled into 10 Aug AEST -- no tournament day.
  assert.equal(defaultDay(new Date('2026-08-09T14:00:00Z')), null);
});

test('defaultDay: outside the tournament dates returns null so the caller falls back', () => {
  assert.equal(defaultDay(new Date('2026-08-06T00:00:00Z')), null);
  assert.equal(defaultDay(new Date('2026-08-10T00:00:00Z')), null);
  assert.equal(defaultDay(new Date('2025-08-07T00:00:00Z')), null);
});

/* ── scoreToParSymbol / day1CourseHolesFor (issue #250 — golf leaderboard
   scoring symbols on entered hole scores) ── */
test('scoreToParSymbol: maps gross-vs-par to the standard leaderboard marks', () => {
  assert.equal(scoreToParSymbol(2, 4), 'eagle');   // -2 or better
  assert.equal(scoreToParSymbol(1, 4), 'eagle');   // -3, still eagle-or-better
  assert.equal(scoreToParSymbol(3, 4), 'birdie');  // -1
  assert.equal(scoreToParSymbol(4, 4), 'par');      // even
  assert.equal(scoreToParSymbol(5, 4), 'bogey');   // +1
  assert.equal(scoreToParSymbol(6, 4), 'double-bogey'); // +2
  assert.equal(scoreToParSymbol(9, 4), 'double-bogey'); // +5, still double-bogey-or-worse
});

test('scoreToParSymbol: null whenever the gross score or par is missing (no score entered yet)', () => {
  assert.equal(scoreToParSymbol(null, 4), null);
  assert.equal(scoreToParSymbol(undefined, 4), null);
  assert.equal(scoreToParSymbol(4, null), null);
});

test('day1CourseHolesFor: returns the Murray Course par/SI per hole', () => {
  const courses = { 1: { holes: [{ hole: 1, par: 4, si: 6 }, { hole: 2, par: 3, si: 18 }] } };
  assert.deepEqual(day1CourseHolesFor(courses), courses[1].holes);
});

test('day1CourseHolesFor: degrades to a flat par-4 fallback if courses.js somehow failed to load', () => {
  const fallback = day1CourseHolesFor(null);
  assert.equal(fallback.length, 18);
  assert.equal(fallback[0].par, 4);
  assert.equal(fallback[0].si, 1);
});

/* ── holeScoreReaction / stablefordTotalReaction (issue #228 — undo toast
   score reaction emoji) ── */
test('holeScoreReaction: buckets by net-to-par (gross minus strokes, minus par)', () => {
  // Par 4, no strokes received.
  assert.equal(holeScoreReaction(2, 4, 0), 'great'); // net eagle (-2)
  assert.equal(holeScoreReaction(3, 4, 0), 'great'); // net birdie (-1)
  assert.equal(holeScoreReaction(4, 4, 0), 'ok');     // net par (0)
  assert.equal(holeScoreReaction(5, 4, 0), 'ok');     // net bogey (+1)
  assert.equal(holeScoreReaction(6, 4, 0), 'bad');    // net double-bogey (+2)
  assert.equal(holeScoreReaction(9, 4, 0), 'bad');    // net +5, still bad
});

test('holeScoreReaction: a stroke received shifts the bucket the same way it shifts the score-to-par symbol', () => {
  // Par 4, gross 5, but this player gets 1 stroke -> net 4 -> net par -> ok.
  assert.equal(holeScoreReaction(5, 4, 1), 'ok');
  // Same gross/par with 2 strokes received -> net 3 -> net birdie -> great.
  assert.equal(holeScoreReaction(5, 4, 2), 'great');
});

test('holeScoreReaction: null gross (no score entered) means no reaction', () => {
  assert.equal(holeScoreReaction(null, 4, 0), null);
  assert.equal(holeScoreReaction(undefined, 4, 0), null);
});

test('stablefordTotalReaction: buckets around the 36pt "played to handicap" baseline', () => {
  assert.equal(stablefordTotalReaction(45), 'great');
  assert.equal(stablefordTotalReaction(40), 'great'); // boundary
  assert.equal(stablefordTotalReaction(39), 'ok');    // boundary
  assert.equal(stablefordTotalReaction(36), 'ok');
  assert.equal(stablefordTotalReaction(32), 'ok');    // boundary
  assert.equal(stablefordTotalReaction(31), 'bad');   // boundary
  assert.equal(stablefordTotalReaction(0), 'bad');
});

test('stablefordTotalReaction: accepts a numeric string (as stored) as well as a number', () => {
  assert.equal(stablefordTotalReaction('42'), 'great');
});

test('stablefordTotalReaction: null/blank/non-numeric total means no reaction', () => {
  assert.equal(stablefordTotalReaction(null), null);
  assert.equal(stablefordTotalReaction(undefined), null);
  assert.equal(stablefordTotalReaction(''), null);
  assert.equal(stablefordTotalReaction('abc'), null);
});

test('REACTION_EMOJI: has exactly one deterministic emoji per bucket', () => {
  assert.equal(REACTION_EMOJI.great, '🎉');
  assert.equal(REACTION_EMOJI.ok, '🙂');
  assert.equal(REACTION_EMOJI.bad, '😥');
});
