/* ─────────────────────────────────────
   STAGE S0 SMOKE (issue #176, Step 5 / Checkpoint 5)

   3 scorers, 9 holes of Day 1, concurrently, with every slip probability
   zeroed. Proves the harness itself is not a source of divergence before
   any chaos is switched on — if S0 is flaky, every S1 failure is
   ambiguous and the whole exercise is worthless.

   Run: node test/stress/smoke.mjs [--seed X]
───────────────────────────────────── */
import { createMock } from './supamock.mjs';
import { createStaticServer } from './server.mjs';
import { loadPlaywright } from './pw.mjs';
import { Ledger } from './persona.mjs';
import { Agent } from './agents.mjs';
import { PLAYERS } from './players.mjs';
import * as dom from './dom.mjs';
import { runAll } from './oracles.mjs';
import { makeRng } from './rng.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE_TOKEN = 'test-token';

const argOf = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

async function main() {
  const seed = argOf('seed') || 's0-smoke';
  const runId = `smoke-${Date.now()}`;
  console.log(`S0 smoke — seed=${seed} runId=${runId}`);

  const mock = createMock({ seed, writeToken: WRITE_TOKEN });
  const mockPort = await mock.listen(0);
  const tournamentId = `wonga-stress-${runId}`;
  const site = createStaticServer({ mockUrl: `http://127.0.0.1:${mockPort}`, tournamentId });
  const sitePort = await site.listen(0);
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const ledger = new Ledger(path.join(HERE, 'ledger', runId), { runId });
  const rng = makeRng(seed);
  const agents = [];
  let failure = null;

  try {
    // Three scorers, each owning one Day 1 match.
    const spec = [
      { playerId: 1, match: 0, pA: 0, pB: 1 },
      { playerId: 2, match: 1, pA: 2, pB: 3 },
      { playerId: 5, match: 2, pA: 4, pB: 5 }
    ];

    for (const s of spec) {
      const player = PLAYERS.find(p => p.id === s.playerId);
      const errors = [];
      const phone = await dom.newPhone(browser, { name: player.name, url, errors });
      await dom.login(phone, { name: player.name, token: WRITE_TOKEN, summonPlayerId: s.playerId });
      agents.push(new Agent({
        name: player.name, playerId: s.playerId, role: 'scorer', phone, ledger,
        seed, slipScale: 0 // S0: no imperfection at all
      }));
    }

    // Assign both players in each match, from the owning scorer's device.
    for (let i = 0; i < spec.length; i++) {
      await agents[i].assignDay1Player(spec[i].match, 'A', spec[i].pA, PLAYERS.map(p => p.id));
      await agents[i].assignDay1Player(spec[i].match, 'B', spec[i].pB, PLAYERS.map(p => p.id));
    }
    await settle(agents, 2000);

    // Nine holes, all three matches concurrently — interleaved so writes
    // from different devices land inside each other's poll windows.
    for (let hole = 1; hole <= 9; hole++) {
      await Promise.all(agents.map(async (agent, i) => {
        await agent.scoreDay1Hole(spec[i].match, 'A', hole, rng.int(3, 7));
        await agent.scoreDay1Hole(spec[i].match, 'B', hole, rng.int(3, 7));
      }));
      await settle(agents, 400);
    }

    console.log('scoring done, waiting for quiescence...');
    agents.forEach(a => a.stop());
    // Two full poll cycles (30s each) so every device has certainly seen
    // every other device's writes.
    await waitForQuiescence(agents, 70000);

    const devices = await collectDevices(agents);
    const scoreboards = [];
    for (const a of agents) scoreboards.push({ agent: a.name, board: await dom.readScoreboard(a.phone) });

    const result = runAll({
      devices,
      serverRows: mock.rows,
      ledgerLines: ledger.lines,
      scoreboards,
      rollbackCutoffs: ledger.rollbackCutoffs
    });

    report(result, ledger, mock);
    if (!result.ok) failure = new Error(`${result.failures.length} oracle failure(s)`);
  } catch (e) {
    failure = e;
    console.error('S0 threw:', e.stack || e.message);
  } finally {
    await browser.close();
    await site.close();
    await mock.close();
  }

  if (failure) { console.log('\nS0 SMOKE FAILED'); process.exit(1); }
  console.log('\nS0 SMOKE OK');
}

async function settle(agents, ms) {
  await Promise.all(agents.map(a => a.runDueCorrections()));
  await new Promise(r => setTimeout(r, ms));
}

// Quiescence is not "agents stopped" — it's "every queued write has
// actually reached the server". Comparing devices before that reports a
// false convergence (they'd agree on state the server has never seen).
export async function waitForQuiescence(agents, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(agents.map(a => dom.readLocalState(a.phone)));
    const anyPending = states.some(s => {
      try { return JSON.parse(s.pending || '[]').length > 0; } catch { return false; }
    });
    if (!anyPending && Date.now() > deadline - maxMs + 65000) break;
    await new Promise(r => setTimeout(r, 2000));
  }
}

export async function collectDevices(agents) {
  const out = [];
  for (const a of agents) {
    const s = await dom.readLocalState(a.phone);
    out.push({
      agent: a.name, raw: s.state, pending: s.pending,
      errors: a.phone.errors, navigations: a.phone.navigations.count
    });
  }
  return out;
}

export function report(result, ledger, mock) {
  const sum = ledger.summary();
  console.log(`\nrows on server: ${mock.rows.length}`);
  console.log(`ledger: ${sum.total} actions, ${sum.committed} committed`);
  console.log(`slips: ${JSON.stringify(sum.bySlip)}`);
  console.log('\noracles:');
  Object.entries(result.report).forEach(([name, r]) => {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name}`);
  });
  if (!result.ok) {
    console.log('\nfailures:');
    result.failures.slice(0, 20).forEach(f => console.log('  ' + JSON.stringify(f)));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
