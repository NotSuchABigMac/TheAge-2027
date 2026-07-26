# Wonga Cup — Live Scorecard Security & Logic Audit

**Scope:** `scorecard-live.html`, `scoring.js`, Supabase `tournament_updates` sync architecture.
**Auditor role:** Lead Cybersecurity Architect / Principal Engineer.
**Verdict:** Two classes of tournament-day failure exist — (1) an **unauthenticated, publicly-writable backend** that lets anyone forge the live result, and (2) a **normal-usage data-corruption bug** on Day 2 that silently wipes the other team's scramble score. Both are fixable before go-live. Fix order: **SEC-01 → LOG-01 → SYNC-01 → the rest.**

---

## 1. Prioritized Issue Log

### 🔴 CRITICAL

---

#### `SEC-01: Unauthenticated public write to tournament_updates`
**Location:** `scorecard-live.html` lines 596–601 (embedded key), `sendUpdateRow()` lines 1438–1464.

**Vulnerability & Impact:** The Supabase publishable key ships in client JS and — per the code's own comment ("publicly-writable table", `scoring.js:18`) — anonymous `INSERT` is open. Anyone who loads the page can read the key from DevTools and `curl` arbitrary rows into the log: a forged `tiebreak=A`, bogus `day3_stableford` scores, or a `team_name` of their choosing, all of which every device replays as gospel within 30 seconds. There is no authentication; `updated_by` is a free-text label that proves nothing and `requireUsername()` is a client-side prompt an attacker never sees.

**Prescriptive Solution:** The publishable key is *designed* to be public — all integrity must live in **Row Level Security**, which client code cannot supply. Enforce these bounds in Supabase (not in the HTML):
1. **Enable RLS** on `tournament_updates` (default-deny).
2. **Gate writes behind a shared secret.** Add a `write_token text` column. Create a Postgres function / Edge Function that checks `token = <server-side secret>` before insert; expose *only* that RPC to `anon`. Remove the table's direct `INSERT` grant from `anon`.
3. Client sends the token (a tournament passphrase given only to the ~14 scorers) with each write. It is still technically extractable by a determined scorer, but it removes drive-by/anonymous-internet write access — the realistic threat for a public URL.
4. If an Edge Function is too heavy for this project, the minimum acceptable bound is an RLS `INSERT` policy: `WITH CHECK (write_token = current_setting('app.tournament_secret'))`.

Do **not** attempt to fix this in `scorecard-live.html` alone — a client-side check is not a control.

---

#### `SEC-02: Log is not provably append-only (erase/rewrite risk)`
**Location:** Supabase table policy (external); relied on by `loadFromSupabase()` line 1493 and `processUpdateRows()` `scoring.js:237`.

**Vulnerability & Impact:** The entire scoreboard is a replay of the `tournament_updates` history. If RLS grants `anon` `DELETE` or `UPDATE` (or RLS is disabled), one request wipes or rewrites the whole tournament mid-round, and clients that have already advanced their `LAST_SYNC_KEY` cursor will never re-fetch the deleted rows — the corruption is permanent per device. The app has no server-side audit trail or restore path.

**Prescriptive Solution:** Lock the table to insert-only for `anon`:
1. RLS: **no** `UPDATE` policy, **no** `DELETE` policy for `anon` (default-deny handles this once RLS is on — verify explicitly).
2. Revoke `UPDATE, DELETE` grants: `REVOKE UPDATE, DELETE ON tournament_updates FROM anon;`
3. Keep an owner-only (service-role) path for manual correction.
4. Because scoring is last-write-wins per field, a *mistaken* entry is corrected by writing a new row — deletes are never needed by the app and must be denied.

---

#### `LOG-01: Day 2 handler clobbers the opponent's scramble score with stale local state`
**Location:** `updateDay2()` lines 1155–1162.

**Vulnerability & Impact:** On every keystroke in *any* Day 2 box, the handler emits sync rows for **all four** fields (`a4, a3, b4, b3`) from this device's local state — including the two fields belonging to the *other* team. If Team B's scorer has just entered `b4 = -12` on their phone and Team A's scorer types into `a4` before that value has polled in (guaranteed within the 5s poll-skip window of SYNC-01), Team A's device writes `b4 = null`, and last-write-wins silently erases Team B's score on the shared board. This needs no attacker — it is the expected two-scorers-on-scramble-day workflow.

**Prescriptive Solution:** Emit **only the field that changed**, and only when it actually changed.
```
// HTML: pass the field id from each box
oninput="updateDay2('a4')"   // and 'a3','b4','b3' respectively

function updateDay2(changedId) {
  requireUsername(() => {
    const before = state.day2[changedId];
    _doUpdateDay2();                       // still recomputes badges/totals from DOM
    if (state.day2[changedId] !== before)  // guard: no-op keystrokes emit nothing
      insertUpdate('day2_score', { field_key: changedId, value: state.day2[changedId] });
  });
}
```
Bound of fix: a Day 2 input must **never** write a `field_key` other than the box the user touched.

---

### 🟠 HIGH

---

#### `SYNC-01: Poll-skip window starves all remote sync during active editing`
**Location:** auto-poll `setInterval` lines 1679–1690 (guard at 1681).

**Vulnerability & Impact:** To avoid wiping a half-typed input, the 30s poller `return`s entirely whenever a save happened in the last 5s — but that skip suppresses the *whole* `loadFromSupabase()` call, not just the re-render. A scorer entering scores in a steady rhythm keeps `lastSaveTime` fresh and therefore **stops pulling other devices' updates indefinitely**, and also never flushes queued offline writes (`flushPendingWrites`, line 1519) or clears the offline banner. The device drifts out of sync exactly when scoring is busiest.

**Prescriptive Solution:** Always fetch; protect only the focused input from being overwritten.
```
setInterval(() => {
  loadFromSupabase().then(success => { if (success) refreshAllDays(); });
}, 30000);

// In the render path, never clobber the element the user is typing in:
function safeSetInput(el, val) {
  if (el && document.activeElement !== el) el.value = val;
}
// Use safeSetInput in restoreDay2() and the Day 3 row update instead of el.value = ...
```
Bound of fix: remove the early `return`; the only thing sync must not touch is `document.activeElement`.

---

#### `SEC-03: No bounds validation on replayed rows — forged values yield unbounded points`
**Location:** `applyUpdateToState()` `scoring.js:261–319`; `day2GroupPoints()` `scoring.js:72–78`.

**Vulnerability & Impact:** Local inputs are clamped (Day 2 ±20, Day 3 0–60), but values arriving via sync are trusted verbatim. A single forged `day2_score` of `b4 = -999` makes `day2GroupPoints` award `abs(diff)` ≈ **987 points**; a forged `day3_stableford` or out-of-range `match_idx`/`player_id` is replayed without range checks. Combined with SEC-01 this turns one POST into an unwinnable scoreboard.

**Prescriptive Solution:** Re-apply the same clamps on the **read/apply** path, not just on input:
```
// in applyUpdateToState, before storing:
case 'day2_score':
  if (row.field_key) {
    const n = parseScoreToPar(v);
    state.day2[row.field_key] =
      n === null ? null : String(Math.max(-20, Math.min(20, n)));
  }
  break;
case 'day3_stableford':
  if (validPlayerId(row.player_id)) {           // 0..PLAYERS.length-1
    const n = parseIntOrNull(v);
    state.day3.scores[row.player_id] =
      n === null ? null : String(Math.max(0, Math.min(60, n)));
  }
  break;
// day1_match: reject match_idx outside 0..5 (already partially guarded by `!match`).
```
Bound of fix: every numeric field is clamped identically on input **and** on sync-apply; ids are range-checked before use.

---

### 🟡 MEDIUM

---

#### `SYNC-02: Initial load capped at 500 rows with no pagination loop`
**Location:** `loadFromSupabase()` line 1500 (`limit=500`), single call at 1673.

**Vulnerability & Impact:** A device joining late fetches the **oldest** 500 rows (`order=updated_at.asc`), advances the cursor, and only catches up 500 rows per 30s poll. Over a 3-day log that easily exceeds 500 edits, a freshly-opened phone shows a *stale, partial* scoreboard for up to several minutes before it converges.

**Prescriptive Solution:** Loop the fetch until a short page returns, before first render:
```
async function loadFromSupabase() {
  let advanced = false;
  while (true) {
    const rows = await fetchPage(localStorage.getItem(LAST_SYNC_KEY));  // limit 500
    if (!rows.length) break;
    const r = processUpdateRows(rows, applyUpdate);
    localStorage.setItem(LAST_SYNC_KEY, r.lastUpdatedAt);
    advanced = true;
    if (rows.length < 500) break;    // last page
  }
  return advanced;
}
```
Bound of fix: keep paging while a full 500-row page comes back; render once caught up.

---

#### `SYNC-03: Strict `gt.updated_at` cursor can permanently skip equal-timestamp rows`
**Location:** cursor query line 1500; cursor advance line 1516.

**Vulnerability & Impact:** The cursor stores the last row's `updated_at` and next poll requests `updated_at > cursor`. If a `limit`/batch boundary ever falls between two rows sharing an identical `updated_at`, the second is `> `-excluded forever and never applied. Rare (microsecond timestamps) but silent and unrecoverable when it hits.

**Prescriptive Solution:** Break ties with the primary key. Either order by `(updated_at, id)` and store both as the cursor, or overlap by re-fetching `>=` the last timestamp and de-duplicate applied `id`s client-side:
```
// track applied ids for the current cursor-second; request updated_at=gte.cursor
// skip any row whose id is already in the applied set.
```
Bound of fix: no committed row may be excluded solely because it shares a timestamp with the cursor.

---

#### `BUG-01: setMatchPlayer skips requireUsername — Day 1 assignments save locally but never sync`
**Location:** `setMatchPlayer()` lines 1057–1076 vs. every sibling (`setNineResult`, `setDay1Ntp`, `updateDay2`, `setStableford`) which wrap `requireUsername`.

**Vulnerability & Impact:** Because `insertUpdate` early-returns when `currentUsername` is null (line 1467), a scorer who assigns all six Day 1 matchups *before* entering a name gets no prompt, sees the picks saved to localStorage, but none of them ever reach Supabase — their board silently diverges from everyone else's.

**Prescriptive Solution:** Wrap the body in `requireUsername`, matching its siblings:
```
function setMatchPlayer(matchIdx, team, slot, val) {
  requireUsername(() => {
    // ...existing body unchanged...
  });
}
```
Bound of fix: any handler that calls `insertUpdate` must first pass through `requireUsername`.

---

## 2. Downstream Execution Briefs

> Each brief is self-contained for a zero-context coding model. Paste the named file where indicated.

---

### Brief — LOG-01 (Day 2 field clobber)
```
You are editing a single HTML file for a golf scorecard app. BUG: the Day 2
scramble handler emits sync writes for ALL FOUR score fields on every keystroke,
which overwrites the opposing team's freshly-entered score with this device's
stale value. FIX: emit only the field the user actually changed, and only if it
changed.

Steps:
1. Find the four Day 2 number inputs with ids "a4-score","a3-score","b4-score",
   "b3-score". Change each `oninput="updateDay2()"` to pass its own field id
   WITHOUT the "-score" suffix: oninput="updateDay2('a4')", 'a3', 'b4', 'b3'.
2. Replace the updateDay2 function with:

function updateDay2(changedId) {
  requireUsername(() => {
    const before = state.day2[changedId];
    _doUpdateDay2();
    if (state.day2[changedId] !== before) {
      insertUpdate('day2_score', { field_key: changedId, value: state.day2[changedId] });
    }
  });
}

3. Do not modify _doUpdateDay2 (it still reads all boxes to recompute totals).
4. Change nothing else.

[PASTE TARGET FILE HERE]  <-- scorecard-live.html
```

---

### Brief — SYNC-01 (poll starvation)
```
You are editing a single HTML file. BUG: a 30-second polling loop skips the
ENTIRE remote fetch whenever a local save happened in the last 5 seconds, so a
device being actively edited stops receiving other devices' updates. FIX: always
fetch; only avoid overwriting the input the user is currently typing in.

Steps:
1. Find the setInterval(...) block that contains
   `if (Date.now() - lastSaveTime < 5000) { ... return; }`. Replace the WHOLE
   interval body so it always polls:

setInterval(() => {
  loadFromSupabase().then((success) => { if (success) refreshAllDays(); })
                    .catch(e => console.error('Poll load error:', e));
}, 30000);

2. Add this helper near the other render helpers:

function safeSetInput(el, val) {
  if (el && document.activeElement !== el) el.value = val;
}

3. In restoreDay2(), replace `el.value = state.day2[id];` with
   `safeSetInput(el, state.day2[id]);`
4. In the Day 3 setStableford re-render and renderDay3, wherever an <input>'s
   `.value` is assigned from state, route it through safeSetInput.
5. Change nothing else.

[PASTE TARGET FILE HERE]  <-- scorecard-live.html
```

---

### Brief — SEC-03 (bounds on sync-apply)
```
You are editing a pure-JS scoring module (no DOM). HARDENING: values arriving
from the sync log are currently trusted verbatim, so a bad/forged row can store
out-of-range numbers that produce absurd point totals. FIX: clamp numeric fields
on the apply path exactly as they are clamped on input, and range-check ids.

In function applyUpdateToState(state, row), replace the 'day2_score' and
'day3_stableford' cases with:

case 'day2_score':
  if (row.field_key) {
    const n = parseScoreToPar(v);
    state.day2[row.field_key] = n === null ? null : String(Math.max(-20, Math.min(20, n)));
  }
  break;

case 'day3_stableford':
  if (row.player_id !== null && row.player_id !== undefined &&
      row.player_id >= 0 && row.player_id < 14) {
    const n = parseIntOrNull(v);
    state.day3.scores[row.player_id] = n === null ? null : String(Math.max(0, Math.min(60, n)));
  }
  break;

Also in the 'day1_match' case, after `const match = state.day1.matches[row.match_idx];`
add a guard so an out-of-range index is rejected:
  if (!(row.match_idx >= 0 && row.match_idx < 6)) break;

Do not change function signatures or exports. Change nothing else.

[PASTE TARGET FILE HERE]  <-- scoring.js
```

---

### Brief — BUG-01 (missing requireUsername)
```
You are editing a single HTML file. BUG: setMatchPlayer() mutates state and
calls insertUpdate() WITHOUT going through requireUsername(), unlike every other
scoring handler. Because insertUpdate() silently no-ops when no username is set,
Day 1 match assignments made before naming save locally but never sync.

FIX: wrap the entire existing body of setMatchPlayer in requireUsername(() => { ... }),
identical to how setNineResult does it. Keep all existing logic inside the wrapper
unchanged (id parsing, result invalidation, saveState, insertUpdate calls,
renderDay1, updateScoreboard). Change nothing else.

[PASTE TARGET FILE HERE]  <-- scorecard-live.html
```

---

### Brief — SEC-01 / SEC-02 (backend, no code file)
```
This is a Supabase configuration task, NOT a code edit — do not modify the HTML.
The table `tournament_updates` is written by a static site using a public
publishable key, so ALL integrity must be enforced by Row Level Security.

Apply in the Supabase SQL editor:

1. ALTER TABLE tournament_updates ENABLE ROW LEVEL SECURITY;
2. REVOKE UPDATE, DELETE ON tournament_updates FROM anon;
3. Add a column:  ALTER TABLE tournament_updates ADD COLUMN write_token text;
4. Create an INSERT-only policy that requires a shared secret:
   CREATE POLICY anon_insert_with_token ON tournament_updates
     FOR INSERT TO anon
     WITH CHECK (write_token = current_setting('app.tournament_secret', true));
   -- set the secret at the DB/role level, out of client reach.
5. Confirm there is NO SELECT/UPDATE/DELETE policy for anon beyond read
   (read-only SELECT is acceptable; UPDATE/DELETE must remain denied).
6. Verify: from an anonymous client, INSERT without the token must fail;
   UPDATE and DELETE must fail; SELECT may succeed.

The client must then send write_token with each insert (a passphrase shared only
with the scorers). This removes anonymous drive-by writes from the public URL.
```

---

*Prepared for the Wonga Cup 2026 build team. Fix SEC-01, LOG-01, and SYNC-01 before go-live; the rest are hardening.*
