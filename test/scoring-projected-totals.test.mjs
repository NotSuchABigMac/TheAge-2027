/* Issue #260 -- unit tests for the "if everything ended right now"
   projection helpers in scoring.js (projectedNinePoints,
   projectedMatchPoints, projectedMatchPointsFor, sumProjectedMatchPoints,
   projectedDay2Field, projectedDay2Totals, projectedTotals).

   These are pure, additive functions that live alongside the real
   scoring path (matchPoints/day2GroupPoints/calcDay1/calcDay2) rather
   than inside it -- the core invariant under test throughout is that a
   *projection* never touches, replaces, or diverges from those real
   functions' output once a match/round is actually decided. Each
   "degrades to the real score" test below proves that by feeding the
   same complete input to both the projected and the real path and
   asserting identical results. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchPoints, day2GroupPoints, day2Bonus,
  day1StrokeIndexesFor, matchStrokesForPlayers, effectiveMatchFor,
  day2CourseHolesFor, day2GroupHandicapFor, effectiveDay2FieldFor,
  projectedNinePoints, projectedMatchPoints, projectedMatchPointsFor, sumProjectedMatchPoints,
  projectedDay2Field, projectedDay2Totals, projectedTotals
} = require('../scoring.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
const COURSES_FIXTURE = {
  1: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) },
  2: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) }
};

/* ── projectedNinePoints ── */

test('projectedNinePoints: no holes played (thru 0) projects nothing, not a 0.5-0.5 tie', () => {
  assert.deepEqual(projectedNinePoints(Array(9).fill(null)), { a: 0, b: 0 });
});

test('projectedNinePoints: in-progress with a clear leader projects a full point to them', () => {
  const results = ['A', 'A', 'A', null, null, null, null, null, null];
  assert.deepEqual(projectedNinePoints(results), { a: 1, b: 0 });
});

test('projectedNinePoints: in-progress dead level (thru > 0, no leader) projects a 0.5-0.5 split', () => {
  const results = ['A', 'B', null, null, null, null, null, null, null];
  assert.deepEqual(projectedNinePoints(results), { a: 0.5, b: 0.5 });
});

test('projectedNinePoints degrades to the real ninePoints()-equivalent once the nine is fully played', () => {
  const resultsAWin = ['A', 'A', 'T', 'B', 'A', 'A', 'T', 'A', 'A']; // A wins outright
  assert.deepEqual(projectedNinePoints(resultsAWin), { a: 1, b: 0 });
  const resultsTie = ['A', 'B', 'T', 'A', 'B', 'T', 'A', 'B', 'T']; // dead-even split
  assert.deepEqual(projectedNinePoints(resultsTie), { a: 0.5, b: 0.5 });
});

/* ── projectedMatchPoints / projectedMatchPointsFor ── */

test('projectedMatchPoints: no hole arrays at all falls back to the manual front9/back9 value, same fallback effectiveNines() uses', () => {
  const match = { front9: 'A', back9: 'T', holesA: null, holesB: null };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  assert.deepEqual(projectedMatchPoints(match, strokes), matchPoints({ front9: 'A', back9: 'T' }));
});

test('projectedMatchPoints: a nine with no hole data yet falls back to its own manual value even when the other nine has hole data', () => {
  const match = {
    front9: null, back9: 'B', // back9 has no hole data -> falls back to manual 'B'
    holesA: [4, 4, 4, ...Array(15).fill(null)],
    holesB: [5, 5, 5, ...Array(15).fill(null)]
  };
  const strokes = { a: Array(18).fill(0), b: Array(18).fill(0) };
  const got = projectedMatchPoints(match, strokes);
  // Front9: A leads 3-0 thru 3 -> projects a full point to A. Back9: manual 'B' -> a full point to B.
  assert.deepEqual(got, { a: 1, b: 1 });
});

test('projectedMatchPointsFor degrades to the real effectiveMatchFor()+matchPoints() once both nines are fully decided', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }]; // equal hcp -> no strokes
  const match = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [4, 4, 4, 4, 4, 5, 5, 5, 5, 4, 4, 4, 4, 4, 5, 5, 5, 5],
    holesB: [5, 5, 5, 5, 5, 4, 4, 4, 4, 5, 5, 5, 5, 5, 4, 4, 4, 4]
  };
  const day1SI = day1StrokeIndexesFor(COURSES_FIXTURE);
  const projected = projectedMatchPointsFor(match, players, day1SI);
  const real = matchPoints(effectiveMatchFor(match, players, day1SI));
  assert.deepEqual(projected, real);
});

test('sumProjectedMatchPoints sums projectedMatchPointsFor across every match', () => {
  const players = [
    { id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' },
    { id: 2, hcp: '12.0' }, { id: 3, hcp: '12.0' }
  ];
  const day1SI = day1StrokeIndexesFor(COURSES_FIXTURE);
  const matchDecidedAWin = {
    pA: [0], pB: [1], front9: 'A', back9: 'A', holesA: null, holesB: null
  };
  const matchInProgress = {
    pA: [2], pB: [3], front9: null, back9: null,
    holesA: [4, 4, 4, ...Array(15).fill(null)],
    holesB: [5, 5, 5, ...Array(15).fill(null)]
  };
  const got = sumProjectedMatchPoints([matchDecidedAWin, matchInProgress], players, day1SI);
  // Decided match: 2pts A. In-progress front9 projects a full point to A (3-0 thru 3), back9 untouched (0-0).
  assert.deepEqual(got, { a: 3, b: 0 });
});

/* ── projectedDay2Field ── */

// Groups are scramble teams of 3+ (SCRAMBLE_HANDICAP_PCT has no entry for
// a lone player) -- all-zero handicaps keep the stroke math trivial (net
// == gross) so these tests isolate the hole-progress logic under test.
const GROUP3_ZERO_HCP = [{ id: 0, hcp: '0.0' }, { id: 1, hcp: '0.0' }, { id: 2, hcp: '0.0' }];

test('projectedDay2Field: no hole data at all falls back to the manual stored value, same fallback effectiveDay2FieldFor() uses', () => {
  const day2 = { a4: '3', groups: { a4: [0, 1, 2] }, anthem: {}, holes: { a4: Array(18).fill(null) } };
  assert.equal(projectedDay2Field('a4', day2, GROUP3_ZERO_HCP, COURSES_FIXTURE), 3);
});

test('projectedDay2Field: partial hole-by-hole data projects net-to-par thru whatever has been entered so far', () => {
  const day2 = {
    a4: null, groups: { a4: [0, 1, 2] }, anthem: {},
    holes: { a4: [4, 3, 4, ...Array(15).fill(null)] } // 3 holes, all par 4 -> net-to-par -1
  };
  assert.equal(projectedDay2Field('a4', day2, GROUP3_ZERO_HCP, COURSES_FIXTURE), -1);
});

test('projectedDay2Field degrades to the real effectiveDay2FieldFor() once the round is fully played (same net-to-par, modulo effectiveDay2FieldFor\'s legacy string-ification of its result)', () => {
  const day2 = {
    a4: null, groups: { a4: [0, 1, 2] }, anthem: {},
    holes: { a4: Array(18).fill(4) } // 18 holes, all par 4, all scored 4 -> even par
  };
  const projected = projectedDay2Field('a4', day2, GROUP3_ZERO_HCP, COURSES_FIXTURE);
  const real = effectiveDay2FieldFor('a4', day2, GROUP3_ZERO_HCP, COURSES_FIXTURE);
  assert.equal(projected, Number(real));
  assert.equal(projected, 0);
});

/* ── projectedDay2Totals ── */

function emptyDay2() {
  return {
    a4: null, a3: null, b4: null, b3: null,
    groups: { a4: [], a3: [], b4: [], b3: [] },
    anthem: {},
    holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
    ntp: { h4: null, h16: null }
  };
}

test('projectedDay2Totals: withholds the 5pt bonus until every one of the 4 groups has at least some signal', () => {
  const players = [
    { id: 0, hcp: '0.0' }, { id: 1, hcp: '0.0' }, { id: 2, hcp: '0.0' },
    { id: 3, hcp: '0.0' }, { id: 4, hcp: '0.0' }, { id: 5, hcp: '0.0' }
  ];
  const day2 = emptyDay2();
  day2.groups.a4 = [0, 1, 2];
  day2.groups.b4 = [3, 4, 5];
  day2.holes.a4 = [3, ...Array(17).fill(null)]; // A ahead by 1 stroke thru 1
  day2.holes.b4 = [4, ...Array(17).fill(null)];
  // a3/b3 groups have no signal at all -> bonus withheld even though the
  // 4-group differential itself is already computable.
  const got = projectedDay2Totals(day2, players, COURSES_FIXTURE);
  assert.deepEqual(got.bonus, { a: 0, b: 0 });
  assert.equal(got.four.a, 1);
  assert.equal(got.four.b, 0);
});

test('projectedDay2Totals degrades to real day2GroupPoints()/day2Bonus() once all 4 groups are fully played', () => {
  const players = Array.from({ length: 12 }, (_, i) => ({ id: i, hcp: '0.0' }));
  const day2 = emptyDay2();
  day2.groups = { a4: [0, 1, 2], a3: [3, 4, 5], b4: [6, 7, 8], b3: [9, 10, 11] };
  day2.holes.a4 = Array(18).fill(4); // even par
  day2.holes.a3 = Array(18).fill(3); // -18 to par
  day2.holes.b4 = Array(18).fill(5); // +18 to par
  day2.holes.b3 = Array(18).fill(4); // even par

  const projected = projectedDay2Totals(day2, players, COURSES_FIXTURE);
  const a4 = 0, a3 = -18, b4 = 18, b3 = 0;
  const realFour = day2GroupPoints(a4, b4);
  const realThree = day2GroupPoints(a3, b3);
  const realBonus = day2Bonus(a4 + a3, b4 + b3);
  assert.deepEqual(projected.four, realFour);
  assert.deepEqual(projected.three, realThree);
  assert.deepEqual(projected.bonus, realBonus);
  assert.equal(projected.a, realFour.a + realThree.a + realBonus.a);
  assert.equal(projected.b, realFour.b + realThree.b + realBonus.b);
});

/* ── projectedTotals ── */

function emptyDay1() {
  return {
    matches: Array.from({ length: 6 }, () => ({
      pA: [null], pB: [null], front9: null, back9: null,
      holesA: Array(18).fill(null), holesB: Array(18).fill(null)
    })),
    ntp: { h8: null, h17: null }
  };
}

test('projectedTotals: an entirely empty state projects zero for both teams', () => {
  const state = { day1: emptyDay1(), day2: emptyDay2(), teamA: new Set(), teamB: new Set() };
  const got = projectedTotals(state, [], COURSES_FIXTURE);
  assert.deepEqual(got, { totalA: 0, totalB: 0 });
});

test('projectedTotals: an in-progress Day 1 match with a clear leader shows up in the projection before it is decided', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }];
  const day1 = emptyDay1();
  day1.matches[0] = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [4, 4, 4, ...Array(15).fill(null)],
    holesB: [5, 5, 5, ...Array(15).fill(null)]
  };
  const state = { day1, day2: emptyDay2(), teamA: new Set([0]), teamB: new Set([1]) };
  const got = projectedTotals(state, players, COURSES_FIXTURE);
  assert.equal(got.totalA, 1); // front9 projects a full point to A, back9 untouched
  assert.equal(got.totalB, 0);
});

test('projectedTotals degrades to computeSeasonTotals\' day1+day2 numbers once everything is fully decided', () => {
  const { computeSeasonTotals } = require('../scoring.js');
  const players = [
    { id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: i + 2, hcp: '0.0' }))
  ];
  const day1 = emptyDay1();
  day1.matches[0] = { pA: [0], pB: [1], front9: 'A', back9: 'T', holesA: null, holesB: null };
  day1.ntp.h8 = 0;
  const day2 = emptyDay2();
  day2.groups = { a4: [2, 3, 4], a3: [], b4: [5, 6, 7], b3: [] };
  day2.holes.a4 = Array(18).fill(3); // -18 to par -> nonzero group differential, exercises the real math
  day2.holes.b4 = Array(18).fill(5); // +18 to par
  const day3 = { scores: {}, ntp: { h7: null, h14: null } };
  const teamA = new Set([0, 2]);
  const teamB = new Set([1, 3]);

  const state = { day1, day2, day3, teamA, teamB };
  const projected = projectedTotals(state, players, COURSES_FIXTURE);
  const real = computeSeasonTotals(state, players, COURSES_FIXTURE);
  assert.equal(projected.totalA, real.day1.a + real.day2.a);
  assert.equal(projected.totalB, real.day1.b + real.day2.b);
});
