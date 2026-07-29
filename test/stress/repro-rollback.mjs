/* ─────────────────────────────────────
   MINIMAL REPRODUCTION — rollback does not actually clear a device
   (found by the issue #176 stress harness, seed full-2)

   Two devices, a handful of scores, one admin rollback whose window
   covers every row. Afterwards the server holds nothing but the rollback
   marker — yet both devices still show the rolled-back scores.

   Run: node test/stress/repro-rollback.mjs
   Exits 0 if the app behaves correctly (state cleared), 1 if the bug
   reproduces.
───────────────────────────────────── */
import { createMock } from './supamock.mjs';
import { createStaticServer } from './server.mjs';
import { loadPlaywright } from './pw.mjs';
import * as dom from './dom.mjs';

const WRITE_TOKEN = 'test-token';
const ADMIN_TOKEN = 'admin-token';

async function main() {
  const mock = createMock({ seed: 'repro', writeToken: WRITE_TOKEN, adminToken: ADMIN_TOKEN });
  const mockPort = await mock.listen(0);
  const site = createStaticServer({
    mockUrl: `http://127.0.0.1:${mockPort}`, tournamentId: 'wonga-stress-repro'
  });
  const sitePort = await site.listen(0);
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  let reproduced = false;

  try {
    const errors = [];
    const onDialog = async d => (d.type() === 'prompt' ? d.accept(ADMIN_TOKEN) : d.accept());
    const admin = await dom.newPhone(browser, { name: 'James McIntyre', url, errors, onDialog });
    const scorer = await dom.newPhone(browser, { name: 'Gary King', url, errors, onDialog });
    await dom.login(admin, { name: 'James McIntyre', token: WRITE_TOKEN, summonPlayerId: 3 });
    await dom.login(scorer, { name: 'Gary King', token: WRITE_TOKEN, summonPlayerId: 1 });

    // Distinctive, easily-identified scores.
    console.log('1. entering scores...');
    await dom.gotoTab(scorer, 'day3');
    await dom.setStableford(scorer, 0, 41);
    await dom.setStableford(scorer, 1, 42);
    await dom.setStableford(scorer, 2, 43);
    await scorer.page.waitForTimeout(2000);

    // Let both devices sync so the state is genuinely shared, not local.
    console.log('2. waiting for both devices to sync...');
    await admin.page.waitForTimeout(32000);

    const before = JSON.parse((await dom.readLocalState(admin)).state);
    console.log(`   admin sees scores: ${JSON.stringify(before.day3.scores)}`);

    console.log('3. admin rolls back a window covering every row...');
    await dom.gotoTab(admin, 'admin');
    await dom.rollback(admin, 5);

    // Both devices should wipe and reload; give them a generous window.
    await admin.page.waitForTimeout(45000);

    const serverRows = mock.rows.filter(r => r.update_type !== 'rollback');
    console.log(`4. server now holds ${serverRows.length} non-marker row(s)`);

    const results = [];
    for (const [name, phone] of [['admin', admin], ['scorer', scorer]]) {
      const raw = (await dom.readLocalState(phone)).state;
      const st = raw ? JSON.parse(raw) : {};
      const scores = st.day3?.scores || {};
      const survivors = Object.entries(scores).filter(([, v]) => v !== null && v !== '' && v !== undefined);
      results.push({ name, survivors, navigations: phone.navigations.count });
      console.log(`   ${name}: navigations=${phone.navigations.count} day3.scores=${JSON.stringify(scores)}`);
    }

    const stillHolding = results.filter(r => r.survivors.length > 0);
    if (serverRows.length === 0 && stillHolding.length > 0) {
      reproduced = true;
      console.log('\n─────────────────────────────────────────────────────');
      console.log('BUG REPRODUCED');
      console.log('The server holds zero scoring rows after the rollback, yet');
      console.log(`${stillHolding.length} of ${results.length} device(s) still show the rolled-back scores.`);
      console.log('');
      console.log('Mechanism: applyUpdate() removes the four localStorage keys and');
      console.log('calls location.reload(), but a reload does not stop the JS that is');
      console.log('already running. Execution continues straight back into');
      console.log('loadFromSupabase(), which re-sets LAST_SYNC_KEY and');
      console.log('LAST_SYNC_IDS_KEY, and then into pollOnce -> refreshAllDays ->');
      console.log('renderTeams -> saveState(), which writes the still-intact');
      console.log('in-memory state back to wongaCup2026. Every key the handler just');
      console.log('deleted is restored before the page actually navigates, so the');
      console.log('reloaded page loads the pre-rollback state and simply replays the');
      console.log('surviving rows on top of it.');
      console.log('─────────────────────────────────────────────────────');
    } else if (serverRows.length === 0) {
      console.log('\nApp behaved correctly: every device cleared its rolled-back state.');
    } else {
      console.log(`\nINCONCLUSIVE: expected 0 surviving rows, found ${serverRows.length}.`);
    }
  } finally {
    await browser.close();
    await site.close();
    await mock.close();
  }
  process.exit(reproduced ? 1 : 0);
}

main();
