/* ─────────────────────────────────────
   ORACLES (issue #176, Step 3)

   Pure functions: data in, {ok, failures[]} out. No Playwright, no
   network — so they're unit-testable against hand-built fixtures and can
   be reasoned about independently of the chaos that produced the data.

   The contract they enforce, in one line: incremental replay must equal
   from-epoch replay, on every device. Golf-correctness is explicitly not
   checked — a mis-tapped score that stayed consistent everywhere is a
   pass, because that's a real thing that happens on a real weekend.
───────────────────────────────────── */
import { createRequire } from 'node:module';
import { PLAYERS, defaultState } from './players.mjs';

const require = createRequire(import.meta.url);
// The REAL scoring module — the same code the page runs. Re-implementing
// any of this in the harness would let the oracle and the app drift into
// agreeing with each other while both being wrong.
const {
  normalizeState, applyUpdateToState, processUpdateRows, dedupeTeams,
  sumMatchPoints, calcDay2, computeStableford, sumStablefordPoints,
  ntpTeamPoints, resolveOverallWinner, effectiveNines, matchStrokes,
  scrambleTeamHandicap, groupStrokes, scrambleNetToParThru,
  scrambleRoundComplete, anthemAdjustedHandicap, parseScoreToPar
} = require('../../scoring.js');
const { COURSES, NTP_HOLES } = require('../../courses.js');

const DAY1_GROSS_MIN = 1, DAY1_GROSS_MAX = 15;

function fail(failures, kind, detail) {
  failures.push({ kind, ...detail });
}

/* ── comparison helpers ──
   localStorage holds teams as arrays (Sets don't survive JSON), but
   normalizeState leaves whatever it found in place. Canonicalising here
   is what makes two devices' payloads comparable at all. */
export function canonical(state) {
  const toSorted = v => {
    if (v instanceof Set) return [...v].sort((a, b) => a - b);
    if (Array.isArray(v)) return [...v].sort((a, b) => a - b);
    return v ?? [];
  };
  return {
    teamA: toSorted(state.teamA),
    teamB: toSorted(state.teamB),
    teamNameA: state.teamNameA ?? null,
    teamNameB: state.teamNameB ?? null,
    tiebreak: state.tiebreak ?? null,
    day1: {
      locked: state.day1.locked === true,
      ntp: { h8: state.day1.ntp?.h8 ?? null, h17: state.day1.ntp?.h17 ?? null },
      matches: state.day1.matches.map(m => ({
        pA: m.pA?.[0] ?? null,
        pB: m.pB?.[0] ?? null,
        front9: m.front9 ?? null,
        back9: m.back9 ?? null,
        holesA: [...m.holesA],
        holesB: [...m.holesB]
      }))
    },
    day2: {
      locked: state.day2.locked === true,
      a4: state.day2.a4 ?? null, a3: state.day2.a3 ?? null,
      b4: state.day2.b4 ?? null, b3: state.day2.b3 ?? null,
      ntp: { h4: state.day2.ntp?.h4 ?? null, h16: state.day2.ntp?.h16 ?? null },
      groups: {
        a4: toSorted(state.day2.groups.a4), a3: toSorted(state.day2.groups.a3),
        b4: toSorted(state.day2.groups.b4), b3: toSorted(state.day2.groups.b3)
      },
      holes: {
        a4: [...state.day2.holes.a4], a3: [...state.day2.holes.a3],
        b4: [...state.day2.holes.b4], b3: [...state.day2.holes.b3]
      },
      // Keys arrive as strings from JSON and as numbers from a live
      // replay; normalise so the two are comparable.
      anthem: Object.fromEntries(
        Object.entries(state.day2.anthem || {}).map(([k, v]) => [String(k), v]).sort()
      )
    },
    day3: {
      locked: state.day3.locked === true,
      ntp: { h7: state.day3.ntp?.h7 ?? null, h14: state.day3.ntp?.h14 ?? null },
      scores: Object.fromEntries(
        Object.entries(state.day3.scores || {})
          .filter(([, v]) => v !== null && v !== undefined && v !== '')
          .map(([k, v]) => [String(k), String(v)]).sort()
      )
    }
  };
}

// Walks two canonical states and reports every differing path — a single
// "not deepEqual" tells you nothing useful at 2am with 2,000 rows in play.
export function diffPaths(a, b, path = '', out = []) {
  if (a === b) return out;
  const aIsObj = a && typeof a === 'object', bIsObj = b && typeof b === 'object';
  if (!aIsObj || !bIsObj) {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: path || '(root)', a, b });
    return out;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    diffPaths(a[k], b[k], path ? `${path}.${k}` : k, out);
  }
  return out;
}

export function parseDeviceState(raw) {
  const parsed = raw ? JSON.parse(raw) : {};
  // The page stores Sets as arrays; normalizeState doesn't rebuild them,
  // and canonical() doesn't care — but teamOf-style logic would, so keep
  // the shape the page itself would have after loadState().
  return normalizeState(parsed);
}

/* ── Oracle 1: cross-device convergence ──
   Every device (including a late joiner that replayed from epoch) must
   hold byte-identical state once quiescent. This is THE test. */
export function convergenceOracle(devices) {
  const failures = [];
  if (devices.length === 0) {
    fail(failures, 'convergence', { detail: 'no devices supplied' });
    return { ok: false, failures };
  }
  const parsed = devices.map(d => {
    try {
      return { agent: d.agent, state: canonical(parseDeviceState(d.raw)) };
    } catch (e) {
      fail(failures, 'convergence-parse', { agent: d.agent, detail: e.message });
      return null;
    }
  }).filter(Boolean);

  if (parsed.length < 2) {
    return { ok: failures.length === 0, failures, reference: parsed[0]?.state };
  }
  const ref = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    const diffs = diffPaths(ref.state, parsed[i].state);
    if (diffs.length > 0) {
      fail(failures, 'convergence', {
        agentA: ref.agent, agentB: parsed[i].agent,
        diffCount: diffs.length,
        // Cap the report: a systemic divergence produces hundreds of
        // paths and the first few are what identify it.
        diffs: diffs.slice(0, 12)
      });
    }
  }
  return { ok: failures.length === 0, failures, reference: ref.state };
}

/* ── Oracle 2: from-epoch replay ──
   Fold the whole server log through the app's own applyUpdateToState and
   compare with what the devices converged on. Catches anything that
   depends on the ORDER a device happened to learn things in. */
export function replayOracle(serverRows, referenceCanonical) {
  const failures = [];
  // NOT a blank state: a device that has never seen a row still shows the
  // shipped default roster and team names (see players.mjs/defaultState).
  // Replaying from empty would report every device as diverged on a
  // roster no log row ever set.
  const blank = normalizeState({ ...defaultState() });
  const sorted = [...serverRows].sort((x, y) => {
    if (x.updated_at !== y.updated_at) return x.updated_at < y.updated_at ? -1 : 1;
    return String(x.id) < String(y.id) ? -1 : 1;
  });
  // Same resilience contract the page has (issue #63): one bad row must
  // not abort the fold. `rollback` rows are page-layer-only markers with
  // no state effect, exactly as applyUpdate() treats them.
  const result = processUpdateRows(
    sorted.filter(r => r.update_type !== 'rollback'),
    row => applyUpdateToState(blank, row)
  );
  const replayed = canonical(normalizeState(blank));
  const diffs = diffPaths(replayed, referenceCanonical);
  if (diffs.length > 0) {
    fail(failures, 'replay', {
      detail: 'from-epoch replay of the server log does not match converged device state',
      rowsApplied: result.applied,
      diffCount: diffs.length,
      diffs: diffs.slice(0, 12)
    });
  }
  if (result.failed.length > 0) {
    fail(failures, 'replay-bad-rows', {
      detail: `${result.failed.length} row(s) threw during replay`,
      rows: result.failed.slice(0, 5).map(f => ({ row: f.row, error: String(f.error) }))
    });
  }
  return { ok: failures.length === 0, failures, replayed };
}

/* ── Oracle 3: structural invariants ──
   Things that must hold no matter what anyone tapped. */
export function structuralOracle(c) {
  const failures = [];

  const teamA = new Set(c.teamA), teamB = new Set(c.teamB);
  const dupes = dedupeTeams(teamA, teamB).dupes;
  if (dupes.length > 0) fail(failures, 'both-teams', { players: dupes });

  // A player may hold at most one Day 1 slot across all six matches
  // (issue #147's eviction is what guarantees this under concurrency).
  const seen = new Map();
  c.day1.matches.forEach((m, mi) => {
    ['pA', 'pB'].forEach(side => {
      const id = m[side];
      if (id === null) return;
      if (seen.has(id)) {
        fail(failures, 'double-booked-day1', { player: id, matches: [seen.get(id), mi] });
      } else seen.set(id, mi);
    });
  });

  // Same for Day 2 scramble groups.
  const groupSeen = new Map();
  Object.entries(c.day2.groups).forEach(([code, ids]) => {
    ids.forEach(id => {
      if (groupSeen.has(id)) {
        fail(failures, 'double-booked-day2', { player: id, groups: [groupSeen.get(id), code] });
      } else groupSeen.set(id, code);
    });
  });

  // Clamps must hold in SHARED state, not just on the device that typed
  // the value (issue #109) — a forged row is the interesting case.
  c.day1.matches.forEach((m, mi) => {
    ['holesA', 'holesB'].forEach(key => {
      m[key].forEach((v, i) => {
        if (v === null) return;
        if (!Number.isInteger(v) || v < DAY1_GROSS_MIN || v > DAY1_GROSS_MAX) {
          fail(failures, 'day1-hole-out-of-range', { match: mi, side: key, hole: i + 1, value: v });
        }
      });
    });
    if (![null, 'A', 'B', 'T'].includes(m.front9)) fail(failures, 'bad-nine-result', { match: mi, half: 'front9', value: m.front9 });
    if (![null, 'A', 'B', 'T'].includes(m.back9)) fail(failures, 'bad-nine-result', { match: mi, half: 'back9', value: m.back9 });
  });

  Object.entries(c.day2.holes).forEach(([code, arr]) => {
    arr.forEach((v, i) => {
      if (v === null) return;
      if (!Number.isInteger(v) || v < 1 || v > 15) {
        fail(failures, 'day2-hole-out-of-range', { group: code, hole: i + 1, value: v });
      }
    });
  });

  ['a4', 'a3', 'b4', 'b3'].forEach(code => {
    const v = c.day2[code];
    if (v === null) return;
    const n = parseInt(v, 10);
    if (isNaN(n) || n < -20 || n > 20) fail(failures, 'day2-manual-out-of-range', { group: code, value: v });
  });

  Object.entries(c.day3.scores).forEach(([pid, v]) => {
    const n = parseInt(v, 10);
    if (isNaN(n) || n < 0 || n > 60) fail(failures, 'day3-score-out-of-range', { player: pid, value: v });
  });

  if (![null, 'A', 'B'].includes(c.tiebreak)) fail(failures, 'bad-tiebreak', { value: c.tiebreak });

  return { ok: failures.length === 0, failures };
}

/* ── Oracle 4: no lost or duplicated writes ──
   Every gesture the ledger recorded as committed must appear in the log
   exactly once, minus whatever a rollback legitimately deleted. This is
   the oracle that catches the offline queue double-sending or dropping. */
/* A flat "one action, one row" count is wrong for this app, and the S0
   smoke run proved it: clearing a nine emits one row per scored hole,
   a team move cascades into the match slots it invalidates, and
   setMatchPlayer clears any result recorded against the slot. Counting
   those as duplicates would make the oracle cry wolf on correct
   behaviour.

   The clean boundary is that every cascade row the app emits carries
   `value: null` — cascades only ever CLEAR. So value-bearing rows are
   counted strictly, per exact content key (who wrote what, where), which
   is a sharper test than a total: it catches a duplicate even when some
   other write was lost in the same run and the totals happened to
   cancel out. Null-valued rows are reported informationally.

   That content key is also exactly the signature of the failure this
   oracle exists for: a write whose response was dropped, retried off the
   pending queue, and landed twice. */
function contentKey(r) {
  return [r.update_type, r.match_idx ?? '', r.player_id ?? '', r.field_key ?? '', r.value ?? '', r.updated_by ?? ''].join('|');
}

// Mirrors contentKey() above, built from the coordinates the agent
// recorded at the time (serverCoords) rather than re-derived here — the
// earlier version guessed at the shape and matched nothing, leaving the
// duplicate check permanently inert.
function ledgerContentKey(line) {
  const p = line.performed || {};
  const c = line.serverCoords;
  if (!c) return null;
  return [
    p.updateType ?? '',
    c.match_idx ?? '',
    c.player_id ?? '',
    c.field_key ?? '',
    // The stored (clamped) value, not the typed one — see storedValueFor.
    line.storedValue ?? p.value ?? '',
    line.agent ?? ''
  ].join('|');
}

export function ledgerOracle(serverRows, ledgerLines, { rollbackCutoffs = [], journal = [] } = {}) {
  const failures = [];
  const committed = ledgerLines.filter(l => l.committed === true);

  // Rows a rollback legitimately deleted must not count as lost.
  const surviving = committed.filter(l =>
    l.queuedWhileOffline === true ||
    !rollbackCutoffs.some(cut => l.ts > Date.parse(cut.cutoff) && l.ts < cut.at)
  );

  const rows = serverRows.filter(r => r.update_type !== 'rollback');
  const valueRows = rows.filter(r => r.value !== null && r.value !== undefined);
  const clearRows = rows.filter(r => r.value === null || r.value === undefined);

  /* A write whose response the mock deliberately withheld DID land, and
     the client — having heard nothing — correctly queues and retries it,
     so the log legitimately ends up holding it twice. The app cannot do
     better: it has no way to distinguish "stored, response lost" from
     "never arrived", which is precisely why that fault is injected.

     These are therefore expected extra rows, not duplicates, and the
     count is exact rather than estimated: the mock journals the type of
     every insert it applied-then-dropped. */
  const droppedByType = {};
  journal.filter(j => j.result === 'applied-then-dropped').forEach(j => {
    droppedByType[j.type] = (droppedByType[j.type] || 0) + 1;
  });

  /* Strict, per-type totals over value-bearing rows.

     Counting ledger LINES is wrong, because one gesture does not always
     write one row: "Save Names" writes both team_name rows every time,
     clearing a nine writes one null per scored hole. Excluding those
     lines instead (the first attempt) is wrong in the other direction —
     it drops the ledger side while the server side still counts, which
     reports the app duplicating writes the harness simply forgot to
     predict.

     So each line declares `expectedValueRows`: how many VALUE-bearing
     rows that gesture should produce. Default 1. Zero for a pure-clear
     cascade. `null` means genuinely unpredictable, and excludes that
     update_type from strict counting rather than guessing at it. */
  const countable = surviving.filter(l =>
    l.performed?.value !== null && l.performed?.value !== undefined
  );
  const unpredictableTypes = new Set(
    countable.filter(l => l.expectedValueRows === null)
      .map(l => l.performed?.updateType || l.intent?.updateType)
      .filter(Boolean)
  );

  const byTypeRows = {}, byTypeLedger = {};
  valueRows.forEach(r => { byTypeRows[r.update_type] = (byTypeRows[r.update_type] || 0) + 1; });
  countable.forEach(l => {
    const t = l.performed?.updateType || l.intent?.updateType || 'unknown';
    const n = l.expectedValueRows === undefined ? 1 : l.expectedValueRows;
    byTypeLedger[t] = (byTypeLedger[t] || 0) + (n === null ? 0 : n);
  });

  /* Per-content, not per-total.

     Totals are timing-dependent here and cannot be made exact: a write
     whose response was dropped lands once if the client never retried
     within the run, and twice if it did. Any arithmetic over counts
     inherits that ambiguity and produces "lost writes" or "duplicated
     writes" findings that are really just about when the socket died.

     Asking the two questions separately, per exact content key, removes
     the ambiguity entirely and is a sharper test besides — it catches a
     duplicate even when a lost write elsewhere would have cancelled the
     totals out:

       1. every gesture the agent performed has AT LEAST one row  (nothing lost)
       2. no content appears more often than the agent performed it,
          plus one per ghost the mock created behind the client's back  (nothing duplicated)
  */
  const ghostKeyCounts = new Map();
  const addGhost = r => {
    const k = contentKey(r);
    ghostKeyCounts.set(k, (ghostKeyCounts.get(k) || 0) + 1);
  };

  // Ghost 1: the mock deliberately withheld the response.
  const droppedIds = new Set(journal.filter(j => j.result === 'applied-then-dropped').map(j => j.id));
  rows.filter(r => droppedIds.has(r.id)).forEach(addGhost);

  /* Ghost 2: the device lost its connection at the exact moment a write
     landed. A request dispatched microseconds before the radio drops
     still reaches the server and is applied, but the response never gets
     back — so the client queues it and retries on reconnect, and the log
     legitimately holds it twice.

     This is not the mock being clever; it is the single most ordinary
     thing that happens to a phone on a golf course, and the app has no
     way to distinguish it from a write that never arrived. Recognising
     it needs both halves of the picture: the mock's journal knows when a
     row was applied and by whom, the ledger knows when that agent's
     connection went down. */
  const offlineWindows = new Map();
  const pendingOffline = new Map();
  const addWindow = (agent, from, to) => {
    const list = offlineWindows.get(agent) || [];
    list.push([from, to]);
    offlineWindows.set(agent, list);
  };
  (ledgerLines || []).forEach(l => {
    if (l.kind === 'connectivity' && l.note === 'offline') {
      pendingOffline.set(l.agent, l.ts);
    } else if (l.kind === 'connectivity' && l.note === 'online' && pendingOffline.has(l.agent)) {
      // Widened at both ends: a write dispatched just BEFORE the drop is
      // the case in question, and the retry lands just after reconnect.
      addWindow(l.agent, pendingOffline.get(l.agent) - 5000, l.ts + 15000);
      pendingOffline.delete(l.agent);
    } else if (typeof l.note === 'string' && l.note.includes('reload')) {
      /* Navigating away while a save is in flight is the same
         unanswerable condition as a dropped response: the request may
         have reached the server before the page unloaded (measured: one
         landed 183ms before its reload), but the client never sees the
         answer, so it queues and retries. Perfectly correlated in
         practice — in the run that surfaced this, exactly the two agents
         with a mid-entry reload produced duplicates, and the other
         twelve produced none. */
      addWindow(l.agent, l.ts - 5000, l.ts + 5000);
    }
  });
  if (offlineWindows.size > 0) {
    const rowById = new Map(rows.map(r => [r.id, r]));
    journal.forEach(j => {
      if (!j.id || j.method !== 'POST') return;
      const r = rowById.get(j.id);
      if (!r) return;
      const windows = offlineWindows.get(r.updated_by);
      if (!windows) return;
      if (windows.some(([from, to]) => j.ts >= from && j.ts <= to)) addGhost(r);
    });
  }

  const rowCounts = new Map();
  valueRows.forEach(r => {
    const k = contentKey(r);
    rowCounts.set(k, (rowCounts.get(k) || 0) + 1);
  });
  const ledgerCounts = new Map();
  countable.forEach(l => {
    const k = ledgerContentKey(l);
    if (k === null) return;
    const n = l.expectedValueRows === undefined ? 1 : l.expectedValueRows;
    if (n === null || n === 0) return;
    ledgerCounts.set(k, (ledgerCounts.get(k) || 0) + n);
  });

  const lost = [], duplicated = [];
  ledgerCounts.forEach((expected, key) => {
    if (unpredictableTypes.has(key.split('|')[0])) return;
    const got = rowCounts.get(key) || 0;
    if (got === 0) lost.push({ key, agentPerformed: expected, serverCopies: 0 });
  });
  rowCounts.forEach((got, key) => {
    if (unpredictableTypes.has(key.split('|')[0])) return;
    const expected = ledgerCounts.get(key);
    // No ledger entry at all — a cascade or admin-issued row the harness
    // cannot attribute. Not evidence of anything.
    if (expected === undefined) return;
    const allowed = expected + (ghostKeyCounts.get(key) || 0);
    if (got > allowed) duplicated.push({ key, serverCopies: got, agentPerformed: expected, ghostCopies: ghostKeyCounts.get(key) || 0 });
  });

  if (lost.length > 0) {
    fail(failures, 'lost-writes', {
      detail: `${lost.length} gesture(s) the agent committed produced no row on the server`,
      samples: lost.slice(0, 8)
    });
  }
  if (duplicated.length > 0) {
    fail(failures, 'duplicate-content-rows', {
      detail: 'content written more often than the agent performed it, beyond what a dropped response explains',
      samples: duplicated.slice(0, 8)
    });
  }

  // Per-type totals are reported for context only — see the note above on
  // why they cannot be an assertion.
  const informational = {};
  new Set([...Object.keys(byTypeRows), ...Object.keys(byTypeLedger)]).forEach(t => {
    informational[t] = { serverRows: byTypeRows[t] || 0, ledgerExpected: byTypeLedger[t] || 0 };
  });

  return {
    ok: failures.length === 0, failures,
    serverRowCount: rows.length, valueRowCount: valueRows.length,
    clearRowCount: clearRows.length,
    ledgerCommitted: surviving.length,
    informational
  };
}

/* ── Oracle 5: displayed totals ──
   Recompute the scoreboard in Node from converged state and compare with
   what the page is actually showing. Catches a render that has drifted
   from the state behind it. */
export function computeTotals(c) {
  const teamOf = id => c.teamA.includes(id) ? 'A' : c.teamB.includes(id) ? 'B' : null;
  const players = PLAYERS;
  const hcpOf = id => (players.find(p => p.id === id) || {}).hcp;

  // Day 1 — same effectiveNines precedence the page uses.
  const si1 = COURSES[1].holes.map(h => h.si);
  const effMatches = c.day1.matches.map(m => {
    const match = { ...m, pA: [m.pA], pB: [m.pB] };
    if (m.pA === null || m.pB === null) return { front9: m.front9, back9: m.back9 };
    const strokes = matchStrokes(hcpOf(m.pA), hcpOf(m.pB), si1);
    return effectiveNines(match, strokes);
  });
  const d1base = sumMatchPoints(effMatches);
  const d1ntp = ntpTeamPoints([c.day1.ntp.h8, c.day1.ntp.h17].map(id => id === null ? null : teamOf(id)));

  // Day 2 — derived where a group's 18 holes are complete, manual otherwise.
  const course2 = COURSES[2].holes;
  const pars2 = course2.map(h => h.par), sis2 = course2.map(h => h.si);
  // Mirrors effectiveDay2Field() exactly. The subtle part, and the one
  // this oracle originally got wrong: once a group has ANY hole data the
  // manual aggregate stops being used, and an INCOMPLETE round yields
  // null rather than falling back to the manual score. Falling back
  // (the obvious-looking reading) credits points the app never awards.
  const day2Effective = {};
  ['a4', 'a3', 'b4', 'b3'].forEach(code => {
    const holes = c.day2.holes[code];
    if (!holes.some(h => h !== null)) { day2Effective[code] = c.day2[code]; return; }
    if (!scrambleRoundComplete(holes)) { day2Effective[code] = null; return; }
    const hcps = c.day2.groups[code].map(id => anthemAdjustedHandicap(hcpOf(id), c.day2.anthem[String(id)]));
    const teamHcp = scrambleTeamHandicap(hcps);
    if (teamHcp === null) { day2Effective[code] = null; return; }
    const strokes = groupStrokes(teamHcp, sis2);
    const { netToPar } = scrambleNetToParThru(holes, strokes, pars2);
    day2Effective[code] = netToPar === null ? null : String(netToPar);
  });
  const d2 = calcDay2(day2Effective);
  const d2ntp = ntpTeamPoints([c.day2.ntp.h4, c.day2.ntp.h16].map(id => id === null ? null : teamOf(id)));

  // Day 3 — stableford placings.
  const entries = players.map(p => ({
    id: p.id, team: teamOf(p.id), score: parseScoreToPar(c.day3.scores[String(p.id)])
  }));
  const d3 = sumStablefordPoints(computeStableford(entries));
  const d3ntp = ntpTeamPoints([c.day3.ntp.h7, c.day3.ntp.h14].map(id => id === null ? null : teamOf(id)));

  const a = d1base.a + d1ntp.a + d2.a + d2ntp.a + d3.a + d3ntp.a;
  const b = d1base.b + d1ntp.b + d2.b + d2ntp.b + d3.b + d3ntp.b;
  return {
    day1: { a: d1base.a + d1ntp.a, b: d1base.b + d1ntp.b },
    day2: { a: d2.a + d2ntp.a, b: d2.b + d2ntp.b },
    day3: { a: d3.a + d3ntp.a, b: d3.b + d3ntp.b },
    grand: { a, b },
    winner: resolveOverallWinner(a, b, c.tiebreak)
  };
}

const numFromText = t => {
  if (t === null || t === undefined) return null;
  const m = /-?\d+(\.\d+)?/.exec(String(t));
  return m ? parseFloat(m[0]) : null;
};

export function displayedTotalsOracle(scoreboards, c) {
  const failures = [];
  const expected = computeTotals(c);
  scoreboards.forEach(({ agent, board }) => {
    const checks = [
      ['day1', 'day1A', 'day1B', expected.day1],
      ['day2', 'day2A', 'day2B', expected.day2],
      ['day3', 'day3A', 'day3B', expected.day3],
      ['grand', 'grandA', 'grandB', expected.grand]
    ];
    checks.forEach(([label, keyA, keyB, exp]) => {
      const gotA = typeof board[keyA] === 'number' ? board[keyA] : numFromText(board[keyA]);
      const gotB = typeof board[keyB] === 'number' ? board[keyB] : numFromText(board[keyB]);
      if (gotA === null && gotB === null) return; // element absent on this view
      if (gotA !== exp.a || gotB !== exp.b) {
        fail(failures, 'displayed-total', {
          agent, section: label,
          displayed: { a: gotA, b: gotB }, computed: { a: exp.a, b: exp.b }
        });
      }
    });
  });
  return { ok: failures.length === 0, failures, expected };
}

/* ── Oracle 6: client health ── */

// The app logs console.error deliberately on paths the scenario provokes
// on purpose (injected 500s, the forged-row probe, offline stretches).
// Those are the test working, not the app failing. Anything else is a
// real finding.
const EXPECTED_CONSOLE_ERRORS = [
  /Supabase insert failed/,
  /Supabase load failed/,
  /Poll load error/,
  /Skipping malformed update row/,
  /Rollback marker insert failed/,
  /Field history load failed/,
  /Failed to load resource/,
  /net::ERR_/
];

/* `deliberateReloads` is a per-agent count of reloads the harness itself
   caused (the midEntryReload slip, and the scenario's explicit
   force-reload). Without it the detector flags the test's own behaviour
   as an app reload loop — which is exactly what the first Day 1 run
   did, on the two agents whose slip stream happened to fire. */
export function clientHealthOracle(devices, { maxReloadsPerDevice = 2, deliberateReloads = {} } = {}) {
  const failures = [];
  devices.forEach(d => {
    (d.errors || []).forEach(e => {
      if (e.kind === 'pageerror') {
        fail(failures, 'uncaught-exception', { agent: d.agent, message: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
      } else if (!EXPECTED_CONSOLE_ERRORS.some(re => re.test(e.message))) {
        fail(failures, 'unexpected-console-error', { agent: d.agent, message: e.message });
      }
    });
    // Reload-loop detector (issue #153): a rollback marker must fire its
    // wipe-and-reload exactly once per device, ever.
    // 1 for the initial load, plus whatever the harness deliberately did,
    // plus one permitted wipe-and-reload per rollback marker.
    const allowed = 1 + (deliberateReloads[d.agent] || 0) + maxReloadsPerDevice;
    if (d.navigations > allowed) {
      fail(failures, 'reload-loop', {
        agent: d.agent, navigations: d.navigations, allowed,
        deliberate: deliberateReloads[d.agent] || 0,
        detail: 'a device reloaded more often than its initial load + deliberate reloads + one per rollback — suspect the #153 handled-markers logic'
      });
    }
  });
  return { ok: failures.length === 0, failures };
}

/* ── Oracle 7: pending queues drained ──
   Quiescence isn't just "agents stopped" — a device still holding queued
   writes has state the server has never seen, and comparing devices at
   that moment would report a false convergence. */
export function pendingQueueOracle(devices) {
  const failures = [];
  devices.forEach(d => {
    let queue = [];
    try { queue = JSON.parse(d.pending || '[]'); } catch { queue = []; }
    if (Array.isArray(queue) && queue.length > 0) {
      fail(failures, 'pending-writes-remain', { agent: d.agent, count: queue.length, sample: queue.slice(0, 3) });
    }
  });
  return { ok: failures.length === 0, failures };
}

export function runAll({ devices, serverRows, ledgerLines, scoreboards, rollbackCutoffs, journal }) {
  const report = {};
  report.pending = pendingQueueOracle(devices);
  report.convergence = convergenceOracle(devices.map(d => ({ agent: d.agent, raw: d.raw })));
  const ref = report.convergence.reference;
  report.replay = ref ? replayOracle(serverRows, ref) : { ok: false, failures: [{ kind: 'replay', detail: 'no reference state' }] };
  report.structural = ref ? structuralOracle(ref) : { ok: false, failures: [{ kind: 'structural', detail: 'no reference state' }] };
  report.ledger = ledgerOracle(serverRows, ledgerLines, { rollbackCutoffs, journal });
  report.displayed = (ref && scoreboards?.length) ? displayedTotalsOracle(scoreboards, ref) : { ok: true, failures: [] };
  // Count the reloads the harness itself performed, per agent, straight
  // from the ledger — the oracle must not be blind to the test's own
  // actions.
  const deliberateReloads = {};
  (ledgerLines || []).forEach(l => {
    if (typeof l.note === 'string' && l.note.includes('reload')) {
      deliberateReloads[l.agent] = (deliberateReloads[l.agent] || 0) + 1;
    }
  });
  report.health = clientHealthOracle(devices, {
    maxReloadsPerDevice: rollbackCutoffs?.length || 0,
    deliberateReloads
  });

  const failures = Object.entries(report).flatMap(([name, r]) =>
    (r.failures || []).map(f => ({ oracle: name, ...f }))
  );
  return { ok: failures.length === 0, failures, report };
}
