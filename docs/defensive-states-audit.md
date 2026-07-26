# Defensive State Audit — Wonga Cup Live Scorecard

**Scope:** `scorecard-live.html` (live scoring app), `scoring.js` (pure math + sync row application), `theme.js`, `index.html`.
**Stack:** Vanilla JS multi-page site · Supabase REST (`tournament_updates` insert-only transaction log, anon publishable key) · `localStorage` persistence · 30-second polling sync.
**Method:** Manual trace of every user interaction, sync path, and persisted-data shape against the API contract in `TODO.md`.

Severity key: 🔴 breaks the page or corrupts data · 🟠 silent data loss / divergence · 🟡 degraded UX.

---

## 1. Defensive State Issue Log

### A. Loading

#### A1. 🟡 `scorecard-live.html` (sync bar / whole page) — Missing initial-sync loading state
- **Failure scenario:** On first load the page renders localStorage/default state immediately, then `loadFromSupabase()` mutates state up to several seconds later and re-renders. A user on a fresh device sees default teams and 0–0 with a green "Live" dot, and can start entering scores against stale state before the first sync resolves.
- **Prescriptive solution:** Introduce an explicit sync status machine and render it in the sync bar; suppress the "live" affordance until the first poll settles.

```
syncStatus: 'initial-loading' | 'live' | 'offline'

// init
syncStatus = 'initial-loading'
renderSyncBar()   // grey dot + "Syncing latest scores…", refresh btn disabled

loadFromSupabase()
  .then(ok => { syncStatus = ok || !isOffline ? 'live' : 'offline' })
  .finally(() => { renderSyncBar(); refreshAllDays() })

renderSyncBar():
  if syncStatus == 'initial-loading': dot.class = 'grey'; label = 'Syncing…'
  if syncStatus == 'live':            dot.class = 'live-dot'; label = 'Live Scores'
  if syncStatus == 'offline':         dot.class = 'red'; label = 'Offline — local only'
```

#### A2. 🟡 `scorecard-live.html` (Refresh button) — No in-flight state, silent failure
- **Failure scenario:** `onclick="loadFromSupabase().then(() => refreshAllDays())"` gives no visual feedback; double-taps fire overlapping fetches, and a failed refresh looks identical to "no new scores" (errors go to console only).
- **Prescriptive solution:** Disable the button and swap its label while the promise is pending; toast on failure.

```
async function manualRefresh(btn):
  if (btn.disabled) return
  btn.disabled = true; btn.textContent = '⏳ Refreshing…'
  try:
    const ok = await loadFromSupabase()
    refreshAllDays()
    if (isOffline) showSaveToast('✗ Could not reach server', 'error')
  finally:
    btn.disabled = false; btn.textContent = '🔄 Refresh'
```

#### A3. 🟡 `loadFromSupabase()` — 500-row page limit leaves first load partially applied
- **Failure scenario:** The query uses `limit=500`; a device that has been offline all weekend (or a fresh device replaying the whole log) applies only the oldest 500 rows and shows a wrong scoreboard for 30s per extra page until the poll loop catches up.
- **Prescriptive solution:** Drain the backlog in a loop before declaring the load complete, keeping the per-page cursor advance that already protects against poison rows.

```
async function loadFromSupabase():
  let gotAny = false
  do:
    rows = await fetchPage(lastSync, 500)
    if rows.length: apply + advance cursor; gotAny = true
  while rows.length === 500
  return gotAny
```

### B. Empty States

#### B1. 🟡 `scorecard-live.html` (`#team-a-list` / `#team-b-list`) — Empty team columns render blank
- **Failure scenario:** After "Clear Teams" mid-correction, or before the draft is entered, a team column is an empty bordered box with no content — it reads as broken, especially next to the populated "Not Yet On A Team" list.
- **Prescriptive solution:** Render a placeholder row when a column receives zero players.

```
// end of renderTeams(), per column:
if (aList.children.length === 0)
  aList.innerHTML = '<div class="team-player-item" style="justify-content:center">
    <span class="grey">No players drafted yet — use → A below</span></div>'
```

#### B2. 🟡 `renderDay1()` / `ntpPlayerOptions()` — Empty player pools give a bare placeholder with no guidance
- **Failure scenario:** With teams unassigned (or fewer than 6 Friday players on a side), every match dropdown and NTP select contains only "— pick player —" / "— none yet —"; nothing tells the scorer that the Teams tab is the prerequisite. The uneven-split warning only fires when counts *differ*, so 0 vs 0 shows nothing.
- **Prescriptive solution:** Detect an empty pool once per render and show a directive callout above the match cards.

```
// top of renderDay1():
if (fridayPlayers('A').length === 0 && fridayPlayers('B').length === 0):
  container.innerHTML = '<div class="info-box">⚠ No players are assigned to teams yet —
    complete the <a onclick="activateTab(tabTeams)">Captain\'s Draft on the Teams tab</a>
    before setting up matches.</div>'
  // still render the 6 cards below it (selects stay usable once teams exist)
```

#### B3. 🟡 `index.html` (course photos) — No broken-image fallback
- **Failure scenario:** The three course photos are CSS `background-image` divs; a missing/renamed file (note `course-black-bull (1).jpg` duplication in `/images`) renders as a silent empty grey box. `scorecard-live.html` already defines a `.course-ph` placeholder pattern (`.course-img.loaded`) but nothing uses it.
- **Prescriptive solution:** Reuse the existing placeholder pattern: real `<img>` with `onload` adding `.loaded` and the styled `.course-ph` div as the default-visible sibling.

```
<div class="course-img-frame">
  <img class="course-img" src="images/course-murray.webp" alt="…"
       onload="this.classList.add('loaded'); this.nextElementSibling.hidden = true">
  <div class="course-ph"><span class="course-ph-icon">⛳</span>
    <span class="course-ph-label">Murray Course</span></div>
</div>
```

### C. Error Handling

#### C1. 🔴 `scorecard-live.html` `normalizeState()` — Malformed persisted state kills the entire app at init
- **Failure scenario:** `loadState()` accepts `s.day1` wholesale inside its try/catch, but `normalizeState()` runs *after* the catch and calls `state.day1.matches.map(...)` unguarded — a localStorage blob where `day1` exists but `matches` is missing/not an array throws at line ~724, the top-level init script dies, and the page loads permanently dead (no tabs, no sync, no inputs).
- **Prescriptive solution:** Type-guard every field in `normalizeState()`, and wrap the whole init sequence in a recovery boundary that offers a "reset saved data" escape hatch instead of a silent corpse.

```
// normalizeState():
if (!Array.isArray(state.day1?.matches)) state.day1 = { matches: [], ntp: {h8:null,h17:null} }
if (typeof state.day2 !== 'object' || state.day2 === null) state.day2 = { a4:null,a3:null,b4:null,b3:null, ntp:{h4:null,h16:null} }
// …then the existing map/pad logic

// init boundary:
try:
  loadState(); renderTeams(); renderDay1(); restoreDay2(); renderDay3(); updateScoreboard()
catch (e):
  document.getElementById('page-scorecard').innerHTML =
    '<div class="info-box tc">⚠ Saved data on this device is corrupted.
     <button onclick="localStorage.removeItem(\'wongaCup2026\');
                      localStorage.removeItem(LAST_SYNC_KEY); location.reload()">
       Reset &amp; Reload</button></div>'
```

#### C2. 🟠 `pendingWrites` queue — Failed writes are lost on page reload
- **Failure scenario:** Writes that fail on patchy course wifi are queued in the in-memory `pendingWrites` array while the banner says "Offline — Using Local Storage"; the very users this protects (bad signal) are the most likely to reload the page, which permanently discards the queue — the local device shows a score no other device will ever receive.
- **Prescriptive solution:** Persist the queue to localStorage on every mutation and rehydrate at init, flushing on the first successful poll (the existing `flushPendingWrites` path already handles the resend).

```
const PENDING_KEY = 'wongaCup2026_pendingWrites'
function persistPending(): localStorage.setItem(PENDING_KEY, JSON.stringify(pendingWrites))
// call persistPending() after every push/reassignment of pendingWrites
// init: pendingWrites = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]')  (try/catch → [])
//       updateOfflineIndicator()   // banner shows immediately if writes are owed
```

#### C3. 🟠 Polling loop — No reentrancy guard on `loadFromSupabase()` / `flushPendingWrites()`
- **Failure scenario:** The 30s `setInterval` fires regardless of whether the previous poll finished; a request that hangs on bad wifi overlaps the next one, and two concurrent `flushPendingWrites()` runs iterate the same queue and double-insert every pending row into the transaction log.
- **Prescriptive solution:** Single-flight guard around the whole poll body.

```
let syncInFlight = false
async function pollOnce():
  if (syncInFlight) return
  syncInFlight = true
  try: { const ok = await loadFromSupabase(); if (ok) refreshAllDays() }
  finally: syncInFlight = false
// use pollOnce in both setInterval and the Refresh button
```

#### C4. 🟠 `refreshAllDays()` via auto-poll — Clobbers in-progress typing that hasn't saved
- **Failure scenario:** The `lastSaveTime < 5000` guard only helps after a *successful* save; a user mid-typing a team name (no save until the button), or typing without a username set (saves are no-ops), gets their input wiped and focus lost when the 30s poll rewrites `input.value`/`innerHTML`.
- **Prescriptive solution:** Never overwrite the element that currently has focus; restore focus after structural re-renders.

```
// updateTeamNames() / restoreDay2() / renderDay3() before writing input.value:
if (document.activeElement !== el) el.value = newVal

// refreshAllDays(): additionally skip the whole re-render while an
// editable element inside #page-scorecard has focus:
const ae = document.activeElement
if (ae && ae.matches('input, select') && Date.now() - ae._focusedAt < 60000) return
```

#### C5. 🟠 `setMatchPlayer()` / `requireUsername` cancel path — UI silently diverges from state
- **Failure scenario:** `setMatchPlayer` is the only mutator *not* wrapped in `requireUsername`, so an anonymous user's match assignment saves locally but `insertUpdate` returns early — the change never syncs and devices diverge with no error. Separately, when any gated control triggers the username modal and the user presses Escape, the control keeps its new visible value (select/number input) while state was never mutated.
- **Prescriptive solution:** Gate `setMatchPlayer` like its siblings, and make modal-cancel re-render so controls snap back to true state.

```
function setMatchPlayer(matchIdx, team, slot, val):
  requireUsername(() => { …existing body… })

function closeUsernameModal():
  modal.classList.add('hidden')
  _pendingAction = null
  refreshAllDays()          // snap any optimistic control back to state
```

#### C6. 🟡 `bg-audio.play()` — Unhandled promise rejection on autoplay block / missing file
- **Failure scenario:** On a revisit with `musicConsented === '1'`, `play()` runs with no user gesture; modern autoplay policy rejects the promise and the console fills with unhandled rejections (and a 404 on `TheSong.mp3` does the same even after the YES click).
- **Prescriptive solution:** `document.getElementById('bg-audio').play().catch(() => {/* autoplay blocked — will start on next explicit YES */})` at both call sites; optionally re-show the consent modal when autoplay is rejected.

#### C7. 🟡 `showSaveToast()` — Overlapping saves race the 2s hide timer
- **Failure scenario:** Each non-`saving` toast schedules `setTimeout(hide, 2000)` without cancelling prior timers; with rapid entries (Day 2 typing emits 4 writes per keystroke) an old timer hides the toast for a save still in flight, so "✗ Offline" can vanish instantly.
- **Prescriptive solution:** Keep one timer handle: `clearTimeout(toastTimer)` at the top of `showSaveToast`, reassign `toastTimer = setTimeout(...)` only for terminal states.

### D. Input Validation

#### D1. 🔴 `applyUpdateToState()` (`scoring.js`) + `renderDay3()` — Synced values are trusted, enabling attribute-breakout XSS and NaN standings
- **Failure scenario:** The `tournament_updates` table is written with a public anon key, but `day3_stableford` values are applied raw and interpolated into `value="${state.day3.scores[p.id]||''}"` inside `innerHTML` — a crafted row like `" autofocus onfocus="alert(1)` executes on every polling device; a merely-garbage row (`"abc"`) becomes `NaN` in `computeStableford`, corrupting sort order and rendering "NaN" points.
- **Prescriptive solution:** Validate at the trust boundary (row application) *and* escape at render — never rely on the honest client having clamped.

```
// applyUpdateToState, case 'day3_stableford':
const n = parseInt(v, 10)
state.day3.scores[row.player_id] =
  (v === null || v === 'null' || v === '') ? null
  : Number.isInteger(n) ? String(clamp(n, 0, 60)) : null   // drop garbage

// renderDay3 row template:
value="${escapeHtml(state.day3.scores[p.id] || '')}"
// apply the same clamp-on-apply to 'day2_score' (±20) for symmetry
```

#### D2. 🟠 `parseIntOrNull()` (`scoring.js`) — NaN player ids poison team sets and match slots
- **Failure scenario:** `parseIntOrNull('garbage')` returns `NaN`, not `null`; a malformed `day1_match pA`/`day1_ntp` row puts `NaN` into a match slot or `player_team` handling would pass it downstream, leaving dropdowns permanently blank-looking and `teamOf(NaN)` returning `null` (silently uncounted points).
- **Prescriptive solution:** Make the parser total:

```
function parseIntOrNull(v):
  if (v === null || v === undefined || v === 'null' || v === '') return null
  const n = parseInt(v, 10)
  return Number.isInteger(n) ? n : null
// additionally in applyUpdateToState: ignore rows whose parsed player id
// has no entry in PLAYERS (id < 0 or > max known id)
```

#### D3. 🟡 `saveTeamNames()` — Empty input is silently ignored
- **Failure scenario:** `if (a) {…}` means clearing a field and hitting "Save Names" does nothing, with no feedback — the user believes the blank saved, and the next poll "mysteriously" restores the old name.
- **Prescriptive solution:** Explicit rejection feedback per field:

```
if (!a): { inputA.style.borderColor = '#ff6b6b'; showSaveToast('Team name can\'t be empty', 'error') }
else: { …existing save… }
```

#### D4. 🟡 `confirmUsername()` — Validation feedback is a 300ms border flash only
- **Failure scenario:** Submitting an empty name flashes the border and returns; there is no text, no `aria-live` output, and no `aria-invalid`, so screen-reader users get zero indication why "Enter Tournament" did nothing.
- **Prescriptive solution:** Add a persistent inline error node:

```
<div id="username-error" class="username-modal-desc" role="alert" hidden
     style="color:#ff6b6b">Please enter your name to continue</div>
// confirmUsername(): if (!name) { errEl.hidden = false; input.setAttribute('aria-invalid','true'); input.focus(); return }
// on valid submit / input event: errEl.hidden = true; input.removeAttribute('aria-invalid')
```

---

## 2. Downstream Execution Briefs

Copy-paste one brief per implementation task. Each targets one component cluster; all styling must reuse the existing utility classes (`info-box`, `save-toast`, `grey`, `sync-label`, etc.) already defined in `scorecard-live.html`'s `<style>` block.

**Brief 1 — Sync loading & refresh states**
> Task: Implement defensive states for the sync bar in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: a `syncStatus` variable (`'initial-loading' | 'live' | 'offline'`) rendered into `.sync-bar` (grey dot + "Syncing…" until the first `loadFromSupabase()` settles); a `manualRefresh(btn)` wrapper for the Refresh button that disables it and shows "⏳ Refreshing…" while in flight and toasts `'✗ Could not reach server'` via `showSaveToast` on failure; and a do/while loop in `loadFromSupabase()` that keeps fetching while a page returns exactly 500 rows. Ensure it matches the existing styling framework (reuse `.live-dot`, `.sync-label`, `.refresh-btn`).

**Brief 2 — Empty states for Teams & Day 1**
> Task: Implement defensive states for the Teams and Day 1 panels in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: a placeholder row ("No players drafted yet") inside `#team-a-list`/`#team-b-list` when `renderTeams()` leaves them empty; an `info-box` callout at the top of `#day1-matches` in `renderDay1()` when both `fridayPlayers('A')` and `fridayPlayers('B')` are empty, directing the user to the Teams tab (still render the 6 match cards below it). Ensure it matches the existing styling framework (`.info-box`, `.team-player-item`, `.grey`).

**Brief 3 — Init crash boundary & state normalization guards**
> Task: Implement defensive states for state loading in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: type guards at the top of `normalizeState()` so `state.day1.matches` is always an array and `state.day2`/`state.day3` are always objects before the existing normalization runs; a try/catch around the init call sequence (`loadState()` through `updateScoreboard()`) that, on error, replaces `#page-scorecard`'s content with an `info-box` containing a "Reset & Reload" button which removes `wongaCup2026` and `wongaCup2026_lastSync` from localStorage and reloads. Ensure it matches the existing styling framework.

**Brief 4 — Offline write-queue persistence & poll reentrancy**
> Task: Implement defensive states for the Supabase sync layer in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: persist `pendingWrites` to localStorage (key `wongaCup2026_pendingWrites`) on every push/reassignment and rehydrate it at init (try/catch → `[]`), calling `updateOfflineIndicator()` immediately so the offline banner reflects owed writes after a reload; a `syncInFlight` boolean single-flight guard shared by the 30s `setInterval` poll and the Refresh button so `loadFromSupabase()`/`flushPendingWrites()` never overlap; a single module-level toast timer in `showSaveToast()` cleared at the top of each call. Ensure it matches the existing styling framework.

**Brief 5 — Focus-safe re-rendering & username-gate consistency**
> Task: Implement defensive states for input handling in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: guard every `input.value` write in `updateTeamNames()`, `restoreDay2()`, and `renderDay3()` with `document.activeElement !== el`, and make `refreshAllDays()` skip re-rendering while an `input`/`select` inside `#page-scorecard` has focus; wrap `setMatchPlayer()`'s body in `requireUsername(...)` like the other mutators; make `closeUsernameModal()` call `refreshAllDays()` so cancelled gated actions snap controls back to true state. Ensure it matches the existing styling framework.

**Brief 6 — Sync-row input validation (scoring.js)**
> Task: Implement defensive validation for synced rows in `scoring.js` (+ one render fix in `scorecard-live.html`). Using these target files: `[PASTE scoring.js AND scorecard-live.html HERE]`, add the following states: `parseIntOrNull()` returns `null` (never `NaN`) via a `Number.isInteger` check; `applyUpdateToState()` clamps `day3_stableford` values to an integer in 0–60 (else `null`) and `day2_score` to −20…20 before storing; `renderDay3()` interpolates the score into the input's `value` attribute through `escapeHtml(...)`. Add unit tests to `test/scoring.test.mjs` covering garbage strings, out-of-range numbers, and attribute-breakout payloads. Ensure it matches the existing code style (UMD module, no DOM in scoring.js).

**Brief 7 — Form feedback (team names, username, audio)**
> Task: Implement defensive states for forms and media in `scorecard-live.html`. Using this target file: `[PASTE scorecard-live.html HERE]`, add the following UI states: `saveTeamNames()` shows a red border plus `showSaveToast("Team name can't be empty", 'error')` when a trimmed field is blank instead of silently skipping it; a `role="alert"` inline error node in the username modal toggled by `confirmUsername()` with `aria-invalid` on the input; `.catch(() => {})` on both `bg-audio` `.play()` call sites. Ensure it matches the existing styling framework (`.username-modal-desc`, toast colors).

**Brief 8 — Course image fallbacks (index.html)**
> Task: Implement defensive states for course photos in `index.html`. Using this target file: `[PASTE index.html HERE]`, add the following UI states: replace the three `background-image` photo divs with real `<img>` elements using the `.course-img`/`.course-ph` loaded-class pattern already defined in `scorecard-live.html`'s stylesheet (placeholder visible by default, image revealed `onload`), copying those CSS rules into `styles.css` so both pages share them. Ensure it matches the existing styling framework.
