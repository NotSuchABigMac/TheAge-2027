/* Issue #203 -- unit tests for the new parameterized season-totals glue
   in scoring.js (day1StrokeIndexesFor, matchStrokesForPlayers,
   effectiveMatchFor, teamOfSets, ntpPointsFor, day2CourseHolesFor,
   day2GroupHandicapFor, effectiveDay2FieldFor, effectiveDay2StateFor,
   computeSeasonTotals, phaseFor).

   These are the exact functions scorecard-live.html's own
   day1StrokeIndexes()/matchStrokesFor()/effectiveMatch()/
   day2CourseHoles()/day2GroupHandicap()/effectiveDay2Field()/
   effectiveDay2State()/ntpPointsFor() now delegate to (see the "thin
   wrapper" comments at each of those call sites) and index.html's
   live-score ribbon calls directly -- one set of tests protects both
   callers from silently drifting apart. The underlying primitives
   (matchStrokes, effectiveNines, scrambleTeamHandicap, computeStableford,
   etc.) already have their own thorough coverage in scoring.test.mjs;
   these tests exist to prove the *wiring* between them is correct, not
   to re-verify math those tests already pin. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  matchStrokes, effectiveNines, sumMatchPoints, ntpTeamPoints,
  day1StrokeIndexesFor, matchStrokesForPlayers, effectiveMatchFor, matchWormFor,
  teamOfSets, ntpPointsFor,
  day2CourseHolesFor, day2GroupHandicapFor, effectiveDay2FieldFor, effectiveDay2StateFor,
  day3CourseHolesFor, effectiveDay3ScoreFor, stablefordPoints, day3PointsThru, groupStrokes,
  scrambleTeamHandicap, anthemAdjustedHandicap,
  computeSeasonTotals, weekendWormFor, phaseFor, playersWithOverrides
} = require('../scoring.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
const COURSES_FIXTURE = {
  1: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) },
  2: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) },
  3: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) }
};

/* ── day1StrokeIndexesFor / matchStrokesForPlayers ── */

test('day1StrokeIndexesFor reads Murray\'s (courses[1]) stroke indexes', () => {
  assert.deepEqual(day1StrokeIndexesFor(COURSES_FIXTURE), SI_ASCENDING);
});

test('day1StrokeIndexesFor degrades to 1-18 when courses data is missing, same as the pre-#203 local fallback', () => {
  assert.deepEqual(day1StrokeIndexesFor(null), SI_ASCENDING);
  assert.deepEqual(day1StrokeIndexesFor({}), SI_ASCENDING);
});

test('matchStrokesForPlayers finds both players by id and produces the same result as calling matchStrokes directly', () => {
  const players = [{ id: 0, hcp: '8.0' }, { id: 1, hcp: '19.0' }];
  const match = { pA: [0], pB: [1] };
  const result = matchStrokesForPlayers(match, players, SI_ASCENDING);
  assert.deepEqual(result, matchStrokes('8.0', '19.0', SI_ASCENDING));
});

test('matchStrokesForPlayers returns zero strokes when a slot is unassigned (pA:[null])', () => {
  const players = [{ id: 0, hcp: '8.0' }];
  const match = { pA: [0], pB: [null] };
  const result = matchStrokesForPlayers(match, players, SI_ASCENDING);
  assert.equal(result.receiver, null);
  assert.deepEqual(result.a, Array(18).fill(0));
});

/* ── effectiveMatchFor ── */

test('effectiveMatchFor: a hole-derived result matches calling effectiveNines/matchStrokes directly', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }]; // equal hcp -> no strokes, simplest case
  const match = {
    pA: [0], pB: [1],
    front9: null, back9: null,
    holesA: [4, 4, 4, 4, 4, 5, 5, 5, 5, ...Array(9).fill(null)],
    holesB: [5, 5, 5, 5, 5, 4, 4, 4, 4, ...Array(9).fill(null)]
  };
  const got = effectiveMatchFor(match, players, SI_ASCENDING);
  const strokes = matchStrokes('12.0', '12.0', SI_ASCENDING);
  const want = effectiveNines(match, strokes);
  assert.equal(got.front9, want.front9);
  assert.equal(got.back9, want.back9);
  // Front 9 is a 5-0 sweep for A (lower gross every hole, no strokes) -> 'A'.
  assert.equal(got.front9, 'A');
});

/* ── matchWormFor (issue #270) ── */

test('matchWormFor returns null for a match with no hole-by-hole data at all', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }];
  const match = { pA: [0], pB: [1], front9: 'A', back9: 'B', holesA: Array(18).fill(null), holesB: Array(18).fill(null) };
  assert.equal(matchWormFor(match, players, SI_ASCENDING), null);
});

test('matchWormFor accumulates +1 per A-won hole, -1 per B-won hole, skipping holes with no data yet', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }]; // equal hcp -> no strokes
  const match = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [4, 4, 5, null, ...Array(14).fill(null)],
    holesB: [5, 5, 4, null, ...Array(14).fill(null)]
  };
  // hole1: A wins (4<5) -> +1; hole2: A wins -> +2; hole3: B wins (5>4) -> +1; hole4 has no data, skipped.
  assert.deepEqual(matchWormFor(match, players, SI_ASCENDING).front9, [1, 2, 1]);
  assert.deepEqual(matchWormFor(match, players, SI_ASCENDING).back9, []);
});

test('matchWormFor holds flat (no change) through a halved hole', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }];
  const match = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [4, 4, ...Array(16).fill(null)],
    holesB: [4, 5, ...Array(16).fill(null)]
  };
  assert.deepEqual(matchWormFor(match, players, SI_ASCENDING).front9, [0, 1]);
});

// Issue: the worm must reset at the turn, not carry a front-9 lead into
// the back 9 -- front9/back9 are each their own 1pt contest.
test('matchWormFor resets to 0 at the start of the back 9 regardless of the front-9 lead', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }];
  const match = {
    pA: [0], pB: [1], front9: null, back9: null,
    // Front 9: A sweeps all 9 holes (lead climbs to +9).
    holesA: [4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, ...Array(7).fill(null)],
    holesB: [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, ...Array(7).fill(null)]
  };
  const worm = matchWormFor(match, players, SI_ASCENDING);
  assert.deepEqual(worm.front9, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Back 9 starts fresh at 0, not continuing from +9 -- hole10: B wins -> -1; hole11: B wins -> -2.
  assert.deepEqual(worm.back9, [-1, -2]);
});

test('sumMatchPoints on effectiveMatchFor output feeds the same totals as manual front9/back9 (issue #124 invariant, now via the shared composition)', () => {
  const players = [{ id: 0, hcp: '12.0' }, { id: 1, hcp: '12.0' }];
  const derivedMatch = {
    pA: [0], pB: [1],
    front9: 'B', back9: 'B', // stale manual values that must be fully overridden by hole data
    holesA: [5, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4],
    holesB: [4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]
  };
  const eff = effectiveMatchFor(derivedMatch, players, SI_ASCENDING);
  assert.deepEqual(sumMatchPoints([eff]), { a: 0.5, b: 1.5 });
});

/* ── teamOfSets / ntpPointsFor ── */

test('teamOfSets mirrors the app\'s teamOf(): membership in teamA/teamB Sets, null when in neither', () => {
  const teamA = new Set([0, 2]);
  const teamB = new Set([1, 3]);
  assert.equal(teamOfSets(0, teamA, teamB), 'A');
  assert.equal(teamOfSets(1, teamA, teamB), 'B');
  assert.equal(teamOfSets(99, teamA, teamB), null);
  assert.equal(teamOfSets(null, teamA, teamB), null);
});

test('ntpPointsFor resolves each hole\'s winning player to a team and matches ntpTeamPoints directly', () => {
  const teamA = new Set([0]);
  const teamB = new Set([1]);
  const ntpState = { h8: 0, h17: 1 };
  const got = ntpPointsFor(ntpState, ['h8', 'h17'], teamA, teamB);
  assert.deepEqual(got, ntpTeamPoints(['A', 'B']));
});

test('ntpPointsFor: an unset hole (null) contributes to neither team', () => {
  const teamA = new Set([0]);
  const teamB = new Set([1]);
  const got = ntpPointsFor({ h8: null, h17: 1 }, ['h8', 'h17'], teamA, teamB);
  assert.deepEqual(got, ntpTeamPoints([null, 'B']));
});

/* ── day2CourseHolesFor / day2GroupHandicapFor / effectiveDay2FieldFor ── */

test('day2CourseHolesFor reads Black Bull\'s (courses[2]) holes, degrading gracefully when missing', () => {
  assert.deepEqual(day2CourseHolesFor(COURSES_FIXTURE), COURSES_FIXTURE[2].holes);
  assert.equal(day2CourseHolesFor(null).length, 18);
});

test('day2GroupHandicapFor applies the anthem adjustment per player before scrambleTeamHandicap, same as day2GroupHandicap() used to inline', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '20.0' }, { id: 2, hcp: '15.0' }];
  const day2 = { groups: { a3: [0, 1, 2] }, anthem: { 0: true, 1: false } }; // player 2: no adjustment
  const got = day2GroupHandicapFor('a3', day2, players);
  const want = scrambleTeamHandicap([
    anthemAdjustedHandicap('10.0', true),
    anthemAdjustedHandicap('20.0', false),
    anthemAdjustedHandicap('15.0', undefined)
  ]);
  assert.equal(got, want);
});

test('day2GroupHandicapFor returns null when a group id no longer maps to a real player (stale id)', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const day2 = { groups: { a3: [0, 999] }, anthem: {} };
  assert.equal(day2GroupHandicapFor('a3', day2, players), null);
});

test('effectiveDay2FieldFor: no hole data at all falls back to the manual stored value', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const day2 = {
    a4: '5', groups: { a4: [0] }, anthem: {},
    holes: { a4: Array(18).fill(null) }
  };
  assert.equal(effectiveDay2FieldFor('a4', day2, players, COURSES_FIXTURE), '5');
});

test('effectiveDay2FieldFor: an incomplete hole-by-hole round (some holes played, not all) is null, not the stale manual value', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const day2 = {
    a4: '5', groups: { a4: [0] }, anthem: {},
    holes: { a4: [4, 4, ...Array(16).fill(null)] }
  };
  assert.equal(effectiveDay2FieldFor('a4', day2, players, COURSES_FIXTURE), null);
});

test('effectiveDay2StateFor computes all four codes independently', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const day2 = {
    a4: null, a3: null, b4: null, b3: '2',
    groups: { a4: [0], a3: [], b4: [], b3: [1] },
    anthem: {},
    holes: {
      a4: Array(18).fill(null),
      a3: Array(18).fill(null),
      b4: Array(18).fill(null),
      b3: Array(18).fill(null) // no hole data -> falls back to manual '2'
    }
  };
  const got = effectiveDay2StateFor(day2, players, COURSES_FIXTURE);
  assert.equal(got.b3, '2');
  assert.equal(got.a4, null); // no manual value, no hole data
});

/* ── day3CourseHolesFor / stablefordPoints / day3PointsThru / effectiveDay3ScoreFor (issue #188) ── */

test('day3CourseHolesFor reads the Lake course\'s (courses[3]) holes, degrading gracefully when missing', () => {
  assert.deepEqual(day3CourseHolesFor(COURSES_FIXTURE), COURSES_FIXTURE[3].holes);
  assert.equal(day3CourseHolesFor(null).length, 18);
});

test('stablefordPoints: 2 = net par, +1 point per stroke better, -1 per stroke worse, floored at 0', () => {
  assert.equal(stablefordPoints(4, 4, 0), 2); // net par
  assert.equal(stablefordPoints(3, 4, 0), 3); // net birdie
  assert.equal(stablefordPoints(2, 4, 0), 4); // net eagle
  assert.equal(stablefordPoints(5, 4, 0), 1); // net bogey
  assert.equal(stablefordPoints(6, 4, 0), 0); // net double-bogey
  assert.equal(stablefordPoints(9, 4, 0), 0); // way over -- floored, not negative
  assert.equal(stablefordPoints(5, 4, 1), 2); // a stroke received shifts net back to par
});

test('stablefordPoints: null gross (hole not played) is null, not 0', () => {
  assert.equal(stablefordPoints(null, 4, 0), null);
  assert.equal(stablefordPoints(undefined, 4, 0), null);
});

test('day3PointsThru: sums points only over holes actually played, same "thru N" shape as scrambleNetToParThru', () => {
  const gross = [4, 3, ...Array(16).fill(null)]; // 2 holes played: par, birdie
  const strokes = Array(18).fill(0);
  const pars = Array(18).fill(4);
  const result = day3PointsThru(gross, strokes, pars);
  assert.equal(result.total, 5); // 2 (par) + 3 (birdie)
  assert.equal(result.played, 2);
});

test('day3PointsThru: no holes played yet returns total 0, played 0 (points are additive, not gated on completeness)', () => {
  const result = day3PointsThru(Array(18).fill(null), Array(18).fill(0), Array(18).fill(4));
  assert.equal(result.total, 0);
  assert.equal(result.played, 0);
});

test('effectiveDay3ScoreFor: no hole data at all falls back to the manual stored value', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const day3 = { scores: { 0: '38' }, holes: {} };
  assert.equal(effectiveDay3ScoreFor(0, day3, players, COURSES_FIXTURE), 38);
});

test('effectiveDay3ScoreFor: any hole data derives a live points-thru-N total, overriding a stale manual value -- no completeness gate', () => {
  const players = [{ id: 0, hcp: '0.0' }]; // scratch -- no strokes anywhere
  const day3 = {
    scores: { 0: '99' }, // stale manual value that must be fully overridden
    holes: { 0: [4, 3, ...Array(16).fill(null)] } // par, birdie, rest unplayed
  };
  const got = effectiveDay3ScoreFor(0, day3, players, COURSES_FIXTURE);
  assert.equal(got, 5); // 2 (net par) + 3 (net birdie), matches day3PointsThru directly
});

test('effectiveDay3ScoreFor: matches calling groupStrokes/day3PointsThru directly for a handicapped player', () => {
  const players = [{ id: 0, hcp: '9.0' }]; // 9 strokes, ascending SI -- one stroke each on holes SI 1-9
  const day3 = { scores: {}, holes: { 0: Array(18).fill(4) } }; // gross par on every hole
  const got = effectiveDay3ScoreFor(0, day3, players, COURSES_FIXTURE);
  const strokes = groupStrokes(9, SI_ASCENDING);
  const want = day3PointsThru(Array(18).fill(4), strokes, Array(18).fill(4)).total;
  assert.equal(got, want);
  // Sanity: 9 holes get a stroke (net birdie, 3pts), 9 don't (net par, 2pts) -> 9*3 + 9*2 = 45.
  assert.equal(got, 45);
});

test('effectiveDay3ScoreFor: an unknown player id (stale/removed) is null, not a crash', () => {
  const day3 = { scores: {}, holes: { 99: Array(18).fill(4) } };
  assert.equal(effectiveDay3ScoreFor(99, day3, [], COURSES_FIXTURE), null);
});

/* ── computeSeasonTotals ── */

function emptyDay1() {
  return {
    matches: Array.from({ length: 6 }, () => ({
      pA: [null], pB: [null], front9: null, back9: null,
      holesA: Array(18).fill(null), holesB: Array(18).fill(null)
    })),
    ntp: { h8: null, h17: null }
  };
}
function emptyDay2() {
  return {
    a4: null, a3: null, b4: null, b3: null,
    groups: { a4: [], a3: [], b4: [], b3: [] },
    anthem: {},
    holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
    ntp: { h4: null, h16: null }
  };
}
function emptyDay3() {
  return { scores: {}, ntp: { h7: null, h14: null } };
}

test('computeSeasonTotals: an entirely empty state totals zero for both teams', () => {
  const state = { day1: emptyDay1(), day2: emptyDay2(), day3: emptyDay3(), teamA: new Set(), teamB: new Set() };
  const totals = computeSeasonTotals(state, [], COURSES_FIXTURE);
  assert.equal(totals.totalA, 0);
  assert.equal(totals.totalB, 0);
});

test('computeSeasonTotals: sums day1 + day2 + day3 exactly (cross-checked by hand against each day\'s own numbers)', () => {
  const players = [
    { id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }, // day1 match, equal hcp
    { id: 2, hcp: '10.0' } // day3 only
  ];
  const teamA = new Set([0, 2]);
  const teamB = new Set([1]);

  const day1 = emptyDay1();
  // Match 0: A sweeps the front 9 gross (equal hcp, no strokes) -> front9 'A'; back9 untouched (null, no points).
  day1.matches[0] = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [4, 4, 4, 4, 4, 5, 5, 5, 5, ...Array(9).fill(null)],
    holesB: [5, 5, 5, 5, 5, 4, 4, 4, 4, ...Array(9).fill(null)]
  };
  // Day1 NTP: hole 8 to player 0 (team A).
  day1.ntp.h8 = 0;

  const day2 = emptyDay2();
  // No day2 scores entered at all -> day2 contributes 0.

  const day3 = emptyDay3();
  day3.scores[0] = '2'; // team A, better score
  day3.scores[2] = '-1'; // team A too
  day3.scores[1] = '0'; // team B

  const state = { day1, day2, day3, teamA, teamB };
  const totals = computeSeasonTotals(state, players, COURSES_FIXTURE);

  // Hand-check: day1 front9 A win = 1pt to A, plus NTP h8 to A (ntpTeamPoints
  // awards 1pt per NTP hole to the winning team) = 2pts A, 0 B so far.
  assert.equal(totals.day1.a, 2);
  assert.equal(totals.day1.b, 0);
  assert.equal(totals.day2.a, 0);
  assert.equal(totals.day2.b, 0);
  // Day3: player 0 (score 2, best) and player 2 (score -1) both team A;
  // player 1 (score 0) team B. Exact points come from computeStableford's
  // POS_PTS table (already covered by scoring.test.mjs) -- just confirm
  // team A's stableford points exceed team B's, and the grand total is the
  // simple sum of the three days.
  assert.ok(totals.day3.a > totals.day3.b);
  assert.equal(totals.totalA, totals.day1.a + totals.day2.a + totals.day3.a);
  assert.equal(totals.totalB, totals.day1.b + totals.day2.b + totals.day3.b);
});

test('computeSeasonTotals: Day 3 hole-by-hole data overrides a stale manual score, same precedence as Day 1/Day 2 (issue #188) -- this is the exact function index.html\'s live ribbon calls, so it must never silently disagree with the Day 3 tab', () => {
  const players = [
    { id: 0, hcp: '0.0' }, // team A, scratch, hole-by-hole entry
    { id: 1, hcp: '10.0' } // team B, manual only
  ];
  const teamA = new Set([0]);
  const teamB = new Set([1]);

  const day1 = emptyDay1();
  const day2 = emptyDay2();
  const day3 = emptyDay3();
  day3.holes = { 0: Array(18).fill(4) }; // player 0: gross par every hole, scratch -> 2pts x 18 = 36
  day3.scores[0] = '5'; // stale manual value that must be fully overridden by the hole data
  day3.scores[1] = '20'; // team B, manual only (no hole data)

  const state = { day1, day2, day3, teamA, teamB };
  const totals = computeSeasonTotals(state, players, COURSES_FIXTURE);

  // Player 0's derived total (36) beats player 1's manual total (20), so
  // player 0 is 1st (14pts) and player 1 is 2nd (13pts) per POS_PTS.
  assert.equal(totals.day3.a, 14);
  assert.equal(totals.day3.b, 13);
});

test('computeSeasonTotals: an admin handicap override (issue #206), layered via playersWithOverrides, changes the Day 1 match result exactly as if the roster itself had shipped that handicap', () => {
  // Both players scratch (hcp 0) -- gross-only match, B is one stroke
  // better than A on every hole, so B wins the front9 outright.
  const players = [{ id: 0, hcp: '0.0' }, { id: 1, hcp: '0.0' }];
  const teamA = new Set([0]);
  const teamB = new Set([1]);
  const day1 = emptyDay1();
  day1.matches[0] = {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: [5, 5, 5, 5, 5, 5, 5, 5, 5, ...Array(9).fill(null)],
    holesB: [4, 4, 4, 4, 4, 4, 4, 4, 4, ...Array(9).fill(null)]
  };
  const state = { day1, day2: emptyDay2(), day3: emptyDay3(), teamA, teamB };

  const before = computeSeasonTotals(state, players, COURSES_FIXTURE);
  assert.equal(before.day1.a, 0);
  assert.equal(before.day1.b, 1); // B wins the front9 on gross alone

  // Override player 0's handicap to 18 (SI_ASCENDING fixture -> exactly 1
  // stroke every hole, per matchStrokes' base=1/extra=0 allocation for an
  // 18-point difference) -- that stroke exactly cancels A's 1-gross-stroke
  // deficit on every hole, turning the front9 into a dead-square tie.
  const overridden = playersWithOverrides(players, { 0: '18.0' });
  const after = computeSeasonTotals(state, overridden, COURSES_FIXTURE);
  assert.equal(after.day1.a, 0.5);
  assert.equal(after.day1.b, 0.5);
});

/* ── weekendWormFor (issue #299) ── */

test('weekendWormFor returns null when there are no rows to replay', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  assert.equal(weekendWormFor([], players, COURSES_FIXTURE, teams), null);
});

test('weekendWormFor returns null when the team differential never once leaves 0 (a hole score alone resolves no nine/match)', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4', updated_at: '2026-08-07T09:00:00Z' }
  ];
  assert.equal(weekendWormFor(rows, players, COURSES_FIXTURE, teams), null);
});

test('weekendWormFor accumulates the team-point differential as NTP holes resolve, in chronological (not necessarily array) order', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:00:00Z' },  // player 0 (A) -> +1 A
    { update_type: 'day1_ntp', field_key: 'h17', value: '1', updated_at: '2026-08-07T15:00:00Z' }, // player 1 (B) -> +1 B
    { update_type: 'day2_ntp', field_key: 'h4', value: '0', updated_at: '2026-08-08T09:00:00Z' }   // (next day) player 0 (A) again -> +1 A
  ];
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1, 0, 1]);
});

test('weekendWormFor replays by each field\'s own updated_at, not by array position -- a caller-supplied array that\'s already sorted stays exactly in that order, but nothing relies on it being pre-sorted', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    // Listed out of chronological order on purpose (h17 first in the array,
    // but its timestamp is actually latest) -- the real replay order must
    // still be h8, then day2 h4, then h17.
    { update_type: 'day1_ntp', field_key: 'h17', value: '1', updated_at: '2026-08-07T15:00:00Z' }, // B, but LAST chronologically
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:00:00Z' },  // A, earliest
    { update_type: 'day2_ntp', field_key: 'h4', value: '0', updated_at: '2026-08-07T12:00:00Z' }   // A, middle
  ];
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1, 2, 1]);
});

test('weekendWormFor only records a point when the differential actually changes -- a row that resolves nothing is not a duplicate flat entry', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:00:00Z' },   // +1 A
    { update_type: 'day1_hole', match_idx: 1, field_key: 'A1', value: '4', updated_at: '2026-08-07T09:01:00Z' }, // no points yet
    { update_type: 'day1_ntp', field_key: 'h17', value: '0', updated_at: '2026-08-07T15:00:00Z' }   // +1 A again
  ];
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1, 2]);
});

test('weekendWormFor collapses a typo-then-correction on the same field to just the correction, credited at the correction\'s own time -- not two steps (the wrong value, then undoing it)', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_ntp', field_key: 'h8', value: '1', updated_at: '2026-08-07T09:00:00Z' }, // typo: player 1 (B) recorded as winner
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:05:00Z' }  // corrected: really player 0 (A)
  ];
  // Only the correction (A) should ever be applied -- never a B-then-A
  // flip-flop from replaying both the mistake and its fix.
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1]);
});

test('weekendWormFor: a field\'s deduped final value still slots into the replay at its OWN last-write time, not the time it was first (wrongly) entered', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_ntp', field_key: 'h17', value: '1', updated_at: '2026-08-07T08:00:00Z' }, // genuine, single write -> +1 B
    { update_type: 'day1_ntp', field_key: 'h8', value: '1', updated_at: '2026-08-07T09:00:00Z' },  // typo -> +1 B (wrong)
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T10:00:00Z' }   // corrected -> +1 A instead
  ];
  // Raw chronological replay (no dedup) would read [-1, -2, 0] -- a
  // spurious extra step showing B pulling further ahead, then snapping
  // back, purely from the correction. Deduped: h17 (B) applies at 08:00,
  // h8's surviving correction (A) applies at its own last-write time
  // (10:00) -- net [-1, 0], the tournament's actual progression.
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [-1, 0]);
});

test('weekendWormFor skips a row that throws when applied (e.g. a malformed legacy team_assign value) instead of aborting the whole replay -- same tolerance processUpdateRows() gives the real sync path (issue #63)', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const teams = { teamA: new Set([0]), teamB: new Set([1]) };
  const rows = [
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:00:00Z' },        // +1 A
    { update_type: 'team_assign', field_key: 'A', value: 'not-json', updated_at: '2026-08-07T09:01:00Z' }, // JSON.parse() throws -- must be skipped, not fatal
    { update_type: 'day1_ntp', field_key: 'h17', value: '0', updated_at: '2026-08-07T15:00:00Z' }         // +1 A again
  ];
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1, 2]);
});

test('weekendWormFor seeds team membership from initialTeams, not any hardcoded default -- a later player_team row can then move it', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  // Player 0 starts on Team B per the seeded initialTeams...
  const teams = { teamA: [], teamB: [0] };
  const rows = [
    { update_type: 'player_team', player_id: 0, value: 'A', updated_at: '2026-08-07T08:00:00Z' }, // ...moved to Team A
    { update_type: 'day1_ntp', field_key: 'h8', value: '0', updated_at: '2026-08-07T09:00:00Z' }  // now scores for A, not B
  ];
  assert.deepEqual(weekendWormFor(rows, players, COURSES_FIXTURE, teams), [1]);
});

/* ── phaseFor ── */

test('phaseFor: before 7 Aug 2026 (Melbourne) is "countdown"', () => {
  assert.equal(phaseFor(new Date('2026-08-06T23:00:00+10:00')), 'countdown');
  assert.equal(phaseFor(new Date('2026-01-01T00:00:00Z')), 'countdown');
});

test('phaseFor: on any of the three tournament dates (Melbourne) is "live"', () => {
  assert.equal(phaseFor(new Date('2026-08-07T01:00:00+10:00')), 'live');
  assert.equal(phaseFor(new Date('2026-08-08T12:00:00+10:00')), 'live');
  assert.equal(phaseFor(new Date('2026-08-09T23:00:00+10:00')), 'live');
});

test('phaseFor: after 9 Aug 2026 (Melbourne) is "final"', () => {
  assert.equal(phaseFor(new Date('2026-08-10T00:00:01+10:00')), 'final');
  assert.equal(phaseFor(new Date('2027-01-01T00:00:00Z')), 'final');
});

test('phaseFor: a UTC instant that has already rolled into Day 1 Melbourne-local is "live", not "countdown" (same rollover as defaultDay)', () => {
  // 2026-08-06T15:00:00Z is 2026-08-07T01:00:00+10:00 in Melbourne.
  assert.equal(phaseFor(new Date('2026-08-06T15:00:00Z')), 'live');
});
