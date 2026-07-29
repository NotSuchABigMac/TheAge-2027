/* ─────────────────────────────────────
   AGENTS (issue #176, Step 5)

   An agent expresses INTENTS. Every intent goes through mutateAction()
   before any DOM code runs, and the DOM code is identical for a clean
   action and a slipped one — the slip changes the coordinates or the
   value, never the gesture. That's what keeps the imperfection honest:
   there is no "slip path" that could behave differently from the real
   path for reasons other than the slip itself.
───────────────────────────────────── */
import { mutateAction, makeAgentRng } from './persona.mjs';
import { PLAYERS, shortOf } from './players.mjs';
import * as dom from './dom.mjs';

const DAY2_CODES = ['a4', 'a3', 'b4', 'b3'];

/* Maps an agent's action kind to the update_type the app writes for it.
   Purely for the write-count oracle's per-type breakdown: without it a
   count mismatch reports "unknown: -41" and tells you nothing about which
   path lost or duplicated a write. Actions that address a different
   update_type depending on context resolve it per call (see act()). */
export const UPDATE_TYPE_BY_KIND = {
  day1Hole: 'day1_hole',
  day2Hole: 'day2_hole',
  stableford: 'day3_stableford',
  day2Manual: 'day2_score',
  anthem: 'day2_anthem',
  teamMove: 'player_team',
  login: 'day2_anthem'
};

export class Agent {
  constructor({ name, playerId, role, phone, ledger, seed, slipScale = 1, log = () => {} }) {
    this.name = name;
    this.playerId = playerId;
    this.role = role;
    this.phone = phone;
    this.ledger = ledger;
    this.rng = makeAgentRng(seed, playerId);
    this.slipScale = slipScale;
    this.log = log;
    this.pendingCorrections = [];
    this.stopped = false;
    this.offline = false;
  }

  /* ── login ──
     Recorded in the ledger because the modal-summoning tap appends a real
     (no-op) day2_anthem row; an unrecorded row shows up in the oracle as
     a phantom duplicate write. */
  async login(token, { wrongFirst = null } = {}) {
    if (wrongFirst) {
      const r = await dom.loginWithWrongPin(this.phone, {
        name: this.name, wrongToken: wrongFirst, summonPlayerId: this.playerId
      });
      this.ledger.record({
        agent: this.name, kind: 'login', intent: { kind: 'login', updateType: 'day2_anthem' },
        performed: { kind: 'login', updateType: 'day2_anthem' },
        committed: false, note: `wrong-pin; modal-reopened=${r.reopened}`
      });
      this.wrongPinReopenedModal = r.reopened;
    }
    const { summoned } = await dom.login(this.phone, {
      name: this.name, token, summonPlayerId: this.playerId
    });
    if (summoned) {
      this.ledger.record({
        agent: this.name, kind: 'login', intent: { kind: 'login', updateType: 'day2_anthem' },
        performed: { kind: 'login', updateType: 'day2_anthem' },
        committed: true, note: 'modal-summon tap (anthem no-adjustment)'
      });
    }
    return { summoned };
  }

  /* ── the single funnel every action passes through ── */
  async act(intent, bounds, perform, { cascade = false, expectedValueRows = 1 } = {}) {
    if (this.stopped) return { committed: false, skipped: 'stopped' };
    intent = { ...intent, updateType: intent.updateType || UPDATE_TYPE_BY_KIND[intent.kind] || null };
    const m = mutateAction(this.rng, intent, { scale: this.slipScale, bounds });
    m.performed.updateType = intent.updateType;

    let committed = false;
    let note = null;
    try {
      const times = m.extra.repeat || 1;
      for (let i = 0; i < times; i++) {
        // A double-tap is two real commits of the same value. The second
        // one is a genuine duplicate write by the APP's reckoning too, so
        // the ledger records both — otherwise the write-count oracle
        // would report the app duplicating what the agent actually did
        // twice.
        const ok = await perform(m.performed);
        if (ok === false) { note = 'blocked-by-ui'; break; }
        committed = true;
        if (i + 1 < times) await this.phone.page.waitForTimeout(120);
        if (i > 0) {
          // The Day 1 nine-result control is a TOGGLE
          // (`match[half] === result ? null : result`), so tapping the
          // same button twice sets the value and then clears it — the
          // repeat writes a null, not a second copy of the value.
          this.ledger.record({
            agent: this.name, kind: intent.kind, intent, performed: m.performed,
            slipType: 'doubleTap', committed: true,
            expectedValueRows: intent.kind === 'toggle' ? 0 : 1,
            note: 'repeat-commit'
          });
        }
      }

      if (m.extra.reloadMidEntry) {
        await this.phone.page.reload({ waitUntil: 'domcontentloaded' });
        await dom.dismissMusicModal(this.phone.page);
        note = (note ? note + ';' : '') + 'reloaded-mid-entry';
      }
    } catch (e) {
      note = `error:${e.message.slice(0, 120)}`;
    }

    this.ledger.record({
      agent: this.name, kind: intent.kind, intent, performed: m.performed,
      slipType: m.slipType, willCorrect: m.willCorrect, committed, cascade,
      expectedValueRows,
      // A write made while this device was offline sits in the pending
      // queue, so it is NOT on the server when a rollback runs — it lands
      // afterwards and legitimately survives. Discounting it as
      // "deleted by the rollback" undercounts the expectation.
      queuedWhileOffline: this.offline === true,
      note
    });

    // A noticed slip becomes a scheduled future intent re-entering the
    // value that was meant, at the coordinates that were meant.
    if (committed && m.willCorrect) {
      this.pendingCorrections.push({
        dueAt: Date.now() + m.correctAfterMs,
        intent,
        bounds,
        perform,
        slipped: m.performed
      });
    }
    return { committed, slipType: m.slipType };
  }

  // Re-enters anything whose correction has come due. Called by the
  // scenario loop between actions, so corrections interleave with live
  // scoring exactly as they would on a real card.
  async runDueCorrections() {
    const now = Date.now();
    const due = this.pendingCorrections.filter(c => c.dueAt <= now);
    this.pendingCorrections = this.pendingCorrections.filter(c => c.dueAt > now);
    for (const c of due) {
      if (this.stopped) return;
      let committed = false;
      try { committed = (await c.perform(c.intent)) !== false; }
      catch { committed = false; }
      this.ledger.record({
        agent: this.name, kind: c.intent.kind, intent: c.intent, performed: c.intent,
        slipType: null, committed, note: 'correction'
      });
      // Clearing a slipped cell the agent wandered into: if the slip put
      // a score on the WRONG hole/row/card, correcting the right one
      // leaves the wrong one holding a bogus score. A real scorer
      // usually clears it — and when they don't, that stray score has to
      // stay consistent everywhere, which is the interesting case.
      const strayed = JSON.stringify(c.slipped.target) !== JSON.stringify(c.intent.target);
      if (strayed && this.rng.chance(0.7)) {
        let cleared = false;
        try { cleared = (await c.perform({ ...c.slipped, value: null })) !== false; }
        catch { cleared = false; }
        this.ledger.record({
          agent: this.name, kind: c.intent.kind, intent: { ...c.slipped, value: null },
          performed: { ...c.slipped, value: null }, slipType: null, committed: cleared,
          note: 'correction-clear-stray'
        });
      }
    }
  }

  /* ── Day 1 ── */
  async scoreDay1Hole(matchIdx, side, hole, gross, { cards = [matchIdx] } = {}) {
    return this.act(
      { kind: 'day1Hole', target: { card: matchIdx, side, hole }, value: gross },
      { holeMin: 1, holeMax: 18, cards },
      async p => {
        await dom.gotoTab(this.phone, 'day1');
        await dom.openDay1HoleGrid(this.phone, p.target.card);
        return dom.setDay1Hole(this.phone, p.target.card, p.target.side, p.target.hole, p.value);
      }
    );
  }

  async assignDay1Player(matchIdx, side, playerId, options) {
    return this.act(
      { kind: 'dropdown', updateType: 'day1_match', target: { card: matchIdx, side }, value: playerId },
      { options },
      async p => {
        await dom.gotoTab(this.phone, 'day1');
        return dom.setDay1MatchPlayer(this.phone, p.target.card, p.target.side, p.value);
      }
    );
  }

  async setNineResult(matchIdx, whichNine, result) {
    return this.act(
      { kind: 'toggle', updateType: 'day1_match', target: { card: matchIdx, nine: whichNine }, value: result },
      {},
      async p => {
        await dom.gotoTab(this.phone, 'day1');
        return dom.setDay1NineResult(this.phone, p.target.card, p.target.nine, p.value);
      }
    );
  }

  async clearNine(matchIdx, whichNine) {
    return this.act(
      { kind: 'admin', updateType: 'day1_hole', target: { card: matchIdx, nine: whichNine }, value: 'clear' },
      {},
      async () => {
        await dom.gotoTab(this.phone, 'day1');
        return dom.clearDay1Nine(this.phone, matchIdx, whichNine);
      },
      { cascade: true, expectedValueRows: 0 }
    );
  }

  /* ── Day 2 ── */
  async scoreDay2Hole(code, hole, gross, { cards = DAY2_CODES } = {}) {
    return this.act(
      { kind: 'day2Hole', target: { card: code, hole }, value: gross },
      { holeMin: 1, holeMax: 18, cards },
      async p => {
        await dom.gotoTab(this.phone, 'day2');
        await dom.openDay2HoleGrid(this.phone, p.target.card);
        return dom.setDay2Hole(this.phone, p.target.card, p.target.hole, p.value);
      }
    );
  }

  async assignDay2Group(playerId, code) {
    return this.act(
      { kind: 'dropdown', updateType: 'day2_group', target: { player: playerId }, value: code },
      { options: DAY2_CODES },
      async p => {
        await dom.gotoTab(this.phone, 'day2');
        return dom.setDay2Group(this.phone, shortOf(p.target.player), p.value);
      }
    );
  }

  async setDay2Manual(code, netToPar) {
    return this.act(
      { kind: 'day2Manual', target: { card: code }, value: netToPar },
      {},
      async p => {
        await dom.gotoTab(this.phone, 'day2');
        return dom.setDay2Manual(this.phone, p.target.card, p.value);
      }
    );
  }

  async setAnthem(playerId, sang) {
    return this.act(
      { kind: 'anthem', target: { player: playerId }, value: sang },
      {},
      async p => {
        await dom.gotoTab(this.phone, 'day2');
        return dom.setAnthem(this.phone, p.target.player, p.value);
      }
    );
  }

  /* ── Day 3 ── */
  async setStableford(playerId, score) {
    return this.act(
      { kind: 'stableford', target: { player: playerId }, value: score },
      {},
      async p => {
        await dom.gotoTab(this.phone, 'day3');
        return dom.setStableford(this.phone, p.target.player, p.value);
      }
    );
  }

  /* ── shared ── */
  async setNtp(day, holeKey, playerId) {
    const options = PLAYERS.map(p => p.id);
    return this.act(
      { kind: 'ntp', updateType: `day${day}_ntp`, target: { day, holeKey }, value: playerId },
      { options },
      async p => {
        await dom.gotoTab(this.phone, `day${p.target.day}`);
        return dom.setNtp(this.phone, p.target.day, p.target.holeKey, p.value);
      }
    );
  }

  // Saving names writes BOTH team_name rows every time (the app doesn't
  // diff them), so this is a cascade by the oracle's reckoning.
  async setTeamNames(nameA, nameB) {
    return this.act(
      { kind: 'admin', updateType: 'team_name', target: {}, value: `${nameA}|${nameB}` },
      {},
      async () => {
        await dom.gotoTab(this.phone, 'teams');
        await dom.setTeamName(this.phone, 'a', nameA);
        await this.phone.page.waitForTimeout(300);
        await dom.setTeamName(this.phone, 'b', nameB);
        return true;
      },
      { cascade: true, expectedValueRows: 4 }
    );
  }

  async toggleDayLock(day) {
    return this.act(
      { kind: 'admin', updateType: 'day_lock', target: { day }, value: 'toggle' },
      {},
      async () => {
        await dom.gotoTab(this.phone, `day${day}`);
        return dom.toggleDayLock(this.phone, day);
      },
      { cascade: true, expectedValueRows: 1 }
    );
  }

  async moveToTeam(playerId, team) {
    return this.act(
      { kind: 'teamMove', target: { player: playerId }, value: team },
      { options: ['A', 'B'] },
      async p => {
        await dom.gotoTab(this.phone, 'teams');
        const player = PLAYERS.find(x => x.id === p.target.player);
        return dom.assignTeam(this.phone, player.name, p.value);
      }
    );
  }

  /* ── idle browsing: what the 5 kibitzers mostly do ──
      Not decorative — tab switching and opening/closing <details> is
      exactly what exercises the #148 open-state and #143 focus paths
      against a live poll. */
  async browse() {
    if (this.stopped) return;
    const tab = this.rng.pick(['day1', 'day2', 'day3', 'day1', 'day2']);
    try {
      await dom.gotoTab(this.phone, tab);
      if (tab === 'day1' && this.rng.chance(0.4)) {
        await dom.openDay1HoleGrid(this.phone, this.rng.int(0, 5));
      } else if (tab === 'day2' && this.rng.chance(0.4)) {
        await dom.openDay2HoleGrid(this.phone, this.rng.pick(DAY2_CODES));
      }
      await dom.blur(this.phone);
    } catch { /* a tab hidden for this user, or a rebuild mid-click */ }
  }

  async goOffline() {
    this.offline = true;
    await this.phone.context.setOffline(true);
    this.ledger.record({ agent: this.name, kind: 'connectivity', committed: false, note: 'offline' });
  }

  async goOnline() {
    this.offline = false;
    await this.phone.context.setOffline(false);
    this.ledger.record({ agent: this.name, kind: 'connectivity', committed: false, note: 'online' });
  }

  stop() { this.stopped = true; }
}

/* ── role construction ──
   Mirrors §4 of the plan: 6 scorers (one per Day 1 match), 2 backseat
   scorers shadowing matches 2 and 5, 5 kibitzers, 1 admin (James, id 3 —
   the app gates the Admin tab on that exact name). */
export const ROLES = {
  scorer: 'scorer',
  backseat: 'backseat',
  kibitzer: 'kibitzer',
  admin: 'admin'
};

export function assignRoles() {
  const roles = new Map();
  // James McIntyre (id 3) must be the admin — updateAdminVisibility()
  // checks the literal name, so this is not a free choice.
  roles.set(3, ROLES.admin);
  const scorerIds = [1, 0, 2, 5, 6, 9];      // one per Day 1 match
  scorerIds.forEach(id => roles.set(id, ROLES.scorer));
  [7, 11].forEach(id => roles.set(id, ROLES.backseat));
  PLAYERS.forEach(p => { if (!roles.has(p.id)) roles.set(p.id, ROLES.kibitzer); });
  return roles;
}
