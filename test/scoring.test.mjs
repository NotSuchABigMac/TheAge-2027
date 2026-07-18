import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ninePoints, matchPoints, sumMatchPoints,
  ntpTeamPoints,
  parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2,
  POS_PTS, computeStableford, sumStablefordPoints,
  resolveOverallWinner
} = require('../scoring.js');

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
