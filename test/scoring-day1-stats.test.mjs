/* Unit tests for the Day 1 stats-export glue in scoring.js
   (day1HoleDifficultyFor, day1PlayerReportCardsFor, isLopsidedNine,
   handicapPerformanceBadge, day1StreaksFor, day1BirdieCountsFor,
   day1BlowUpHoleFor) -- built for scripts/export-day1-stats.mjs to turn
   into CSVs, not (yet) wired into any page UI. Parameterized the same
   way computeSeasonTotals() is (state/players/courses in, nothing read
   from a global). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  day1HoleDifficultyFor, day1PlayerReportCardsFor,
  isLopsidedNine, handicapPerformanceBadge,
  day1StreaksFor, day1BirdieCountsFor, day1BlowUpHoleFor,
  nineStatus, matchStrokes
} = require('../scoring.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
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
