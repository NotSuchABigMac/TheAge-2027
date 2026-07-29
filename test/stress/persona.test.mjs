/* Checkpoint 4 (issue #176 Step 4): determinism, calibration, and the
   zero-probability identity. If any of these three is wrong the whole
   harness becomes unreproducible or silently mis-calibrated. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRng, hashSeed } from './rng.mjs';
import { mutateAction, Ledger, SLIP_RATES, CORRECTION_RATE, makeAgentRng } from './persona.mjs';

const BOUNDS = {
  holeMin: 1, holeMax: 18,
  cards: [0, 1, 2, 3, 4, 5],
  options: [0, 1, 2, 3, 4, 5, 6, 7]
};

function holeAction(hole = 9, value = 5) {
  return { kind: 'day1Hole', target: { card: 2, side: 'A', hole }, value };
}

function runSequence(seed, n, scale = 1) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(mutateAction(rng, holeAction((i % 18) + 1, (i % 8) + 2), { scale, bounds: BOUNDS }));
  }
  return out;
}

/* ── (a) determinism ── */

test('the same seed reproduces a byte-identical slip sequence over 1000 actions', () => {
  const a = JSON.stringify(runSequence('seed-alpha', 1000));
  const b = JSON.stringify(runSequence('seed-alpha', 1000));
  assert.equal(a, b);
});

test('a different seed produces a different sequence', () => {
  const a = JSON.stringify(runSequence('seed-alpha', 500));
  const b = JSON.stringify(runSequence('seed-beta', 500));
  assert.notEqual(a, b);
});

test('per-agent streams are independent — one agent acting more cannot shift another', () => {
  const seed = 'shared-seed';
  // Agent 2's first 50 results must be identical whether or not agent 1
  // performed extra actions first.
  const agent2First = [];
  const r2a = makeAgentRng(seed, 2);
  for (let i = 0; i < 50; i++) agent2First.push(mutateAction(r2a, holeAction(i % 18 + 1), { bounds: BOUNDS }));

  const r1 = makeAgentRng(seed, 1);
  for (let i = 0; i < 977; i++) mutateAction(r1, holeAction(i % 18 + 1), { bounds: BOUNDS });
  const r2b = makeAgentRng(seed, 2);
  const agent2Second = [];
  for (let i = 0; i < 50; i++) agent2Second.push(mutateAction(r2b, holeAction(i % 18 + 1), { bounds: BOUNDS }));

  assert.equal(JSON.stringify(agent2First), JSON.stringify(agent2Second));
});

test('hashSeed is stable and distributes distinct seeds to distinct streams', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(hashSeed(`seed::${i}`));
  assert.equal(seen.size, 200, 'no collisions across 200 agent streams');
});

/* ── (b) calibration ── */

test('observed slip frequencies land within ±30% relative of their configured rates', () => {
  const N = 20000;
  const results = runSequence('calibration', N);
  const counts = {};
  results.forEach(r => { if (r.slipType) counts[r.slipType] = (counts[r.slipType] || 0) + 1; });

  const applicable = ['adjacentCell', 'wrongRow', 'wrongCard', 'fatFinger', 'accidentalClear', 'doubleTap', 'midEntryReload'];
  for (const slip of applicable) {
    const expected = SLIP_RATES[slip] * N;
    const actual = counts[slip] || 0;
    const relative = Math.abs(actual - expected) / expected;
    assert.ok(
      relative <= 0.30,
      `${slip}: expected ~${expected.toFixed(0)}, got ${actual} (${(relative * 100).toFixed(1)}% off — allowed 30%)`
    );
  }
});

test('at most one slip mutates any single action — exactly one dimension moves', () => {
  const rng = makeRng('one-slip');
  for (let i = 0; i < 5000; i++) {
    const intent = holeAction((i % 18) + 1, (i % 8) + 2);
    const r = mutateAction(rng, intent, { scale: 4, bounds: BOUNDS });

    // Compare performed against intent dimension by dimension, so this
    // measures the actual mutation rather than restating the slip name.
    const moved = {
      hole: r.performed.target.hole !== intent.target.hole,
      side: r.performed.target.side !== intent.target.side,
      card: r.performed.target.card !== intent.target.card,
      value: r.performed.value !== intent.value
    };
    const movedCount = Object.values(moved).filter(Boolean).length;

    if (r.slipType === null) {
      assert.equal(movedCount, 0, `a clean action changed ${JSON.stringify(moved)}`);
    } else if (['doubleTap', 'midEntryReload'].includes(r.slipType)) {
      // These change how the action is delivered, not what it says.
      assert.equal(movedCount, 0, `${r.slipType} must not alter the action itself`);
    } else {
      assert.equal(movedCount, 1, `${r.slipType} moved ${movedCount} dimensions: ${JSON.stringify(moved)}`);
    }
  }
});

test('the correction rate lands near its configured value', () => {
  const results = runSequence('corrections', 20000).filter(
    r => r.slipType && !['doubleTap', 'midEntryReload'].includes(r.slipType)
  );
  const corrected = results.filter(r => r.willCorrect).length;
  const rate = corrected / results.length;
  assert.ok(
    Math.abs(rate - CORRECTION_RATE) < 0.05,
    `correction rate ${rate.toFixed(3)} should be near ${CORRECTION_RATE}`
  );
  // The uncorrected remainder is the whole point — those mistakes live on
  // and must simply stay consistent everywhere.
  assert.ok(results.length - corrected > 0, 'some slips must go uncorrected');
});

test('scale multiplies the slip rate (stage S2 cranks it 3x)', () => {
  const base = runSequence('scaling', 8000, 1).filter(r => r.slipType).length;
  const cranked = runSequence('scaling', 8000, 3).filter(r => r.slipType).length;
  assert.ok(cranked > base * 2, `3x scale should produce far more slips (${base} → ${cranked})`);
});

/* ── (c) the zero-probability identity ── */

test('with every probability zeroed, performed always equals intent (stage S0)', () => {
  const results = runSequence('s0', 3000, 0);
  results.forEach((r, i) => {
    assert.equal(r.slipType, null, `action ${i} slipped at scale 0`);
    const intended = holeAction((i % 18) + 1, (i % 8) + 2);
    assert.deepEqual(r.performed.target, intended.target);
    assert.equal(r.performed.value, intended.value);
    assert.deepEqual(r.extra, {});
  });
});

/* ── slip semantics ── */

test('adjacentCell stays on the card rather than running off the end', () => {
  const rng = makeRng('edges');
  for (let i = 0; i < 3000; i++) {
    const hole = i % 2 === 0 ? 1 : 18;
    const r = mutateAction(rng, holeAction(hole), { scale: 10, bounds: BOUNDS });
    assert.ok(r.performed.target.hole >= 1 && r.performed.target.hole <= 18,
      `hole ${r.performed.target.hole} out of range from ${hole}`);
  }
});

test('wrongDropdown picks a list-adjacent option — the wrong-Freestun case', () => {
  const rng = makeRng('dropdown');
  const picks = new Set();
  for (let i = 0; i < 4000; i++) {
    const r = mutateAction(rng, { kind: 'dropdown', target: {}, value: 6 }, { scale: 10, bounds: BOUNDS });
    if (r.slipType === 'wrongDropdown') picks.add(r.performed.value);
  }
  assert.ok(picks.size > 0, 'the slip must fire at least once');
  [...picks].forEach(v => assert.ok(v === 5 || v === 7, `picked ${v}, expected a neighbour of 6`));
});

test('fatFinger produces both off-by-one and doubled-digit values', () => {
  const rng = makeRng('fat');
  const values = new Set();
  for (let i = 0; i < 6000; i++) {
    const r = mutateAction(rng, holeAction(5, 5), { scale: 10, bounds: BOUNDS });
    if (r.slipType === 'fatFinger') values.add(r.performed.value);
  }
  assert.ok(values.has(4) || values.has(6), 'off-by-one variant must occur');
  assert.ok(values.has(55), 'doubled-digit variant must occur (exercises the clamp)');
});

test('admin actions never slip — destructive controls are deliberate-only', () => {
  const rng = makeRng('admin');
  for (let i = 0; i < 2000; i++) {
    const r = mutateAction(rng, { kind: 'admin', target: {}, value: 'rollback' }, { scale: 10, bounds: BOUNDS });
    assert.equal(r.slipType, null);
  }
});

/* ── the ledger ── */

test('Ledger writes JSONL synchronously and survives a mid-run read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonga-ledger-'));
  const ledger = new Ledger(dir, { runId: 'test' });
  ledger.record({ agent: 'alice', kind: 'day1Hole', intent: { value: 5 }, performed: { value: 5 }, committed: true });
  ledger.record({ agent: 'bob', kind: 'day1Hole', intent: { value: 4 }, performed: { value: 44 }, slipType: 'fatFinger', willCorrect: true, committed: true });

  // Read from disk, not from memory — the point is crash survival.
  const lines = fs.readFileSync(path.join(dir, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].seq, 0);
  assert.equal(lines[1].slipType, 'fatFinger');
  assert.equal(lines[1].performed.value, 44);
  assert.equal(ledger.summary().committed, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Ledger records rollback cutoffs for the write-count oracle', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wonga-ledger-'));
  const ledger = new Ledger(dir, { runId: 'test' });
  const cut = ledger.recordRollback('2026-04-01T10:00:00.000Z');
  assert.equal(ledger.rollbackCutoffs.length, 1);
  assert.equal(cut.cutoff, '2026-04-01T10:00:00.000Z');
  assert.ok(cut.at > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
