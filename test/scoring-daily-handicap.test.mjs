/* Golf Australia Daily Handicap conversion -- converts a player's GA
   Handicap Index into the strokes they receive for one round at a
   specific course, given that course's Course Rating and Slope Rating
   (courses.js):

     Daily Handicap = ((Index x Slope / 113) + (Rating - Par)) x 0.93 x CF

   0.93 is Golf Australia's standard stroke-play handicap allowance; CF is
   the CONNECT gender equity Consistency Factor (0.9986 for men/boys,
   1.0483 for women/girls -- every players.js entry is currently male, so
   only the men's figure is exercised here).

   dailyHandicap()/courseHasSlopeData() are the pure implementation in
   scoring.js. This file pins the formula itself, then the wiring into
   Day 1 match strokes (matchStrokesForPlayers/effectiveMatchFor), Day 2
   scramble team handicaps (day2GroupHandicapFor) and Day 3 net Stableford
   strokes (day3PointsThruFor) -- each keyed off the matching courses.js
   entry (Murray/Black Bull/Lake) -- and the graceful fallback to the
   pre-existing raw-handicap behavior when a course has no rating/slope on
   file, which every test in scoring.test.mjs/scoring-season-totals.test.mjs
   that predates this feature relies on. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  dailyHandicap, courseHasSlopeData, GA_HANDICAP_ALLOWANCE, GA_CONSISTENCY_FACTOR_MEN,
  matchStrokesForPlayers, effectiveMatchFor, effectiveNines, holeResult,
  day2GroupHandicapFor,
  day3PointsThruFor
} = require('../scoring.js');
const { COURSES } = require('../courses.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
function courseFixture(rating, slope, par = 72) {
  return { rating, slope, total: { par }, holes: SI_ASCENDING.map(si => ({ si, par: 4 })) };
}
// Real Wonga Cup ratings/slopes (courses.js), but with a synthetic
// ascending-SI hole layout so stroke-allocation math stays as easy to
// hand-verify as the rest of the suite's SI_ASCENDING fixtures.
const MURRAY_FIXTURE = courseFixture(72.3, 128);
const BLACK_BULL_FIXTURE = courseFixture(73.8, 134);
const LAKE_FIXTURE = courseFixture(71.5, 126);

/* ── courseHasSlopeData() ── */

test('courseHasSlopeData: true only once rating, slope and total.par are all present', () => {
  assert.equal(courseHasSlopeData({ rating: 72.3, slope: 128, total: { par: 72 } }), true);
  assert.equal(courseHasSlopeData(undefined), false);
  assert.equal(courseHasSlopeData(null), false);
  assert.equal(courseHasSlopeData({}), false);
  assert.equal(courseHasSlopeData({ holes: [] }), false); // pre-feature courses.js shape / test fixtures
  assert.equal(courseHasSlopeData({ rating: 72.3, slope: 128 }), false); // no total.par
  assert.equal(courseHasSlopeData({ rating: 72.3, total: { par: 72 } }), false); // no slope
  assert.equal(courseHasSlopeData({ slope: 128, total: { par: 72 } }), false); // no rating
});

/* ── dailyHandicap() -- pure formula ── */

test('GA_HANDICAP_ALLOWANCE and GA_CONSISTENCY_FACTOR_MEN are the documented constants', () => {
  assert.equal(GA_HANDICAP_ALLOWANCE, 0.93);
  assert.equal(GA_CONSISTENCY_FACTOR_MEN, 0.9986);
});

test('dailyHandicap: worked example on a neutral-slope course (slope 113, rating == par) reduces to Index x 0.93 x CF', () => {
  const course = { rating: 72, slope: 113, total: { par: 72 } };
  // 20 x (113/113) + 0 = 20; 20 x 0.93 x 0.9986 = 18.57396 -> rounds to 19.
  assert.equal(dailyHandicap(20, course), 19);
});

test('dailyHandicap: matches the formula for Murray\'s real rating/slope (72.3 / 128)', () => {
  // 8 x (128/113) + 0.3 = 9.357...; x0.93x0.9986 = 8.694... -> 9.
  assert.equal(dailyHandicap(8, COURSES[1]), 9);
  // 19 x (128/113) + 0.3 = 21.815...; x0.93x0.9986 = 20.266... -> 20.
  assert.equal(dailyHandicap(19, COURSES[1]), 20);
});

test('dailyHandicap: matches the formula for Black Bull\'s real rating/slope (73.8 / 134)', () => {
  // 26 x (134/113) + 1.8 = 32.649...; x0.93x0.9986 = 30.305... -> 30.
  assert.equal(dailyHandicap(26, COURSES[2]), 30);
});

test('dailyHandicap: matches the formula for Lake\'s real rating/slope (71.5 / 126)', () => {
  // 44 x (126/113) + (-0.5) = 48.539...; x0.93x0.9986 = 45.099... -> 45.
  assert.equal(dailyHandicap(44, COURSES[3]), 45);
});

test('dailyHandicap: falls back to the raw index (rounded) when no course is given', () => {
  assert.equal(dailyHandicap('19.0', undefined), 19);
  assert.equal(dailyHandicap('19.4', null), 19);
});

test('dailyHandicap: falls back to the raw index (rounded) when the course is missing rating/slope/par', () => {
  assert.equal(dailyHandicap('19.0', {}), 19);
  assert.equal(dailyHandicap('19.0', { rating: 72.3, slope: 128 }), 19); // no total.par
  assert.equal(dailyHandicap('19.0', { holes: [] }), 19); // pre-feature courses.js shape
});

test('dailyHandicap: a non-numeric index (data-entry typo) returns NaN regardless of course, same as the pre-existing Math.round(parseFloat(...)) callers relied on', () => {
  assert.ok(Number.isNaN(dailyHandicap('abc', COURSES[1])));
  assert.ok(Number.isNaN(dailyHandicap(undefined, COURSES[1])));
});

/* ── Day 1 wiring: matchStrokesForPlayers() / effectiveMatchFor() ── */

test('matchStrokesForPlayers: without a course argument, strokes are computed from the raw handicap difference exactly as before (backward compatibility)', () => {
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }];
  const match = { type: 'singles', pA: [1], pB: [2] };
  const result = matchStrokesForPlayers(match, players, SI_ASCENDING);
  // |30-8|=22 -> base=1, extra=4 -> B gets 2 strokes on SI 1-4, 1 elsewhere.
  assert.deepEqual(result.b, SI_ASCENDING.map(si => 1 + (si <= 4 ? 1 : 0)));
});

test('matchStrokesForPlayers: with a slope-rated course, strokes are computed from each player\'s Daily Handicap instead of the raw index', () => {
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }];
  const match = { type: 'singles', pA: [1], pB: [2] };
  // Murray Daily Handicaps: 8 -> 9, 30 -> 32 (see dailyHandicap tests above).
  // |32-9|=23 -> base=1, extra=5 -> B gets 2 strokes on SI 1-5, 1 elsewhere
  // -- one more low-SI hole with 2 strokes than the unadjusted case above.
  const result = matchStrokesForPlayers(match, players, SI_ASCENDING, MURRAY_FIXTURE);
  assert.deepEqual(result.b, SI_ASCENDING.map(si => 1 + (si <= 5 ? 1 : 0)));
});

test('matchStrokesForPlayers: a course with no rating/slope on file behaves exactly like no course at all', () => {
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }];
  const match = { type: 'singles', pA: [1], pB: [2] };
  const withoutCourse = matchStrokesForPlayers(match, players, SI_ASCENDING);
  const withIncompleteCourse = matchStrokesForPlayers(match, players, SI_ASCENDING, { holes: [] });
  assert.deepEqual(withIncompleteCourse, withoutCourse);
});

test('effectiveMatchFor: threads the course argument down to matchStrokesForPlayers (wiring, not re-deriving the math -- same pattern as scoring-season-totals.test.mjs\'s pre-existing effectiveMatchFor coverage)', () => {
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }];
  const match = {
    type: 'singles', pA: [1], pB: [2], front9: null, back9: null,
    holesA: Array(18).fill(4), holesB: Array(18).fill(5)
  };
  const got = effectiveMatchFor(match, players, SI_ASCENDING, MURRAY_FIXTURE);
  const strokes = matchStrokesForPlayers(match, players, SI_ASCENDING, MURRAY_FIXTURE);
  const want = effectiveNines(match, strokes);
  assert.equal(got.front9, want.front9);
  assert.equal(got.back9, want.back9);
});

test('matchStrokesForPlayers: slope adjustment can flip a halved hole into a win by changing who receives the second stroke', () => {
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '30.0' }];
  // Only the SI-5 hole has scores: A shoots 4, B shoots 5.
  // Unadjusted: |30-8|=22 -> base=1, extra=4 -> SI5 > 4 -> B gets 1 stroke
  // -> net B = 5-1 = 4 = net A -> halve ('T').
  // Murray-adjusted: Daily Handicaps 9 vs 32 -> diff=23 -> base=1, extra=5
  // -> SI5 <= 5 -> B gets 2 strokes -> net B = 5-2 = 3 < 4 -> B wins.
  const holeIdx = 4; // SI 5, 0-indexed
  const holesA = Array(18).fill(null); holesA[holeIdx] = 4;
  const holesB = Array(18).fill(null); holesB[holeIdx] = 5;
  const match = { type: 'singles', pA: [1], pB: [2], holesA, holesB };
  const unadjustedStrokes = matchStrokesForPlayers(match, players, SI_ASCENDING);
  const adjustedStrokes = matchStrokesForPlayers(match, players, SI_ASCENDING, MURRAY_FIXTURE);
  assert.equal(holeResult(4, 5, unadjustedStrokes.a[holeIdx], unadjustedStrokes.b[holeIdx]), 'T');
  assert.equal(holeResult(4, 5, adjustedStrokes.a[holeIdx], adjustedStrokes.b[holeIdx]), 'B');
});

/* ── Day 2 wiring: day2GroupHandicapFor() ── */

test('day2GroupHandicapFor: without courses, the team handicap is computed from raw indexes exactly as before (backward compatibility)', () => {
  const day2 = { groups: { a4: [1, 2] } };
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '26.0' }];
  // sorted [8,26] x [0.35,0.15] = 2.8 + 3.9 = 6.7 -> 7.
  assert.equal(day2GroupHandicapFor('a4', day2, players), 7);
});

test('day2GroupHandicapFor: with a slope-rated course, the team handicap is computed from each player\'s Daily Handicap', () => {
  const day2 = { groups: { a4: [1, 2] } };
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '26.0' }];
  // Black Bull Daily Handicaps: 8 -> 10, 26 -> 30 (see dailyHandicap tests).
  // sorted [10,30] x [0.35,0.15] = 3.5 + 4.5 = 8.0 -> 8.
  assert.equal(day2GroupHandicapFor('a4', day2, players, { 2: BLACK_BULL_FIXTURE }), 8);
});

test('day2GroupHandicapFor: a courses map missing the day-2 entry behaves exactly like no courses at all', () => {
  const day2 = { groups: { a4: [1, 2] } };
  const players = [{ id: 1, hcp: '8.0' }, { id: 2, hcp: '26.0' }];
  assert.equal(day2GroupHandicapFor('a4', day2, players, {}), day2GroupHandicapFor('a4', day2, players));
});

/* ── Day 3 wiring: day3PointsThruFor() ── */

test('day3PointsThruFor: without slope data, strokes come from the raw rounded index exactly as before (backward compatibility)', () => {
  const players = [{ id: 5, hcp: '44.0' }];
  const holes = Array(18).fill(null);
  holes[8] = 4; // hole 9 -> SI 9 in the ascending fixture, par 4
  const day3 = { holes: { 5: holes } };
  // raw hcp 44 -> base=2, extra=8 -> SI 9 > 8 -> 2 strokes.
  // points = max(0, 2 + par(4) + strokes(2) - gross(4)) = 4.
  const result = day3PointsThruFor(5, day3, players, { 3: { holes: LAKE_FIXTURE.holes } });
  assert.deepEqual(result, { total: 4, played: 1 });
});

test('day3PointsThruFor: with Lake\'s slope, strokes come from the player\'s Daily Handicap instead', () => {
  const players = [{ id: 5, hcp: '44.0' }];
  const holes = Array(18).fill(null);
  holes[8] = 4; // hole 9 -> SI 9
  const day3 = { holes: { 5: holes } };
  // Lake Daily Handicap for 44 -> 45 (see dailyHandicap tests) -> base=2,
  // extra=9 -> SI 9 <= 9 -> 3 strokes, one more than the unadjusted case.
  // points = max(0, 2 + 4 + 3 - 4) = 5.
  const result = day3PointsThruFor(5, day3, players, { 3: LAKE_FIXTURE });
  assert.deepEqual(result, { total: 5, played: 1 });
});
