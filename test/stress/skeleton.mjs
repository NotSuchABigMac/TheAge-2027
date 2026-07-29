/* ─────────────────────────────────────
   WALKING SKELETON (issue #176, Step 2 / Checkpoint 2)

   One context, one login, one score, one assertion against the server
   log. Everything the full harness does is this, 14 times over, with
   slips. If this is flaky, nothing built on top of it can be trusted —
   so it is deliberately the smallest possible end-to-end slice.
───────────────────────────────────── */
import { createMock } from './supamock.mjs';
import { createStaticServer } from './server.mjs';
import { loadPlaywright } from './pw.mjs';
import { newPhone, login, gotoTab, setStableford } from './dom.mjs';

const WRITE_TOKEN = 'test-token';

async function main() {
  const mock = createMock({ seed: 'skeleton', writeToken: WRITE_TOKEN });
  const mockPort = await mock.listen(0);
  const tournamentId = 'wonga-stress-skeleton';
  const site = createStaticServer({ mockUrl: `http://127.0.0.1:${mockPort}`, tournamentId });
  const sitePort = await site.listen(0);
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const errors = [];
  let failed = null;

  try {
    const phone = await newPhone(browser, { name: 'Gary King', url, errors });
    await login(phone, { name: 'Gary King', token: WRITE_TOKEN });
    await gotoTab(phone, 'day3');
    await setStableford(phone, 0, 34);

    // Give the write a beat to land (insertUpdate is fire-and-forget from
    // the handler's point of view).
    await phone.page.waitForTimeout(1500);

    const rows = mock.rows.filter(r => r.update_type === 'day3_stableford');
    if (rows.length !== 1) throw new Error(`expected exactly 1 day3_stableford row, got ${rows.length}`);
    if (rows[0].player_id !== 0) throw new Error(`expected player_id 0, got ${rows[0].player_id}`);
    if (rows[0].value !== '34') throw new Error(`expected value "34", got ${JSON.stringify(rows[0].value)}`);
    if (rows[0].updated_by !== 'Gary King') throw new Error(`expected updated_by "Gary King", got ${rows[0].updated_by}`);
    if (rows[0].tournament_id !== tournamentId) throw new Error(`wrong tournament id: ${rows[0].tournament_id}`);
    if (errors.length > 0) throw new Error(`page errors: ${errors.map(e => e.message).join('; ')}`);
  } catch (e) {
    failed = e;
  } finally {
    await browser.close();
    await site.close();
    await mock.close();
  }

  if (failed) {
    console.error('SKELETON FAILED:', failed.message);
    process.exit(1);
  }
  console.log('SKELETON OK');
}

main();
