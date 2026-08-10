/* ─────────────────────────────────────
   WONGA CUP — HOMEPAGE RIBBON STATUS (issue #203)

   index.html is a static brochure right up until the moment traffic
   actually peaks (tournament week). This swaps the key-facts ribbon's
   "Holders" slot through three phases based on Melbourne-local date
   (WongaScoring.phaseFor):

     - countdown (before 7 Aug): "Kicks Off In · N Days"
     - live (7-9 Aug): a real score, replayed from the same
       tournament_updates log the live scorecard reads, computed via the
       exact same WongaScoring.computeSeasonTotals() scorecard-live.html
       calls -- one source of truth for what the score actually is
     - final (after 9 Aug): the frozen result, computed once

   Read-only forever: no login, no writes, no localStorage sync-cursor
   machinery here -- every load/poll does a fresh full read rather than
   maintaining any synced state of its own. Graceful degradation is the
   core requirement: any fetch/parse failure during the *initial* render
   leaves the ribbon's shipped static content ("Holders / Team
   Underdogs") completely untouched -- no spinner, no error state, no
   layout shift. A failed background *refresh* during live mode instead
   just keeps showing the last successful render.
───────────────────────────────────── */
(function () {
  const labelEl = document.getElementById('ribbon-status-label');
  const valueEl = document.getElementById('ribbon-status-value');
  if (!labelEl || !valueEl) return;
  if (typeof WongaScoring === 'undefined' || typeof WongaCourses === 'undefined' || typeof WongaPlayers === 'undefined') return;

  const {
    phaseFor, daysUntilDay1, defaultDay,
    normalizeState, processUpdateRows, applyUpdateToState,
    computeSeasonTotals, resolveOverallWinner, playersWithOverrides
  } = WongaScoring;
  const { COURSES } = WongaCourses;
  const { PLAYERS } = WongaPlayers;

  // Issue #23: shared with every other Supabase-reading file via
  // supabase-config.js. anon can SELECT the safe columns only, same
  // grant the live scorecard reads under -- RLS is the boundary, see
  // supabase/migrations/.
  if (typeof SupabaseConfig === 'undefined') return;
  const SUPABASE_URL = SupabaseConfig.URL;
  const SUPABASE_ANON_KEY = SupabaseConfig.ANON_KEY;
  const TOURNAMENT_ID = SupabaseConfig.TOURNAMENT_ID;
  const SAFE_SELECT_COLUMNS = SupabaseConfig.SAFE_SELECT_COLUMNS;

  const DAY_LABELS = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3' };

  function fmt(n) {
    return n === Math.floor(n) ? n.toString() : n.toFixed(1);
  }

  function renderCountdown() {
    const days = daysUntilDay1(new Date());
    labelEl.textContent = 'Kicks Off In';
    valueEl.textContent = days <= 0 ? 'Today' : (days === 1 ? '1 Day' : `${days} Days`);
  }

  // Issue #24: shared with tv.html via scoring.js's fetchWithTimeout()/
  // fetchAllRows() -- both were byte-for-byte duplicated between the two
  // files (fetchWithTimeout also existed a third time, divergently, in
  // scorecard-live.html). Issue #285 is why fetchWithTimeout exists at
  // all: a fetch has no default timeout, and schedulePoll() only re-arms
  // its next setTimeout after its `await renderLive()` settles -- so a
  // fetch that never settles here means the ribbon simply stops polling
  // forever, frozen on whatever score it last showed with no visible
  // sign anything is wrong (this ribbon has no offline banner by
  // design). A hard timeout turns the hang into an ordinary rejection,
  // which schedulePoll()'s existing catch already handles (keep last
  // render, re-arm next tick).
  function fetchAllRows() {
    return WongaScoring.fetchAllRows({ baseUrl: SUPABASE_URL, apiKey: SUPABASE_ANON_KEY, tournamentId: TOURNAMENT_ID, columns: SAFE_SELECT_COLUMNS });
  }

  function replayState(rows) {
    const state = { teamNameA: 'Team A', teamNameB: 'Team B', teamA: new Set(), teamB: new Set() };
    normalizeState(state);
    processUpdateRows(rows, (row) => applyUpdateToState(state, row));
    return state;
  }

  async function computeTotals() {
    const rows = await fetchAllRows();
    const state = replayState(rows);
    // Admin handicap overrides (issue #206) replay onto state.hcp the same
    // way every other synced field does -- must be layered on top of the
    // roster here too, or this ribbon's score would silently drift from
    // the live scorecard's once an organiser corrects a handicap.
    return { totals: computeSeasonTotals(state, playersWithOverrides(PLAYERS, state.hcp), COURSES), state };
  }

  async function renderLive() {
    const { totals, state } = await computeTotals();
    const dayLabel = DAY_LABELS[defaultDay(new Date())] || '';
    labelEl.textContent = 'Live Now';
    valueEl.textContent = `${state.teamNameA} ${fmt(totals.totalA)} – ${fmt(totals.totalB)} ${state.teamNameB}${dayLabel ? ' · ' + dayLabel + ' in play' : ''}`;
  }

  async function renderFinal() {
    const { totals, state } = await computeTotals();
    const result = resolveOverallWinner(totals.totalA, totals.totalB, state.tiebreak);
    const hi = fmt(Math.max(totals.totalA, totals.totalB));
    const lo = fmt(Math.min(totals.totalA, totals.totalB));
    labelEl.textContent = 'Result';
    if (result.winner === 'A') valueEl.textContent = `🏆 ${state.teamNameA} win ${hi}–${lo}`;
    else if (result.winner === 'B') valueEl.textContent = `🏆 ${state.teamNameB} win ${hi}–${lo}`;
    else valueEl.textContent = `${fmt(totals.totalA)} – ${fmt(totals.totalB)} (tiebreak pending)`;
    // Once the season's truly over and no further changes are expected,
    // this can be frozen straight into the ribbon's static markup and
    // this script (plus its scoring.js/courses.js/players.js loads)
    // removed from index.html entirely.
  }

  async function init() {
    const phase = phaseFor(new Date());
    if (phase === 'countdown') { renderCountdown(); return; }
    try {
      if (phase === 'live') await renderLive();
      else await renderFinal();
    } catch (e) { /* leave the shipped static "Holders" content exactly as-is */ }
  }
  init();

  // Live mode refreshes lazily -- 60s, and only while the tab is
  // actually visible. Naturally stops once the date rolls past Day 3
  // (the next scheduled check sees phase !== 'live' and doesn't
  // reschedule); a tab left open across that exact transition just
  // stops updating until reloaded, which is an acceptable edge case for
  // a read-only overlay on an otherwise-static page.
  function schedulePoll() {
    if (phaseFor(new Date()) !== 'live') return;
    setTimeout(async () => {
      if (!document.hidden) {
        try { await renderLive(); } catch (e) { /* keep showing the last good render */ }
      }
      schedulePoll();
    }, 60000);
  }
  schedulePoll();
})();
