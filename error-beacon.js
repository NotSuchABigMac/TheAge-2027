/* ─────────────────────────────────────
   WONGA CUP — CLIENT ERROR BEACON (issue #202)

   During the tournament, breakage on one of ~14 devices currently
   surfaces as "the site's cooked" in the group chat with zero detail.
   This fires a fire-and-forget insert into Supabase's client_errors
   table (supabase/migrations/004_client_errors.sql) on every uncaught
   error/rejection, so the organiser can read the stack trace before
   anyone's finished typing that message.

   Loaded on every page in the repo via its own <script> tag -- same UMD
   pattern as scoring.js/courses.js so the decision logic is unit
   testable without a browser, while still auto-installing its real
   listeners the instant it's loaded as a plain <script>.

   Deliberately decoupled from the scorecard's own offline retry queue
   and insertUpdate(): a broken beacon must never be able to break
   scoring, and a scoring bug being reported must never touch scoring's
   own sync machinery.
───────────────────────────────────── */
(function (root, factory) {
  // Which environment we're in decides both how the config is reached and
  // where the module is published, so it's sniffed once here and the
  // resolved config handed to the factory -- rather than the factory
  // re-deriving the same thing to pick between require() and a global.
  const isCommonJS = typeof module === 'object' && module.exports;
  const config = isCommonJS ? require('./supabase-config.js') : root.SupabaseConfig;
  const mod = factory(config);
  if (isCommonJS) {
    module.exports = mod;
  } else {
    root.WongaErrorBeacon = mod;
    if (typeof window !== 'undefined') mod.install(window);
  }
})(typeof window !== 'undefined' ? window : globalThis, function (SupabaseConfig) {

  const MAX_REPORTS_PER_SESSION = 5;

  // Known benign noise, excluded so one common non-bug doesn't eat the
  // whole per-session budget. audio play() rejections were the original
  // motivating case (issue #183 fixed the underlying resilience gap, but
  // a stray rejection from an unrelated browser autoplay policy is still
  // not actionable here).
  const IGNORE_PATTERNS = [
    /play\(\) (failed|request was interrupted)/i
  ];

  function makeState() {
    return { reportCount: 0, seen: new Set() };
  }

  // Pure decision: does this (message, stackHead) pair get reported,
  // given what's already been reported this session? No fetch, no DOM,
  // no globals -- unit testable head-on.
  function shouldReport(state, message) {
    if (!message) return false;
    if (state.reportCount >= MAX_REPORTS_PER_SESSION) return false;
    if (IGNORE_PATTERNS.some((re) => re.test(message))) return false;
    if (state.seen.has(message)) return false;
    return true;
  }

  function recordReport(state, message) {
    state.reportCount++;
    state.seen.add(message);
  }

  // Issue #23: shared with every other Supabase-reading file via
  // supabase-config.js, loaded on every page just before this one and
  // handed in by the wrapper above.
  const SUPABASE_URL = SupabaseConfig.URL;
  const SUPABASE_ANON_KEY = SupabaseConfig.ANON_KEY;
  const TOURNAMENT_ID = SupabaseConfig.TOURNAMENT_ID;

  function install(win) {
    const state = makeState();

    function send(message, stackHead) {
      try {
        if (!shouldReport(state, message)) return;
        recordReport(state, message);
        let token = null;
        let username = null;
        try { token = win.sessionStorage.getItem('wongaCup_writeToken'); } catch (e) {}
        try { username = win.sessionStorage.getItem('wongaCup_username'); } catch (e) {}
        const body = {
          tournament_id: TOURNAMENT_ID,
          page: (win.location.pathname.split('/').pop() || 'index.html'),
          message: String(message).slice(0, 500),
          stack_head: stackHead ? String(stackHead).slice(0, 500) : null,
          ua: win.navigator ? win.navigator.userAgent : null,
          username: username,
          write_token: token
        };
        // Fire-and-forget: never awaited, never throws, never routed
        // through the scorecard's own offline retry queue -- an error
        // beacon must not be able to interact with scoring's own sync
        // machinery.
        win.fetch(`${SUPABASE_URL}/rest/v1/client_errors`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_ANON_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(body)
        }).catch(() => {});
      } catch (e) { /* the beacon itself must never throw */ }
    }

    win.addEventListener('error', (e) => {
      send(e.message, e.error && e.error.stack);
    });
    win.addEventListener('unhandledrejection', (e) => {
      const reason = e.reason;
      const message = reason && reason.message ? reason.message : String(reason);
      const stack = reason && reason.stack;
      send(message, stack);
    });
  }

  return { shouldReport, recordReport, makeState, install, MAX_REPORTS_PER_SESSION, IGNORE_PATTERNS };
});
