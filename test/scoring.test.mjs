import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  escapeHtml,
  ninePoints, matchPoints, sumMatchPoints,
  ntpTeamPoints,
  parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2, day2InputState,
  POS_PTS, computeStableford, sumStablefordPoints,
  resolveOverallWinner,
  applyPlayerTeamMove, reconcileMatchesAfterTeamMove, processUpdateRows
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

test('sumStablefordPoints totals points by team', () => {
  const sorted = computeStableford([
    { id: 1, score: 40, team: 'A' },
    { id: 2, score: 38, team: 'B' },
    { id: 3, score: 36, team: 'A' }
  ]);
  assert.deepEqual(sumStablefordPoints(sorted), { a: 14 + 12, b: 13 });
});

/* ── Tiebreak ── */

test('resolveOverallWinner declares the higher total the winner', () => {
  assert.deepEqual(resolveOverallWinner(21, 18, null), { winner: 'A', mode: 'points' });
  assert.deepEqual(resolveOverallWinner(18, 21, null), { winner: 'B', mode: 'points' });
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

test('processUpdateRows on an empty batch reports no timestamp', () => {
  const result = processUpdateRows([], () => {});
  assert.equal(result.lastUpdatedAt, null);
  assert.equal(result.applied, 0);
});
