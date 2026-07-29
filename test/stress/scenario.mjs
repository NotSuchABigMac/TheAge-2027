/* ─────────────────────────────────────
   THE THREE-DAY SCENARIO (issue #176, Step 6)

   §5–§6 of test/STRESS_TEST_PLAN.md, executed. Each day is a function
   over the agent set; the orchestrator (run.mjs) supplies the cast, the
   mock's fault controls and the ledger.

   Timing is compressed by playing holes faster than golfers do, NOT by
   touching the app's 30s poll — the poll is the thing under test, so it
   must run at its real period. `--pace` scales the per-hole gap for a
   quicker (or slower, for S4 soak) run.
───────────────────────────────────── */
import { PLAYERS, FRIDAY_PLAYERS, shortOf } from './players.mjs';
import * as dom from './dom.mjs';

export const DAY2_CODES = ['a4', 'a3', 'b4', 'b3'];

// Six singles matches. Team A ids are even, B odd (the app's DEFAULT_A),
// and only `friday: true` players are eligible for Day 1.
export function day1Pairings() {
  const a = FRIDAY_PLAYERS.filter(p => [0, 2, 4, 6, 8, 10, 12].includes(p.id)).map(p => p.id);
  const b = FRIDAY_PLAYERS.filter(p => [1, 3, 5, 7, 9, 11, 13].includes(p.id)).map(p => p.id);
  const pairs = [];
  for (let i = 0; i < 6; i++) pairs.push({ match: i, pA: a[i] ?? null, pB: b[i] ?? null });
  return pairs;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tick(agents, ms) {
  // Corrections come due mid-round, exactly as they would on a real card.
  await Promise.all(agents.map(a => a.runDueCorrections().catch(() => {})));
  await sleep(ms);
}

// Kibitzers browse while everyone else scores — this is what exercises
// the #148 <details> open-state and #143 focus paths against live polls.
function startBrowsing(kibitzers, rng, stopSignal) {
  return (async () => {
    while (!stopSignal.stopped) {
      await Promise.all(kibitzers.map(k => k.browse().catch(() => {})));
      await sleep(rng.int(3000, 9000));
    }
  })();
}

/* ═══════════════ LOGIN & SETUP (§5) ═══════════════ */
export async function loginPhase(ctx) {
  const { agents, byRole, log, ledger, writeToken } = ctx;
  log('phase: login & setup');

  // One agent mistypes the PIN first. The app must reopen the login modal
  // (issue #141) rather than silently queue the write as if offline.
  const mistyper = byRole.scorer[0];
  await mistyper.login(writeToken, { wrongFirst: 'wrong-pin-9999' });
  ctx.assertions.push({
    name: 'wrong PIN reopens the login modal (#141)',
    ok: mistyper.wrongPinReopenedModal === true,
    detail: `modal reopened: ${mistyper.wrongPinReopenedModal}`
  });

  for (const a of agents) {
    if (a === mistyper) continue;
    await a.login(writeToken);
  }

  // Team names, including a standing XSS probe (issue #58).
  const admin = byRole.admin[0];
  await admin.setTeamNames('<img src=x onerror=alert(1)>', 'Team ⛳️ Golf');
  await sleep(400);

  // Captain's draft: the admin moves players while two kibitzers "help",
  // moving players the admin has just moved (T2).
  const helpers = byRole.kibitzer.slice(0, 2);
  const draft = [
    { id: 4, team: 'A' }, { id: 5, team: 'B' }, { id: 6, team: 'A' },
    { id: 7, team: 'B' }, { id: 12, team: 'A' }, { id: 13, team: 'B' }
  ];
  for (let i = 0; i < draft.length; i++) {
    const d = draft[i];
    await admin.moveToTeam(d.id, d.team);
    if (i % 2 === 0 && helpers[i % helpers.length]) {
      // Concurrent move of the SAME player from another device, inside one
      // poll window — the race issue #62/#71 exist to make survivable.
      helpers[i % helpers.length].moveToTeam(d.id, d.team === 'A' ? 'B' : 'A').catch(() => {});
    }
    await sleep(300);
  }
  await tick(agents, 3000);

  ctx.assertions.push({
    name: 'XSS team name rendered inert (#58)',
    ok: await admin.phone.page.evaluate(() => !document.querySelector('#team-a-list img, .sb-team-a img')),
    detail: 'no raw <img> element from the team name payload'
  });
}

/* ═══════════════ DAY 1 — MURRAY (§6) ═══════════════ */
export async function day1(ctx) {
  const { agents, byRole, mockCtl, log, rng, pace } = ctx;
  log('phase: day 1 — 6 singles matches, hole by hole');

  const pairs = day1Pairings();
  const scorers = byRole.scorer;
  const backseats = byRole.backseat;
  const stopSignal = { stopped: false };
  const browsing = startBrowsing(byRole.kibitzer, rng, stopSignal);

  // Assign both players in every match, one match per scorer.
  const eligible = FRIDAY_PLAYERS.map(p => p.id);
  for (let i = 0; i < 6; i++) {
    const scorer = scorers[i % scorers.length];
    if (pairs[i].pA !== null) await scorer.assignDay1Player(i, 'A', pairs[i].pA, eligible);
    if (pairs[i].pB !== null) await scorer.assignDay1Player(i, 'B', pairs[i].pB, eligible);
    await sleep(200);
  }
  await tick(agents, 3000);

  // Backseat scorers shadow matches 2 and 5 (0-indexed 1 and 4), lagging
  // 1–3 holes and sometimes disagreeing — last write must win everywhere.
  const shadowOf = { [backseats[0]?.name]: 1, [backseats[1]?.name]: 4 };
  const lag = { [backseats[0]?.name]: 2, [backseats[1]?.name]: 3 };

  for (let hole = 1; hole <= 18; hole++) {
    await Promise.all(scorers.map(async (scorer, i) => {
      const match = i;
      if (pairs[match].pA === null || pairs[match].pB === null) return;
      await scorer.scoreDay1Hole(match, 'A', hole, rng.int(3, 8), { cards: [0, 1, 2, 3, 4, 5] });
      await scorer.scoreDay1Hole(match, 'B', hole, rng.int(3, 8), { cards: [0, 1, 2, 3, 4, 5] });
    }));

    await Promise.all(backseats.map(async bs => {
      const match = shadowOf[bs.name];
      const h = hole - (lag[bs.name] || 2);
      if (h < 1 || match === undefined) return;
      // Deliberately disagrees a fraction of the time: two devices with
      // different numbers for the same cell, resolved by log order alone.
      await bs.scoreDay1Hole(match, rng.chance(0.5) ? 'A' : 'B', h, rng.int(3, 8), { cards: [0, 1, 2, 3, 4, 5] });
    }));

    /* scheduled disruptions */
    if (hole === 6) {
      log('  hole 6: scorer 3 goes offline for the next 4 holes');
      await scorers[2].goOffline();
    }
    if (hole === 10) {
      log('  hole 10: scorer 3 reconnects — queue flush');
      await scorers[2].goOnline();
    }
    if (hole === 9) {
      log('  hole 9: admin sets a manual back-9 result on match 6 (T9 precedence)');
      // Match 6 (index 5) has no hole data yet at the back nine, so the
      // manual toggle is still live. Hole scores arrive later and must
      // take precedence.
      await byRole.admin[0].setNineResult(5, 'back9', rng.pick(['A', 'B', 'T']));
    }
    if (hole === 12) {
      log('  hole 12: 20% of write responses dropped for the next 90s');
      mockCtl.setFaults({ dropRate: 0.2 });
    }
    if (hole === 15) {
      mockCtl.setFaults({});
      log('  hole 15: wire healed');
    }
    if (hole === 14) {
      log('  hole 14: clearing match 6 back-9 hole scores (escape hatch)');
      await byRole.admin[0].clearNine(5, 'back9');
    }

    await tick(agents, pace);
  }

  // NTP: one kibitzer sets the wrong player, then corrects.
  const kib = byRole.kibitzer[0];
  await kib.setNtp(1, 'h8', rng.pick(eligible));
  await sleep(500);
  await kib.setNtp(1, 'h17', rng.pick(eligible));
  await tick(agents, 2000);

  // Lock Day 1 while a backseat scorer still has writes in flight (T10).
  log('  end of day: locking Day 1 with writes still in flight');
  if (backseats[0]) backseats[0].scoreDay1Hole(1, 'A', 18, rng.int(3, 8)).catch(() => {});
  await byRole.admin[0].toggleDayLock(1);
  await tick(agents, 4000);

  stopSignal.stopped = true;
  await browsing;
}

/* ═══════════════ DAY 2 — BLACK BULL (§6) ═══════════════ */
export async function day2(ctx) {
  const { agents, byRole, mockCtl, log, rng, pace } = ctx;
  log('phase: day 2 — 4-group Ambrose scramble');

  const admin = byRole.admin[0];
  const stopSignal = { stopped: false };
  const browsing = startBrowsing(byRole.kibitzer.slice(2), rng, stopSignal);

  // Build the four groups. A kibitzer concurrently moves a player between
  // groups mid-build (T2 for day2_group).
  const groups = {
    a4: [0, 2, 4, 6], a3: [8, 10, 12],
    b4: [1, 3, 5, 7], b3: [9, 11, 13]
  };
  for (const [code, ids] of Object.entries(groups)) {
    for (const id of ids) {
      await admin.assignDay2Group(id, code);
      await sleep(150);
    }
  }
  // The interference: same player, different group, from another device.
  byRole.kibitzer[0].assignDay2Group(6, 'a3').catch(() => {});
  await tick(agents, 3000);
  // Admin puts them back where they belong — the last write in log order.
  await admin.assignDay2Group(6, 'a4');
  await tick(agents, 2000);

  // Anthem toggles for all 14; two get toggled twice from different
  // devices inside one poll window, one is set on the wrong player and
  // corrected. Every one of these re-derives a group handicap.
  for (const p of PLAYERS) {
    const owner = byRole.scorer[p.id % byRole.scorer.length];
    await owner.setAnthem(p.id, rng.chance(0.5));
    await sleep(120);
  }
  byRole.kibitzer[0].setAnthem(3, true).catch(() => {});
  byRole.kibitzer[1].setAnthem(3, false).catch(() => {});
  byRole.kibitzer[2]?.setAnthem(9, true).catch(() => {});
  await tick(agents, 3000);

  // Four scorers, one group each.
  const groupScorers = byRole.scorer.slice(0, 4);
  for (let hole = 1; hole <= 18; hole++) {
    await Promise.all(groupScorers.map(async (scorer, i) => {
      await scorer.scoreDay2Hole(DAY2_CODES[i], hole, rng.int(3, 6), { cards: DAY2_CODES });
    }));

    if (hole === 7) {
      log('  hole 7: 5s latency on every request for the next 2 min');
      mockCtl.setFaults({ latencyMs: 5000 });
    }
    if (hole === 11) {
      mockCtl.setFaults({});
      log('  hole 11: latency cleared');
    }
    if (hole === 9) {
      // Duty handoff: a different device takes over group b3's card.
      log('  hole 9: group b3 scoring duty hands off to another device');
      ctx.b3Owner = byRole.backseat[0];
    }
    if (hole > 9 && ctx.b3Owner) {
      await ctx.b3Owner.scoreDay2Hole('b3', hole, rng.int(3, 6), { cards: DAY2_CODES });
    }
    if (hole === 13) {
      log('  hole 13: a kibitzer types a manual group score mid-round (T9)');
      await byRole.kibitzer[0].setDay2Manual('a3', rng.int(-12, -4));
    }
    if (hole === 16) {
      log('  hole 16: a scorer force-reloads mid-entry');
      await groupScorers[1].phone.page.reload({ waitUntil: 'domcontentloaded' });
      await dom.dismissMusicModal(groupScorers[1].phone.page);
      ctx.ledger.record({ agent: groupScorers[1].name, kind: 'connectivity', committed: false, note: 'scenario force-reload mid-entry' });
    }

    await tick(agents, pace);
  }

  await byRole.kibitzer[0].setNtp(2, 'h4', rng.pick(PLAYERS.map(p => p.id)));
  await byRole.kibitzer[1].setNtp(2, 'h16', rng.pick(PLAYERS.map(p => p.id)));
  await tick(agents, 3000);

  stopSignal.stopped = true;
  await browsing;
}

/* ═══════════════ DAY 3 — LAKE + THE CHAOS FINALE (§6) ═══════════════ */
export async function day3(ctx) {
  const { agents, byRole, log, rng, mockCtl, ledger, tournamentId, writeToken } = ctx;
  log('phase: day 3 — stableford burst, forged rows, rollback finale');

  // Everyone finishes around the same time in reality: a burst, not a
  // trickle. Three deliberate ties (including one spanning a fractional
  // shared-points boundary) and two out-of-range entries for the clamps.
  const scores = [34, 31, 31, 29, 40, 27, 31, 25, 22, 36, 36, 19, 75, -3];
  await Promise.all(PLAYERS.map(async (p, i) => {
    const owner = byRole.scorer[i % byRole.scorer.length];
    await owner.setStableford(p.id, scores[i]);
  }));
  await tick(agents, 4000);

  await byRole.kibitzer[0].setNtp(3, 'h7', rng.pick(PLAYERS.map(p => p.id)));
  await byRole.kibitzer[1].setNtp(3, 'h14', rng.pick(PLAYERS.map(p => p.id)));
  await tick(agents, 3000);

  /* ── T8: forged rows, posted straight at the backend ──
     Any phone-holder has the shared write token, so these are writes the
     real deployment genuinely permits. Every device must skip them, keep
     polling, and stay converged (#63/#109/#120). */
  log('  forged-row probe: 7 hostile rows with a VALID token');
  const forged = [
    { update_type: 'day2_score', field_key: 'ntp', value: 'gotcha' },
    { update_type: 'day1_match', match_idx: 99, field_key: 'pA', value: '3' },
    { update_type: 'day1_match', match_idx: 0, field_key: '__proto__', value: 'polluted' },
    { update_type: 'day3_stableford', player_id: 0, value: 'NaN' },
    { update_type: 'day3_stableford', player_id: 999, value: '50' },
    { update_type: 'not_a_real_type', field_key: 'x', value: 'y' },
    { update_type: 'day1_hole', match_idx: 0, field_key: 'A1', value: '9999' }
  ];
  for (const f of forged) {
    await fetch(`${ctx.mockUrl}/rest/v1/tournament_updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        tournament_id: tournamentId, updated_by: 'forged', write_token: writeToken,
        match_idx: null, player_id: null, field_key: null, value: null, ...f
      })
    }).catch(() => {});
    ledger.record({ agent: 'forged', kind: 'forged', committed: false, note: JSON.stringify(f) });
  }
  // Two full polls so every device has certainly ingested them.
  await tick(agents, 65000);

  ctx.assertions.push({
    name: 'prototype not polluted by a forged __proto__ field_key (#120)',
    ok: await byRole.admin[0].phone.page.evaluate(() => ({}).polluted === undefined),
    detail: 'Object.prototype.polluted must be undefined'
  });

  /* ── T6: rollback under fire ── */
  log('  rollback finale: one device offline holding queued writes');
  const offlineVictim = byRole.scorer[3];
  await offlineVictim.goOffline();
  await offlineVictim.setStableford(11, 44); // queues locally, never sent
  await sleep(1500);

  const admin = byRole.admin[0];
  await dom.gotoTab(admin.phone, 'admin');
  const cutoffIso = new Date(Date.now() - 10 * 60000).toISOString();
  ledger.recordRollback(cutoffIso);
  await dom.rollback(admin.phone, 10);
  log('  rollback issued — waiting for every device to wipe and reload');
  await sleep(20000);

  await offlineVictim.goOnline();
  await tick(agents, 40000);

  /* ── T7: restores via Field History ── */
  log('  admin restores three historic rows');
  await dom.gotoTab(admin.phone, 'admin');
  const restores = [
    { type: 'day3_stableford', ctx: { player: 0 } },
    { type: 'day1_ntp', ctx: { fieldkey: 'h8' } },
    { type: 'player_team', ctx: { player: 4 } }
  ];
  for (const r of restores) {
    try {
      const n = await dom.showFieldHistory(admin.phone, r.type, r.ctx);
      if (n > 0) {
        await dom.restoreHistoryRow(admin.phone, 0);
        ledger.record({ agent: admin.name, kind: 'restore', committed: true, cascade: true, expectedValueRows: null, performed: { updateType: r.type, value: 'restored' }, note: r.type });
        await sleep(1200);
      }
    } catch { /* nothing in history for this field after the rollback */ }
  }

  // team_assign must be non-restorable (legacy snapshot, issue #71).
  try {
    await admin.phone.page.selectOption('#history-type', 'team_assign');
    await sleep(200);
    await admin.phone.page.locator('button', { hasText: 'Show History' }).first().click();
    await sleep(800);
    const restorable = await admin.phone.page.locator('#history-results .restore-btn').count();
    ctx.assertions.push({
      name: 'team_assign rows are not restorable (#71)',
      ok: restorable === 0,
      detail: `${restorable} restore buttons offered`
    });
  } catch { /* picker unavailable */ }

  await tick(agents, 5000);

  // Re-enter the scores the rollback removed.
  log('  re-entering post-rollback scores');
  await Promise.all(PLAYERS.slice(0, 8).map(async (p, i) => {
    const owner = byRole.scorer[i % byRole.scorer.length];
    await owner.setStableford(p.id, scores[i]);
  }));
  await tick(agents, 5000);
}
