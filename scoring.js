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

  // National anthem house rule (issue #149, Day 2 only; mechanism revised
  // per issue report -- was previously folded into the player's handicap,
  // see git history): +2 strokes added directly to a player's scramble
  // group's final score if they didn't sing, -1 if they did. Summed per
  // player across the whole group (per the confirmed "individual, not
  // team-wide" scope) and applied to the group's net-to-par *after*
  // handicap strokes are allocated, so it's a straightforward score
  // penalty/bonus rather than something that reshapes how strokes get
  // divided up via scrambleTeamHandicap()/groupStrokes(). `sang` is `true`
  // (sang), `false` (didn't sing), or null/undefined (no adjustment).
  const ANTHEM_STROKE_ADJUSTMENT = { sang: -1, notSung: 2 };
  function day2AnthemStrokesFor(code, day2) {
    const ids = (day2.groups && day2.groups[code]) || [];
    const anthem = day2.anthem || {};
    return ids.reduce((sum, id) => {
      if (anthem[id] === true) return sum + ANTHEM_STROKE_ADJUSTMENT.sang;
      if (anthem[id] === false) return sum + ANTHEM_STROKE_ADJUSTMENT.notSung;
      return sum;
    }, 0);
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

  // Which player id represents `sideArr` for a given nine. A plain singles
  // side (or the lone-player side of a Captain's Challenge match) is just
  // sideArr[0], used for both nines -- unchanged from before #256. Only the
  // challenge match's designated 2-opponent side reads a different id for
  // the back nine (sideArr[1], its 2nd slot) when one has actually been
  // assigned; falls back to sideArr[0] until it has, so a challenge side
  // with only its front9 opponent picked still resolves sensibly rather
  // than facing a null pairing on the back 9.
  function nineOpponentId(sideArr, isDoubleSide, isBack) {
    if (!Array.isArray(sideArr)) return null;
    if (isDoubleSide && isBack && sideArr[1] !== null && sideArr[1] !== undefined) return sideArr[1];
    return sideArr[0] !== undefined ? sideArr[0] : null;
  }

  // Handicap strokes for one match. Computed independently per nine (issue
  // #256) rather than once across all 18 holes -- for an ordinary singles
  // match this is mathematically identical to the old single 18-hole call
  // (matchStrokes() is a pure per-element map over whichever stroke-index
  // array it's given; splitting the same hcp pair's computation into two 9-
  // element slices and concatenating produces the same 18 values either
  // way, pinned by an equivalence test in test/scoring.test.mjs). It's only
  // for a Captain's Challenge match -- one side facing a different opponent
  // each nine -- that the two nines can actually differ, since each is then
  // its own handicap-difference computation against that nine's specific
  // opponent.
  function matchStrokesForPlayers(match, players, day1StrokeIndexes) {
    const isChallenge = match.type === 'challenge';
    const aIsDouble = isChallenge && match.challengeSide === 'A';
    const bIsDouble = isChallenge && match.challengeSide === 'B';
    const frontSI = day1StrokeIndexes.slice(0, 9);
    const backSI = day1StrokeIndexes.slice(9, 18);
    function nineStrokes(isBack, si) {
      const pA = players.find(p => p.id === nineOpponentId(match.pA, aIsDouble, isBack));
      const pB = players.find(p => p.id === nineOpponentId(match.pB, bIsDouble, isBack));
      if (!pA || !pB) return { receiver: null, a: Array(si.length).fill(0), b: Array(si.length).fill(0) };
      return matchStrokes(pA.hcp, pB.hcp, si);
    }
    const front = nineStrokes(false, frontSI);
    const back = nineStrokes(true, backSI);
    // Both nines agree on a receiver for any ordinary singles match (same
    // pairing both nines, by construction) -- only a genuine Captain's
    // Challenge pairing with different opponents per nine can disagree, in
    // which case there's no single well-defined receiver to report.
    const receiver = front.receiver === back.receiver ? front.receiver : null;
    return { receiver, a: [...front.a, ...back.a], b: [...front.b, ...back.b] };
  }

  function effectiveMatchFor(match, players, day1StrokeIndexes) {
    const eff = effectiveNines(match, matchStrokesForPlayers(match, players, day1StrokeIndexes));
    return { front9: eff.front9, back9: eff.back9 };
  }

  // Cumulative hole-by-hole lead sequence for the "worm" chart on a
  // completed match (issue #270), kept separate per nine -- front 9 and
  // back 9 are each their own 1pt contest (matchPoints()/ninePoints()), so
  // a lead built up on the front 9 has no bearing on the back 9 and must
  // not carry over into it. One entry per hole that actually has data (a
  // hole with no score yet is skipped rather than padded, since this is
  // only ever rendered once a match is already decided, at which point any
  // remaining hole is moot anyway). +1 per hole A wins, -1 per hole B
  // wins, unchanged on a halve, reset to 0 at the start of each nine.
  // Returns null when the match has no hole-by-hole data at all (decided
  // only via the manual front9/back9 toggle) -- same "hole data or
  // nothing" precedent as effectiveNines(); otherwise {front9, back9},
  // either of which can itself be an empty array if that nine has no data
  // yet.
  function matchWormFor(match, players, day1StrokeIndexes) {
    if (!Array.isArray(match.holesA) || !Array.isArray(match.holesB)) return null;
    const hasData = match.holesA.some(v => v !== null) || match.holesB.some(v => v !== null);
    if (!hasData) return null;
    const strokes = matchStrokesForPlayers(match, players, day1StrokeIndexes);
    function nineWorm(start) {
      let cum = 0;
      const points = [];
      for (let i = start; i < start + 9; i++) {
        const result = holeResult(match.holesA[i], match.holesB[i], strokes.a[i], strokes.b[i]);
        if (result === null) continue;
        if (result === 'A') cum += 1;
        else if (result === 'B') cum -= 1;
        points.push(cum);
      }
      return points;
    }
    return { front9: nineWorm(0), back9: nineWorm(9) };
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
    const hcps = ids.map(id => {
      const p = players.find(p => p.id === id);
      return p === undefined ? undefined : p.hcp;
    }).filter(h => h !== undefined);
    if (hcps.length !== ids.length) return null; // stale id no longer a real player
    return scrambleTeamHandicap(hcps);
  }

  // National anthem strokes (see day2AnthemStrokesFor above) are added to
  // the group's score here -- on both the manual and hole-derived paths,
  // so the house rule takes effect the same way regardless of which entry
  // method a group happens to be using.
  function effectiveDay2FieldFor(code, day2, players, courses) {
    const holes = day2.holes[code];
    const anthemStrokes = day2AnthemStrokesFor(code, day2);
    if (!holes.some(h => h !== null)) {
      const manual = parseScoreToPar(day2[code]);
      return manual === null ? day2[code] : String(manual + anthemStrokes);
    }
    if (!scrambleRoundComplete(holes)) return null;
    const handicap = day2GroupHandicapFor(code, day2, players);
    if (handicap === null) return null;
    const courseHoles = day2CourseHolesFor(courses);
    const strokes = groupStrokes(handicap, courseHoles.map(h => h.si));
    const { netToPar } = scrambleNetToParThru(holes, strokes, courseHoles.map(h => h.par));
    return netToPar === null ? null : String(netToPar + anthemStrokes);
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

  /* ── WEEKEND WORM (issue #299) ──
     Same "worm" idea as matchWormFor() above (issue #270), but for the
     whole tournament rather than one match: replays the full,
     already-synced tournament_updates log through applyUpdateToState()
     into a scratch state (never the live page state), calling
     computeSeasonTotals() after each row to get the team-point
     differential (totalA - totalB) at that point in the weekend.
     Purely derived from data already synced -- no new writes, no new
     schema, no sync changes -- and it's the exact same
     applyUpdateToState()/computeSeasonTotals() driving the live
     scoreboard, so the worm can never disagree with it. `rows` doesn't
     need to arrive pre-sorted -- lastRowPerField() below always
     re-derives replay order from each surviving row's own updated_at.

     Only records a new point when the differential actually changes --
     most rows (an in-progress hole score, a Day 2 group assignment)
     don't move a team's total until a nine/match/scramble round/NTP hole
     resolves, so recording every single row would mostly repeat the same
     value with nothing to show for it.

     `initialTeams` seeds the scratch replay's starting teamA/teamB --
     normalizeState() has no opinion on team membership (only on
     day1/day2/day3 shape), so the pre-draft default roster must be
     passed in by the caller rather than assumed here.

     Returns null when there's nothing to draw: no rows at all, or the
     differential never once left 0 -- same "hole data or nothing"
     precedent as matchWormFor().

     A row that throws when applied (e.g. a malformed/legacy `team_assign`
     value JSON.parse() can't handle) is skipped rather than left to abort
     the whole replay -- same "a single malformed row must never wedge
     everything" tolerance processUpdateRows() already gives the real
     sync path (issue #63). Unlike processUpdateRows(), this can't just
     hand the batch to that helper: it needs a differential snapshot
     after every row, succeeded or not, so the try/catch is inline here
     instead.

     Before any of that, `rows` is collapsed via lastRowPerField() to just
     the LAST write ever made to each distinct field -- a scorer's
     typo-then-correction (or an admin's Field History restore) otherwise
     shows up as a spurious extra step in the worm right at the moment of
     the mistake, immediately followed by another step undoing it once
     it's fixed. Crediting only each field's real final value, at the
     time it was actually last set (not first, possibly wrongly,
     entered), keeps the worm reading as the tournament's true
     progression rather than a replay of every keystroke. */
  // Coordinate identity mirrors undoCoordKey()/describeUpdateRow() in
  // scorecard-live.html -- same (update_type, match_idx, player_id,
  // field_key) tuple those already use to mean "the same field".
  function lastRowPerField(rows) {
    const latest = new Map();
    rows.forEach(row => {
      const key = [row.update_type, row.match_idx ?? '', row.player_id ?? '', row.field_key ?? ''].join('|');
      const existing = latest.get(key);
      if (!existing || row.updated_at > existing.updated_at) latest.set(key, row);
    });
    return [...latest.values()].sort((a, b) => a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0);
  }

  function weekendWormFor(rows, players, courses, initialTeams) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const state = normalizeState({
      teamA: new Set((initialTeams && initialTeams.teamA) || []),
      teamB: new Set((initialTeams && initialTeams.teamB) || [])
    });
    const series = [];
    let last = 0;
    lastRowPerField(rows).forEach(row => {
      try { applyUpdateToState(state, row); } catch { /* malformed row, skip it */ }
      const totals = computeSeasonTotals(state, players, courses);
      const diff = totals.totalA - totals.totalB;
      if (diff !== last) {
        series.push(diff);
        last = diff;
      }
    });
    return series.length > 0 ? series : null;
  }

  /* ── PROJECTED "IF IT ENDED RIGHT NOW" (issue #260) ──
     The real scoreboard only counts a match/round once it's decided or
     complete -- an in-progress result contributes nothing until then,
     so mid-round the total can look artificially low even when the
     outcome is obvious from the hole-by-hole grid one tap away. These
     compute a SEPARATE projection from the exact same nineStatus()/
     scrambleNetToParThru() progress data already shown elsewhere.
     Never called by the real scoring path (matchPoints()/
     day2GroupPoints()/calcDay1()/calcDay2() themselves are untouched
     by any of this), and a fully-decided/complete input always
     projects to exactly its real score -- nothing here can override a
     finished result, only fill in a not-yet-finished one. Day 3 has no
     per-hole entry yet (blocked on issue #188), so nothing to project
     there; NTP points are real-or-nothing regardless (a hole either has
     a recorded winner or it doesn't -- no "in progress" state), so
     they're included unprojected, same as the real total. */

  // One nine's provisional points from its current tally, regardless of
  // whether nineFromHoles() would call it "decided" -- an untouched
  // nine (thru 0) has nothing to project and stays 0-0. A nine that IS
  // decided projects to exactly the same points ninePoints() would give
  // its real result, since nineStatus().leader agrees with
  // nineFromHoles().result once fully played or mathematically over.
  function projectedNinePoints(nineResults) {
    const s = nineStatus(nineResults);
    if (s.thru === 0) return { a: 0, b: 0 };
    if (s.leader === null) return { a: 0.5, b: 0.5 };
    return s.leader === 'A' ? { a: 1, b: 0 } : { a: 0, b: 1 };
  }

  // One match's projected points: a nine with any hole data at all
  // projects via projectedNinePoints() above; a nine with none falls
  // back to its manual front9/back9 value, the same fallback
  // effectiveNines() already uses for the real score.
  function projectedMatchPoints(match, strokes) {
    if (!Array.isArray(match.holesA) || !Array.isArray(match.holesB)) {
      return matchPoints({ front9: match.front9, back9: match.back9 });
    }
    function projectNine(start, manualVal) {
      const holesA = match.holesA.slice(start, start + 9);
      const holesB = match.holesB.slice(start, start + 9);
      const hasData = holesA.some(v => v !== null) || holesB.some(v => v !== null);
      if (!hasData) return ninePoints(manualVal);
      const strokesA = strokes.a.slice(start, start + 9);
      const strokesB = strokes.b.slice(start, start + 9);
      const results = holesA.map((g, i) => holeResult(g, holesB[i], strokesA[i], strokesB[i]));
      return projectedNinePoints(results);
    }
    const front = projectNine(0, match.front9);
    const back = projectNine(9, match.back9);
    return { a: front.a + back.a, b: front.b + back.b };
  }

  function projectedMatchPointsFor(match, players, day1StrokeIndexes) {
    return projectedMatchPoints(match, matchStrokesForPlayers(match, players, day1StrokeIndexes));
  }

  function sumProjectedMatchPoints(matches, players, day1StrokeIndexes) {
    let a = 0, b = 0;
    matches.forEach(match => {
      const pts = projectedMatchPointsFor(match, players, day1StrokeIndexes);
      a += pts.a; b += pts.b;
    });
    return { a, b };
  }

  // One Day 2 group's projected net-to-par: scrambleNetToParThru() over
  // whatever holes are entered so far, with no completeness gate
  // (unlike effectiveDay2FieldFor(), which returns null until all 18
  // are in) -- falls back to the manual value when no hole data exists
  // at all, same fallback effectiveDay2FieldFor() already uses.
  function projectedDay2Field(code, day2, players, courses) {
    const holes = day2.holes[code];
    const anthemStrokes = day2AnthemStrokesFor(code, day2);
    if (!holes.some(h => h !== null)) {
      const manual = parseScoreToPar(day2[code]);
      return manual === null ? null : manual + anthemStrokes;
    }
    const handicap = day2GroupHandicapFor(code, day2, players);
    if (handicap === null) return null;
    const courseHoles = day2CourseHolesFor(courses);
    const strokes = groupStrokes(handicap, courseHoles.map(h => h.si));
    const { netToPar } = scrambleNetToParThru(holes, strokes, courseHoles.map(h => h.par));
    return netToPar === null ? null : netToPar + anthemStrokes;
  }

  // Projected group differentials via the real day2GroupPoints()/
  // day2Bonus() (they don't care whether their inputs came from a
  // complete round or a thru-N projection) -- the bonus only projects
  // once every group has at least one hole's worth of signal, mirroring
  // calcDay2()'s own "complete" gate one level down.
  function projectedDay2Totals(day2, players, courses) {
    const a4 = projectedDay2Field('a4', day2, players, courses);
    const a3 = projectedDay2Field('a3', day2, players, courses);
    const b4 = projectedDay2Field('b4', day2, players, courses);
    const b3 = projectedDay2Field('b3', day2, players, courses);
    const four = day2GroupPoints(a4, b4);
    const three = day2GroupPoints(a3, b3);
    const allHaveSignal = a4 !== null && a3 !== null && b4 !== null && b3 !== null;
    const bonus = allHaveSignal ? day2Bonus(a4 + a3, b4 + b3) : { a: 0, b: 0 };
    return { a: four.a + three.a + bonus.a, b: four.b + three.b + bonus.b, four, three, bonus };
  }

  // The one function scorecard-live.html's UI actually calls for the
  // "if everything ended right now" line.
  function projectedTotals(state, players, courses) {
    const day1SI = day1StrokeIndexesFor(courses);
    const day1 = sumProjectedMatchPoints(state.day1.matches, players, day1SI);
    const day1Ntp = ntpPointsFor(state.day1.ntp, ['h8', 'h17'], state.teamA, state.teamB);
    const day2 = projectedDay2Totals(state.day2, players, courses);
    const day2Ntp = ntpPointsFor(state.day2.ntp, ['h4', 'h16'], state.teamA, state.teamB);
    return {
      totalA: day1.a + day1Ntp.a + day2.a + day2Ntp.a,
      totalB: day1.b + day1Ntp.b + day2.b + day2Ntp.b
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
      const slotArr = m[staleField] || [];
      // Issue #256: a Captain's Challenge match's 2-opponent side has 2
      // slots (front9/back9 opponent) instead of 1 -- check both, and only
      // null out the slot(s) that actually held this player, not the whole
      // side (a challenge match's OTHER opponent, in the slot this player
      // didn't occupy, is unaffected by this move).
      const staleSlots = [];
      slotArr.forEach((id, slot) => { if (id === playerId) staleSlots.push(slot); });
      if (staleSlots.length === 0) return m;
      staleSlots.forEach(slot => {
        changes.push({ matchIdx, field: slot === 1 ? `${staleField}2` : staleField, value: null });
      });
      if (m.front9 !== null) changes.push({ matchIdx, field: 'front9', value: null });
      if (m.back9 !== null) changes.push({ matchIdx, field: 'back9', value: null });
      const nextSlotArr = slotArr.map((id, slot) => staleSlots.includes(slot) ? null : id);
      const next = { ...m, [staleField]: nextSlotArr, front9: null, back9: null };
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
  // field_key (e.g. day2_score/'ntp', day1_match/'zz' or '__proto__')
  // must not be able to overwrite a differently-shaped part of state --
  // without this, such a row replaces a whole object with a string or
  // rewrites a match's shape instead of just one of its real fields
  // (issue #120). update_types without a field_key (day3_stableford,
  // player_team, tiebreak) have no entry here and are unaffected.
  //
  // 'pA2'/'pB2' and 'type'/'challengeSide' (issue #256) are the Captain's
  // Challenge fields: a match flipped to type:'challenge' gets a 2nd player
  // slot (pA2 or pB2, whichever side challengeSide names) for its "two
  // opponents" side -- the lone player's own slot is still just pA/pB, used
  // for both nines same as any singles match. These carry exactly the same
  // trust level as pA/pB already do (anyone with the shared write token can
  // reassign a match's players today; toggling one match's format is no
  // more sensitive than that, and it's a deliberately visitor-correctable
  // per-match setting, not a one-way admin action).
  const UPDATE_FIELD_KEYS = {
    day1_match: ['pA', 'pB', 'pA2', 'pB2', 'front9', 'back9', 'type', 'challengeSide'],
    day1_ntp:   ['h8', 'h17'],
    day2_score: ['a4', 'a3', 'b4', 'b3'],
    day2_ntp:   ['h4', 'h16'],
    day3_ntp:   ['h7', 'h14'],
    team_name:  ['A', 'B'],
    team_assign:['A', 'B'],
    day_lock:   ['day1', 'day2', 'day3']
  };

  // Classifies a Day 1 match's given side ('pA'/'pB') for the cross-match
  // double-booking rule below: 'double' is a Captain's Challenge match's
  // 2-opponent side (issue #256, direction flipped by issue #326), 'lone'
  // is that same match's single spare-player side, 'ordinary' is either
  // side of a plain Singles match. day1SeatsCompatible() says which pairs
  // of seats a single player may legitimately hold at once (issue #328):
  // only an 'ordinary' seat plus a 'double' seat, since the short-handed
  // team's 2 Challenge opponents are drawn from players already playing
  // their own singles match. Every other pairing -- including anything
  // touching a 'lone' seat, which must stay exclusive to that one player --
  // keeps the original one-seat-per-day rule (issue #147).
  function day1SeatKind(match, side) {
    if (match.type !== 'challenge') return 'ordinary';
    return match.challengeSide === (side === 'pA' ? 'A' : 'B') ? 'double' : 'lone';
  }
  function day1SeatsCompatible(kindA, kindB) {
    return (kindA === 'ordinary' && kindB === 'double') || (kindA === 'double' && kindB === 'ordinary');
  }

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
        if (row.field_key === 'pA' || row.field_key === 'pB' || row.field_key === 'pA2' || row.field_key === 'pB2') {
          const id = parseIntOrNull(v);
          const side = (row.field_key === 'pA' || row.field_key === 'pA2') ? 'pA' : 'pB';
          const slot = (row.field_key === 'pA2' || row.field_key === 'pB2') ? 1 : 0;
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
          // Checks both slots of both sides (issue #256's Captain's
          // Challenge 2nd slot included) since a player can only ever hold
          // one seat across the whole day regardless of which slot it is --
          // UNLESS this assignment and the other seat are an
          // ordinary-singles/Challenge-opponent pair, the one legitimate
          // double-booking the format now requires (issue #328).
          if (id !== null) {
            const hereKind = day1SeatKind(match, side);
            state.day1.matches.forEach((other, oi) => {
              if (oi === row.match_idx) return;
              ['pA', 'pB'].forEach(s => {
                [0, 1].forEach(si => {
                  if (other[s][si] !== id) return;
                  if (day1SeatsCompatible(hereKind, day1SeatKind(other, s))) return;
                  other[s][si] = null;
                  other.front9 = null;
                  other.back9 = null;
                  other.holesA = Array(18).fill(null);
                  other.holesB = Array(18).fill(null);
                });
              });
            });
          }
          match[side][slot] = id;
        } else if (row.field_key === 'type') {
          match.type = v === 'challenge' ? 'challenge' : 'singles';
        } else if (row.field_key === 'challengeSide') {
          match.challengeSide = (v === 'A' || v === 'B') ? v : null;
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
      case 'team_lock':
        // No field_key -- a single global toggle, same shape as tiebreak
        // (issue #302). Team Setup now lives in the admin-only panel, so
        // unlike day_lock this exists purely as an admin self-guard against
        // an accidental edit, not a viewer-facing gate.
        state.teamsLocked = v === 'true';
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
    day1_match:      { label: 'Day 1 — Match Result / Player',  addressing: 'match+field', fieldKeys: ['pA', 'pB', 'pA2', 'pB2', 'front9', 'back9', 'type', 'challengeSide'], restorable: true },
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
    day_lock:        { label: 'Day Lock',                        addressing: 'field',       fieldKeys: ['day1', 'day2', 'day3'], restorable: true },
    team_lock:       { label: 'Team Lock',                       addressing: 'none',        restorable: true }
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
        if (row.field_key === 'pA' || row.field_key === 'pB' || row.field_key === 'pA2' || row.field_key === 'pB2') {
          const isSecond = row.field_key === 'pA2' || row.field_key === 'pB2';
          const teamLetter = (row.field_key === 'pA' || row.field_key === 'pA2') ? 'A' : 'B';
          const side = `Team ${teamLetter} slot${isSecond ? ' (Captain\'s Challenge, back 9 opponent)' : ''}`;
          return { fieldLabel: `${matchLabel} · ${side}`, valueLabel: isCleared ? '(cleared)' : (playerName(v) || String(v)) };
        }
        if (row.field_key === 'type') {
          return { fieldLabel: `${matchLabel} · Format`, valueLabel: v === 'challenge' ? "Captain's Challenge (1v2)" : 'Singles (1v1)' };
        }
        if (row.field_key === 'challengeSide') {
          return { fieldLabel: `${matchLabel} · Captain's Challenge side`, valueLabel: isCleared ? '(cleared)' : `Team ${v}` };
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
      case 'team_lock':
        return { fieldLabel: 'Team Lock', valueLabel: isCleared ? '(cleared)' : (v === 'true' ? 'Locked' : 'Unlocked') };
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

  /* ── LIVE COMMENTARY WIRE (issue #186) ──
     Pure, state-aware event classifier: given one just-applied sync row
     and the tournament state immediately before/after applying it,
     returns a human headline plus an importance tier ('notify' vs
     'feed') for the UI to decide whether it's toast/feed-only or also
     fires a system notification. `courses` isn't in the issue's own
     suggested signature but there's no way to compute Day 1 stroke
     indexes or Day 2 group handicaps without it.

     Scope: match-play drama (a nine decided, the lead changing), NTP
     claims, and a Day 2 group finishing its round -- three of the four
     concrete categories the issue names. The fourth, "record pace", is
     deliberately NOT implemented: there's no historical baseline
     anywhere in this app to compare a live score against, so "record"
     can't actually be detected, only asserted -- left out of scope
     rather than guessed at. */
  function playerLabelFor(ids, players) {
    const names = (ids || []).filter(id => id !== null && id !== undefined).map(id => {
      const p = (players || []).find(pp => pp.id === id);
      return p ? p.short : `Player #${id}`;
    });
    return names.length ? names.join(' & ') : 'TBD';
  }

  function describeDay1HoleEvent(row, prevState, nextState, players, courses) {
    const idx = row.match_idx;
    if (typeof idx !== 'number') return null;
    const match = nextState.day1.matches[idx];
    const prevMatch = prevState.day1.matches[idx];
    if (!match || !prevMatch) return null;
    const holeMatch = /^([AB])(\d{1,2})$/.exec(row.field_key || '');
    if (!holeMatch) return null;
    const holeNum = parseInt(holeMatch[2], 10);
    if (isNaN(holeNum) || holeNum < 1 || holeNum > 18) return null;
    const start = holeNum <= 9 ? 0 : 9;
    const nineLabel = start === 0 ? 'front 9' : 'back 9';

    function nineStatusFor(mtch) {
      if (!Array.isArray(mtch.holesA) || !Array.isArray(mtch.holesB)) return nineStatus(Array(9).fill(null));
      const si = day1StrokeIndexesFor(courses);
      const strokes = matchStrokesForPlayers(mtch, players, si);
      const holesA = mtch.holesA.slice(start, start + 9);
      const holesB = mtch.holesB.slice(start, start + 9);
      const strokesA = strokes.a.slice(start, start + 9);
      const strokesB = strokes.b.slice(start, start + 9);
      const results = holesA.map((g, i) => holeResult(g, holesB[i], strokesA[i], strokesB[i]));
      return nineStatus(results);
    }

    const status = nineStatusFor(match);
    if (status.thru === 0) return null;
    const prevStatus = nineStatusFor(prevMatch);
    // Issue #304: holeResult() (and so nineStatus()'s `thru` count) already
    // requires BOTH players' gross scores before a hole counts as played --
    // but until now that only gated the *first* branch below (status.thru
    // === 0). Every other day1_hole row still fell through to the plain
    // "thru N" feed line at the bottom even when THIS row didn't complete a
    // new hole: entering player A's score fires one event, then entering
    // player B's score for the very same hole fires a second, near-identical
    // one (or a no-op admin edit fires a redundant one). Only proceed once
    // `thru` actually advanced -- i.e. this row is the one that completed a
    // hole both players now have a score for.
    if (status.thru <= prevStatus.thru) return null;

    const nameA = playerLabelFor(match.pA, players);
    const nameB = playerLabelFor(match.pB, players);

    if (status.decided && !prevStatus.decided) {
      if (status.leader === null) return { headline: `${nameA} and ${nameB} halve the ${nineLabel}`, importance: 'notify' };
      const winnerName = status.leader === 'A' ? nameA : nameB;
      const marginStr = status.margin !== null ? `${status.lead}&${status.margin}` : `${status.lead}UP`;
      return { headline: `${winnerName} wins the ${nineLabel} ${marginStr}`, importance: 'notify' };
    }
    if (!status.decided && status.leader !== prevStatus.leader) {
      if (status.leader === null) return { headline: `${nameA} and ${nameB} level thru ${status.thru}`, importance: 'notify' };
      const leaderName = status.leader === 'A' ? nameA : nameB;
      return { headline: `${leaderName} goes ${status.lead}UP thru ${status.thru}`, importance: 'notify' };
    }
    const leaderName = status.leader === 'A' ? nameA : status.leader === 'B' ? nameB : null;
    const line = leaderName ? `${leaderName} ${status.lead}UP thru ${status.thru}` : `${nameA} v ${nameB} level thru ${status.thru}`;
    return { headline: line, importance: 'feed' };
  }

  function describeNtpEvent(row, players) {
    const holderId = parseIntOrNull(row.value);
    if (holderId === null) return null; // cleared -- not commentary-worthy
    const holeLabel = String(row.field_key || '').replace(/^h/, '');
    const name = playerLabelFor([holderId], players);
    const dayLabel = row.update_type === 'day1_ntp' ? 'Day 1' : row.update_type === 'day2_ntp' ? 'Day 2' : 'Day 3';
    return { headline: `${name} takes NTP — ${dayLabel}, hole ${holeLabel}`, importance: 'notify' };
  }

  function describeDay2HoleEvent(row, nextState, players, courses, teamNames) {
    const groupMatch = /^(a4|a3|b4|b3)_(\d{1,2})$/.exec(row.field_key || '');
    if (!groupMatch) return null;
    const code = groupMatch[1];
    const day2 = nextState.day2;
    const holes = day2.holes[code];
    if (!Array.isArray(holes) || !scrambleRoundComplete(holes)) return null; // only notify-worthy once the group actually finishes
    const handicap = day2GroupHandicapFor(code, day2, players);
    if (handicap === null) return null;
    const courseHoles = day2CourseHolesFor(courses);
    const strokes = groupStrokes(handicap, courseHoles.map(h => h.si));
    const { netToPar } = scrambleNetToParThru(holes, strokes, courseHoles.map(h => h.par));
    const adjusted = netToPar === null ? null : netToPar + day2AnthemStrokesFor(code, day2);
    const parLabel = adjusted === null ? '—' : adjusted === 0 ? 'level par' : adjusted > 0 ? `+${adjusted}` : String(adjusted);
    const teamLabel = code[0] === 'a' ? ((teamNames && teamNames.A) || 'Team A') : ((teamNames && teamNames.B) || 'Team B');
    const sizeLabel = code[1] === '4' ? 'four-ball' : 'three-ball';
    return { headline: `${teamLabel}'s ${sizeLabel} finishes ${parLabel}`, importance: 'notify' };
  }

  // The one function the UI actually calls -- dispatches to the
  // per-update_type classifiers above. Any update_type not covered
  // (team-name edits, admin overrides, lock toggles, etc.) is
  // deliberately not commentary -- returning null, not a fallback
  // generic line, keeps the wire signal-only.
  function describeEvent(row, prevState, nextState, players, courses, teamNames) {
    switch (row.update_type) {
      case 'day1_hole': return describeDay1HoleEvent(row, prevState, nextState, players, courses);
      case 'day1_ntp':
      case 'day2_ntp':
      case 'day3_ntp': return describeNtpEvent(row, players);
      case 'day2_hole': return describeDay2HoleEvent(row, nextState, players, courses, teamNames);
      default: return null;
    }
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
    // Coerce every existing match into a known-good shape — a match saved
    // during the short-lived doubles-era format (type:'doubles', both sides
    // 2-slot) can otherwise survive indefinitely in a browser's cached
    // state, since this used to only pad new matches onto the end rather
    // than fixing up what was already there. Only 'singles' and 'challenge'
    // (issue #256's Captain's Challenge) are recognized types; anything
    // else -- including the old 'doubles' -- coerces to 'singles'.
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
    // A 'challenge' match's designated challengeSide gets a 2nd slot (the
    // "two opponents" side); every other side of every match -- including
    // both sides of a plain singles match -- keeps exactly 1, same shape as
    // before #256. `keepSecond` decides which.
    function normalizedPlayerSlots(arr, keepSecond) {
      const slot0 = (arr && arr[0] !== undefined) ? arr[0] : null;
      if (!keepSecond) return [slot0];
      const slot1 = (arr && arr[1] !== undefined) ? arr[1] : null;
      return [slot0, slot1];
    }
    state.day1.matches = state.day1.matches.map(m => {
      const type = m.type === 'challenge' ? 'challenge' : 'singles';
      const challengeSide = (type === 'challenge' && (m.challengeSide === 'A' || m.challengeSide === 'B')) ? m.challengeSide : null;
      return {
        type,
        challengeSide,
        pA: normalizedPlayerSlots(m.pA, challengeSide === 'A'),
        pB: normalizedPlayerSlots(m.pB, challengeSide === 'B'),
        front9: m.front9 ?? null,
        back9: m.back9 ?? null,
        holesA: normalizedHoles(m.holesA),
        holesB: normalizedHoles(m.holesB)
      };
    });
    while (state.day1.matches.length < 6) {
      state.day1.matches.push({ type:'singles', challengeSide: null, pA:[null], pB:[null], front9:null, back9:null, holesA: Array(18).fill(null), holesB: Array(18).fill(null) });
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
    ANTHEM_STROKE_ADJUSTMENT, day2AnthemStrokesFor, HCP_MIN, HCP_MAX, playersWithOverrides,
    scrambleNetToParThru, scrambleRoundComplete, applyPlayerGroupMove,
    POS_PTS, computeStableford, sumStablefordPoints,
    DAY3_HOLE_GROSS_MIN, DAY3_HOLE_GROSS_MAX, stablefordPoints, day3HolePoints, day3PointsThru,
    resolveOverallWinner,
    day1StrokeIndexesFor, day1CourseHolesFor, matchStrokesForPlayers, effectiveMatchFor,
    matchWormFor, day1SeatKind, day1SeatsCompatible,
    teamOfSets, ntpPointsFor, scoreToParSymbol,
    REACTION_EMOJI, holeScoreReaction, stablefordTotalReaction,
    day2CourseHolesFor, day2GroupHandicapFor, effectiveDay2FieldFor, effectiveDay2StateFor,
    day3CourseHolesFor, effectiveDay3ScoreFor,
    computeSeasonTotals, weekendWormFor, phaseFor, daysUntilDay1,
    projectedNinePoints, projectedMatchPoints, projectedMatchPointsFor, sumProjectedMatchPoints,
    projectedDay2Field, projectedDay2Totals, projectedTotals,
    applyPlayerTeamMove, dedupeTeams, reconcileMatchesAfterTeamMove, processUpdateRows,
    parseIntOrNull, applyUpdateToState,
    UPDATE_TYPE_DESCRIPTORS, describeUpdateRow, isRestorable, buildRestoreRow,
    describeEvent,
    normalizeState, flushQueue
  };
});
