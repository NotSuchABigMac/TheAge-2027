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

  /* ── TAB NAVIGATION (issue #193) ──
     Pure so it can be tested without a DOM: given a Date (any instant, e.g.
     from Date.now()), returns which tab a fresh visitor with no hash and no
     saved position should land on, based on the *Melbourne-local* calendar
     date -- the tournament runs on Melbourne time, and a server or device
     reporting UTC must never round to the wrong side of midnight and pick
     the wrong day. Returns null outside the three tournament dates, so the
     caller can fall back to the last-viewed tab (or 'day1' as the ultimate
     default). */
  const TOURNAMENT_DAY_DATES = { '2026-08-07': 'day1', '2026-08-08': 'day2', '2026-08-09': 'day3' };
  function defaultDay(date) {
    const melbourneDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    return TOURNAMENT_DAY_DATES[melbourneDate] || null;
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
    // A hand-edited PLAYERS.hcp typo is one keystroke away from a
    // non-numeric value -- NaN handicaps used to flow straight through
    // into NaN stroke arrays, which holeResult() then silently resolves
    // every hole as a halve ('T') with no visible error (issue #164).
    if (isNaN(a) || isNaN(b)) return { receiver: null, a: zeros, b: zeros };
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
    // normalizeState() guarantees holesA/holesB exist on every match today
    // -- this guard is only for a future direct call that bypasses it,
    // where .slice() of undefined would otherwise throw and crash render
    // (issue #164). A pure manual fallback is the same behavior a match
    // with no hole data at all already gets.
    if (!Array.isArray(match.holesA) || !Array.isArray(match.holesB)) {
      return { front9: match.front9, back9: match.back9 };
    }
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
    // Same one-typo-away risk as matchStrokes() above -- a non-numeric
    // handicap here would otherwise produce NaN, which flows into
    // groupStrokes(NaN) as a NaN stroke array for the whole group (issue
    // #164). Callers already treat a null handicap as "not yet computable"
    // and fall back to zero strokes (see day2GroupHandicap() call sites).
    if (sorted.some(h => isNaN(h))) return null;
    const total = sorted.reduce((sum, h, i) => sum + h * pct[i], 0);
    return Math.round(total);
  }

  // National anthem house rule (issue #149, Day 2 only): +2 strokes to a
  // player's handicap if they didn't sing, -1 if they did -- folded into
  // that player's own handicap *before* it goes into scrambleTeamHandicap()
  // above, so it's applied per-player (per the confirmed scope) rather
  // than as a flat team-wide adjustment, and rides the same
  // lowest-handicap-first divisor logic unchanged. `sang` is `true`
  // (sang), `false` (didn't sing), or null/undefined (no adjustment).
  const ANTHEM_STROKE_ADJUSTMENT = { sang: -1, notSung: 2 };
  function anthemAdjustedHandicap(hcp, sang) {
    const n = parseFloat(hcp);
    if (sang === true) return n + ANTHEM_STROKE_ADJUSTMENT.sang;
    if (sang === false) return n + ANTHEM_STROKE_ADJUSTMENT.notSung;
    return n;
  }

  // Admin-entered handicap overrides (issue #206): players.js ships the
  // handicaps as of when the roster was built, but a real change (a card
  // submitted late, a data-entry fix) needs to reach every derived score
  // without a code deploy. `hcpOverrides` is state.hcp -- a sparse object
  // keyed by player id, synced the same way every other field is -- and
  // this is the one substitution point every match/scramble/Stableford
  // calculation reads players through, so a single override lookup here
  // reaches Day 1 match strokes, Day 2 scramble handicaps and Day 3
  // individual strokes alike rather than needing one at each call site.
  function playersWithOverrides(players, hcpOverrides) {
    if (!hcpOverrides) return players;
    return players.map(p => {
      const override = hcpOverrides[p.id];
      return (override === undefined || override === null || override === '') ? p : { ...p, hcp: override };
    });
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

  /* ── DAY 3 — AUTOMATIC HOLE-BY-HOLE STABLEFORD (issue #188) ──
     Pure and course-data-free, same spirit as #124's Day 1 and #128's
     Day 2 hole-by-hole functions. */
  const DAY3_HOLE_GROSS_MIN = 1, DAY3_HOLE_GROSS_MAX = 15;

  // Net Stableford points for one hole: 2 = net par, 3 = net birdie, one
  // stroke better per stroke under, one worse per stroke over, floored at
  // 0 (never negative). null gross (hole not played yet) -> null.
  function stablefordPoints(gross, par, strokes) {
    if (gross === null || gross === undefined) return null;
    return Math.max(0, 2 + par + strokes - gross);
  }

  // Points-per-hole array (nullable, one entry per hole) -- the input to
  // the sortable points-per-hole table (issue #188).
  function day3HolePoints(grossHoles, strokes, pars) {
    return grossHoles.map((g, i) => stablefordPoints(g, pars[i], strokes[i]));
  }

  // Running total + how many holes are actually in, summed over played
  // holes only -- unlike Day 2's net-to-par (which needs all 18 for a
  // meaningful "complete round" total, see scrambleRoundComplete()),
  // Stableford points are inherently additive per hole, so a live
  // leaderboard mid-round ("23 points thru 11") needs no completeness
  // gate at all (confirmed scope for #188).
  function day3PointsThru(grossHoles, strokes, pars) {
    const points = day3HolePoints(grossHoles, strokes, pars);
    let total = 0, played = 0;
    points.forEach(p => { if (p !== null) { total += p; played++; } });
    return { total, played };
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

  /* ── SEASON TOTALS (issue #203) ──
     scorecard-live.html computes Day 1/2/3 team points from a chain of
     small glue functions (which player has which handicap, what a
     match's/scramble group's *effective* result is once hole-by-hole
     data exists) that used to live only as page-local functions closing
     over globals (PLAYERS, COURSES, state). index.html needs the exact
     same numbers for its live-score ribbon -- duplicating that glue a
     second time would leave two copies of tournament scoring logic that
     could silently drift apart. Parameterized here instead (players/
     courses/teamA/teamB all passed in, nothing read from a global) so
     both pages call the same functions; scorecard-live.html's own
     day1StrokeIndexes()/matchStrokesFor()/effectiveMatch()/
     day2CourseHoles()/day2GroupHandicap()/effectiveDay2Field()/
     effectiveDay2State()/ntpPointsFor() are now thin wrappers around
     these. */

  function day1StrokeIndexesFor(courses) {
    const course = courses && courses[1];
    return course ? course.holes.map(h => h.si) : Array.from({ length: 18 }, (_, i) => i + 1);
  }

  // Murray Course par/stroke index per hole, same degrade-gracefully
  // fallback as day1StrokeIndexesFor() (issue #250 — needed to mark up
  // entered gross scores with a birdie/bogey symbol against par).
  function day1CourseHolesFor(courses) {
    const course = courses && courses[1];
    return course ? course.holes : Array.from({ length: 18 }, (_, i) => ({ par: 4, si: i + 1 }));
  }

  // Traditional golf leaderboard marking for one hole's entered gross score
  // relative to par — circle marks (birdie/eagle) for under par, square
  // marks (bogey/double-bogey-or-worse) for over par, none for par itself.
  // Pure and course-agnostic (par is passed in) so it works for both Day 1
  // (Murray) and Day 2 (Black Bull) grids (issue #250).
  function scoreToParSymbol(gross, par) {
    if (gross === null || gross === undefined || par === null || par === undefined) return null;
    const rel = gross - par;
    if (rel <= -2) return 'eagle';
    if (rel === -1) return 'birdie';
    if (rel === 0) return 'par';
    if (rel === 1) return 'bogey';
    return 'double-bogey';
  }

  /* ── UNDO TOAST SCORE REACTIONS (issue #228) ──
     A one-glance emoji reaction to a just-entered score, shown on the
     undo toast alongside the existing "what changed" text. Two buckets,
     since the two scoring models aren't comparable: net-to-par for
     Day 1/Day 2 hole-by-hole entry (where a real par + handicap-stroke
     allocation exists per hole), and the manual 18-hole Stableford total
     for Day 3 (points-based, no per-hole granularity yet -- see #188). */
  const REACTION_EMOJI = { great: '🎉', ok: '🙂', bad: '😥' };

  // net-to-par = (gross - strokes received) - par. `great` = net birdie or
  // better, `ok` = net par or net bogey, `bad` = net double-bogey or
  // worse. null gross (no score entered) -> no reaction.
  function holeScoreReaction(gross, par, strokes) {
    if (gross === null || gross === undefined) return null;
    const netToPar = (gross - (strokes || 0)) - par;
    if (netToPar <= -1) return 'great';
    if (netToPar <= 1) return 'ok';
    return 'bad';
  }

  // Buckets around the standard 36-point "played to handicap" baseline --
  // organiser-confirmed cut lines (see issue #228): bad < 32, ok 32-39,
  // great >= 40. null/blank/non-numeric total -> no reaction.
  function stablefordTotalReaction(total) {
    if (total === null || total === undefined || total === '') return null;
    const n = typeof total === 'number' ? total : parseInt(total, 10);
    if (isNaN(n)) return null;
    if (n >= 40) return 'great';
    if (n >= 32) return 'ok';
    return 'bad';
  }

  function matchStrokesForPlayers(match, players, day1StrokeIndexes) {
    const pA = players.find(p => p.id === match.pA[0]);
    const pB = players.find(p => p.id === match.pB[0]);
    if (!pA || !pB) return { receiver: null, a: Array(18).fill(0), b: Array(18).fill(0) };
    return matchStrokes(pA.hcp, pB.hcp, day1StrokeIndexes);
  }

  function effectiveMatchFor(match, players, day1StrokeIndexes) {
    const eff = effectiveNines(match, matchStrokesForPlayers(match, players, day1StrokeIndexes));
    return { front9: eff.front9, back9: eff.back9 };
  }

  function teamOfSets(playerId, teamA, teamB) {
    if (playerId === null || playerId === undefined) return null;
    if (teamA && teamA.has(playerId)) return 'A';
    if (teamB && teamB.has(playerId)) return 'B';
    return null;
  }

  function ntpPointsFor(ntpState, holeKeys, teamA, teamB) {
    return ntpTeamPoints(holeKeys.map(k => teamOfSets(ntpState[k], teamA, teamB)));
  }

  function day2CourseHolesFor(courses) {
    const course = courses && courses[2];
    return course ? course.holes : Array.from({ length: 18 }, (_, i) => ({ par: 4, si: i + 1 }));
  }

  // Lake Course par/stroke index per hole, same degrade-gracefully
  // fallback as day1CourseHolesFor()/day2CourseHolesFor() (issue #188).
  function day3CourseHolesFor(courses) {
    const course = courses && courses[3];
    return course ? course.holes : Array.from({ length: 18 }, (_, i) => ({ par: 4, si: i + 1 }));
  }

  function day2GroupHandicapFor(code, day2, players) {
    const ids = day2.groups[code];
    const anthem = day2.anthem || {};
    const hcps = ids.map(id => {
      const p = players.find(p => p.id === id);
      return p === undefined ? undefined : anthemAdjustedHandicap(p.hcp, anthem[id]);
    }).filter(h => h !== undefined);
    if (hcps.length !== ids.length) return null; // stale id no longer a real player
    return scrambleTeamHandicap(hcps);
  }

  function effectiveDay2FieldFor(code, day2, players, courses) {
    const holes = day2.holes[code];
    if (!holes.some(h => h !== null)) return day2[code];
    if (!scrambleRoundComplete(holes)) return null;
    const handicap = day2GroupHandicapFor(code, day2, players);
    if (handicap === null) return null;
    const courseHoles = day2CourseHolesFor(courses);
    const strokes = groupStrokes(handicap, courseHoles.map(h => h.si));
    const { netToPar } = scrambleNetToParThru(holes, strokes, courseHoles.map(h => h.par));
    return netToPar === null ? null : String(netToPar);
  }

  function effectiveDay2StateFor(day2, players, courses) {
    return {
      a4: effectiveDay2FieldFor('a4', day2, players, courses),
      a3: effectiveDay2FieldFor('a3', day2, players, courses),
      b4: effectiveDay2FieldFor('b4', day2, players, courses),
      b3: effectiveDay2FieldFor('b3', day2, players, courses)
    };
  }

  // The value that actually feeds computeStableford()/sumStablefordPoints()
  // for this player (issue #188): derived from hole-by-hole entry as soon
  // as any hole has a score -- a live points-thru-N total, no completeness
  // gate needed (see day3PointsThru()) -- otherwise the manual 18-hole
  // total exactly as before. Same precedence shape as
  // effectiveNines()/effectiveDay2FieldFor(): hole data wins once any
  // exists, manual is only ever read as the no-hole-data fallback.
  function effectiveDay3ScoreFor(playerId, day3, players, courses) {
    const holes = (day3.holes || {})[playerId];
    if (!Array.isArray(holes) || !holes.some(h => h !== null)) {
      return parseScoreToPar(day3.scores[playerId]);
    }
    const player = players.find(p => p.id === playerId);
    if (!player) return null;
    const hcp = Math.round(parseFloat(player.hcp));
    if (isNaN(hcp)) return null;
    const courseHoles = day3CourseHolesFor(courses);
    const strokes = groupStrokes(hcp, courseHoles.map(h => h.si));
    const pars = courseHoles.map(h => h.par);
    return day3PointsThru(holes, strokes, pars).total;
  }

  // The one function index.html actually calls: replayed `state` (see
  // normalizeState/applyUpdateToState) plus the static players/courses
  // data in, every day's points and the running total out.
  function computeSeasonTotals(state, players, courses) {
    const day1SI = day1StrokeIndexesFor(courses);
    const day1Base = sumMatchPoints(state.day1.matches.map(m => effectiveMatchFor(m, players, day1SI)));
    const day1Ntp = ntpPointsFor(state.day1.ntp, ['h8', 'h17'], state.teamA, state.teamB);
    const day1 = { a: day1Base.a + day1Ntp.a, b: day1Base.b + day1Ntp.b, base: day1Base, ntp: day1Ntp };

    const day2Scramble = calcDay2(effectiveDay2StateFor(state.day2, players, courses));
    const day2Ntp = ntpPointsFor(state.day2.ntp, ['h4', 'h16'], state.teamA, state.teamB);
    const day2 = { a: day2Scramble.a + day2Ntp.a, b: day2Scramble.b + day2Ntp.b, scramble: day2Scramble, ntp: day2Ntp };

    const day3Entries = players.map(p => ({
      id: p.id,
      hcp: p.hcp,
      team: teamOfSets(p.id, state.teamA, state.teamB),
      score: effectiveDay3ScoreFor(p.id, state.day3, players, courses)
    }));
    const day3Sorted = computeStableford(day3Entries);
    const day3Base = sumStablefordPoints(day3Sorted);
    const day3Ntp = ntpPointsFor(state.day3.ntp, ['h7', 'h14'], state.teamA, state.teamB);
    const day3 = { a: day3Base.a + day3Ntp.a, b: day3Base.b + day3Ntp.b, base: day3Base, ntp: day3Ntp };

    return {
      totalA: day1.a + day2.a + day3.a,
      totalB: day1.b + day2.b + day3.b,
      day1, day2, day3
    };
  }

  /* ── HOMEPAGE PHASE (issue #203) ──
     Which of countdown/live/final index.html's ribbon should show, from
     a Melbourne-local calendar date -- pure so it's unit-testable
     without mocking Date/timezone at the environment level. Reuses the
     same TOURNAMENT_DAY_DATES lookup defaultDay() already keys off. */
  function phaseFor(date) {
    if (defaultDay(date) !== null) return 'live';
    const melbourneDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    return melbourneDate < '2026-08-07' ? 'countdown' : 'final';
  }

  // Whole calendar days from `date` (Melbourne-local) until Day 1 --
  // diffs two Y-M-D calendar dates as UTC midnights specifically to stay
  // clear of DST/offset arithmetic entirely (Melbourne is UTC+10 in
  // August, but this file must not assume that holds on the date the
  // countdown is actually being read).
  function daysUntilDay1(date) {
    const melbourneToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
    const todayUTC = Date.parse(melbourneToday + 'T00:00:00Z');
    const targetUTC = Date.parse('2026-08-07T00:00:00Z');
    return Math.ceil((targetUTC - todayUTC) / 86400000);
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
  // Handicap index bounds (issue #206) -- 0 covers a scratch player, 54 is
  // the WHS maximum, wide enough to never reject a real card while still
  // catching a fat-fingered admin entry (e.g. "190" instead of "19.0").
  const HCP_MIN = 0, HCP_MAX = 54;

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
    team_assign:['A', 'B'],
    day_lock:   ['day1', 'day2', 'day3']
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
          const id = parseIntOrNull(v);
          // Issue #147: the app's own UI only disables a player already
          // used in another match against *this device's* current state --
          // two devices independently assigning the same not-yet-used
          // player to two different matches at nearly the same time both
          // succeed, since they write to different (match_idx, field_key)
          // keys with nothing to conflict. Evicting the player from any
          // other match here (rather than only in the UI) is a pure
          // function of the ordered update stream, so every device
          // converges on the same result without an extra write: whichever
          // assignment is LATEST in log order wins, and the earlier one
          // -- plus any result already recorded against it, same fields
          // setMatchPlayer() clears on a manual reassignment -- is undone.
          if (id !== null) {
            state.day1.matches.forEach((other, oi) => {
              if (oi === row.match_idx) return;
              ['pA', 'pB'].forEach(side => {
                if (other[side][0] === id) {
                  other[side][0] = null;
                  other.front9 = null;
                  other.back9 = null;
                  other.holesA = Array(18).fill(null);
                  other.holesB = Array(18).fill(null);
                }
              });
            });
          }
          (row.field_key === 'pA' ? match.pA : match.pB)[0] = id;
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
      case 'day2_anthem': {
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        if (!state.day2.anthem) break;
        if (v === 'true') state.day2.anthem[row.player_id] = true;
        else if (v === 'false') state.day2.anthem[row.player_id] = false;
        else delete state.day2.anthem[row.player_id];
        break;
      }
      case 'day3_stableford': {
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        const n = parseIntOrNull(v);
        state.day3.scores[row.player_id] = n === null ? null : String(Math.max(DAY3_SCORE_MIN, Math.min(DAY3_SCORE_MAX, n)));
        break;
      }
      case 'day3_hole': {
        // Addressed by the native player_id column (like day3_stableford
        // above) plus field_key 'h1'..'h18' -- not a fixed whitelist, so
        // the hole number is validated here via pattern + range.
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        const m = /^h(\d{1,2})$/.exec(row.field_key || '');
        if (!m) break;
        const holeNum = parseInt(m[1], 10);
        if (holeNum < 1 || holeNum > 18) break;
        if (!state.day3.holes) state.day3.holes = {};
        if (!Array.isArray(state.day3.holes[row.player_id])) state.day3.holes[row.player_id] = Array(18).fill(null);
        const n = parseIntOrNull(v);
        state.day3.holes[row.player_id][holeNum - 1] = n === null ? null : Math.max(DAY3_HOLE_GROSS_MIN, Math.min(DAY3_HOLE_GROSS_MAX, n));
        break;
      }
      case 'day3_ntp':
        if (row.field_key) state.day3.ntp[row.field_key] = parseIntOrNull(v);
        break;
      case 'player_hcp': {
        // An admin-entered override on top of the players.js default
        // (issue #206) -- read via playersWithOverrides() at every call
        // site that used to pass the raw roster straight into a
        // handicap-dependent calculation. Clearing (empty/unparseable
        // value) removes the override entirely, reverting to the shipped
        // default rather than storing an empty string as if it were one.
        if (typeof row.player_id !== 'number' || row.player_id < 0 || row.player_id >= 14) break;
        if (!state.hcp) state.hcp = {};
        const n = parseFloat(v);
        if (isNaN(n)) delete state.hcp[row.player_id];
        else state.hcp[row.player_id] = String(Math.max(HCP_MIN, Math.min(HCP_MAX, n)));
        break;
      }
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
      case 'day_lock':
        // field_key is the day itself ('day1'/'day2'/'day3', whitelisted
        // above), so this indexes straight into state rather than a nested
        // field the way every other update_type does.
        if (row.field_key && state[row.field_key]) state[row.field_key].locked = v === 'true';
        break;
    }
  }

  /* ── ADMIN: FIELD HISTORY + RESTORE (issues #129, #132) ──
     One descriptor per update_type drives both the Admin history picker's
     addressing (which selector(s) a field needs: a match, a player, a
     fixed field_key, or none) and whether a row of that type is
     restorable -- a new update_type (like day1_hole/day2_hole/day2_group
     above) gets history + restore support by adding one entry here, not
     new picker UI. `team_assign` is deliberately excluded: it's a legacy
     whole-roster snapshot, and re-imposing one over later per-player
     deltas is exactly the corruption pattern issue #71 was about --
     restoring team membership goes through individual player_team rows. */
  const UPDATE_TYPE_DESCRIPTORS = {
    day1_match:      { label: 'Day 1 — Match Result / Player',  addressing: 'match+field', fieldKeys: ['pA', 'pB', 'front9', 'back9'], restorable: true },
    day1_hole:       { label: 'Day 1 — Hole Score',              addressing: 'match+hole',  restorable: true },
    day1_ntp:        { label: 'Day 1 — Nearest the Pin',         addressing: 'field',       fieldKeys: ['h8', 'h17'], restorable: true },
    day2_score:      { label: 'Day 2 — Group Net Score (manual)', addressing: 'field',      fieldKeys: ['a4', 'a3', 'b4', 'b3'], restorable: true },
    day2_hole:       { label: 'Day 2 — Hole Score',              addressing: 'group+hole',  restorable: true },
    day2_group:      { label: 'Day 2 — Group Assignment',        addressing: 'player',      restorable: true },
    day2_ntp:        { label: 'Day 2 — Nearest the Pin',         addressing: 'field',       fieldKeys: ['h4', 'h16'], restorable: true },
    day2_anthem:     { label: 'Day 2 — National Anthem',         addressing: 'player',      restorable: true },
    day3_stableford: { label: 'Day 3 — Stableford Score (manual)', addressing: 'player',     restorable: true },
    day3_hole:       { label: 'Day 3 — Hole Score',              addressing: 'player+hole', restorable: true },
    day3_ntp:        { label: 'Day 3 — Nearest the Pin',         addressing: 'field',       fieldKeys: ['h7', 'h14'], restorable: true },
    tiebreak:        { label: 'Tiebreak',                        addressing: 'none',        restorable: true },
    team_name:       { label: 'Team Name',                       addressing: 'field',       fieldKeys: ['A', 'B'], restorable: true },
    team_assign:     { label: 'Team Roster (legacy snapshot)',   addressing: 'field',       fieldKeys: ['A', 'B'], restorable: false },
    player_team:     { label: 'Player Team Assignment',          addressing: 'player',      restorable: true, cascadeWarning: 'May also clear Day 1 match assignments for this player.' },
    player_hcp:      { label: 'Player Handicap (override)',      addressing: 'player',      restorable: true, cascadeWarning: 'Retroactively changes every derived match/scramble/Stableford score for this player.' },
    day_lock:        { label: 'Day Lock',                        addressing: 'field',       fieldKeys: ['day1', 'day2', 'day3'], restorable: true }
  };

  // Decodes one tournament_updates row into human-readable {fieldLabel,
  // valueLabel} -- the read-side mirror of applyUpdateToState(), which is
  // why it lives here rather than inline in the page (issue #129). Returns
  // raw (unescaped) strings, same convention as the rest of this module --
  // callers escape at render time, same as team names elsewhere.
  function describeUpdateRow(row, players, teamNames) {
    const v = row.value;
    const isCleared = v === null || v === undefined || v === 'null';
    const playerName = id => {
      const n = parseIntOrNull(id);
      if (n === null) return null;
      const p = (players || []).find(pp => pp.id === n);
      return p ? (p.short || p.name) : `Player #${n}`;
    };
    const teamName = code => {
      if (code === 'A') return (teamNames && teamNames.A) || 'Team A';
      if (code === 'B') return (teamNames && teamNames.B) || 'Team B';
      if (code === 'T') return 'Tie';
      return null;
    };
    switch (row.update_type) {
      case 'day1_match': {
        const matchLabel = Number.isInteger(row.match_idx) ? `Match ${row.match_idx + 1}` : 'Match ?';
        if (row.field_key === 'pA' || row.field_key === 'pB') {
          const side = row.field_key === 'pA' ? 'Team A slot' : 'Team B slot';
          return { fieldLabel: `${matchLabel} · ${side}`, valueLabel: isCleared ? '(cleared)' : (playerName(v) || String(v)) };
        }
        const half = row.field_key === 'front9' ? 'Front 9' : row.field_key === 'back9' ? 'Back 9' : (row.field_key || '?');
        return { fieldLabel: `${matchLabel} · ${half}`, valueLabel: isCleared ? '(cleared)' : (teamName(v) || String(v)) };
      }
      case 'day1_hole': {
        const matchLabel = Number.isInteger(row.match_idx) ? `Match ${row.match_idx + 1}` : 'Match ?';
        const m = /^([AB])(\d{1,2})$/.exec(row.field_key || '');
        const holeLabel = m ? `Hole ${m[2]} (Team ${m[1]} slot)` : (row.field_key || '?');
        return { fieldLabel: `${matchLabel} · ${holeLabel}`, valueLabel: isCleared ? '(cleared)' : String(v) };
      }
      case 'day1_ntp':
        return { fieldLabel: `Day 1 NTP · ${row.field_key || '?'}`, valueLabel: isCleared ? '(cleared)' : (playerName(v) || String(v)) };
      case 'day2_score':
        return { fieldLabel: `Day 2 · ${(row.field_key || '?').toUpperCase()} net to par`, valueLabel: isCleared ? '(cleared)' : String(v) };
      case 'day2_hole': {
        const m = /^(a4|a3|b4|b3)_(\d{1,2})$/.exec(row.field_key || '');
        return { fieldLabel: m ? `Day 2 · ${m[1].toUpperCase()} · Hole ${m[2]}` : `Day 2 hole · ${row.field_key || '?'}`, valueLabel: isCleared ? '(cleared)' : String(v) };
      }
      case 'day2_group':
        return { fieldLabel: `Day 2 Group · ${playerName(row.player_id) || `Player #${row.player_id}`}`, valueLabel: isCleared ? '(cleared)' : String(v).toUpperCase() };
      case 'day2_ntp':
        return { fieldLabel: `Day 2 NTP · ${row.field_key || '?'}`, valueLabel: isCleared ? '(cleared)' : (playerName(v) || String(v)) };
      case 'day2_anthem':
        return { fieldLabel: `Day 2 Anthem · ${playerName(row.player_id) || `Player #${row.player_id}`}`, valueLabel: isCleared ? '(cleared)' : (v === 'true' ? 'Sang (-1)' : v === 'false' ? "Didn't sing (+2)" : String(v)) };
      case 'day3_stableford':
        return { fieldLabel: `Day 3 Stableford · ${playerName(row.player_id) || `Player #${row.player_id}`}`, valueLabel: isCleared ? '(cleared)' : String(v) };
      case 'day3_hole': {
        const m = /^h(\d{1,2})$/.exec(row.field_key || '');
        const holeLabel = m ? `Hole ${m[1]}` : (row.field_key || '?');
        return { fieldLabel: `Day 3 · ${playerName(row.player_id) || `Player #${row.player_id}`} · ${holeLabel}`, valueLabel: isCleared ? '(cleared)' : String(v) };
      }
      case 'day3_ntp':
        return { fieldLabel: `Day 3 NTP · ${row.field_key || '?'}`, valueLabel: isCleared ? '(cleared)' : (playerName(v) || String(v)) };
      case 'tiebreak':
        return { fieldLabel: 'Tiebreak', valueLabel: isCleared ? '(cleared)' : (teamName(v) || String(v)) };
      case 'team_name':
        return { fieldLabel: `Team ${row.field_key || '?'} Name`, valueLabel: isCleared ? '(cleared)' : String(v) };
      case 'team_assign':
        return { fieldLabel: `Team ${row.field_key || '?'} Roster (legacy snapshot)`, valueLabel: isCleared ? '(cleared)' : String(v) };
      case 'player_team':
        return { fieldLabel: `Player Team · ${playerName(row.player_id) || `Player #${row.player_id}`}`, valueLabel: isCleared ? '(cleared)' : (teamName(v) || String(v)) };
      case 'player_hcp':
        return { fieldLabel: `Handicap · ${playerName(row.player_id) || `Player #${row.player_id}`}`, valueLabel: isCleared ? '(reverted to default)' : String(v) };
      case 'day_lock': {
        const dayLabel = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3' }[row.field_key] || row.field_key || '?';
        return { fieldLabel: `Day Lock · ${dayLabel}`, valueLabel: isCleared ? '(cleared)' : (v === 'true' ? 'Locked' : 'Unlocked') };
      }
      default:
        // An update_type this version of the app doesn't recognize (e.g. a
        // future type, or a forged row) must render *something* rather than
        // throw and break the whole history view -- same resilience
        // philosophy as processUpdateRows (issue #63).
        return { fieldLabel: `Unknown update type (${row.update_type})`, valueLabel: isCleared ? '(cleared)' : String(v) };
    }
  }

  // Whether a historic row can be restored -- team_assign is the one
  // deliberate exclusion (see UPDATE_TYPE_DESCRIPTORS comment above).
  // Unknown update_types are also non-restorable, since there's no
  // descriptor to trust.
  function isRestorable(updateType) {
    const d = UPDATE_TYPE_DESCRIPTORS[updateType];
    return !!d && d.restorable === true;
  }

  // Produces the insert payload to restore a historic row as a NEW row
  // (issue #132) -- copies the field's coordinates and value, but drops
  // identity/authorship (id, updated_at, updated_by) so the caller's
  // insertUpdate() gets a fresh timestamp and attributes the restore to
  // whoever is doing the restoring, not the row's original author.
  function buildRestoreRow(historicRow) {
    return {
      update_type: historicRow.update_type,
      match_idx: historicRow.match_idx ?? null,
      player_id: historicRow.player_id ?? null,
      field_key: historicRow.field_key ?? null,
      value: historicRow.value ?? null
    };
  }

  /* ── STATE HYGIENE (issue #166) ──
     Extracted from scorecard-live.html's loadState() with no behavior
     change -- runs on every page load against whatever's in localStorage,
     repairing a wrong-shaped or stale-format payload before anything else
     touches it. A crash here bricks the page at init, the exact failure
     class it exists to prevent, so it's the highest-value slice of the app
     to have under test. */
  function normalizeState(state) {
    // A saved/synced payload can have a day1/day2/day3 key present but shaped
    // wrong (e.g. `matches` missing or not an array) — the map/access logic
    // below assumes the current shape unconditionally, so guard it here
    // before anything else runs rather than let it throw and kill init.
    if (typeof state.day1 !== 'object' || state.day1 === null || !Array.isArray(state.day1.matches)) {
      state.day1 = { matches: [], ntp: { h8: null, h17: null }, locked: false };
    }
    if (typeof state.day2 !== 'object' || state.day2 === null) {
      state.day2 = {
        a4: null, a3: null, b4: null, b3: null, ntp: { h4: null, h16: null },
        groups: { a4: [], a3: [], b4: [], b3: [] },
        holes: { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) },
        locked: false
      };
    }
    if (typeof state.day3 !== 'object' || state.day3 === null) {
      state.day3 = { scores: {}, ntp: { h7: null, h14: null }, locked: false };
    }
    // Coerce every existing match into the current singles shape — a match
    // saved during the short-lived doubles-era format (type:'doubles',
    // 2-slot pA/pB) can otherwise survive indefinitely in a browser's cached
    // state, since this used to only pad new matches onto the end rather
    // than fixing up what was already there.
    // Pads/repairs a hole-scores array to exactly 18 entries so a
    // stale/malformed synced payload (missing holesA/holesB entirely, or an
    // array of the wrong length) can't crash the per-hole grid.
    function normalizedHoles(arr, min, max) {
      const lo = min === undefined ? DAY1_GROSS_MIN : min;
      const hi = max === undefined ? DAY1_GROSS_MAX : max;
      const out = Array(18).fill(null);
      if (Array.isArray(arr)) {
        for (let i = 0; i < 18; i++) {
          const n = parseIntOrNull(arr[i]);
          out[i] = n === null ? null : Math.max(lo, Math.min(hi, n));
        }
      }
      return out;
    }
    state.day1.matches = state.day1.matches.map(m => ({
      type: 'singles',
      pA: [ (m.pA && m.pA[0] !== undefined) ? m.pA[0] : null ],
      pB: [ (m.pB && m.pB[0] !== undefined) ? m.pB[0] : null ],
      front9: m.front9 ?? null,
      back9: m.back9 ?? null,
      holesA: normalizedHoles(m.holesA),
      holesB: normalizedHoles(m.holesB)
    }));
    while (state.day1.matches.length < 6) {
      state.day1.matches.push({ type:'singles', pA:[null], pB:[null], front9:null, back9:null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) });
    }
    if (!state.day1.ntp) state.day1.ntp = { h8:null, h17:null };
    if (!state.day2.ntp) state.day2.ntp = { h4:null, h16:null };
    if (state.day2.a2 !== undefined) { if (state.day2.a3 === undefined) state.day2.a3 = state.day2.a2; delete state.day2.a2; }
    if (state.day2.b2 !== undefined) { if (state.day2.b3 === undefined) state.day2.b3 = state.day2.b2; delete state.day2.b2; }
    // Group assignments/hole scores (issue #128) -- pad/repair the same way
    // holesA/holesB is above, so a stale/pre-#128 saved payload can't crash
    // the scramble grid.
    const GROUP_CODES = ['a4', 'a3', 'b4', 'b3'];
    if (typeof state.day2.groups !== 'object' || state.day2.groups === null) {
      state.day2.groups = { a4: [], a3: [], b4: [], b3: [] };
    } else {
      const seen = new Set();
      GROUP_CODES.forEach(code => {
        const raw = Array.isArray(state.day2.groups[code]) ? state.day2.groups[code] : [];
        // A player should never structurally belong to two groups at once --
        // first group (in a4/a3/b4/b3 order) wins, same self-heal philosophy
        // as dedupeTeams().
        state.day2.groups[code] = raw.filter(id => {
          const n = parseIntOrNull(id);
          if (n === null || seen.has(n)) return false;
          seen.add(n);
          return true;
        });
      });
    }
    if (typeof state.day2.holes !== 'object' || state.day2.holes === null) {
      state.day2.holes = { a4: Array(18).fill(null), a3: Array(18).fill(null), b4: Array(18).fill(null), b3: Array(18).fill(null) };
    } else {
      GROUP_CODES.forEach(code => { state.day2.holes[code] = normalizedHoles(state.day2.holes[code], DAY2_HOLE_GROSS_MIN, DAY2_HOLE_GROSS_MAX); });
    }
    // National anthem house rule (issue #149) -- a stale/malformed saved
    // payload could hold anything under an id key, so only true/false
    // survive; anything else is dropped rather than fed into the handicap
    // calc as a truthy/falsy accident.
    if (typeof state.day2.anthem !== 'object' || state.day2.anthem === null) {
      state.day2.anthem = {};
    } else {
      Object.keys(state.day2.anthem).forEach(id => {
        if (state.day2.anthem[id] !== true && state.day2.anthem[id] !== false) delete state.day2.anthem[id];
      });
    }
    if (!state.day3.scores) {
      const old = state.day3;
      state.day3 = { scores: old.scores || old || {}, ntp: old.ntp || { h7:null, h14:null } };
    }
    if (!state.day3.ntp) state.day3.ntp = { h7:null, h14:null };
    // Per-player hole-by-hole gross scores (issue #188) -- sparse object
    // keyed by player id (unlike Day 2's fixed a4/a3/b4/b3 keys, Day 3 has
    // up to 14 dynamic player ids), created lazily on first hole entry
    // rather than pre-populated for every player. Existing entries are
    // padded/repaired the same way normalizedHoles() already does for
    // Day 1/Day 2, so a stale/malformed synced payload can't crash the grid.
    if (typeof state.day3.holes !== 'object' || state.day3.holes === null) {
      state.day3.holes = {};
    } else {
      Object.keys(state.day3.holes).forEach(id => {
        state.day3.holes[id] = normalizedHoles(state.day3.holes[id], DAY3_HOLE_GROSS_MIN, DAY3_HOLE_GROSS_MAX);
      });
    }
    // Admin handicap overrides (issue #206) -- sparse object keyed by
    // player id, same shape/repair philosophy as day2.anthem above: only a
    // value parseFloat() can actually use survives, anything else (a
    // stray object, NaN string, etc.) is dropped rather than silently
    // corrupting every downstream stroke calculation.
    if (typeof state.hcp !== 'object' || state.hcp === null) {
      state.hcp = {};
    } else {
      Object.keys(state.hcp).forEach(id => {
        if (isNaN(parseFloat(state.hcp[id]))) delete state.hcp[id];
      });
    }
    // Lock flags (issue #168) -- only `true` survives a stale/forged saved or
    // synced payload; anything else (missing, a string, etc.) normalizes to
    // unlocked rather than accidentally locking a day out from under everyone.
    state.day1.locked = state.day1.locked === true;
    state.day2.locked = state.day2.locked === true;
    state.day3.locked = state.day3.locked === true;
    return state;
  }

  /* ── OFFLINE RETRY QUEUE (issue #66, extracted for #166) ──
     The queue-walking core of scorecard-live.html's flushPendingWrites():
     send everything in `queue` via `sendFn`, oldest-first, keeping
     whatever fails for the next pass. `sendFn` must resolve to
     'ok' | 'auth' | 'network' -- the same three-way contract
     sendUpdateRow() already has (issue #141), not a plain boolean: an
     'auth' result stops the pass immediately and requeues every remaining
     item unretried (re-trying a token the server just told us is wrong is
     pointless), while a 'network' failure only requeues that one item and
     the loop continues. `sendFn` must not throw -- sendUpdateRow() already
     catches internally and resolves 'network' rather than rejecting; a
     throwing sendFn would abort the loop and lose every item after it. */
  async function flushQueue(queue, sendFn) {
    const stillPending = [];
    for (let i = 0; i < queue.length; i++) {
      const w = queue[i];
      const result = await sendFn(w);
      if (result === 'auth') {
        stillPending.push(...queue.slice(i));
        break;
      }
      if (result === 'network') stillPending.push(w);
    }
    return stillPending;
  }

  return {
    escapeHtml,
    defaultDay,
    ninePoints, matchPoints, sumMatchPoints,
    DAY1_GROSS_MIN, DAY1_GROSS_MAX,
    matchStrokes, holeResult, nineFromHoles, nineStatus, effectiveNines,
    ntpTeamPoints,
    parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2, day2InputState,
    DAY2_HOLE_GROSS_MIN, DAY2_HOLE_GROSS_MAX,
    SCRAMBLE_HANDICAP_PCT, scrambleTeamHandicap, groupStrokes,
    ANTHEM_STROKE_ADJUSTMENT, anthemAdjustedHandicap, HCP_MIN, HCP_MAX, playersWithOverrides,
    scrambleNetToParThru, scrambleRoundComplete, applyPlayerGroupMove,
    POS_PTS, computeStableford, sumStablefordPoints,
    DAY3_HOLE_GROSS_MIN, DAY3_HOLE_GROSS_MAX, stablefordPoints, day3HolePoints, day3PointsThru,
    resolveOverallWinner,
    day1StrokeIndexesFor, day1CourseHolesFor, matchStrokesForPlayers, effectiveMatchFor,
    teamOfSets, ntpPointsFor, scoreToParSymbol,
    REACTION_EMOJI, holeScoreReaction, stablefordTotalReaction,
    day2CourseHolesFor, day2GroupHandicapFor, effectiveDay2FieldFor, effectiveDay2StateFor,
    day3CourseHolesFor, effectiveDay3ScoreFor,
    computeSeasonTotals, phaseFor, daysUntilDay1,
    applyPlayerTeamMove, dedupeTeams, reconcileMatchesAfterTeamMove, processUpdateRows,
    parseIntOrNull, applyUpdateToState,
    UPDATE_TYPE_DESCRIPTORS, describeUpdateRow, isRestorable, buildRestoreRow,
    normalizeState, flushQueue
  };
});
