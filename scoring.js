/* ─────────────────────────────────────
   WONGA CUP — PURE SCORING MATH
   No DOM, no Supabase, no globals besides
   the exports below — safe to `require()`
   from Node tests or load via <script>.
───────────────────────────────────── */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.WongaScoring = mod;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  /* ── HTML ESCAPING ──
     Anything that reaches innerHTML (team names, in particular) is
     user-entered text synced from a publicly-writable table, not trusted
     markup, and must be escaped before interpolation (issue #58). */
  const HTML_ESCAPES = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => HTML_ESCAPES[c]);
  }

  /* ── DAY 1 — MATCH PLAY ── */
  function ninePoints(result) {
    if (result === 'A') return { a: 1, b: 0 };
    if (result === 'B') return { a: 0, b: 1 };
    if (result === 'T') return { a: 0.5, b: 0.5 };
    return { a: 0, b: 0 };
  }

  function matchPoints(match) {
    const f = ninePoints(match.front9);
    const k = ninePoints(match.back9);
    return { a: f.a + k.a, b: f.b + k.b };
  }

  function sumMatchPoints(matches) {
    let a = 0, b = 0;
    matches.forEach(match => {
      const pts = matchPoints(match);
      a += pts.a;
      b += pts.b;
    });
    return { a, b };
  }

  /* ── DAY 1 — AUTOMATIC HOLE-BY-HOLE SCORING (issue #124) ──
     Pure functions only -- the Murray Course stroke index (#122's
     courses.js) is passed in as `strokeIndexes`, never imported here,
     so this stays DOM-free and course-data-free. */
  const DAY1_GROSS_MIN = 1, DAY1_GROSS_MAX = 15;

  // Standard difference-in-handicap allocation: the lower-handicap player
  // plays off scratch; the higher-handicap player receives one stroke on
  // every hole plus a second stroke on the lowest-stroke-index holes, for
  // as many holes as the (rounded) handicap difference requires -- e.g. a
  // difference of 31 over an 18-hole nine-and-back match means 2 strokes
  // on SI 1-13 and 1 stroke on SI 14-18 (13*2 + 5*1 = 31).
  function matchStrokes(hcpA, hcpB, strokeIndexes) {
    const zeros = strokeIndexes.map(() => 0);
    const a = parseFloat(hcpA), b = parseFloat(hcpB);
    if (a === b) return { receiver: null, a: zeros, b: zeros };
    const receiver = a > b ? 'A' : 'B';
    const diff = Math.round(Math.abs(a - b));
    const base = Math.floor(diff / 18);
    const extra = diff % 18;
    const strokesFor = strokeIndexes.map(si => base + (si <= extra ? 1 : 0));
    return {
      receiver,
      a: receiver === 'A' ? strokesFor : zeros,
      b: receiver === 'B' ? strokesFor : zeros
    };
  }

  // Compares net scores (gross - strokes received) for one hole. Null
  // whenever either player's gross score hasn't been entered yet, so a
  // half-entered hole never gets silently resolved.
  function holeResult(grossA, grossB, strokesA, strokesB) {
    if (grossA === null || grossA === undefined || grossB === null || grossB === undefined) return null;
    const netA = grossA - strokesA, netB = grossB - strokesB;
    if (netA < netB) return 'A';
    if (netB < netA) return 'B';
    return 'T';
  }

  // Rolls up 9 per-hole results ('A'|'B'|'T'|null) into a nine's outcome.
  // `decided` covers both a fully-played nine and one that's mathematically
  // over early (the leader's margin exceeds the holes left to play) --
  // being exactly dormie (margin == holes left) is deliberately NOT
  // decided, since the trailing player can still force a halve.
  function nineFromHoles(nineResults) {
    const wonA = nineResults.filter(r => r === 'A').length;
    const wonB = nineResults.filter(r => r === 'B').length;
    const played = nineResults.filter(r => r !== null && r !== undefined).length;
    const remaining = nineResults.length - played;
    const lead = Math.abs(wonA - wonB);
    const decided = played === nineResults.length || lead > remaining;
    let result = null;
    if (decided) result = wonA > wonB ? 'A' : wonB > wonA ? 'B' : 'T';
    return { result, decided, wonA, wonB, played };
  }

  // Structured status for the UI's per-nine progress line -- callers format
  // this into strings like "AS thru 4", "2UP thru 6", "DORMIE", "Won 3&2",
  // "Won 2UP". `margin` is the second number in an early finish ("&2" in
  // "3&2") and is null once the nine has been fully played (a completed
  // nine is just "2UP"/"AS", never "&"-suffixed).
  function nineStatus(nineResults) {
    const wonA = nineResults.filter(r => r === 'A').length;
    const wonB = nineResults.filter(r => r === 'B').length;
    const thru = nineResults.filter(r => r !== null && r !== undefined).length;
    const remaining = nineResults.length - thru;
    const lead = Math.abs(wonA - wonB);
    const leader = wonA > wonB ? 'A' : wonB > wonA ? 'B' : null;
    const decided = thru === nineResults.length || lead > remaining;
    const dormie = !decided && remaining > 0 && lead === remaining && lead > 0;
    const margin = (decided && thru < nineResults.length) ? remaining : null;
    return { lead, leader, thru, dormie, decided, margin };
  }

  // Precedence rule between per-hole data and the manual front9/back9
  // toggles: as soon as ANY hole in a nine has a score, that nine's result
  // is derived (and null while undecided, even if a stale manual value is
  // still sitting underneath) -- the manual value is only used when the
  // nine has no hole data at all. Feeds the *unchanged* matchPoints() /
  // ninePoints(), so Day 1 point totals are provably unaffected by this
  // feature (see the equivalence test in test/scoring.test.mjs).
  function effectiveNines(match, strokes) {
    function deriveNine(start) {
      const holesA = match.holesA.slice(start, start + 9);
      const holesB = match.holesB.slice(start, start + 9);
      const hasData = holesA.some(v => v !== null) || holesB.some(v => v !== null);
      if (!hasData) return { hasData: false, result: null };
      const strokesA = strokes.a.slice(start, start + 9);
      const strokesB = strokes.b.slice(start, start + 9);
      const results = holesA.map((g, i) => holeResult(g, holesB[i], strokesA[i], strokesB[i]));
      return { hasData: true, result: nineFromHoles(results).result };
    }
    const front = deriveNine(0);
    const back = deriveNine(9);
    return {
      front9: front.hasData ? front.result : match.front9,
      back9: back.hasData ? back.result : match.back9
    };
  }

  /* ── NEAREST THE PIN (shared across all 3 days) ──
     holeTeams: array of 'A' | 'B' | null — one entry per NTP hole,
     already resolved to the winning player's team. Each non-null
     entry is worth 1 point to that team. */
  function ntpTeamPoints(holeTeams) {
    let a = 0, b = 0;
    (holeTeams || []).forEach(t => {
      if (t === 'A') a += 1;
      else if (t === 'B') b += 1;
    });
    return { a, b };
  }

  /* ── DAY 2 — TEAM SCRAMBLE ──
     Scores are net score-to-par per group (e.g. -15). Lower is better. */
  function parseScoreToPar(val) {
    if (val === '' || val === null || val === undefined) return null;
    const n = parseInt(val, 10);
    return isNaN(n) ? null : n;
  }

  // Winner-take-all points equal to the stroke differential between the
  // two teams' results in one grouping (4v4 or 3v3). Ties/incomplete = 0-0.
  function day2GroupPoints(scoreA, scoreB) {
    if (scoreA === null || scoreB === null) return { a: 0, b: 0 };
    const diff = Math.abs(scoreA - scoreB);
    if (scoreA < scoreB) return { a: diff, b: 0 };
    if (scoreB < scoreA) return { a: 0, b: diff };
    return { a: 0, b: 0 };
  }

  // Flat 5pt bonus to whichever team's combined (4-group + 3-group) result
  // is better. Tie/incomplete = 0-0.
  function day2Bonus(totalA, totalB) {
    if (totalA === null || totalB === null) return { a: 0, b: 0 };
    if (totalA < totalB) return { a: 5, b: 0 };
    if (totalB < totalA) return { a: 0, b: 5 };
    return { a: 0, b: 0 };
  }

  // raw: { a4, a3, b4, b3 } — raw string/number inputs as entered by users.
  function calcDay2(raw) {
    const a4 = parseScoreToPar(raw.a4), a3 = parseScoreToPar(raw.a3);
    const b4 = parseScoreToPar(raw.b4), b3 = parseScoreToPar(raw.b3);
    const four = day2GroupPoints(a4, b4);
    const three = day2GroupPoints(a3, b3);
    const complete = a4 !== null && a3 !== null && b4 !== null && b3 !== null;
    const bonus = complete ? day2Bonus(a4 + a3, b4 + b3) : { a: 0, b: 0 };
    return {
      a: four.a + three.a + bonus.a,
      b: four.b + three.b + bonus.b,
      four, three, bonus, complete
    };
  }

  const DAY2_SCORE_MIN = -20, DAY2_SCORE_MAX = 20;

  // Decides what a Day 2 score box's `oninput` handler should do with the
  // raw text currently in the field. `changed: false` means the raw text
  // isn't (yet) a complete number -- e.g. a lone "-" while typing a
  // negative score -- and the caller must leave the box alone rather than
  // rewrite it, otherwise a leading "-" gets stripped before a second
  // digit can be typed (issue #59). `correction` is only non-null when the
  // parsed number was actually out of the +/-20 range and the displayed
  // value needs to be pulled back in bounds.
  function day2InputState(raw) {
    if (raw === '') return { changed: true, stored: null, correction: null };
    const n = parseScoreToPar(raw);
    if (n === null) return { changed: false, stored: null, correction: null };
    const clamped = Math.max(DAY2_SCORE_MIN, Math.min(DAY2_SCORE_MAX, n));
    return { changed: true, stored: String(clamped), correction: clamped !== n ? String(clamped) : null };
  }

  /* ── DAY 2 — AUTOMATIC HOLE-BY-HOLE SCRAMBLE SCORING (issue #128) ──
     Pure and course-data-free, same spirit as #124's Day 1 functions --
     stroke indexes and group handicaps are passed in, never imported. */
  const DAY2_HOLE_GROSS_MIN = 1, DAY2_HOLE_GROSS_MAX = 15;

  // Standard Australian Ambrose team handicap: sort the group's handicaps
  // ascending and apply the percentage table for its size (confirmed by
  // issue #136), then round to the nearest whole number so the derived
  // net-to-par -- and therefore day2GroupPoints()'s stroke differential --
  // stays an integer like every other Day 2 field (issue #128 rounding
  // decision). A group size outside 2-4 has no defined divisor and returns
  // null rather than guessing.
  const SCRAMBLE_HANDICAP_PCT = {
    2: [0.35, 0.15],
    3: [0.30, 0.20, 0.10],
    4: [0.25, 0.20, 0.15, 0.10]
  };
  function scrambleTeamHandicap(hcps) {
    const pct = SCRAMBLE_HANDICAP_PCT[hcps.length];
    if (!pct) return null;
    const sorted = hcps.map(h => parseFloat(h)).sort((a, b) => a - b);
    const total = sorted.reduce((sum, h, i) => sum + h * pct[i], 0);
    return Math.round(total);
  }

  // Allocates one absolute team handicap across 18 holes via stroke index
  // -- same difference-in-handicap wraparound formula matchStrokes() uses
  // for a two-way difference, but here every hole gets the base allocation
  // since there's a single side's handicap rather than a gap between two.
  // Chosen (over applying the handicap only to the 18-hole total) so a
  // partial round's net-to-par is meaningful thru N holes, not just at 18
  // (issue #128 "allocated per hole" decision).
  function groupStrokes(handicap, strokeIndexes) {
    const base = Math.floor(handicap / 18);
    const extra = handicap % 18;
    return strokeIndexes.map(si => base + (si <= extra ? 1 : 0));
  }

  // Net score to par summed over only the holes actually played so far --
  // lets the UI show meaningful progress ("thru 11: -6") without the full
  // handicap distorting an incomplete round. `played` is how many of
  // `grossHoles` are non-null; `netToPar` is null until at least one hole
  // has a score.
  function scrambleNetToParThru(grossHoles, strokes, pars) {
    let net = 0, par = 0, played = 0;
    for (let i = 0; i < grossHoles.length; i++) {
      const g = grossHoles[i];
      if (g === null || g === undefined) continue;
      net += g - strokes[i];
      par += pars[i];
      played++;
    }
    return { netToPar: played > 0 ? net - par : null, played };
  }

  function scrambleRoundComplete(grossHoles) {
    return grossHoles.every(g => g !== null && g !== undefined);
  }

  // Moves a player between the four Day 2 groups (or out of all of them,
  // for groupCode null), returning a fresh object rather than mutating the
  // input -- same reasoning as applyPlayerTeamMove: a delta-only history
  // composes correctly across concurrent moves of different players.
  function applyPlayerGroupMove(groups, playerId, groupCode) {
    const next = {};
    Object.keys(groups).forEach(key => {
      next[key] = groups[key].filter(id => id !== playerId);
    });
    if (groupCode && next[groupCode]) next[groupCode] = [...next[groupCode], playerId];
    return next;
  }

  /* ── DAY 3 — INDIVIDUAL STABLEFORD ──
     1st = 14pts down to 14th = 1pt. Tied players share the averaged
     points across their tied position range. */
  const POS_PTS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  // entries: [{ id, score: number|null, team: 'A'|'B' }]
  // Returns entries sorted desc by score (nulls last) with pos/pts filled in.
  function computeStableford(entries) {
    // A synced score can be NaN (e.g. a null value parsed with parseInt) --
    // without this, the tie-grouping loop below advances with
    // `while (sorted[j].score === sorted[i].score) j++`, and since
    // NaN === NaN is false, j never advances past i and the loop never
    // terminates. Normalizing on copies keeps every non-finite score
    // grouped with the other not-entered (null) scores instead.
    const safe = entries.map(e => ({
      ...e,
      score: (typeof e.score === 'number' && Number.isFinite(e.score)) ? e.score : null
    }));
    const sorted = safe.sort((a, b) => {
      if (a.score === null && b.score === null) return 0;
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score;
    });

    let i = 0;
    while (i < sorted.length) {
      if (sorted[i].score === null) { sorted[i].pos = null; sorted[i].pts = 0; i++; continue; }
      let j = i;
      while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
      let totalPts = 0;
      for (let k = i; k < j; k++) totalPts += (POS_PTS[k] || 0);
      const avgPts = totalPts / (j - i);
      for (let k = i; k < j; k++) { sorted[k].pos = i + 1; sorted[k].pts = avgPts; }
      i = j;
    }
    return sorted;
  }

  // A player not yet assigned to a team (team is null/undefined — hasn't
  // been through the Captain's Draft yet) must not have their points
  // silently credited to either side.
  function sumStablefordPoints(sortedEntries) {
    let a = 0, b = 0;
    sortedEntries.forEach(p => {
      if (p.team === 'A') a += p.pts;
      else if (p.team === 'B') b += p.pts;
    });
    return { a, b };
  }

  /* ── OVERALL WINNER / TIEBREAK ── */
  function resolveOverallWinner(totalA, totalB, tiebreak) {
    if (totalA > totalB) return { winner: 'A', mode: 'points' };
    if (totalB > totalA) return { winner: 'B', mode: 'points' };
    if (tiebreak === 'A' || tiebreak === 'B') return { winner: tiebreak, mode: 'tiebreak' };
    return { winner: null, mode: 'tied-pending-tiebreak' };
  }

  /* ── TEAM ASSIGNMENT SYNC ── */

  // Moves one player between team sets, returning fresh Sets rather than
  // mutating the inputs. Used both for a local team-assignment click and
  // for replaying a synced `player_team` update row. Because it's a
  // single-player delta rather than a whole-roster snapshot, two different
  // players' concurrent moves compose instead of the second one silently
  // clobbering the first (issue #62).
  function applyPlayerTeamMove(teamA, teamB, playerId, team) {
    const nextA = new Set(teamA);
    const nextB = new Set(teamB);
    nextA.delete(playerId);
    nextB.delete(playerId);
    (team === 'A' ? nextA : nextB).add(playerId);
    return { teamA: nextA, teamB: nextB };
  }

  // Structurally, a player should never belong to both teams at once --
  // applyPlayerTeamMove always removes from both sets before adding to one,
  // so a delta-only history can never produce this. The only way it can
  // happen is stale data: a whole-roster snapshot write landing out of
  // order after a delta move that already moved the same player elsewhere
  // (issue #71 -- resetTeams() used to sync this way). Detects and repairs
  // it: any id present in both sets is kept in Team A and dropped from
  // Team B. Returns fresh Sets (no mutation) plus the ids that had to be
  // resolved, so the caller can re-render correctly and sync the fix out.
  function dedupeTeams(teamA, teamB) {
    const dupes = [...teamA].filter(id => teamB.has(id));
    if (dupes.length === 0) return { teamA, teamB, dupes };
    const nextB = new Set(teamB);
    dupes.forEach(id => nextB.delete(id));
    return { teamA, teamB: nextB, dupes };
  }

  // A player moving teams can leave a Day 1 singles match holding a stale
  // reference to them in the slot for their OLD team (issue #65) -- the
  // dropdown for that slot then has no matching <option> and silently
  // renders blank, while the underlying match/result data (and the points
  // it contributes to the scoreboard) is untouched. Worse, "fixing" the
  // apparently-empty slot by re-picking the real current player wipes the
  // match's already-recorded result. This clears any slot left pointing at
  // `playerId` on the team they just LEFT, and any result recorded against
  // it, so the UI and the data can never disagree about who's assigned.
  // Returns fresh match objects (no mutation) plus the list of concrete
  // field changes made, so the caller can both re-render and sync the
  // clearing to other devices.
  function reconcileMatchesAfterTeamMove(matches, playerId, newTeam) {
    const staleField = newTeam === 'B' ? 'pA' : newTeam === 'A' ? 'pB' : null;
    const changes = [];
    if (!staleField) return { matches, changes };
    const nextMatches = matches.map((m, matchIdx) => {
      if (m[staleField][0] !== playerId) return m;
      changes.push({ matchIdx, field: staleField, value: null });
      if (m.front9 !== null) changes.push({ matchIdx, field: 'front9', value: null });
      if (m.back9 !== null) changes.push({ matchIdx, field: 'back9', value: null });
      const next = { ...m, [staleField]: [null], front9: null, back9: null };
      // A moved player's per-hole gross scores (issue #124) are stale in
      // exactly the same way front9/back9 were -- clear them too, but only
      // for matches that actually carry hole data (older callers/tests
      // still pass plain front9/back9-only match objects).
      if (Array.isArray(m.holesA)) {
        next.holesA = m.holesA.map((val, i) => {
          if (val !== null) changes.push({ matchIdx, field: `A${i + 1}`, value: null });
          return null;
        });
      }
      if (Array.isArray(m.holesB)) {
        next.holesB = m.holesB.map((val, i) => {
          if (val !== null) changes.push({ matchIdx, field: `B${i + 1}`, value: null });
          return null;
        });
      }
      return next;
    });
    return { matches: nextMatches, changes };
  }

  // Applies a batch of already-fetched sync rows via `applyFn`, one at a
  // time, skipping (and reporting) any row that throws instead of letting
  // one bad row abort the whole batch. Always returns the last row's
  // timestamp so the caller can advance its sync cursor even when some
  // rows failed to apply -- a single malformed row must never wedge every
  // future poll (issue #63).
  function processUpdateRows(rows, applyFn) {
    let applied = 0;
    const failed = [];
    rows.forEach(row => {
      try { applyFn(row); applied++; }
      catch (error) { failed.push({ row, error }); }
    });
    return {
      applied, failed,
      lastUpdatedAt: rows.length > 0 ? rows[rows.length - 1].updated_at : null
    };
  }

  function parseIntOrNull(v) {
    if (v === null || v === undefined || v === 'null' || v === '') return null;
    const n = parseInt(v, 10);
    return isNaN(n) ? null : n;
  }

  const DAY3_SCORE_MIN = 0, DAY3_SCORE_MAX = 60;

  // Whitelists which field_key values each synced update_type may touch.
  // The tournament_updates table is publicly writable, so a forged
  // field_key (e.g. day2_score/'ntp', day1_match/'type' or '__proto__')
  // must not be able to overwrite a differently-shaped part of state --
  // without this, such a row replaces a whole object with a string or
  // rewrites a match's shape instead of just one of its real fields
  // (issue #120). update_types without a field_key (day3_stableford,
  // player_team, tiebreak) have no entry here and are unaffected.
  const UPDATE_FIELD_KEYS = {
    day1_match: ['pA', 'pB', 'front9', 'back9'],
    day1_ntp:   ['h8', 'h17'],
    day2_score: ['a4', 'a3', 'b4', 'b3'],
    day2_ntp:   ['h4', 'h16'],
    day3_ntp:   ['h7', 'h14'],
    team_name:  ['A', 'B'],
    team_assign:['A', 'B']
  };

  // Interprets one synced `tournament_updates` row and mutates `state`
  // in place accordingly -- the single place every device (regardless of
  // whether it initiated the change) ends up applying a given field
  // change, so it's the code path responsible for most of this app's
  // historical sync bugs (issues #58, #60-#63, #65, #66, #71). Takes
  // `state` as a parameter (rather than closing over a global) so it's
  // unit-testable the same way as the rest of this file.
  //
  // Every numeric field below is re-clamped here to the same range its
  // input path enforces (Day 2 +/-20, Day 3 0-60) -- local clamping alone
  // only protects the device that typed the value, not the shared state
  // every device replays a forged row into (issue #109).
  function applyUpdateToState(state, row) {
    const v = row.value;
    const allowed = UPDATE_FIELD_KEYS[row.update_type];
    if (allowed && !allowed.includes(row.field_key)) return;
    switch (row.update_type) {
      case 'day1_match': {
        if (!Number.isInteger(row.match_idx) || row.match_idx < 0 || row.match_idx > 5) break;
        const match = state.day1.matches[row.match_idx];
        if (!match || !row.field_key) break;
        if (row.field_key === 'pA' || row.field_key === 'pB') {
          (row.field_key === 'pA' ? match.pA : match.pB)[0] = parseIntOrNull(v);
        } else {
          const val = (v === null || v === 'null') ? null : v;
          match[row.field_key] = (val === 'A' || val === 'B' || val === 'T') ? val : null;
        }
        break;
      }
      case 'day1_hole': {
        // field_key isn't a fixed-size whitelist (A1..A18/B1..B18), so it's
        // validated here via pattern + range rather than UPDATE_FIELD_KEYS.
        if (!Number.isInteger(row.match_idx) || row.match_idx < 0 || row.match_idx > 5) break;
        const match = state.day1.matches[row.match_idx];
        if (!match || !row.field_key) break;
        const keyMatch = /^([AB])(\d{1,2})$/.exec(row.field_key);
        if (!keyMatch) break;
        const holeNum = parseInt(keyMatch[2], 10);
        if (holeNum < 1 || holeNum > 18) break;
        const arr = keyMatch[1] === 'A' ? match.holesA : match.holesB;
        if (!Array.isArray(arr)) break;
        const n = parseIntOrNull(v);
        arr[holeNum - 1] = n === null ? null : Math.max(DAY1_GROSS_MIN, Math.min(DAY1_GROSS_MAX, n));
        break;
      }
      case 'day1_ntp':
        if (row.field_key) state.day1.ntp[row.field_key] = parseIntOrNull(v);
        break;
      case 'day2_score': {
        if (!row.field_key) break;
        const n = parseScoreToPar(v);
        state.day2[row.field_key] = n === null ? null : String(Math.max(DAY2_SCORE_MIN, Math.min(DAY2_SCORE_MAX, n)));
        break;
      }
      case 'day2_hole': {
        // field_key is `<group>_<hole>` (e.g. a4_7, b3_18) -- not a fixed
        // whitelist, so it's validated here via pattern + range instead of
        // UPDATE_FIELD_KEYS.
        if (!row.field_key || !state.day2.holes) break;
        const keyMatch = /^(a4|a3|b4|b3)_(\d{1,2})$/.exec(row.field_key);
        if (!keyMatch) break;
        const holeNum = parseInt(keyMatch[2], 10);
        if (holeNum < 1 || holeNum > 18) break;
        const arr = state.day2.holes[keyMatch[1]];
        if (!Array.isArray(arr)) break;
        const n = parseIntOrNull(v);
        arr[holeNum - 1] = n === null ? null : Math.max(DAY2_HOLE_GROSS_MIN, Math.min(DAY2_HOLE_GROSS_MAX, n));
        break;
      }
      case 'day2_group': {
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        if (!state.day2.groups) break;
        const code = ['a4', 'a3', 'b4', 'b3'].includes(v) ? v : null;
        state.day2.groups = applyPlayerGroupMove(state.day2.groups, row.player_id, code);
        break;
      }
      case 'day2_ntp':
        if (row.field_key) state.day2.ntp[row.field_key] = parseIntOrNull(v);
        break;
      case 'day3_stableford': {
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        const n = parseIntOrNull(v);
        state.day3.scores[row.player_id] = n === null ? null : String(Math.max(DAY3_SCORE_MIN, Math.min(DAY3_SCORE_MAX, n)));
        break;
      }
      case 'day3_ntp':
        if (row.field_key) state.day3.ntp[row.field_key] = parseIntOrNull(v);
        break;
      case 'tiebreak':
        state.tiebreak = (v === 'A' || v === 'B') ? v : null;
        break;
      case 'team_name':
        if (row.field_key === 'A') state.teamNameA = v;
        else if (row.field_key === 'B') state.teamNameB = v;
        break;
      case 'team_assign':
        // Whole-roster snapshot -- only emitted by resetTeams() now. Kept
        // here so older rows already in the table still apply correctly.
        if (row.field_key === 'A') state.teamA = new Set(JSON.parse(v));
        else if (row.field_key === 'B') state.teamB = new Set(JSON.parse(v));
        break;
      case 'player_team':
        if (row.player_id !== null && row.player_id !== undefined && (v === 'A' || v === 'B')) {
          const moved = applyPlayerTeamMove(state.teamA, state.teamB, row.player_id, v);
          state.teamA = moved.teamA;
          state.teamB = moved.teamB;
          // Defensive backstop only -- the initiating device is responsible
          // for syncing its own day1_match clearing rows (see movePlayer).
          // This just keeps a device self-consistent even if those rows
          // haven't arrived yet or were dropped. Unlike the initiating
          // device's own call, this never alerts or emits further sync rows.
          const recon = reconcileMatchesAfterTeamMove(state.day1.matches, row.player_id, v);
          if (recon.changes.length > 0) state.day1.matches = recon.matches;
        }
        break;
    }
  }

  return {
    escapeHtml,
    ninePoints, matchPoints, sumMatchPoints,
    DAY1_GROSS_MIN, DAY1_GROSS_MAX,
    matchStrokes, holeResult, nineFromHoles, nineStatus, effectiveNines,
    ntpTeamPoints,
    parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2, day2InputState,
    DAY2_HOLE_GROSS_MIN, DAY2_HOLE_GROSS_MAX,
    SCRAMBLE_HANDICAP_PCT, scrambleTeamHandicap, groupStrokes,
    scrambleNetToParThru, scrambleRoundComplete, applyPlayerGroupMove,
    POS_PTS, computeStableford, sumStablefordPoints,
    resolveOverallWinner,
    applyPlayerTeamMove, dedupeTeams, reconcileMatchesAfterTeamMove, processUpdateRows,
    parseIntOrNull, applyUpdateToState
  };
});
