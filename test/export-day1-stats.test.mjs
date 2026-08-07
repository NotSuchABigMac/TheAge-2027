/* Unit tests for scripts/export-day1-stats.mjs -- toCsv() is pure string
   formatting; holeDifficultyRows()/playerReportCardRows()/
   matchResultRows() are thin adapters from scoring.js's Day 1 stats
   functions (already covered in depth by test/scoring-day1-stats.test.mjs)
   into flat, CSV-friendly row objects, so these tests focus on the
   adaptation (column shape, string/number/blank formatting) rather than
   re-proving the underlying stats math. replayState() itself (reading
   the real snapshot file) is exercised indirectly by actually running
   the script -- see the "generate the real CSVs" step in the README/PR,
   not re-tested here with a fake snapshot file. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeState } = require('../scoring.js');
const { toCsv, holeDifficultyRows, playerReportCardRows, matchResultRows } = await import('../scripts/export-day1-stats.mjs');

const SI_ASCENDING = Array.from({ length: 18 }, (_, i) => i + 1);
const COURSES_FIXTURE = { 1: { holes: SI_ASCENDING.map((si) => ({ si, par: 4 })) } };

function baseState() {
  const state = { teamNameA: 'Flamingos', teamNameB: 'Gorillas', teamA: new Set(), teamB: new Set() };
  normalizeState(state);
  return state;
}

/* ── toCsv ── */

test('toCsv: header row plus one row per input, in the given column order', () => {
  const out = toCsv(['a', 'b'], [{ a: 1, b: 2 }, { a: 3, b: 4 }]);
  assert.equal(out, 'a,b\n1,2\n3,4\n');
});

test('toCsv: quotes a field containing a comma, doubling any internal quote', () => {
  const out = toCsv(['name'], [{ name: 'Smith, John "Jack"' }]);
  assert.equal(out, 'name\n"Smith, John ""Jack"""\n');
});

test('toCsv: null/undefined fields render as empty, not the literal string "null"', () => {
  const out = toCsv(['x'], [{ x: null }, { x: undefined }]);
  assert.equal(out, 'x\n\n\n');
});

test('toCsv: an empty row set is just the header line', () => {
  assert.equal(toCsv(['a', 'b'], []), 'a,b\n');
});

/* ── holeDifficultyRows ── */

test('holeDifficultyRows: rounds avgNetToPar to 3dp and blanks out a hole nobody has played', () => {
  const state = baseState();
  state.day1.matches[0] = {
    type: 'singles', pA: [0], pB: [1], front9: null, back9: null,
    holesA: Array(18).fill(null), holesB: Array(18).fill(null)
  };
  state.day1.matches[0].holesA[0] = 5; state.day1.matches[0].holesB[0] = 6; // hole1: both +1/+2 over par
  const players = [{ id: 0, hcp: '10.0' }, { id: 1, hcp: '10.0' }];
  const rows = holeDifficultyRows(state, players, COURSES_FIXTURE);
  assert.equal(rows.length, 18);
  assert.equal(rows[0].hole, 1);
  assert.equal(rows[0].sample_size, 2);
  assert.equal(rows[0].avg_net_to_par, 1.5); // (1 + 2) / 2
  assert.equal(rows[1].sample_size, 0);
  assert.equal(rows[1].avg_net_to_par, ''); // blank, not null or NaN
});

/* ── playerReportCardRows ── */

test('playerReportCardRows: maps team codes to live team names, formats booleans/blanks correctly', () => {
  const state = baseState();
  state.teamA = new Set([0]);
  state.teamB = new Set([1]);
  const match = state.day1.matches[0];
  match.pA = [0]; match.pB = [1];
  match.holesA = [3, ...Array(17).fill(null)]; // birdie on hole 1
  match.holesB = [5, ...Array(17).fill(null)];
  state.day1.ntp.h8 = 0;
  const players = [{ id: 0, hcp: '10.0', name: 'Alice Alpha', short: 'A. Alpha' }, { id: 1, hcp: '10.0', name: 'Bob Beta', short: 'B. Beta' }];

  const rows = playerReportCardRows(state, players, COURSES_FIXTURE);
  const rowA = rows.find((r) => r.player_id === 0);
  assert.equal(rowA.team, 'Flamingos');
  assert.equal(rowA.player_name, 'Alice Alpha');
  assert.equal(rowA.opponent_name, 'Bob Beta');
  assert.equal(rowA.match_number, 1);
  assert.equal(rowA.ntp_h8, true);
  assert.equal(rowA.ntp_h17, false);
  assert.equal(rowA.blow_up_hole, 1);
  assert.equal(rowA.blow_up_to_par, -1); // birdie, still "worst" since it's the only hole played
  assert.equal(rowA.handicap_badge, 'above'); // net -1 avg, well past the -0.5 threshold

  const rowB = rows.find((r) => r.player_id === 1);
  assert.equal(rowB.team, 'Gorillas');
  assert.equal(rowB.lopsided_nine, ''); // only 1 of 18 holes played -- front9 not decided yet, no lopsided flag
});

test('playerReportCardRows: skips matches missing a player, matching day1PlayerReportCardsFor directly', () => {
  const state = baseState();
  const players = [{ id: 0, hcp: '10.0', name: 'Solo', short: 'Solo' }];
  state.day1.matches[0].pA = [0]; // pB left unassigned
  const rows = playerReportCardRows(state, players, COURSES_FIXTURE);
  assert.equal(rows.length, 0);
});

/* ── matchResultRows ── */

test('matchResultRows: reports front9/back9 results, points, team names, and the lopsided flag; skips unassigned matches', () => {
  const state = baseState();
  state.teamA = new Set([0]);
  state.teamB = new Set([1]);
  const match = state.day1.matches[0];
  match.pA = [0]; match.pB = [1];
  // Front 9: A sweeps all 9 (lopsided, 9-0). Back 9: untouched.
  match.holesA = [3, 3, 3, 3, 3, 3, 3, 3, 3, ...Array(9).fill(null)];
  match.holesB = [5, 5, 5, 5, 5, 5, 5, 5, 5, ...Array(9).fill(null)];
  const players = [{ id: 0, hcp: '10.0', name: 'Alice Alpha' }, { id: 1, hcp: '10.0', name: 'Bob Beta' }];

  const rows = matchResultRows(state, players, COURSES_FIXTURE);
  assert.equal(rows.length, 1); // matches 2-6 have no players assigned
  const row = rows[0];
  assert.equal(row.match_number, 1);
  assert.equal(row.team_a, 'Flamingos');
  assert.equal(row.player_a, 'Alice Alpha');
  assert.equal(row.front9_result, 'A');
  assert.equal(row.back9_result, ''); // not decided -- blank, not null/undefined
  assert.equal(row.points_a, 1);
  assert.equal(row.points_b, 0);
  assert.equal(row.lopsided, true);
});
