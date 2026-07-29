/* Checkpoint 3 (issue #176 Step 3): every oracle must pass a clean case
   AND fail a deliberately-broken one with a message that names the exact
   path/row. An oracle that can't fail is worse than no oracle — it
   converts a broken run into a green one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  canonical, diffPaths, parseDeviceState, convergenceOracle, replayOracle,
  structuralOracle, ledgerOracle, displayedTotalsOracle, clientHealthOracle,
  pendingQueueOracle, computeTotals
} from './oracles.mjs';
import { PLAYERS, defaultState } from './players.mjs';

const require = createRequire(import.meta.url);
const { normalizeState } = require('../../scoring.js');

/* ── fixtures ── */

// A device payload in exactly the shape the page writes to localStorage
// (Sets already serialised to arrays by JSON.stringify).
function deviceRaw(overrides = {}) {
  const base = normalizeState({});
  base.teamA = [0, 2, 4, 6, 8, 10, 12];
  base.teamB = [1, 3, 5, 7, 9, 11, 13];
  base.teamNameA = 'Team Beer';
  base.teamNameB = 'Team Golf';
  const merged = { ...base, ...overrides };
  return JSON.stringify(merged, (k, v) => (v instanceof Set ? [...v] : v));
}

function row(i, over = {}) {
  return {
    id: `id-${String(i).padStart(4, '0')}`,
    tournament_id: 't',
    update_type: 'day3_stableford',
    match_idx: null, player_id: 0, field_key: null, value: '30',
    updated_by: 'Tester',
    updated_at: new Date(1800000000000 + i).toISOString(),
    ...over
  };
}

/* ── diffPaths (the reporting substrate) ── */

test('diffPaths reports the exact path of a nested difference', () => {
  const a = { day1: { matches: [{ front9: 'A' }] } };
  const b = { day1: { matches: [{ front9: 'B' }] } };
  const diffs = diffPaths(a, b);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].path, 'day1.matches.0.front9');
  assert.equal(diffs[0].a, 'A');
  assert.equal(diffs[0].b, 'B');
});

test('diffPaths reports nothing for identical structures', () => {
  const a = { x: [1, 2, { y: null }] };
  assert.equal(diffPaths(a, JSON.parse(JSON.stringify(a))).length, 0);
});

/* ── Oracle 1: convergence ── */

test('convergenceOracle passes when every device holds identical state', () => {
  const devices = ['alice', 'bob', 'carol'].map(agent => ({ agent, raw: deviceRaw() }));
  const r = convergenceOracle(devices);
  assert.ok(r.ok, JSON.stringify(r.failures));
  assert.ok(r.reference, 'a reference state is returned for the downstream oracles');
});

test('convergenceOracle FAILS on a one-hole divergence and names the path', () => {
  const diverged = normalizeState({});
  diverged.day1.matches[2].holesA[6] = 5;
  const devices = [
    { agent: 'alice', raw: deviceRaw() },
    { agent: 'bob', raw: deviceRaw({ day1: diverged.day1 }) }
  ];
  const r = convergenceOracle(devices);
  assert.equal(r.ok, false);
  const f = r.failures[0];
  assert.equal(f.kind, 'convergence');
  assert.equal(f.agentB, 'bob');
  assert.equal(f.diffs[0].path, 'day1.matches.2.holesA.6');
  assert.equal(f.diffs[0].b, 5);
});

test('convergenceOracle treats Set-vs-array team payloads as equal (JSON round-trip)', () => {
  const asArrays = deviceRaw();
  const withSets = JSON.stringify(
    { ...normalizeState({}), teamA: [12, 10, 8, 6, 4, 2, 0], teamB: [13, 11, 9, 7, 5, 3, 1], teamNameA: 'Team Beer', teamNameB: 'Team Golf' }
  );
  const r = convergenceOracle([{ agent: 'a', raw: asArrays }, { agent: 'b', raw: withSets }]);
  assert.ok(r.ok, 'team order must not count as divergence: ' + JSON.stringify(r.failures));
});

/* ── Oracle 2: replay ── */

test('replayOracle passes when the log folds to the converged state', () => {
  const rows = [
    row(1, { update_type: 'day3_stableford', player_id: 0, value: '34' }),
    row(2, { update_type: 'day3_stableford', player_id: 1, value: '30' }),
    row(3, { update_type: 'day1_hole', match_idx: 0, player_id: null, field_key: 'A1', value: '5' })
  ];
  const blank = normalizeState({});
  const { applyUpdateToState } = require('../../scoring.js');
  rows.forEach(r => applyUpdateToState(blank, r));
  blank.teamA = [0, 2, 4, 6, 8, 10, 12];
  blank.teamB = [1, 3, 5, 7, 9, 11, 13];
  blank.teamNameA = 'Team Beer'; blank.teamNameB = 'Team Golf';

  const r = replayOracle(rows, canonical(normalizeState(blank)));
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('replayOracle FAILS when a row is missing from the log', () => {
  const rows = [
    row(1, { player_id: 0, value: '34' }),
    row(2, { player_id: 1, value: '30' })
  ];
  const blank = normalizeState({});
  const { applyUpdateToState } = require('../../scoring.js');
  rows.forEach(r => applyUpdateToState(blank, r));
  blank.teamA = [0, 2, 4, 6, 8, 10, 12];
  blank.teamB = [1, 3, 5, 7, 9, 11, 13];
  blank.teamNameA = 'Team Beer'; blank.teamNameB = 'Team Golf';
  const reference = canonical(normalizeState(blank));

  // Server lost row 2 — replay can no longer reproduce the devices' state.
  const r = replayOracle([rows[0]], reference);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'replay');
  assert.ok(r.failures[0].diffs.some(d => d.path.includes('day3.scores')), JSON.stringify(r.failures[0].diffs));
});

test('replayOracle ignores rollback marker rows (page-layer only, no state effect)', () => {
  const rows = [row(1, { player_id: 0, value: '20' }), row(2, { update_type: 'rollback', value: '2020-01-01T00:00:00.000Z' })];
  const blank = normalizeState({});
  require('../../scoring.js').applyUpdateToState(blank, rows[0]);
  blank.teamA = [0, 2, 4, 6, 8, 10, 12]; blank.teamB = [1, 3, 5, 7, 9, 11, 13];
  blank.teamNameA = 'Team Beer'; blank.teamNameB = 'Team Golf';
  const r = replayOracle(rows, canonical(normalizeState(blank)));
  assert.ok(r.ok, JSON.stringify(r.failures));
});

/* ── Oracle 3: structural ── */

test('structuralOracle passes on a clean state', () => {
  const r = structuralOracle(canonical(parseDeviceState(deviceRaw())));
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('structuralOracle FAILS when a player is on both teams', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.teamB.push(0); // id 0 is already in teamA
  const r = structuralOracle(c);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'both-teams');
  assert.deepEqual(r.failures[0].players, [0]);
});

test('structuralOracle FAILS when one player holds two Day 1 slots', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.matches[0].pA = 4;
  c.day1.matches[3].pB = 4;
  const r = structuralOracle(c);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'double-booked-day1');
  assert.ok(f, JSON.stringify(r.failures));
  assert.equal(f.player, 4);
  assert.deepEqual(f.matches, [0, 3]);
});

test('structuralOracle FAILS when one player is in two Day 2 groups', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day2.groups.a4 = [0, 2];
  c.day2.groups.a3 = [2, 4];
  const r = structuralOracle(c);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'double-booked-day2');
  assert.equal(f.player, 2);
});

test('structuralOracle FAILS on an out-of-range hole score in shared state', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.matches[1].holesB[3] = 99;
  const r = structuralOracle(c);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'day1-hole-out-of-range');
  assert.equal(f.value, 99);
  assert.equal(f.hole, 4);
});

test('structuralOracle FAILS on an out-of-range Day 3 score', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day3.scores['5'] = '75';
  const r = structuralOracle(c);
  assert.equal(r.ok, false);
  assert.equal(r.failures.find(x => x.kind === 'day3-score-out-of-range').value, '75');
});

/* ── Oracle 4: ledger ── */

test('ledgerOracle passes when server rows match committed gestures', () => {
  const rows = [row(1), row(2), row(3)];
  const ledger = [
    { ts: 1, agent: 'a', committed: true, performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } },
    { ts: 2, agent: 'b', committed: true, performed: { updateType: 'day3_stableford', target: { player: 1 }, value: '31' } },
    { ts: 3, agent: 'c', committed: true, performed: { updateType: 'day3_stableford', target: { player: 2 }, value: '32' } },
    { ts: 4, agent: 'd', committed: false, performed: { updateType: 'day3_stableford', target: { player: 3 }, value: '33' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('ledgerOracle FAILS on a duplicated write and names the content key', () => {
  const dup = { update_type: 'day3_stableford', player_id: 0, value: '30', updated_by: 'a' };
  const rows = [row(1, dup), row(2, dup)];
  const ledger = [
    { ts: 1, agent: 'a', committed: true,
      serverCoords: { match_idx: null, player_id: 0, field_key: null },
      performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'duplicate-content-rows');
  assert.equal(f.samples[0].serverCopies, 2);
  assert.equal(f.samples[0].agentPerformed, 1);
});

test('ledgerOracle FAILS on a lost write and names the missing gesture', () => {
  // Player 0's score landed; player 1's never reached the server.
  const rows = [row(1, { update_type: 'day3_stableford', player_id: 0, value: '30', updated_by: 'a' })];
  const ledger = [
    { ts: 1, agent: 'a', committed: true,
      serverCoords: { match_idx: null, player_id: 0, field_key: null },
      performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } },
    { ts: 2, agent: 'b', committed: true,
      serverCoords: { match_idx: null, player_id: 1, field_key: null },
      performed: { updateType: 'day3_stableford', target: { player: 1 }, value: '31' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'lost-writes');
  assert.equal(f.samples[0].serverCopies, 0);
  assert.match(f.samples[0].key, /\|1\|\|31\|b$/);
});

test('ledgerOracle discounts writes a rollback legitimately deleted', () => {
  const cutoffMs = 1800000000000;
  const rows = [row(1)]; // only the pre-cutoff row survived
  const ledger = [
    { ts: cutoffMs - 1000, agent: 'a', committed: true, performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } },
    { ts: cutoffMs + 5000, agent: 'b', committed: true, performed: { updateType: 'day3_stableford', target: { player: 1 }, value: '31' } }
  ];
  const r = ledgerOracle(rows, ledger, {
    rollbackCutoffs: [{ cutoff: new Date(cutoffMs).toISOString(), at: cutoffMs + 10000 }]
  });
  assert.ok(r.ok, JSON.stringify(r.failures));
});

/* ── Oracle 5: displayed totals ── */

test('computeTotals awards Day 1 nine points from manual results', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.matches[0].pA = 0; c.day1.matches[0].pB = 1;
  c.day1.matches[0].front9 = 'A';
  c.day1.matches[0].back9 = 'T';
  const totals = computeTotals(c);
  assert.equal(totals.day1.a, 1.5);
  assert.equal(totals.day1.b, 0.5);
});

test('computeTotals credits an NTP point to the winner\'s team', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.ntp.h8 = 0; // id 0 is on team A
  assert.equal(computeTotals(c).day1.a, 1);
  c.day1.ntp.h8 = 1; // id 1 is on team B
  assert.equal(computeTotals(c).day1.b, 1);
});

test('displayedTotalsOracle passes when the page agrees with recomputation', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.matches[0].pA = 0; c.day1.matches[0].pB = 1; c.day1.matches[0].front9 = 'A';
  const exp = computeTotals(c);
  const board = {
    day1A: `${exp.day1.a} pts`, day1B: `${exp.day1.b} pts`,
    day2A: `${exp.day2.a} pts`, day2B: `${exp.day2.b} pts`,
    day3A: `${exp.day3.a} pts`, day3B: `${exp.day3.b} pts`,
    grandA: String(exp.grand.a), grandB: String(exp.grand.b)
  };
  const r = displayedTotalsOracle([{ agent: 'alice', board }], c);
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('displayedTotalsOracle FAILS when the rendered board drifts from state', () => {
  const c = canonical(parseDeviceState(deviceRaw()));
  c.day1.matches[0].pA = 0; c.day1.matches[0].pB = 1; c.day1.matches[0].front9 = 'A';
  const exp = computeTotals(c);
  const board = {
    day1A: '99 pts', day1B: `${exp.day1.b} pts`,
    day2A: `${exp.day2.a} pts`, day2B: `${exp.day2.b} pts`,
    day3A: `${exp.day3.a} pts`, day3B: `${exp.day3.b} pts`,
    grandA: String(exp.grand.a), grandB: String(exp.grand.b)
  };
  const r = displayedTotalsOracle([{ agent: 'alice', board }], c);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.section === 'day1');
  assert.equal(f.agent, 'alice');
  assert.equal(f.displayed.a, 99);
});

/* ── Oracle 6: client health ── */

test('clientHealthOracle passes on expected console noise', () => {
  const devices = [{
    agent: 'alice', navigations: 1,
    errors: [
      { kind: 'console.error', message: 'Supabase insert failed: 500 injected server error' },
      { kind: 'console.error', message: 'Skipping malformed update row: {...}' }
    ]
  }];
  assert.ok(clientHealthOracle(devices).ok);
});

test('clientHealthOracle FAILS on an uncaught exception', () => {
  const devices = [{
    agent: 'bob', navigations: 1,
    errors: [{ kind: 'pageerror', message: "Cannot read properties of null (reading 'holesA')", stack: 'at renderDay1\nat pollOnce' }]
  }];
  const r = clientHealthOracle(devices);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'uncaught-exception');
  assert.match(r.failures[0].message, /holesA/);
});

test('clientHealthOracle FAILS on a reload loop (issue #153 regression shape)', () => {
  const devices = [{ agent: 'carol', navigations: 9, errors: [] }];
  const r = clientHealthOracle(devices, { maxReloadsPerDevice: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'reload-loop');
  assert.equal(r.failures[0].navigations, 9);
});

/* ── Oracle 7: pending queues ── */

test('pendingQueueOracle passes on empty/absent queues', () => {
  assert.ok(pendingQueueOracle([
    { agent: 'a', pending: '[]' }, { agent: 'b', pending: null }
  ]).ok);
});

test('pendingQueueOracle FAILS when a device still holds unsent writes', () => {
  const r = pendingQueueOracle([
    { agent: 'a', pending: JSON.stringify([{ updateType: 'day1_hole', fields: { field_key: 'A4' } }]) }
  ]);
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'pending-writes-remain');
  assert.equal(r.failures[0].count, 1);
});

/* ── roster extraction ── */

test('PLAYERS is parsed out of the live page, 14 golfers, ids 0..13', () => {
  assert.equal(PLAYERS.length, 14);
  assert.equal(PLAYERS[3].name, 'James McIntyre');
  PLAYERS.forEach((p, i) => assert.equal(p.id, i));
});

test('ledgerOracle FAILS on the retry-duplicate signature (same content, twice)', () => {
  // One agent gesture, two identical rows on the server — the shape a
  // dropped response retried off the pending queue produces.
  const dup = { update_type: 'day3_stableford', player_id: 0, value: '30', updated_by: 'alice' };
  const rows = [row(1, dup), row(2, dup)];
  const ledger = [
    { ts: 1, agent: 'alice', committed: true,
      serverCoords: { match_idx: null, player_id: 0, field_key: null },
      performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.equal(r.ok, false);
  const f = r.failures.find(x => x.kind === 'duplicate-content-rows');
  assert.ok(f, JSON.stringify(r.failures));
  assert.equal(f.samples[0].serverCopies, 2);
  assert.equal(f.samples[0].agentPerformed, 1);
});

test('ledgerOracle accepts a genuine double-tap (agent really did it twice)', () => {
  const dup = { update_type: 'day3_stableford', player_id: 0, value: '30', updated_by: 'alice' };
  const rows = [row(1, dup), row(2, dup)];
  const coords = { match_idx: null, player_id: 0, field_key: null };
  const ledger = [
    { ts: 1, agent: 'alice', committed: true, serverCoords: coords, performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } },
    { ts: 2, agent: 'alice', committed: true, serverCoords: coords, performed: { updateType: 'day3_stableford', target: { player: 0 }, value: '30' } }
  ];
  assert.ok(ledgerOracle(rows, ledger).ok);
});

test('ledgerOracle ignores null-valued cascade rows (clears, not duplicates)', () => {
  // Clearing a nine emits one null row per scored hole from a single
  // gesture — correct behaviour that must not read as duplication.
  const rows = [
    row(1, { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: null, updated_by: 'alice' }),
    row(2, { update_type: 'day1_hole', match_idx: 0, field_key: 'A2', value: null, updated_by: 'alice' }),
    row(3, { update_type: 'day1_hole', match_idx: 0, field_key: 'A3', value: null, updated_by: 'alice' })
  ];
  const ledger = [
    { ts: 1, agent: 'alice', committed: true, cascade: true, expectedValueRows: 0, performed: { updateType: 'day1_hole', target: { card: 0 }, value: 'clear' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.ok(r.ok, 'a cascade of clears from one gesture is not a failure: ' + JSON.stringify(r.failures));
  assert.equal(r.clearRowCount, 3);
  assert.equal(r.valueRowCount, 0);
});

test('ledgerOracle counts expectedValueRows, not ledger lines (Save Names writes both)', () => {
  // One gesture, four rows, and that is correct: the app rewrites both
  // team_name rows on every save and the scenario saves twice.
  const rows = [
    row(1, { update_type: 'team_name', field_key: 'A', value: 'X', updated_by: 'admin' }),
    row(2, { update_type: 'team_name', field_key: 'B', value: 'Y', updated_by: 'admin' }),
    row(3, { update_type: 'team_name', field_key: 'A', value: 'X', updated_by: 'admin' }),
    row(4, { update_type: 'team_name', field_key: 'B', value: 'Y', updated_by: 'admin' })
  ];
  const ledger = [
    { ts: 1, agent: 'admin', committed: true, cascade: true, expectedValueRows: 4,
      performed: { updateType: 'team_name', target: {}, value: 'X|Y' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('ledgerOracle reports an unpredictable type informationally, not as a failure', () => {
  const rows = [row(1, { update_type: 'day1_ntp', field_key: 'h8', value: '3', updated_by: 'admin' })];
  const ledger = [
    { ts: 1, agent: 'admin', committed: true, cascade: true, expectedValueRows: null,
      performed: { updateType: 'day1_ntp', target: {}, value: 'restored' } }
  ];
  const r = ledgerOracle(rows, ledger);
  assert.ok(r.ok, JSON.stringify(r.failures));
  assert.ok(r.informational.day1_ntp, 'the type is reported rather than strict-counted');
});

test('clientHealthOracle does not flag reloads the harness itself performed', () => {
  const devices = [{ agent: 'alice', navigations: 4, errors: [] }];
  // 1 initial + 3 deliberate = 4 allowed, 0 rollbacks.
  assert.ok(clientHealthOracle(devices, { maxReloadsPerDevice: 0, deliberateReloads: { alice: 3 } }).ok);
  // One more than accounted for IS a finding.
  const r = clientHealthOracle([{ agent: 'alice', navigations: 6, errors: [] }],
    { maxReloadsPerDevice: 0, deliberateReloads: { alice: 3 } });
  assert.equal(r.ok, false);
  assert.equal(r.failures[0].kind, 'reload-loop');
});

test('ledgerOracle expects a retried duplicate when the mock dropped the response', () => {
  // The write landed, the client never heard back, queued and retried it.
  // Two identical rows is the correct outcome — the app cannot tell
  // "stored, response lost" from "never arrived".
  const content = { update_type: 'day1_hole', match_idx: 0, player_id: null, field_key: 'A5', value: '6', updated_by: 'alice' };
  const rows = [row(1, content), row(2, content)];
  const ledger = [
    { ts: 1, agent: 'alice', committed: true, expectedValueRows: 1,
      serverCoords: { match_idx: 0, player_id: null, field_key: 'A5' },
      performed: { updateType: 'day1_hole', target: { card: 0, hole: 5 }, value: '6' } }
  ];
  const journal = [{ result: 'applied-then-dropped', type: 'day1_hole', id: rows[0].id }];
  const r = ledgerOracle(rows, ledger, { journal });
  assert.ok(r.ok, JSON.stringify(r.failures));
  // And a THIRD copy is still a finding: one ghost explains one extra.
  const three = ledgerOracle([...rows, row(3, content)], ledger, { journal });
  assert.equal(three.ok, false);
});

test('ledgerOracle still catches a duplicate that no dropped response explains', () => {
  const content = { update_type: 'day1_hole', match_idx: 0, player_id: null, field_key: 'A5', value: '6', updated_by: 'alice' };
  const rows = [row(1, content), row(2, content)];
  const ledger = [
    { ts: 1, agent: 'alice', committed: true, expectedValueRows: 1,
      serverCoords: { match_idx: 0, player_id: null, field_key: 'A5' },
      performed: { updateType: 'day1_hole', target: { card: 0, hole: 5 }, value: '6' } }
  ];
  const r = ledgerOracle(rows, ledger, { journal: [] });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.kind === 'duplicate-content-rows'));
});

test('serverCoordsFor builds the exact field_key the app writes', async () => {
  const { serverCoordsFor } = await import('./agents.mjs');
  assert.deepEqual(
    serverCoordsFor({ updateType: 'day1_hole' }, { target: { card: 2, side: 'B', hole: 14 } }),
    { match_idx: 2, player_id: null, field_key: 'B14' });
  assert.deepEqual(
    serverCoordsFor({ updateType: 'day2_hole' }, { target: { card: 'b3', hole: 7 } }),
    { match_idx: null, player_id: null, field_key: 'b3_7' });
  assert.deepEqual(
    serverCoordsFor({ updateType: 'day1_match' }, { target: { card: 4, side: 'A' } }),
    { match_idx: 4, player_id: null, field_key: 'pA' });
  assert.deepEqual(
    serverCoordsFor({ updateType: 'day1_match' }, { target: { card: 5, nine: 'back9' } }),
    { match_idx: 5, player_id: null, field_key: 'back9' });
  assert.deepEqual(
    serverCoordsFor({ updateType: 'day3_stableford' }, { target: { player: 9 } }),
    { match_idx: null, player_id: 9, field_key: null });
});

test('storedValueFor mirrors the app clamps so typed != stored still matches', async () => {
  const { storedValueFor } = await import('./agents.mjs');
  assert.equal(storedValueFor('day1_hole', 88), '15');   // fat-fingered doubled digit
  assert.equal(storedValueFor('day1_hole', 6), '6');
  assert.equal(storedValueFor('day3_stableford', 75), '60');
  assert.equal(storedValueFor('day3_stableford', -3), '0');
  assert.equal(storedValueFor('day2_score', -44), '-20');
  assert.equal(storedValueFor('day1_hole', null), null);
});

test('ledgerOracle allows a duplicate caused by losing signal as the write landed', () => {
  // The write reached the server; the response did not reach the phone,
  // because the radio dropped in between. The client queues and retries.
  const content = { update_type: 'day1_hole', match_idx: 2, player_id: null, field_key: 'A7', value: '5', updated_by: 'alice' };
  const rows = [row(1, content), row(2, content)];
  const ledger = [
    { ts: 1000, agent: 'alice', committed: true, expectedValueRows: 1,
      serverCoords: { match_idx: 2, player_id: null, field_key: 'A7' },
      performed: { updateType: 'day1_hole', target: { card: 2, hole: 7 }, value: '5' } },
    { ts: 2000, agent: 'alice', kind: 'connectivity', note: 'offline', committed: false },
    { ts: 9000, agent: 'alice', kind: 'connectivity', note: 'online', committed: false }
  ];
  // The insert was applied while alice's connection was going down.
  const journal = [{ method: 'POST', result: 'ok', id: rows[0].id, ts: 1500 }];
  const r = ledgerOracle(rows, ledger, { journal });
  assert.ok(r.ok, JSON.stringify(r.failures));
});

test('ledgerOracle still catches a duplicate from an agent that never went offline', () => {
  const content = { update_type: 'day1_hole', match_idx: 2, player_id: null, field_key: 'A7', value: '5', updated_by: 'bob' };
  const rows = [row(1, content), row(2, content)];
  const ledger = [
    { ts: 1000, agent: 'bob', committed: true, expectedValueRows: 1,
      serverCoords: { match_idx: 2, player_id: null, field_key: 'A7' },
      performed: { updateType: 'day1_hole', target: { card: 2, hole: 7 }, value: '5' } }
  ];
  const r = ledgerOracle(rows, ledger, { journal: [{ method: 'POST', result: 'ok', id: rows[0].id, ts: 1500 }] });
  assert.equal(r.ok, false);
  assert.ok(r.failures.some(f => f.kind === 'duplicate-content-rows'));
});

test('ledgerOracle allows a duplicate caused by reloading while a write was in flight', () => {
  const content = { update_type: 'day1_hole', match_idx: 0, player_id: null, field_key: 'A5', value: '8', updated_by: 'alice' };
  const rows = [row(1, content), row(2, content)];
  const ledger = [
    { ts: 1000, agent: 'alice', committed: true, expectedValueRows: 1,
      serverCoords: { match_idx: 0, player_id: null, field_key: 'A5' },
      performed: { updateType: 'day1_hole', target: { card: 0, hole: 5 }, value: '8' },
      note: 'reloaded-mid-entry' }
  ];
  const journal = [{ method: 'POST', result: 'ok', id: rows[0].id, ts: 1100 }];
  assert.ok(ledgerOracle(rows, ledger, { journal }).ok);
});
