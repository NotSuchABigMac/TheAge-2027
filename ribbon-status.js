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
    computeSeasonTotals, resolveOverallWinner
  } = WongaScoring;
  const { COURSES } = WongaCourses;
  const { PLAYERS } = WongaPlayers;

  // Same publishable anon key already shipped in scorecard-live.html's
  // page source (not a secret -- RLS is the boundary, see
  // supabase/migrations/). anon can SELECT the safe columns only, same
  // grant the live scorecard reads under.
  const SUPABASE_URL = 'https://wtyyarvyscbrrkawjcvo.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_T1z1rYbZ7yMoDdBXZMrjKw_R3aTxsrx';
  const TOURNAMENT_ID = 'wonga-cup-2026';
  const SAFE_SELECT_COLUMNS = 'id,tournament_id,update_type,match_idx,player_id,field_key,value,updated_by,updated_at';

  const DAY_LABELS = { day1: 'Day 1', day2: 'Day 2', day3: 'Day 3' };

  function fmt(n) {
    return n === Math.floor(n) ? n.toString() : n.toFixed(1);
  }

  function renderCountdown() {
    const days = daysUntilDay1(new Date());
    labelEl.textContent = 'Kicks Off In';
    valueEl.textContent = days <= 0 ? 'Today' : (days === 1 ? '1 Day' : `${days} Days`);
  }

  // A deliberately simpler full-refresh read than the live scorecard's
  // exact-once cursor/id tracking (issue #111) -- this is read-only
  // display, not the source of truth for scoring, so re-applying a
  // boundary row that shares its exact timestamp with the next page's
  // first row at worst re-sets a field to the value it already has
  // (every applyUpdateToState case is idempotent for a repeated
  // identical row), never corrupts anything.
  async function fetchAllRows() {
    const rows = [];
    let cursor = '1970-01-01T00:00:00.000Z';
    while (true) {
      const url = `${SUPABASE_URL}/rest/v1/tournament_updates?select=${SAFE_SELECT_COLUMNS}&tournament_id=eq.${TOURNAMENT_ID}&updated_at=gte.${encodeURIComponent(cursor)}&order=updated_at.asc,id.asc&limit=500`;
      const resp = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' } });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const page = await resp.json();
      rows.push(...page);
      if (page.length < 500) break;
      cursor = page[page.length - 1].updated_at;
    }
    return rows;
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
    return { totals: computeSeasonTotals(state, PLAYERS, COURSES), state };
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
