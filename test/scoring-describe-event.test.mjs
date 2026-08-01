/* Issue #186 -- unit tests for describeEvent(), the pure state-aware
   event classifier behind the "Wonga Wire" live commentary feed.
   Covers the 3 in-scope categories (match-play drama, NTP claims, a
   Day 2 group finishing) and confirms out-of-scope update_types and
   "nothing happened yet" cases correctly return null rather than a
   generic/misleading line. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeEvent } = require('../scoring.js');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
const COURSES_FIXTURE = {
  1: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) },
  2: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) }
};
const TEAM_NAMES = { A: 'Team Alpha', B: 'Team Beta' };
const PLAYERS = [
  { id: 0, hcp: '0.0', short: 'A. One' },
  { id: 1, hcp: '0.0', short: 'B. One' },
  { id: 2, hcp: '0.0', short: 'A. Two' },
  { id: 3, hcp: '0.0', short: 'A. Three' },
  { id: 4, hcp: '0.0', short: 'B. Two' },
  { id: 5, hcp: '0.0', short: 'B. Three' }
];

function emptyMatch(overrides) {
  return {
    pA: [0], pB: [1], front9: null, back9: null,
    holesA: Array(18).fill(null), holesB: Array(18).fill(null),
    ...overrides
  };
}
function stateWithMatch(match) {
  return { day1: { matches: [match], ntp: { h8: null, h17: null } }, day2: emptyDay2(), day3: { scores: {}, ntp: {} } };
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

/* ── day1_hole ── */

test('day1_hole: no holes played at all (thru 0) is not commentary-worthy', () => {
  const prev = stateWithMatch(emptyMatch());
  const next = stateWithMatch(emptyMatch());
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '4' };
  assert.equal(describeEvent(row, prev, next, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null);
});

test('day1_hole: entering only one player\'s score for a hole (still incomplete) is not commentary-worthy (issue #304)', () => {
  // Hole 1 already complete (thru=1). This row enters A's gross score for
  // hole 2, but B hasn't entered theirs yet -- hole 2 isn't "thru" until
  // both are in, so this shouldn't fire a duplicate/premature event.
  const prevMatch = emptyMatch({ holesA: [4, null, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got, null);
});

test('day1_hole: the second player\'s entry completing the hole is the one that fires the event (issue #304)', () => {
  // Continuing from the row above: B now enters their hole 2 score,
  // completing it -- thru advances from 1 to 2, so this is the row that
  // should produce the commentary, not the earlier half-entered one.
  const prevMatch = emptyMatch({ holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, 5, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'B2', value: '5' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'feed');
  assert.match(got.headline, /A\. One 2UP thru 2/);
});

test('day1_hole: clearing a score back out (thru regresses) is not commentary-worthy (issue #304)', () => {
  const prevMatch = emptyMatch({ holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, 5, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, null, ...Array(16).fill(null)], holesB: [5, 5, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: null };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got, null);
});

test('day1_hole: routine progress with no lead change is feed-only, not notify', () => {
  // A led by 1 before this row (holesA[0]=4 beats holesB[0]=5), stays
  // led by 1 after this row too (holesA[1]=4 beats holesB[1]=5) --
  // same leader, no drama.
  const prevMatch = emptyMatch({ holesA: [4, null, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, 5, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'feed');
  assert.match(got.headline, /A\. One 2UP thru 2/);
});

test('day1_hole: a lead change is notify-worthy', () => {
  // Level thru 1 before (A wins hole1, B wins hole2 not yet played) --
  // actually: before this row, thru=1, A led 1UP. This row makes B win
  // hole 2, leveling it back to AS -> leader flips from 'A' to null.
  const prevMatch = emptyMatch({ holesA: [4, null, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 5, ...Array(16).fill(null)], holesB: [5, 4, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'B2', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'notify');
  assert.match(got.headline, /level thru 2/);
});

test('day1_hole: leader swings from one side to the other is notify-worthy', () => {
  // A led 1UP thru 2 before; this row swings the lead: B wins hole 3
  // twice as much (par-adjustment aside, simplified with equal
  // handicaps) -- construct B taking a 1UP lead thru 3.
  const prevMatch = emptyMatch({ holesA: [4, 4, null, ...Array(15).fill(null)], holesB: [5, 5, null, ...Array(15).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 5, 6, ...Array(15).fill(null)], holesB: [5, 4, 4, ...Array(15).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'B3', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'notify');
  assert.match(got.headline, /B\. One goes 1UP thru 3/);
});

test('day1_hole: a nine becoming decided is notify-worthy, with the right margin phrasing', () => {
  // A wins holes 1-5, dormie with 4 left -> decided early, 5&4.
  const prevMatch = emptyMatch({ holesA: [4, 4, 4, 4, null, ...Array(14).fill(null)], holesB: [5, 5, 5, 5, null, ...Array(14).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [4, 4, 4, 4, 4, ...Array(13).fill(null)], holesB: [5, 5, 5, 5, 5, ...Array(13).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A5', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'notify');
  assert.match(got.headline, /A\. One wins the front 9 5&4/);
});

test('day1_hole: a nine deciding as a halve names both players, not a winner', () => {
  // Holes 1-3 tied, 4-6 to A, 7-9 to B -> 3-3, dead level thru 9 (halved).
  const holesA = [4, 4, 4, 4, 4, 4, 5, 5, 5];
  const holesB = [4, 4, 4, 5, 5, 5, 4, 4, 4];
  const prevMatch = emptyMatch({ holesA: [...holesA.slice(0, 8), null, ...Array(9).fill(null)], holesB: [...holesB.slice(0, 8), null, ...Array(9).fill(null)] });
  const nextMatch = emptyMatch({ holesA: [...holesA, ...Array(9).fill(null)], holesB: [...holesB, ...Array(9).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'B9', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'notify');
  assert.match(got.headline, /A\. One and B\. One halve the front 9/);
});

test('day1_hole: a Captain\'s Challenge (2v1) match joins both names on the 2-player side', () => {
  const prevMatch = emptyMatch({ pA: [0, 2], holesA: [4, null, ...Array(16).fill(null)], holesB: [5, null, ...Array(16).fill(null)] });
  const nextMatch = emptyMatch({ pA: [0, 2], holesA: [4, 4, ...Array(16).fill(null)], holesB: [5, 5, ...Array(16).fill(null)] });
  const row = { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: '4' };
  const got = describeEvent(row, stateWithMatch(prevMatch), stateWithMatch(nextMatch), PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.match(got.headline, /A\. One & A\. Two/);
});

test('day1_hole: an unknown match_idx or malformed field_key returns null rather than throwing', () => {
  const state = stateWithMatch(emptyMatch());
  assert.equal(describeEvent({ update_type: 'day1_hole', match_idx: 5, field_key: 'A1', value: '4' }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null);
  assert.equal(describeEvent({ update_type: 'day1_hole', match_idx: 0, field_key: 'front9', value: '4' }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null);
});

/* ── NTP ── */

test('day1_ntp/day2_ntp/day3_ntp: claiming NTP is always notify-worthy, with the right day label', () => {
  const state = stateWithMatch(emptyMatch());
  const day1 = describeEvent({ update_type: 'day1_ntp', field_key: 'h8', value: '0' }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(day1.importance, 'notify');
  assert.match(day1.headline, /A\. One takes NTP — Day 1, hole 8/);

  const day2 = describeEvent({ update_type: 'day2_ntp', field_key: 'h4', value: '1' }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.match(day2.headline, /Day 2, hole 4/);

  const day3 = describeEvent({ update_type: 'day3_ntp', field_key: 'h7', value: '2' }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.match(day3.headline, /Day 3, hole 7/);
});

test('NTP: clearing a hole (null value) is not commentary-worthy', () => {
  const state = stateWithMatch(emptyMatch());
  assert.equal(describeEvent({ update_type: 'day1_ntp', field_key: 'h8', value: null }, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null);
});

/* ── day2_hole ── */

test('day2_hole: an incomplete round is not commentary-worthy', () => {
  const day2 = emptyDay2();
  day2.groups.a3 = [2, 3];
  day2.holes.a3 = [4, ...Array(17).fill(null)];
  const state = { day1: { matches: [], ntp: {} }, day2, day3: { scores: {}, ntp: {} } };
  const row = { update_type: 'day2_hole', field_key: 'a3_1', value: '4' };
  assert.equal(describeEvent(row, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null);
});

test('day2_hole: a group finishing its round is notify-worthy, with the right team/size/par label', () => {
  const day2 = emptyDay2();
  day2.groups.a3 = [2, 3, 0]; // 3-player group, all 0.0 hcp -> no strokes
  day2.holes.a3 = Array(18).fill(3); // every hole 1 under par (par 4 fixture) -> -18
  const state = { day1: { matches: [], ntp: {} }, day2, day3: { scores: {}, ntp: {} } };
  const row = { update_type: 'day2_hole', field_key: 'a3_18', value: '3' };
  const got = describeEvent(row, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.equal(got.importance, 'notify');
  assert.match(got.headline, /Team Alpha's three-ball finishes -18/);
});

test('day2_hole: level par finishes read "level par", not "0" or "+0"', () => {
  const day2 = emptyDay2();
  day2.groups.b4 = [1, 4, 5, 0]; // 4-player group
  day2.holes.b4 = Array(18).fill(4); // exactly par every hole
  const state = { day1: { matches: [], ntp: {} }, day2, day3: { scores: {}, ntp: {} } };
  const row = { update_type: 'day2_hole', field_key: 'b4_18', value: '4' };
  const got = describeEvent(row, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES);
  assert.match(got.headline, /Team Beta's four-ball finishes level par/);
});

/* ── out of scope ── */

test('an update_type outside the wire\'s scope (team names, admin overrides, locks, etc.) returns null', () => {
  const state = stateWithMatch(emptyMatch());
  for (const updateType of ['team_name', 'player_hcp', 'day_lock', 'tiebreak', 'day3_stableford', 'player_team']) {
    const row = { update_type: updateType, field_key: 'A', value: 'x' };
    assert.equal(describeEvent(row, state, state, PLAYERS, COURSES_FIXTURE, TEAM_NAMES), null, `expected ${updateType} to be out of the wire's scope`);
  }
});
