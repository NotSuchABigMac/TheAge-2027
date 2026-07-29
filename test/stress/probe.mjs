/* ─────────────────────────────────────
   COMMIT-ONCE PROBE (issue #176, trap list)

   The Day 1 / Day 2 hole grids commit on `change`, not `input`. If one
   agent gesture fires the handler twice, every "no lost or duplicated
   writes" oracle result is meaningless — the harness itself would be
   manufacturing the duplicates. This probe measures the real row count
   per gesture against the live page, so commitOnce() rests on evidence
   rather than on assumptions about Playwright's fill() semantics.

   Run: node test/stress/probe.mjs
───────────────────────────────────── */
import { createMock } from './supamock.mjs';
import { createStaticServer } from './server.mjs';
import { loadPlaywright } from './pw.mjs';
import {
  newPhone, login, gotoTab, setDay1MatchPlayer, openDay1HoleGrid,
  setDay1Hole, setDay2Group, openDay2HoleGrid, setDay2Hole, setStableford, blur
} from './dom.mjs';

const WRITE_TOKEN = 'test-token';
const results = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  results.push({ label, actual, expected, ok });
  console.log(`${ok ? '  ok' : 'FAIL'}  ${label}: ${actual} row(s), expected ${expected}`);
}

async function main() {
  const mock = createMock({ seed: 'probe', writeToken: WRITE_TOKEN });
  const mockPort = await mock.listen(0);
  const site = createStaticServer({ mockUrl: `http://127.0.0.1:${mockPort}`, tournamentId: 'wonga-stress-probe' });
  const sitePort = await site.listen(0);
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const errors = [];

  try {
    const phone = await newPhone(browser, { name: 'Gary King', url, errors });
    await login(phone, { name: 'Gary King', token: WRITE_TOKEN });

    /* Day 3 — oninput, the simple case. */
    await gotoTab(phone, 'day3');
    let before = mock.rows.length;
    await setStableford(phone, 1, 30);
    await phone.page.waitForTimeout(600);
    check('day3 stableford fill', mock.rows.length - before, 1);

    /* Day 1 — assign both players, then one hole score. */
    await gotoTab(phone, 'day1');
    before = mock.rows.length;
    await setDay1MatchPlayer(phone, 0, 'A', 0);
    await phone.page.waitForTimeout(400);
    check('day1 player assign (select)', mock.rows.length - before, 1);
    await setDay1MatchPlayer(phone, 0, 'B', 1);
    await phone.page.waitForTimeout(400);

    await openDay1HoleGrid(phone, 0);
    before = mock.rows.length;
    await setDay1Hole(phone, 0, 'A', 1, 5);
    await phone.page.waitForTimeout(600);
    check('day1 hole fill (onchange)', mock.rows.length - before, 1);

    // The blur that agents perform between holes must not re-fire change.
    before = mock.rows.length;
    await blur(phone);
    await phone.page.waitForTimeout(600);
    check('blur after a day1 hole commit', mock.rows.length - before, 0);

    // Two holes in sequence, the normal scoring rhythm.
    before = mock.rows.length;
    await setDay1Hole(phone, 0, 'A', 2, 4);
    await phone.page.waitForTimeout(300);
    await setDay1Hole(phone, 0, 'B', 2, 6);
    await phone.page.waitForTimeout(600);
    check('two consecutive day1 hole commits', mock.rows.length - before, 2);

    // Re-entering the SAME value: the app still writes (it doesn't dedupe),
    // so the ledger must count it. Verifying the direction of that
    // assumption matters more than the answer itself.
    before = mock.rows.length;
    await setDay1Hole(phone, 0, 'A', 2, 4);
    await phone.page.waitForTimeout(600);
    check('re-entering an identical day1 value', mock.rows.length - before, 0);

    /* Day 2 — group assignment then a scramble hole. */
    await gotoTab(phone, 'day2');
    for (const [short, code] of [['B. Cunningham', 'a4'], ['M. Smith', 'a4'], ['C. Woods', 'a4']]) {
      await setDay2Group(phone, short, code);
      await phone.page.waitForTimeout(250);
    }
    await openDay2HoleGrid(phone, 'a4');
    before = mock.rows.length;
    await setDay2Hole(phone, 'a4', 1, 4);
    await phone.page.waitForTimeout(600);
    check('day2 hole fill (onchange)', mock.rows.length - before, 1);

    before = mock.rows.length;
    await setDay2Hole(phone, 'a4', 2, 5);
    await phone.page.waitForTimeout(300);
    await setDay2Hole(phone, 'a4', 3, 3);
    await phone.page.waitForTimeout(600);
    check('two consecutive day2 hole commits', mock.rows.length - before, 2);

    const pageErrors = errors.filter(e => e.kind === 'pageerror');
    check('uncaught page errors', pageErrors.length, 0);
    if (pageErrors.length) console.log(pageErrors);
  } finally {
    await browser.close();
    await site.close();
    await mock.close();
  }

  const failed = results.filter(r => !r.ok);
  if (failed.length) {
    console.log(`\nPROBE FAILED — ${failed.length} of ${results.length} expectations wrong.`);
    console.log('commitOnce()/the agent layer must be adjusted to match observed behaviour.');
    process.exit(1);
  }
  console.log(`\nPROBE OK — ${results.length} expectations confirmed.`);
}

main();
