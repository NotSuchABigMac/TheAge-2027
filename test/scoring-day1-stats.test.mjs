/* Unit tests for the Day 1 stats-export glue in scoring.js
   (day1HoleDifficultyFor, day1PlayerReportCardsFor, day1Superlatives,
   isLopsidedNine, handicapPerformanceBadge, day1StreaksFor,
   day1BirdieCountsFor, day1BlowUpHoleFor, day1NetParOrBetterCountFor,
   day1ParTypeStatsFor, day1NetToParStdDevFor, day1RangeAvgNetToParFor,
   day1NailbiterCountFor, day1WinLossExtremesFor, day1BiggestComebackFor)
   -- built for scripts/export-day1-stats.mjs and tv.html's Stat Board to
   share, not (yet) wired into scorecard-live.html's own UI. Parameterized
   the same way computeSeasonTotals() is (state/players/courses in,
   nothing read from a global). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  day1HoleDifficultyFor, day1PlayerReportCardsFor, day1Superlatives,
  isLopsidedNine, handicapPerformanceBadge,
  day1StreaksFor, day1BirdieCountsFor, day1BlowUpHoleFor,
  day1NetParOrBetterCountFor, day1ParTypeStatsFor, day1NetToParStdDevFor,
  day1RangeAvgNetToParFor, day1NailbiterCountFor, day1WinLossExtremesFor, day1BiggestComebackFor,
  nineStatus, matchStrokes
} = require('../scoring.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
// Holes 1-6 par 3, 7-12 par 4, 13-18 par 5 -- deterministic buckets of 6
// each so par-type tests can craft predictable per-bucket numbers.
const MIXED_PAR_HOLES = Array.from({ length: 18 }, (_, i) => ({ si: i + 1, par: i < 6 ? 3 : i < 12 ? 4 : 5 }));
const COURSES_FIXTURE = {
  1: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) }
};

function emptyDay1() {
  return {
    matches: Array.from({ length: 6 }, () => ({
      pA: [null], pB: [null], front9: null, back9: null,
      holesA: Array(18).fill(null), holesB: Array(18).fill(null)
    })),
    ntp: { h8: null, h17: null }
  };
}

/* ── day1HoleDifficultyFor ── */

test('day1HoleDifficultyFor averages net-to-par per hole across every match with both players assigned', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }]; // equal hcp -> no strokes
  const day1 = emptyDay1();
  day1.matches[0] = { pA: [0], pB: [1], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) };
  day1.matches[0].holesA[0] = 5; day1.matches[0].holesB[0] = 3; // hole 1: A +1, B -1 -> avg 0
  const result = day1HoleDifficultyFor(day1.matches, players, COURSES_FIXTURE);
  assert.equal(result.length, 18);
  assert.equal(result[0].hole, 1);
  assert.equal(result[0].par, 4);
  assert.equal(result[0].avgNetToPar, 0); // (1 + -1) / 2
  assert.equal(result[0].sampleSize, 2);
  assert.equal(result[1].avgNetToPar, null); // no data on hole 2
  assert.equal(result[1].sampleSize, 0);
});

test('day1HoleDifficultyFor ignores a match with only one (or no) player assigned', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const day1 = emptyDay1();
  day1.matches[0] = { pA: [0], pB: [null], front9: null, back9: null, holesA: Array(18).fill(5), holesB: Array(18).fill(null) };
  const result = day1HoleDifficultyFor(day1.matches, players, COURSES_FIXTURE);
  assert.ok(result.every(h => h.sampleSize === 0));
});

/* ── isLopsidedNine / handicapPerformanceBadge ── */

test('isLopsidedNine: a fully-played 6-3 nine (lead 3) is not lopsided; a fully-played 8-1 (lead 7) is', () => {
  const mild = nineStatus(['A', 'A', 'A', 'A', 'A', 'A', 'B', 'B', 'B']); // 6-3, lead 3
  const blowout = nineStatus(['A', 'A', 'A', 'A', 'A', 'A', 'A', 'A', 'B']); // 8-1, lead 7
  assert.equal(isLopsidedNine(mild), false);
  assert.equal(isLopsidedNine(blowout), true);
});

test('isLopsidedNine: an undecided nine is never lopsided regardless of the current lead', () => {
  const status = nineStatus(['A', 'A', 'A', 'A', null, null, null, null, null]); // 4-0 thru 4, not decided
  assert.equal(status.decided, false);
  assert.equal(isLopsidedNine(status), false);
});

test('handicapPerformanceBadge: thresholds at +-0.5, null passes through as null', () => {
  assert.equal(handicapPerformanceBadge(null), null);
  assert.equal(handicapPerformanceBadge(-0.5), 'above');
  assert.equal(handicapPerformanceBadge(-0.49), 'on');
  assert.equal(handicapPerformanceBadge(0), 'on');
  assert.equal(handicapPerformanceBadge(0.49), 'on');
  assert.equal(handicapPerformanceBadge(0.5), 'below');
});

/* ── day1StreaksFor ── */

test('day1StreaksFor: counts the longest run of consecutive holes won/lost for side A, unaffected by a gap of unplayed holes', () => {
  const strokes = Array(18).fill(0);
  // A wins holes 1-3 (streak 3), halves 4, A wins 5-6 (streak 2, doesn't
  // extend the earlier one across the halve), holes 7-9 unplayed (no
  // effect either way), B wins 10-14 (streak 5).
  const holesA = [3, 3, 3, 4, 3, 3, null, null, null, 5, 5, 5, 5, 5, ...Array(4).fill(null)];
  const holesB = [5, 5, 5, 4, 5, 5, null, null, null, 3, 3, 3, 3, 3, ...Array(4).fill(null)];
  const { hot, cold } = day1StreaksFor(holesA, strokes, holesB, strokes, 'A');
  assert.equal(hot, 3);
  assert.equal(cold, 5);
});

// Same fixture as above, but reading side B's streaks -- must be the
// mirror image (B's cold streak is A's hot streak and vice versa), from
// the SAME canonical (holesA, holesB) argument order. This is exactly
// the case that catches the "swap which array is in the A slot to get
// 'my' streaks" bug: doing that corrupts holeResult()'s position-based
// 'A'/'B' label instead of just relabeling perspective.
test('day1StreaksFor: side B\'s streaks are the mirror image of side A\'s, from the same canonical argument order', () => {
  const strokes = Array(18).fill(0);
  const holesA = [3, 3, 3, 4, 3, 3, null, null, null, 5, 5, 5, 5, 5, ...Array(4).fill(null)];
  const holesB = [5, 5, 5, 4, 5, 5, null, null, null, 3, 3, 3, 3, 3, ...Array(4).fill(null)];
  const { hot, cold } = day1StreaksFor(holesA, strokes, holesB, strokes, 'B');
  assert.equal(hot, 5); // B's hot streak is A's cold streak (holes 10-14)
  assert.equal(cold, 3); // B's cold streak is A's hot streak (holes 1-3)
});

test('day1StreaksFor: a fully halved round has no hot or cold streak', () => {
  const strokes = Array(18).fill(0);
  const holes = Array(18).fill(4);
  const { hot, cold } = day1StreaksFor(holes, strokes, holes, strokes, 'A');
  assert.equal(hot, 0);
  assert.equal(cold, 0);
});

/* ── day1BirdieCountsFor ── */

test('day1BirdieCountsFor: classifies gross and net scores independently via scoreToParSymbol', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const myHoles = [2, 3, 4, 5, 6, ...Array(13).fill(null)]; // eagle, birdie, par, bogey, double-bogey+
  const myStrokes = [0, 0, 0, 0, 0, ...Array(13).fill(0)];
  const got = day1BirdieCountsFor(myHoles, myStrokes, courseHoles);
  assert.equal(got.eagles, 1);
  assert.equal(got.birdies, 1);
  assert.equal(got.netEagles, 1); // no strokes -> net matches gross
  assert.equal(got.netBirdies, 1);
});

test('day1BirdieCountsFor: a received stroke can turn a gross par into a net birdie', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const myHoles = [4, ...Array(17).fill(null)]; // gross par
  const myStrokes = [1, ...Array(17).fill(0)]; // 1 stroke received -> net 3 -> net birdie
  const got = day1BirdieCountsFor(myHoles, myStrokes, courseHoles);
  assert.equal(got.birdies, 0); // gross was only par
  assert.equal(got.netBirdies, 1);
});

/* ── day1BlowUpHoleFor ── */

test('day1BlowUpHoleFor: finds the worst gross-to-par hole, ties keep the earliest', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const myHoles = [4, 8, 5, 8, ...Array(14).fill(null)]; // holes 2 and 4 tie at +4 over par
  const got = day1BlowUpHoleFor(myHoles, courseHoles);
  assert.deepEqual(got, { hole: 2, gross: 8, par: 4, toPar: 4 });
});

test('day1BlowUpHoleFor: null when no holes have been played yet', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  assert.equal(day1BlowUpHoleFor(Array(18).fill(null), courseHoles), null);
});

/* ── day1PlayerReportCardsFor (integration of the above) ── */

test('day1PlayerReportCardsFor: skips a match where either seat is unassigned', () => {
  const players = [{ id: 0, hcp: '10.0' }];
  const state = { day1: emptyDay1(), teamA: new Set([0]), teamB: new Set() };
  state.day1.matches[0] = { pA: [0], pB: [null], front9: null, back9: null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) };
  const cards = day1PlayerReportCardsFor(state, players, COURSES_FIXTURE);
  assert.equal(cards.length, 0);
});

test('day1PlayerReportCardsFor: produces one row per side of an assigned match, with correct won/lost/halved, points, team, and NTP flags', () => {
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }]; // equal hcp -> no strokes
  const state = { day1: emptyDay1(), teamA: new Set([0]), teamB: new Set([1]) };
  const match = state.day1.matches[0];
  match.pA = [0]; match.pB = [1];
  // Front 9: A wins all 9 (lopsided). Back 9: untouched (no data).
  match.holesA = [3, 3, 3, 3, 3, 3, 3, 3, 3, ...Array(9).fill(null)];
  match.holesB = [5, 5, 5, 5, 5, 5, 5, 5, 5, ...Array(9).fill(null)];
  state.day1.ntp.h8 = 0;

  const cards = day1PlayerReportCardsFor(state, players, COURSES_FIXTURE);
  assert.equal(cards.length, 2);
  const cardA = cards.find(c => c.id === 0);
  const cardB = cards.find(c => c.id === 1);

  assert.equal(cardA.team, 'A');
  assert.equal(cardA.holesWon, 9);
  assert.equal(cardA.holesLost, 0);
  assert.equal(cardA.holesPlayed, 9);
  assert.equal(cardA.matchPointsFor, 1); // front9 win = 1pt, back9 undecided = 0pt
  assert.equal(cardA.ntpH8, true);
  assert.equal(cardA.ntpH17, false);
  assert.equal(cardA.hotStreak, 9);
  assert.equal(cardA.lopsidedNine, 'won'); // front9 9-0 is well past the lead-5 threshold
  // blowUpHole reports the worst hole played regardless of how good it
  // actually was (no "was this bad enough" threshold) -- A birdied every
  // hole (gross 3, par 4), so even A's "worst" hole is a birdie, tied
  // across all 9 and keeping the earliest.
  assert.deepEqual(cardA.blowUpHole, { hole: 1, gross: 3, par: 4, toPar: -1 });

  assert.equal(cardB.holesWon, 0);
  assert.equal(cardB.holesLost, 9);
  assert.equal(cardB.coldStreak, 9);
  assert.equal(cardB.lopsidedNine, 'lost');
  assert.deepEqual(cardB.blowUpHole, { hole: 1, gross: 5, par: 4, toPar: 1 }); // B's worst (and only) hole score: +1
});

/* ── day1NetParOrBetterCountFor ── */

test('day1NetParOrBetterCountFor: counts net par/birdie/eagle holes, ignoring net-bogey-or-worse and unplayed holes', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const strokes = Array(18).fill(0);
  const myHoles = [4, 3, 2, 5, 6, ...Array(13).fill(null)]; // par, birdie, eagle (all net-par-or-better), then 2 net-bogey-or-worse
  assert.equal(day1NetParOrBetterCountFor(myHoles, strokes, courseHoles), 3);
});

test('day1NetParOrBetterCountFor: a received stroke can turn a net-bogey hole into a net par, counted', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const myHoles = [5, ...Array(17).fill(null)]; // gross bogey
  const strokes = [1, ...Array(17).fill(0)]; // 1 stroke -> net par
  assert.equal(day1NetParOrBetterCountFor(myHoles, strokes, courseHoles), 1);
});

/* ── day1ParTypeStatsFor ── */

test('day1ParTypeStatsFor: buckets by par (3/4/5), averages only within each bucket, and reports a zero-sample bucket as null averages', () => {
  const strokes = Array(18).fill(0);
  // Par-3 holes (indices 0-5): only hole 1 played, gross birdie (par-1).
  // Par-4 holes (6-11): only hole 7 played, gross par.
  // Par-5 holes (12-17): nothing played.
  const myHoles = [2, null, null, null, null, null, 4, ...Array(11).fill(null)];
  const got = day1ParTypeStatsFor(myHoles, strokes, MIXED_PAR_HOLES);
  assert.equal(got['3'].holesPlayed, 1);
  assert.equal(got['3'].avgToPar, -1);
  assert.equal(got['3'].avgNetToPar, -1);
  assert.equal(got['4'].holesPlayed, 1);
  assert.equal(got['4'].avgToPar, 0);
  assert.equal(got['5'].holesPlayed, 0);
  assert.equal(got['5'].avgToPar, null);
  assert.equal(got['5'].avgNetToPar, null);
});

test('day1ParTypeStatsFor: averages correctly across multiple holes in the same bucket, net accounting for strokes received', () => {
  const strokes = [0, 1, ...Array(16).fill(0)]; // hole 2 (par 3) gets 1 stroke
  const myHoles = [4, 5, ...Array(16).fill(null)]; // par-3 holes 1&2: gross bogey both (+1 each), net: hole1 +1, hole2 (5-1-3)=+1
  const got = day1ParTypeStatsFor(myHoles, strokes, MIXED_PAR_HOLES);
  assert.equal(got['3'].holesPlayed, 2);
  assert.equal(got['3'].avgToPar, 1.5); // (1+2)/2 gross-to-par -- hole1 gross 4 (+1), hole2 gross 5 (+2)
  assert.equal(got['3'].avgNetToPar, 1); // (1+1)/2 net-to-par
});

/* ── day1NetToParStdDevFor ── */

test('day1NetToParStdDevFor: null with fewer than 2 holes played (a single point has no meaningful spread)', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const strokes = Array(18).fill(0);
  assert.equal(day1NetToParStdDevFor(Array(18).fill(null), strokes, courseHoles), null);
  assert.equal(day1NetToParStdDevFor([4, ...Array(17).fill(null)], strokes, courseHoles), null);
});

test('day1NetToParStdDevFor: 0 for a perfectly consistent (identical net-to-par every hole) round', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const strokes = Array(18).fill(0);
  assert.equal(day1NetToParStdDevFor(Array(18).fill(5), strokes, courseHoles), 0); // net bogey every hole
});

test('day1NetToParStdDevFor: matches a hand-computed population std dev for a simple two-value spread', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const strokes = Array(18).fill(0);
  // net-to-par values: -1, +1 -- mean 0, variance ((1)+(1))/2 = 1, std dev 1.
  const got = day1NetToParStdDevFor([3, 5, ...Array(16).fill(null)], strokes, courseHoles);
  assert.equal(got, 1);
});

/* ── day1RangeAvgNetToParFor ── */

test('day1RangeAvgNetToParFor: averages only within [startIdx, endIdx), null if nothing in range is played', () => {
  const courseHoles = Array(18).fill({ par: 4 });
  const strokes = Array(18).fill(0);
  const myHoles = [3, 3, 3, 9, 9, 9, ...Array(12).fill(null)]; // holes 1-3 birdies, 4-6 disasters
  assert.equal(day1RangeAvgNetToParFor(myHoles, strokes, courseHoles, 0, 3), -1); // fast-start range
  assert.equal(day1RangeAvgNetToParFor(myHoles, strokes, courseHoles, 15, 18), null); // closer range, unplayed
});

/* ── day1NailbiterCountFor ── */

test('day1NailbiterCountFor: counts only holes decided by exactly 1 net stroke, not halves or bigger margins', () => {
  const strokesA = Array(18).fill(0), strokesB = Array(18).fill(0);
  // hole1: 4v5 -> margin 1 (nailbiter). hole2: 4v4 -> halved, not a nailbiter.
  // hole3: 3v5 -> margin 2, not a nailbiter. hole4: one side unplayed -> skipped.
  const holesA = [4, 4, 3, 4, ...Array(14).fill(null)];
  const holesB = [5, 4, 5, null, ...Array(14).fill(null)];
  assert.equal(day1NailbiterCountFor(holesA, strokesA, holesB, strokesB), 1);
});

test('day1NailbiterCountFor: a stroke received can turn an equal-gross tie into a 1-net-stroke nailbiter', () => {
  const strokesA = [1, ...Array(17).fill(0)], strokesB = Array(18).fill(0);
  // Equal gross scores (5 and 5) would be a halve on gross alone, but A's
  // 1 stroke received makes it net 4 vs net 5 -- decided by exactly 1.
  const holesA = [5, ...Array(17).fill(null)];
  const holesB = [5, ...Array(17).fill(null)];
  assert.equal(day1NailbiterCountFor(holesA, strokesA, holesB, strokesB), 1);
});

/* ── day1WinLossExtremesFor ── */

test('day1WinLossExtremesFor: finds the worst (highest gross-to-par) hole side A won and the best (lowest) it lost, with opponent context', () => {
  const strokes = Array(18).fill(0);
  const holesA = [7, 3, 6, ...Array(15).fill(null)]; // hole1: A wins with a blow-up (7 vs par4); hole2: A wins clean; hole3: A loses with a good score
  const holesB = [9, 5, 4, ...Array(15).fill(null)];
  const courseHoles = Array(18).fill({ par: 4 });
  const { worstWin, bestLoss } = day1WinLossExtremesFor(holesA, strokes, holesB, strokes, courseHoles, 'A');
  assert.deepEqual(worstWin, { hole: 1, gross: 7, par: 4, toPar: 3, opponentGross: 9 });
  assert.deepEqual(bestLoss, { hole: 3, gross: 6, par: 4, toPar: 2, opponentGross: 4 });
});

test('day1WinLossExtremesFor: both null when this side has neither won nor lost a hole yet', () => {
  const strokes = Array(18).fill(0);
  const holes = Array(18).fill(null);
  const courseHoles = Array(18).fill({ par: 4 });
  const { worstWin, bestLoss } = day1WinLossExtremesFor(holes, strokes, holes, strokes, courseHoles, 'A');
  assert.equal(worstWin, null);
  assert.equal(bestLoss, null);
});

test('day1WinLossExtremesFor: ties keep the earliest hole', () => {
  const strokes = Array(18).fill(0);
  const holesA = [6, 6, ...Array(16).fill(null)]; // A wins both, same margin (+2 over par each)
  const holesB = [8, 8, ...Array(16).fill(null)];
  const courseHoles = Array(18).fill({ par: 4 });
  const { worstWin } = day1WinLossExtremesFor(holesA, strokes, holesB, strokes, courseHoles, 'A');
  assert.equal(worstWin.hole, 1);
});

/* ── day1BiggestComebackFor ── */

test('day1BiggestComebackFor: credits a comeback only when the side recovers to at least a halve', () => {
  const strokes = Array(18).fill(0);
  // Front 9: B wins holes 1-3 (A down 3), then A wins holes 4-9 (A ends up +3 -> wins the nine).
  const holesA = [5, 5, 5, 3, 3, 3, 3, 3, 3, ...Array(9).fill(null)];
  const holesB = [3, 3, 3, 5, 5, 5, 5, 5, 5, ...Array(9).fill(null)];
  assert.equal(day1BiggestComebackFor(holesA, strokes, holesB, strokes, 'A'), 3);
});

test('day1BiggestComebackFor: 0 when the side was down but never recovered past a loss', () => {
  const strokes = Array(18).fill(0);
  // A is down the whole front 9 (B wins holes 1-4, rest halved) -- A loses the nine outright.
  const holesA = [5, 5, 5, 5, 4, 4, 4, 4, 4, ...Array(9).fill(null)];
  const holesB = [3, 3, 3, 3, 4, 4, 4, 4, 4, ...Array(9).fill(null)];
  assert.equal(day1BiggestComebackFor(holesA, strokes, holesB, strokes, 'A'), 0);
});

test('day1BiggestComebackFor: 0 when the side was never behind at all (nothing to come back from)', () => {
  const strokes = Array(18).fill(0);
  const holesA = [3, 3, 3, ...Array(15).fill(null)]; // A wins every hole played, never down
  const holesB = [5, 5, 5, ...Array(15).fill(null)];
  assert.equal(day1BiggestComebackFor(holesA, strokes, holesB, strokes, 'A'), 0);
});

/* ── day1Superlatives (integration over a small synthetic cards array) ── */

test('day1Superlatives: picks the max/min holder per stat and ties keep the earlier card in the array', () => {
  const cards = [
    { id: 0, name: 'Alice', short: 'Alice', netParOrBetterCount: 5, netToParStdDev: 1.0, worstWinHole: { hole: 3, gross: 7, par: 4, toPar: 3, opponentGross: 8 }, bestLossHole: null, parTypeStats: { 3: { avgNetToPar: 1 }, 4: { avgNetToPar: 0.5 }, 5: { avgNetToPar: null } }, holesHalved: 2, nailbiterCount: 3, biggestComeback: 1, fastStartAvgNetToPar: 0, closerAvgNetToPar: -1, opponentName: 'Bob' },
    { id: 1, name: 'Bob', short: 'Bob', netParOrBetterCount: 5, netToParStdDev: 1.0, worstWinHole: null, bestLossHole: { hole: 5, gross: 4, par: 5, toPar: -1, opponentGross: 3 }, parTypeStats: { 3: { avgNetToPar: 0.5 }, 4: { avgNetToPar: 1 }, 5: { avgNetToPar: 0 } }, holesHalved: 4, nailbiterCount: 5, biggestComeback: 3, fastStartAvgNetToPar: 1, closerAvgNetToPar: 0, opponentName: 'Alice' }
  ];
  const got = day1Superlatives(cards);
  // netParOrBetterCount tied 5-5 -> Alice (first in array) wins.
  assert.equal(got.mostNetParsOrBetter.playerId, 0);
  // netToParStdDev tied 1.0-1.0 for both "most" and "least" -> Alice both times.
  assert.equal(got.mostConsistentNetScorer.playerId, 0);
  assert.equal(got.leastConsistentNetScorer.playerId, 0);
  // Only Alice has a worstWinHole, only Bob has a bestLossHole.
  assert.equal(got.worstScoreToWinHole.playerId, 0);
  assert.equal(got.worstScoreToWinHole.hole, 3);
  assert.equal(got.bestScoreToLoseHole.playerId, 1);
  assert.equal(got.bestScoreToLoseHole.hole, 5);
  // Par-type bests: lower avgNetToPar wins each bucket.
  assert.equal(got.bestPar3Player.playerId, 1); // Bob 0.5 < Alice 1
  assert.equal(got.bestPar4Player.playerId, 0); // Alice 0.5 < Bob 1
  assert.equal(got.bestPar5Player.playerId, 1); // Bob's the only one with data
  assert.equal(got.serialPeacemaker.playerId, 1); // Bob 4 halved > Alice 2
  assert.equal(got.nailbiterKing.playerId, 1); // Bob 5 > Alice 3
  assert.equal(got.comebackKing.playerId, 1); // Bob 3 > Alice 1
  assert.equal(got.fastStarter.playerId, 0); // Alice 0 < Bob 1
  assert.equal(got.closer.playerId, 0); // Alice -1 < Bob 0
});

test('day1Superlatives: a stat with no qualifying card anywhere is null, not a false winner', () => {
  const cards = [{ id: 0, name: 'Alice', short: 'Alice', netParOrBetterCount: 0, netToParStdDev: null, worstWinHole: null, bestLossHole: null, parTypeStats: { 3: { avgNetToPar: null }, 4: { avgNetToPar: null }, 5: { avgNetToPar: null } }, holesHalved: 0, nailbiterCount: 0, biggestComeback: 0, fastStartAvgNetToPar: null, closerAvgNetToPar: null }];
  const got = day1Superlatives(cards);
  assert.equal(got.mostConsistentNetScorer, null);
  assert.equal(got.worstScoreToWinHole, null);
  assert.equal(got.bestScoreToLoseHole, null);
  assert.equal(got.bestPar3Player, null);
  assert.equal(got.fastStarter, null);
});
