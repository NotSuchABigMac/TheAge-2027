/* ─────────────────────────────────────
   THE IMPERFECTION MODEL (issue #176, Step 4)

   Every agent action passes through mutateAction() before it reaches the
   DOM. Most of the time it comes out unchanged; every now and then it
   comes out as the thing a tired golfer actually did instead — a tap one
   cell left, the other player's row, the wrong Freestun in a dropdown.

   Two properties this file exists to guarantee:

   1. Determinism. One seed reproduces one run exactly, including which
      slips happened and when. Without this a failure found at 11pm is
      unreproducible at 9am, which makes the whole harness decorative.

   2. Honest accounting. The ledger records what was INTENDED and what was
      PERFORMED separately. The write-count oracle compares the log
      against performed-and-committed gestures, so a slip is never
      mistaken for a lost write — the harness must never manufacture the
      failures it exists to detect.
───────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import { makeRng } from './rng.mjs';

/* ── the slip table ──
   Probabilities are per-action and mutually exclusive: one roll against
   the cumulative table, so at most one slip mutates a given action.
   Rolling each slip independently would let two fire at once and make the
   observed rate of each depend on the others — untestable, and not how a
   single mistaken tap works anyway. */
export const SLIP_RATES = {
  adjacentCell:    0.040, // score meant for hole n lands on n±1
  wrongRow:        0.020, // score goes to the opponent's row (A↔B)
  wrongCard:       0.010, // right hole, wrong match/group entirely
  fatFinger:       0.030, // value ±1, or a doubled digit ("5" → "55")
  accidentalClear: 0.015, // select-all + delete on a field that had a value
  wrongDropdown:   0.030, // picks the adjacent name — the wrong Freestun
  doubleTap:       0.050, // the same commit fired twice in quick succession
  midEntryReload:  0.005  // reloads the page with a field still dirty
};

// How often an agent notices their own slip and goes back to fix it. The
// other ~35% are never corrected and must simply stay consistent
// everywhere — that's the case that matters, and it's the reason
// golf-correctness can't be the oracle.
export const CORRECTION_RATE = 0.65;
export const CORRECTION_DELAY_MS = [5000, 40000];

const SLIP_ORDER = [
  'adjacentCell', 'wrongRow', 'wrongCard', 'fatFinger',
  'accidentalClear', 'wrongDropdown', 'doubleTap', 'midEntryReload'
];

// Which slips can meaningfully apply to which kind of action. A "wrong
// row" means nothing for a stableford entry (there are no rows to
// confuse); applying it anyway would inflate the observed rate of a slip
// that never actually mutated anything.
const APPLICABLE = {
  day1Hole:    ['adjacentCell', 'wrongRow', 'wrongCard', 'fatFinger', 'accidentalClear', 'doubleTap', 'midEntryReload'],
  day2Hole:    ['adjacentCell', 'wrongCard', 'fatFinger', 'accidentalClear', 'doubleTap', 'midEntryReload'],
  stableford:  ['fatFinger', 'accidentalClear', 'doubleTap', 'midEntryReload'],
  day2Manual:  ['fatFinger', 'accidentalClear', 'doubleTap'],
  dropdown:    ['wrongDropdown', 'doubleTap'],
  toggle:      ['doubleTap'],
  ntp:         ['wrongDropdown', 'doubleTap'],
  anthem:      ['doubleTap'],
  teamMove:    ['wrongDropdown', 'doubleTap'],
  admin:       [] // deliberate, deliberate-only: no slips on destructive controls
};

export function makeAgentRng(seed, agentId) {
  // Hashing seed+agentId (rather than sharing one stream) keeps agents
  // independent: an agent doing one extra action must not shift every
  // other agent's slip sequence, or a scenario tweak would invalidate
  // every previously-reproduced failure.
  return makeRng(`${seed}::${agentId}`);
}

/* ── the mutation core ──
   `action` is {kind, target:{...}, value}; the returned `performed` is
   the same shape, possibly with different coordinates or value.
   `scale` multiplies every rate (stage S2 runs at 3). */
export function mutateAction(rng, action, { scale = 1, bounds = {} } = {}) {
  const applicable = APPLICABLE[action.kind] || [];
  const performed = {
    ...action,
    target: { ...action.target }
  };
  const result = { performed, slipType: null, willCorrect: false, correctAfterMs: null, extra: {} };

  if (applicable.length === 0) return result;

  // One roll, walked against the cumulative applicable table.
  const roll = rng();
  let acc = 0;
  let chosen = null;
  for (const slip of SLIP_ORDER) {
    if (!applicable.includes(slip)) continue;
    acc += SLIP_RATES[slip] * scale;
    if (roll < acc) { chosen = slip; break; }
  }
  if (!chosen) return result;

  switch (chosen) {
    case 'adjacentCell': {
      const dir = rng.chance(0.5) ? -1 : 1;
      const min = bounds.holeMin ?? 1, max = bounds.holeMax ?? 18;
      const next = performed.target.hole + dir;
      // A slip off the end of the card isn't a slip, it's a no-op — fall
      // back to the other direction rather than silently dropping the
      // action (which would skew the measured slip rate downward).
      performed.target.hole = (next < min || next > max) ? performed.target.hole - dir : next;
      break;
    }
    case 'wrongRow':
      performed.target.side = performed.target.side === 'A' ? 'B' : 'A';
      break;
    case 'wrongCard': {
      const options = (bounds.cards || []).filter(c => c !== performed.target.card);
      if (options.length === 0) return { ...result, slipType: null };
      performed.target.card = rng.pick(options);
      break;
    }
    case 'fatFinger': {
      if (rng.chance(0.5)) {
        performed.value = Number(action.value) + (rng.chance(0.5) ? -1 : 1);
      } else {
        // A doubled digit — the classic phone mis-tap, and the one that
        // actually exercises the clamp paths (issue #109).
        performed.value = Number(String(action.value) + String(action.value).slice(-1));
      }
      break;
    }
    case 'accidentalClear':
      performed.value = null;
      break;
    case 'wrongDropdown': {
      const options = (bounds.options || []).filter(o => o !== action.value);
      if (options.length === 0) return { ...result, slipType: null };
      // "Adjacent in the list" rather than random: that's how a real
      // mis-tap works, and it's what produces the wrong-Freestun case
      // (ids 6 and 7, adjacent everywhere) that issue #147 is about.
      const all = bounds.options || [];
      const idx = all.indexOf(action.value);
      const neighbours = [all[idx - 1], all[idx + 1]].filter(v => v !== undefined);
      performed.value = neighbours.length > 0 ? rng.pick(neighbours) : rng.pick(options);
      break;
    }
    case 'doubleTap':
      result.extra.repeat = 2;
      break;
    case 'midEntryReload':
      result.extra.reloadMidEntry = true;
      break;
  }

  result.slipType = chosen;
  // A double-tap or a reload isn't a wrong VALUE, so there's nothing to
  // go back and correct.
  const changesValue = !['doubleTap', 'midEntryReload'].includes(chosen);
  if (changesValue) {
    result.willCorrect = rng.chance(CORRECTION_RATE);
    if (result.willCorrect) {
      result.correctAfterMs = rng.int(CORRECTION_DELAY_MS[0], CORRECTION_DELAY_MS[1]);
    }
  }
  return result;
}

/* ── the ledger ──
   Append-only JSONL, flushed synchronously. A crash mid-run must not lose
   the tail: the last few lines before a hang are exactly the ones that
   explain it. */
export class Ledger {
  constructor(dir, { runId } = {}) {
    this.dir = dir;
    this.runId = runId;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'actions.jsonl');
    this.count = 0;
    this.lines = [];
    fs.writeFileSync(this.file, '');
  }

  record(entry) {
    const line = {
      ts: Date.now(),
      seq: this.count++,
      agent: entry.agent,
      kind: entry.kind ?? entry.intent?.kind ?? null,
      intent: entry.intent ?? null,
      performed: entry.performed ?? null,
      slipType: entry.slipType ?? null,
      willCorrect: entry.willCorrect ?? false,
      committed: entry.committed === true,
      note: entry.note ?? null
    };
    this.lines.push(line);
    fs.appendFileSync(this.file, JSON.stringify(line) + '\n');
    return line;
  }

  // Rollbacks legitimately delete rows; the ledger records the cutoff so
  // the write-count oracle can discount exactly those.
  recordRollback(cutoffIso) {
    this.rollbacks = this.rollbacks || [];
    this.rollbacks.push({ cutoff: cutoffIso, at: Date.now() });
    this.record({ agent: 'admin', kind: 'rollback', note: `cutoff=${cutoffIso}`, committed: false });
    return this.rollbacks[this.rollbacks.length - 1];
  }

  get rollbackCutoffs() { return this.rollbacks || []; }

  summary() {
    const bySlip = {};
    this.lines.forEach(l => {
      const k = l.slipType || 'clean';
      bySlip[k] = (bySlip[k] || 0) + 1;
    });
    return {
      total: this.lines.length,
      committed: this.lines.filter(l => l.committed).length,
      bySlip
    };
  }
}
