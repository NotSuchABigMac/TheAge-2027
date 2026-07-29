/* ─────────────────────────────────────
   DOM PRIMITIVES (issue #176, Steps 2 & 5)

   The only layer that touches the page. Every selector here was read out
   of scorecard-live.html's render functions rather than guessed — see the
   comment above each group for which function emits it.

   Two rules this file exists to enforce:
     * agents interact only through real user gestures (click / fill /
       select), never by calling page JS or writing storage;
     * a commit fires the app's handler EXACTLY ONCE, so the "no lost or
       duplicated writes" oracle measures the app, not the harness.
───────────────────────────────────── */

export const NEUTRAL_BLUR_SELECTOR = '.masthead, header, body';

/* ── phone setup ── */

// One isolated browser context == one golfer's phone. Storage is
// per-context, so 14 of these are 14 genuinely independent devices.
export async function newPhone(browser, { name, url, errors = [], onDialog } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true
  });
  // The page pulls webfonts from fonts.googleapis.com. This sandbox has no
  // route to them, and a failed <link> produces console noise that would
  // drown the app-level errors the oracle actually cares about. Stubbing
  // them empty is also the more faithful simulation: a phone on a rural
  // course frequently can't reach a CDN either.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, route => {
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }).catch(() => {});
  });

  const page = await context.newPage();

  // Attached BEFORE the first navigation so nothing is missed (issue #176
  // Step 6: uncaught exceptions are a hard failure).
  page.on('pageerror', err => errors.push({ agent: name, kind: 'pageerror', message: err.message, stack: err.stack }));
  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push({ agent: name, kind: 'console.error', message: msg.text(), at: Date.now() });
    }
  });

  // The page uses alert() (stale Day 1 slot cleared), confirm() (rollback,
  // restore) and prompt() (admin PIN). Playwright auto-dismisses dialogs
  // unless handled — auto-dismiss would silently cancel every rollback and
  // restore, so these must be answered explicitly.
  page.on('dialog', async dialog => {
    if (onDialog) return onDialog(dialog);
    if (dialog.type() === 'prompt') return dialog.accept('admin-token');
    return dialog.accept();
  });

  const navigations = { count: 0 };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.count++; });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await dismissMusicModal(page);
  return { name, context, page, errors, navigations };
}

// Shown on first load (`if (!sessionStorage.getItem('musicConsented'))`)
// and it covers the whole viewport at z-index 99999 — every click would
// hit the backdrop until it's gone.
export async function dismissMusicModal(page) {
  const modal = page.locator('#music-modal');
  try {
    await modal.waitFor({ state: 'attached', timeout: 5000 });
    if (!(await modal.evaluate(el => el.classList.contains('hidden')))) {
      await page.locator('#music-modal .music-no').click();
    }
  } catch { /* never appeared (already consented this session) */ }
  await page.waitForFunction(
    () => document.getElementById('music-modal')?.classList.contains('hidden') !== false,
    null, { timeout: 5000 }
  ).catch(() => {});
}

/* ── login ──
   The page has no standalone sign-in control: requireUsername() summons
   the modal lazily, when an action needs an identity. So a genuine login
   is "tap something, get asked who you are, answer". We summon it with
   the Day 2 anthem "—" (no adjustment) button for the agent's own player,
   which is the one real gesture in the app whose effect on state is nil:
   setDay2Anthem(id, null) deletes a key that isn't there. It does append
   one no-op row to the log, which the ledger records honestly. */
export async function login(phone, { name, token, summonPlayerId = 0 }) {
  const { page } = phone;
  const modal = page.locator('#username-modal');
  const isHidden = await modal.evaluate(el => el.classList.contains('hidden'));
  if (isHidden) {
    await gotoTab(phone, 'day2');
    await page.locator('#day2-anthem .anthem-row').nth(summonPlayerId).locator('button').nth(1).click();
    await page.waitForFunction(
      () => !document.getElementById('username-modal').classList.contains('hidden'),
      null, { timeout: 5000 }
    );
  }
  await page.selectOption('#username-input', name);
  await page.fill('#write-token-input', token);
  await page.locator('#username-modal .username-btn').click();
  await page.waitForFunction(
    () => document.getElementById('username-modal').classList.contains('hidden'),
    null, { timeout: 5000 }
  );
}

// Whether the app has bounced this device back to the login modal — which
// is exactly what a wrong PIN must do (issue #141) rather than silently
// queueing writes as if offline.
export async function isLoginModalOpen(phone) {
  return !(await phone.page.locator('#username-modal').evaluate(el => el.classList.contains('hidden')));
}

/* ── tabs ── */
export async function gotoTab(phone, tab) {
  const btn = phone.page.locator(`#tab-${tab}`);
  if (await btn.evaluate(el => el.style.display === 'none')) {
    throw new Error(`tab ${tab} is hidden for this user`);
  }
  await btn.click();
  await phone.page.waitForTimeout(50);
}

/* ── Day 1 (renderDay1 / holeGridNineHtml) ── */

// Emitted by holeGridNineHtml as id="day1-in-<match>-<A|B>-<hole>".
export function day1HoleSelector(matchIdx, side, holeNum) {
  return `#day1-in-${matchIdx}-${side}-${holeNum}`;
}

export async function openDay1HoleGrid(phone, matchIdx) {
  const details = phone.page.locator(`#match-card-${matchIdx} details.hole-grid-details`);
  if (await details.count() === 0) return false;
  if (!(await details.evaluate(el => el.open))) {
    await details.locator('summary').click();
  }
  return true;
}

// The hole inputs are onchange, not oninput: the handler fires when the
// value is committed (blur / Enter), not per keystroke. fill() alone can
// leave the commit un-fired, and a stray extra blur can fire it twice —
// either way the write count stops matching the action count. commitOnce()
// below is the single place that resolves this, verified empirically by
// probe.mjs.
export async function setDay1Hole(phone, matchIdx, side, holeNum, gross) {
  const sel = day1HoleSelector(matchIdx, side, holeNum);
  const el = phone.page.locator(sel);
  if (await el.count() === 0) return false;
  await commitOnce(phone, el, gross);
  return true;
}

export async function clearDay1Nine(phone, matchIdx, whichNine /* 'front9'|'back9' */) {
  const idx = whichNine === 'front9' ? 0 : 1;
  const btn = phone.page.locator(`#match-card-${matchIdx} .nine-block`).nth(idx).locator('.clear-btn');
  if (await btn.count() === 0) return false;
  await btn.click();
  return true;
}

// The manual front9/back9 radiogroup — only rendered while that nine has
// NO hole data (issue #124 precedence). Buttons are in A / Tie / B order.
export async function setDay1NineResult(phone, matchIdx, whichNine, result /* 'A'|'T'|'B' */) {
  const idx = whichNine === 'front9' ? 0 : 1;
  const group = phone.page.locator(`#match-card-${matchIdx} .nine-block`).nth(idx).locator('.nine-toggle');
  if (await group.count() === 0) return false; // hole data exists: toggle is gone by design
  const pos = result === 'A' ? 0 : result === 'T' ? 1 : 2;
  await group.locator('button').nth(pos).click();
  return true;
}

// Team A's <select> lives in .player-group, team B's in .player-group.pb
// (renderDay1). Options carry the player id as their value.
export async function setDay1MatchPlayer(phone, matchIdx, side, playerId) {
  const groupSel = side === 'A'
    ? `#match-card-${matchIdx} .player-group:not(.pb) select`
    : `#match-card-${matchIdx} .player-group.pb select`;
  const el = phone.page.locator(groupSel);
  if (await el.count() === 0) return false;
  // A disabled option (player already used in another match, issue #147)
  // cannot be chosen through the UI — report that rather than throwing, so
  // the agent's slip is recorded as "tried, blocked" instead of crashing.
  const value = playerId === null ? '' : String(playerId);
  const selectable = await el.evaluate((sel, v) => {
    const opt = Array.from(sel.options).find(o => o.value === v);
    return !!opt && !opt.disabled;
  }, value);
  if (!selectable) return false;
  await el.selectOption(value);
  return true;
}

/* ── NTP selects (renderDay1Ntp / renderDay2Ntp / renderDay3Ntp) ── */
export async function setNtp(phone, day, holeKey, playerId) {
  const el = phone.page.locator(`#ntp-day${day}-${holeKey}`);
  if (await el.count() === 0) return false;
  await el.selectOption(playerId === null ? '' : String(playerId));
  return true;
}

/* ── Day 2 (renderDay2Groups / day2HoleGridNineHtml / renderDay2Anthem) ── */

// The group <select> rows are keyed by the player's short name, and the
// list is re-rendered on every change, so locating by text is both stable
// and the way a human finds their own row.
export async function setDay2Group(phone, playerShort, groupCode) {
  const row = phone.page.locator('#day2-groups .day2-group-row').filter({ hasText: playerShort });
  if (await row.count() === 0) return false;
  await row.first().locator('select').selectOption(groupCode === null ? '' : groupCode);
  return true;
}

export async function openDay2HoleGrid(phone, code) {
  const details = phone.page.locator(`#${code}-grid details`);
  if (await details.count() === 0) return false;
  if (!(await details.evaluate(el => el.open))) {
    await details.locator('summary').click();
  }
  return true;
}

// day2HoleGridNineHtml emits no ids — the 18 inputs are, in hole order,
// the .grid-in elements inside #<code>-grid (front nine table then back).
export async function setDay2Hole(phone, code, holeNum, gross) {
  const el = phone.page.locator(`#${code}-grid input.grid-in`).nth(holeNum - 1);
  if (await el.count() === 0) return false;
  await commitOnce(phone, el, gross);
  return true;
}

export async function clearDay2Group(phone, code) {
  const btn = phone.page.locator(`#${code}-derived .clear-btn`);
  if (await btn.count() === 0) return false;
  await btn.click();
  return true;
}

// The manual aggregate box (#<code>-score) is oninput, so a fill() is one
// commit per call with no blur needed.
export async function setDay2Manual(phone, code, netToPar) {
  const el = phone.page.locator(`#${code}-score`);
  if (await el.count() === 0) return false;
  if (await el.isHidden()) return false; // hole data exists — manual row is display:none
  await el.fill(netToPar === null ? '' : String(netToPar));
  return true;
}

// renderDay2Anthem lists PLAYERS in id order; buttons are Sang / — / Didn't.
export async function setAnthem(phone, playerId, sang /* true | null | false */) {
  const row = phone.page.locator('#day2-anthem .anthem-row').nth(playerId);
  if (await row.count() === 0) return false;
  const pos = sang === true ? 0 : sang === null ? 1 : 2;
  await row.locator('button').nth(pos).click();
  return true;
}

/* ── Day 3 (renderDay3) ──
   Rows re-sort by score on every render, so the ONLY stable handle is
   data-pid. The input is oninput: one fill == one commit. */
export async function setStableford(phone, playerId, score) {
  const el = phone.page.locator(`input.sf-in[data-pid="${playerId}"]`);
  if (await el.count() === 0) return false;
  await el.fill(score === null ? '' : String(score));
  return true;
}

/* ── Teams (renderTeams) ── */
export async function assignTeam(phone, playerName, team) {
  const { page } = phone;
  const item = page.locator('.team-player-item').filter({ hasText: playerName });
  if (await item.count() === 0) return false;
  const target = item.first();
  // An unassigned player has two buttons (→ A / → B); an assigned one has
  // a single move button whose label names the destination.
  const buttons = target.locator('button.move-btn');
  const n = await buttons.count();
  for (let i = 0; i < n; i++) {
    const label = (await buttons.nth(i).textContent() || '').trim();
    if (label.includes(team)) { await buttons.nth(i).click(); return true; }
  }
  return false;
}

export async function setTeamName(phone, side /* 'a'|'b' */, name) {
  await phone.page.fill(`#tn-input-${side}`, name);
  await phone.page.locator('button', { hasText: 'Save Names' }).first().click();
  return true;
}

/* ── Admin ── */
export async function toggleDayLock(phone, day) {
  const btn = phone.page.locator(`#day${day}-lock-row button`);
  if (await btn.count() === 0) return false;
  await btn.click();
  return true;
}

export async function rollback(phone, minutes) {
  const { page } = phone;
  await page.selectOption('#admin-rollback-minutes', String(minutes));
  await page.locator('button', { hasText: 'Rollback Scores' }).first().click();
  return true;
}

export async function showFieldHistory(phone, updateType, context = {}) {
  const { page } = phone;
  await page.selectOption('#history-type', updateType);
  await page.waitForTimeout(50);
  for (const [id, value] of Object.entries(context)) {
    const el = page.locator(`#history-ctx-${id}`);
    if (await el.count() > 0) await el.selectOption(String(value));
  }
  await page.locator('button', { hasText: 'Show History' }).first().click();
  await page.waitForTimeout(300);
  return page.locator('#history-results .restore-btn').count();
}

export async function restoreHistoryRow(phone, index = 0) {
  const btns = phone.page.locator('#history-results .restore-btn');
  if (await btns.count() <= index) return false;
  await btns.nth(index).click();
  return true;
}

/* ── the commit primitive ──
   Fires an onchange input's handler exactly once.

   Measured, not assumed (test/stress/probe.mjs): Playwright's fill()
   dispatches `input` but NOT `change` on these number inputs, so a fill
   alone writes nothing and the commit stays pending until focus leaves.
   Filling 18 holes in a row therefore produced 17 writes — every score
   landing one gesture late, and the last one never landing at all. The
   explicit blur below is what makes one agent gesture equal exactly one
   row, which every write-count oracle depends on.

   It is also the faithful model of the real gesture: a scorer tapping
   from one cell to the next blurs the previous cell, and that blur is
   what commits it. */
export async function commitOnce(phone, locator, value) {
  await locator.fill(value === null || value === undefined ? '' : String(value));
  // Blur the element itself rather than pressing Tab: Tab would focus
  // whatever cell happens to be next and commit-on-focus-change is exactly
  // the ambiguity we're eliminating here.
  await locator.evaluate(el => el.blur());
}

// Deliberately relinquishes focus, because several render paths in the app
// are focus-guarded (renderDay1, renderDay2AllGroupCards, renderDay3 all
// bail while a grid input has focus). An agent that never blurs would
// freeze its own view and mask real sync bugs.
export async function blur(phone) {
  await phone.page.evaluate(() => document.activeElement?.blur());
}

/* ── state readback (oracles only — never used to drive the app) ── */
export async function readLocalState(phone) {
  return phone.page.evaluate(() => ({
    state: localStorage.getItem('wongaCup2026'),
    lastSync: localStorage.getItem('wongaCup2026_lastSync'),
    pending: localStorage.getItem('wongaCup2026_pendingWrites'),
    handledRollbacks: localStorage.getItem('wongaCup2026_handledRollbacks')
  }));
}

export async function readScoreboard(phone) {
  return phone.page.evaluate(() => {
    const txt = id => document.getElementById(id)?.textContent?.trim() ?? null;
    return {
      day1A: txt('a-day1-total'), day1B: txt('b-day1-total'),
      day2A: txt('a-day2-total'), day2B: txt('b-day2-total'),
      day3A: txt('a-day3-total'), day3B: txt('b-day3-total'),
      grandA: txt('a-grand-total'), grandB: txt('b-grand-total')
    };
  });
}
