/* ─────────────────────────────────────
   ORCHESTRATOR (issue #176, Step 6)

   node test/stress/run.mjs [--seed X] [--slips 3] [--faults 2]
                            [--pace 800] [--days 1,2,3]

   Prints the seed first, always: without it a failure is a story you
   can't retell.
───────────────────────────────────── */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMock } from './supamock.mjs';
import { createStaticServer } from './server.mjs';
import { loadPlaywright } from './pw.mjs';
import { Ledger } from './persona.mjs';
import { Agent, assignRoles, ROLES } from './agents.mjs';
import { PLAYERS } from './players.mjs';
import * as dom from './dom.mjs';
import { runAll } from './oracles.mjs';
import { makeRng } from './rng.mjs';
import { loginPhase, day1, day2, day3 } from './scenario.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE_TOKEN = 'test-token';
const ADMIN_TOKEN = 'admin-token';
const POLL_MS = 30000;

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};

async function main() {
  const seed = argOf('seed', String(Date.now()));
  const slipScale = parseFloat(argOf('slips', '1'));
  const faultScale = parseFloat(argOf('faults', '1'));
  const pace = parseInt(argOf('pace', '1200'), 10);
  const days = String(argOf('days', '1,2,3')).split(',').map(Number);
  const runId = `run-${seed}-${Date.now()}`;
  const ledgerDir = path.join(HERE, 'ledger', runId);

  // First line, always.
  console.log(`seed=${seed} slips=${slipScale}x faults=${faultScale}x pace=${pace}ms days=${days.join(',')}`);
  console.log(`ledger: ${ledgerDir}`);

  const mock = createMock({ seed: `${seed}::mock`, writeToken: WRITE_TOKEN, adminToken: ADMIN_TOKEN });
  const mockPort = await mock.listen(0);
  const mockUrl = `http://127.0.0.1:${mockPort}`;
  const tournamentId = `wonga-stress-${runId}`;
  const site = createStaticServer({ mockUrl, tournamentId });
  const sitePort = await site.listen(0);
  const url = `http://127.0.0.1:${sitePort}/scorecard-live.html`;

  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch();
  const ledger = new Ledger(ledgerDir, { runId });
  const rng = makeRng(seed);
  const roles = assignRoles();
  const agents = [];
  const started = Date.now();
  let failure = null;
  let lateJoiner = null;

  const log = msg => console.log(`  [${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s] ${msg}`);

  // Fault scaling is applied centrally so --faults 2 doubles every
  // injected rate the scenario asks for, in one place.
  const mockCtl = {
    setFaults: f => mock.setFaults({
      latencyMs: (f.latencyMs || 0) * faultScale,
      error500Rate: Math.min(1, (f.error500Rate || 0) * faultScale),
      dropRate: Math.min(1, (f.dropRate || 0) * faultScale)
    })
  };

  try {
    /* ── cast: 14 phones ── */
    log('opening 14 phones...');
    for (const p of PLAYERS) {
      const errors = [];
      const phone = await dom.newPhone(browser, {
        name: p.name, url, errors,
        onDialog: async d => {
          // The admin PIN prompt must be answered with the real token;
          // everything else (stale-slot alerts, rollback/restore confirms)
          // is accepted, which is what the organiser would do.
          if (d.type() === 'prompt') return d.accept(ADMIN_TOKEN);
          return d.accept();
        }
      });
      agents.push(new Agent({
        name: p.name, playerId: p.id, role: roles.get(p.id),
        phone, ledger, seed, slipScale, log
      }));
    }

    const byRole = {
      scorer: agents.filter(a => a.role === ROLES.scorer),
      backseat: agents.filter(a => a.role === ROLES.backseat),
      kibitzer: agents.filter(a => a.role === ROLES.kibitzer),
      admin: agents.filter(a => a.role === ROLES.admin)
    };
    log(`roles — ${byRole.scorer.length} scorers, ${byRole.backseat.length} backseat, ${byRole.kibitzer.length} kibitzers, ${byRole.admin.length} admin`);

    const ctx = {
      agents, byRole, ledger, log, rng, pace, mockCtl, mockUrl,
      tournamentId, writeToken: WRITE_TOKEN, assertions: [],
      // Issue #212 (rollback does not clear other devices) is a real,
      // open app bug the harness found. This flag lets the rest of the
      // suite stay useful while it is outstanding — it is NOT a
      // suppression: without it, the run correctly fails.
      skipRollback: process.argv.includes('--skip-rollback')
    };

    /* A phase that throws must NOT cost us the oracles. The whole point
       of a run is the evidence it produces; losing every artifact because
       one selector moved is the worst possible failure mode. Record the
       crash as a failed assertion and carry on to the measurement. */
    const phase = async (name, fn) => {
      try { await fn(); }
      catch (e) {
        log(`PHASE "${name}" THREW: ${e.message.split('\n')[0]}`);
        ctx.assertions.push({ name: `phase ${name} completed`, ok: false, detail: e.message.split('\n')[0] });
      }
    };

    await phase('login', () => loginPhase(ctx));
    if (days.includes(1)) await phase('day1', () => day1(ctx));
    if (days.includes(2)) await phase('day2', () => day2(ctx));

    /* ── T11: the late joiner ──
       Opened before Day 3's finale so it has the whole log to replay,
       paginated, and must land on exactly the same board as everyone
       who watched it happen. */
    if (days.includes(3)) {
      log('late joiner opening with empty storage — must replay the whole log');
      const errors = [];
      const phone = await dom.newPhone(browser, { name: 'Late Joiner', url, errors });
      await dom.login(phone, { name: 'Spectator', token: WRITE_TOKEN, summonPlayerId: 0 });
      lateJoiner = { name: 'Late Joiner', phone };
      await phase('day3', () => day3(ctx));
    }

    /* ── quiescence ── */
    log('agents stopped; waiting for quiescence (queues drained + 2 poll cycles)');
    agents.forEach(a => a.stop());
    mock.setFaults({});
    const quiesced = await waitForQuiescence([...agents.map(a => a.phone), lateJoiner?.phone].filter(Boolean), log, mock);

    /* ── oracles ── */
    const devices = [];
    for (const a of agents) {
      const s = await dom.readLocalState(a.phone);
      devices.push({ agent: a.name, raw: s.state, pending: s.pending, lastSync: s.lastSync, errors: a.phone.errors, navigations: a.phone.navigations.count });
    }
    if (lateJoiner) {
      const s = await dom.readLocalState(lateJoiner.phone);
      devices.push({ agent: 'Late Joiner', raw: s.state, pending: s.pending, lastSync: s.lastSync, errors: lateJoiner.phone.errors, navigations: lateJoiner.phone.navigations.count });
    }

    const scoreboards = [];
    for (const a of agents.slice(0, 3)) {
      scoreboards.push({ agent: a.name, board: await dom.readScoreboard(a.phone) });
    }

    const result = runAll({
      devices, serverRows: mock.rows, ledgerLines: ledger.lines,
      scoreboards, rollbackCutoffs: ledger.rollbackCutoffs, journal: mock.journal
    });

    ctx.assertions.push({
      name: 'every device caught up to the newest row within the quiescence window',
      ok: quiesced.ok,
      detail: quiesced.ok ? 'all cursors reached the newest row' : 'TIMED OUT — a device never caught up'
    });
    const failedAssertions = ctx.assertions.filter(a => !a.ok);
    printReport(result, ledger, mock, ctx.assertions, devices);
    writeArtifacts(ledgerDir, { seed, result, devices, serverRows: mock.rows, assertions: ctx.assertions, journal: mock.journal });

    if (!result.ok || failedAssertions.length > 0) {
      failure = new Error(`${result.failures.length} oracle failure(s), ${failedAssertions.length} scenario assertion(s)`);
    }
  } catch (e) {
    failure = e;
    console.error('\nRUN THREW:', e.stack || e.message);
    try { writeArtifacts(ledgerDir, { seed, crash: String(e.stack || e.message), serverRows: mock.rows, journal: mock.journal }); } catch {}
  } finally {
    await browser.close().catch(() => {});
    await site.close().catch(() => {});
    await mock.close().catch(() => {});
  }

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (failure) {
    console.log(`\nSTRESS FAILED seed=${seed} after ${mins} min — artifacts in ${ledgerDir}`);
    process.exit(1);
  }
  console.log(`\nSTRESS OK seed=${seed} (${mins} min)`);
}

/* Quiescence, done properly.

   "Agents stopped + N poll cycles" is not enough, and the Day 1 shakeout
   proved it: the app flushed a queued write 37s AFTER the last agent
   action, and two devices simply hadn't polled again in the 29s that
   remained. The oracle duly reported a one-cell divergence that was
   nothing but the clock running out — a false failure, and the most
   expensive kind, because it looks exactly like the real bug this
   harness exists to find.

   The correct definition is a property, not a duration: every device's
   sync cursor has reached the newest row on the server, and no queue
   still holds anything. Both are observable, so wait for the property
   and let the timeout be a backstop rather than the mechanism.

   A device that genuinely CANNOT catch up inside the timeout is a real
   finding — reported, not silently waited out. */
async function waitForQuiescence(phones, log, mock) {
  const deadline = Date.now() + 240000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    const newest = mock.rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), '');
    const states = await Promise.all(
      phones.map(p => dom.readLocalState(p).catch(() => ({ pending: '[]', lastSync: null })))
    );

    let pending = 0, behind = 0;
    states.forEach(s => {
      try { pending += JSON.parse(s.pending || '[]').length; } catch { /* unparseable — treat as empty */ }
      if (newest && (!s.lastSync || s.lastSync < newest)) behind++;
    });

    if (pending === 0 && behind === 0) {
      log('  quiescent: all queues empty, every device caught up to the newest row');
      // One more poll period so a device that JUST caught up has also
      // rendered and persisted what it applied.
      await new Promise(r => setTimeout(r, 3000));
      return { ok: true };
    }
    if (Date.now() - lastReport > 10000) {
      log(`  waiting: ${pending} queued write(s), ${behind}/${states.length} device(s) behind the newest row`);
      lastReport = Date.now();
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  log('  QUIESCENCE TIMED OUT — some device never caught up (this is itself a finding)');
  return { ok: false };
}

function printReport(result, ledger, mock, assertions, devices) {
  const sum = ledger.summary();
  console.log('\n' + '─'.repeat(64));
  console.log(`rows on server : ${mock.rows.length}`);
  console.log(`ledger actions : ${sum.total} (${sum.committed} committed)`);
  console.log(`slips          : ${JSON.stringify(sum.bySlip)}`);
  console.log(`devices        : ${devices.length}`);
  const cursors = new Set(devices.map(d => d.lastSync));
  if (cursors.size > 1) {
    console.log(`sync cursors   : ${cursors.size} distinct values (devices are NOT all at the same point in the log)`);
    devices.forEach(d => console.log(`    ${d.lastSync} ${d.agent}`));
  }
  console.log('\nscenario assertions:');
  assertions.forEach(a => console.log(`  ${a.ok ? 'ok  ' : 'FAIL'} ${a.name} — ${a.detail}`));
  console.log('\noracles:');
  Object.entries(result.report).forEach(([name, r]) => console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${name}`));
  if (!result.ok) {
    console.log('\nfailures:');
    result.failures.slice(0, 25).forEach(f => console.log('  ' + JSON.stringify(f).slice(0, 600)));
    if (result.failures.length > 25) console.log(`  ... and ${result.failures.length - 25} more`);
  }
  console.log('─'.repeat(64));
}

function writeArtifacts(dir, payload) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(payload, null, 2));
}

main();
