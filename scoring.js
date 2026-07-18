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

  /* ── DAY 3 — INDIVIDUAL STABLEFORD ──
     1st = 14pts down to 14th = 1pt. Tied players share the averaged
     points across their tied position range. */
  const POS_PTS = [14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  // entries: [{ id, score: number|null, team: 'A'|'B' }]
  // Returns entries sorted desc by score (nulls last) with pos/pts filled in.
  function computeStableford(entries) {
    const sorted = [...entries].sort((a, b) => {
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

  function sumStablefordPoints(sortedEntries) {
    let a = 0, b = 0;
    sortedEntries.forEach(p => { if (p.team === 'A') a += p.pts; else b += p.pts; });
    return { a, b };
  }

  /* ── OVERALL WINNER / TIEBREAK ── */
  function resolveOverallWinner(totalA, totalB, tiebreak) {
    if (totalA > totalB) return { winner: 'A', mode: 'points' };
    if (totalB > totalA) return { winner: 'B', mode: 'points' };
    if (tiebreak === 'A' || tiebreak === 'B') return { winner: tiebreak, mode: 'tiebreak' };
    return { winner: null, mode: 'tied-pending-tiebreak' };
  }

  return {
    ninePoints, matchPoints, sumMatchPoints,
    ntpTeamPoints,
    parseScoreToPar, day2GroupPoints, day2Bonus, calcDay2,
    POS_PTS, computeStableford, sumStablefordPoints,
    resolveOverallWinner
  };
});
