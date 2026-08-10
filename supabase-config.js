/* ─────────────────────────────────────
   WONGA CUP — SUPABASE CONNECTION CONFIG (issue #23)

   Single source of truth for the URL, publishable anon key, tournament
   id, and the safe-select column list every read path uses. Before this,
   the same two lines were hardcoded independently in scorecard-live.html,
   tv.html, ribbon-status.js and error-beacon.js -- four owners for one
   value, with a silent split-brain risk if a tournament-id bump missed
   one of them.

   The publishable key living in page source is deliberate and correct --
   RLS is the actual access-control boundary (see ARCHITECTURE.md's
   Security section), not this key. This module exists to remove
   duplication, not to hide a secret.

   SAFE_SELECT_COLUMNS must stay in step with supabase/migrations/002's
   column grant -- see test/client-errors-migration.test.mjs for the
   migration-vs-client cross-check pattern used elsewhere in this repo.

   No DOM, no globals besides the exports below -- same UMD pattern as
   scoring.js/courses.js/error-beacon.js, so it's require()-able from
   Node tests and still works as a plain <script> load. Loaded before
   error-beacon.js on every page that carries it (and before
   scoring.js/tv.html/ribbon-status.js's own inline scripts).
───────────────────────────────────── */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.SupabaseConfig = mod;
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {

  return {
    URL: 'https://wtyyarvyscbrrkawjcvo.supabase.co',
    ANON_KEY: 'sb_publishable_T1z1rYbZ7yMoDdBXZMrjKw_R3aTxsrx',
    TOURNAMENT_ID: 'wonga-cup-2026',
    SAFE_SELECT_COLUMNS: 'id,tournament_id,update_type,match_idx,player_id,field_key,value,updated_by,updated_at'
  };
});
