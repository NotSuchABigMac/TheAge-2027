/* Checkpoint 1 (issue #176 Step 1): prove the mock honours the exact
   contract scorecard-live.html depends on — including the RLS column
   grants it stands in for, and the drop-mode semantics the offline
   queue oracle is built on. */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMock } from './supamock.mjs';

const SAFE_COLUMNS = 'id,tournament_id,update_type,match_idx,player_id,field_key,value,updated_by,updated_at';
let mock, base;

before(async () => {
  mock = createMock({ seed: 'mock-test', writeToken: 'test-token', adminToken: 'admin-token' });
  const port = await mock.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(async () => { await mock.close(); });
beforeEach(() => { mock.reset(); mock.setFaults({}); });

function insert(overrides = {}) {
  return fetch(`${base}/rest/v1/tournament_updates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      tournament_id: 'wonga-stress-test',
      update_type: 'day3_stableford',
      player_id: 0,
      value: '30',
      updated_by: 'Tester',
      write_token: 'test-token',
      ...overrides
    })
  });
}

test('insert without a write token is rejected 401 (auth, not network)', async () => {
  const resp = await insert({ write_token: undefined });
  assert.equal(resp.status, 401);
  assert.equal(mock.rows.length, 0);
});

test('insert with the wrong write token is rejected 401', async () => {
  const resp = await insert({ write_token: 'nope' });
  assert.equal(resp.status, 401);
  assert.equal(mock.rows.length, 0);
});

test('insert with the right token is stored with an id and timestamp', async () => {
  const resp = await insert();
  assert.equal(resp.status, 201);
  assert.equal(mock.rows.length, 1);
  assert.match(mock.rows[0].id, /^[0-9a-f-]{36}$/);
  assert.match(mock.rows[0].updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('Prefer: return=representation with select=id returns just the id (rollback marker path)', async () => {
  const resp = await fetch(`${base}/rest/v1/tournament_updates?select=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify({ tournament_id: 't', update_type: 'rollback', value: 'x', write_token: 'test-token' })
  });
  assert.equal(resp.status, 201);
  const body = await resp.json();
  assert.equal(body.length, 1);
  assert.deepEqual(Object.keys(body[0]), ['id']);
});

test('select=* is denied — mirrors the RLS column grant (issue #105)', async () => {
  await insert();
  const resp = await fetch(`${base}/rest/v1/tournament_updates?select=*`);
  assert.equal(resp.status, 401);
});

test('a select naming write_token is denied — the shared secret is never readable', async () => {
  await insert();
  const resp = await fetch(`${base}/rest/v1/tournament_updates?select=id,write_token`);
  assert.equal(resp.status, 401);
});

test('the safe column list the app actually sends is allowed, and omits write_token', async () => {
  await insert();
  const resp = await fetch(`${base}/rest/v1/tournament_updates?select=${SAFE_COLUMNS}`);
  assert.equal(resp.status, 200);
  const body = await resp.json();
  assert.equal(body.length, 1);
  assert.ok(!('write_token' in body[0]), 'write_token must never be projected');
  assert.deepEqual(Object.keys(body[0]).sort(), SAFE_COLUMNS.split(',').sort());
});

test('gte cursor + eq filters + asc ordering behave like the sync query', async () => {
  await insert({ value: '1' });
  await insert({ value: '2' });
  await insert({ value: '3', tournament_id: 'other-tournament' });
  const all = mock.rows.filter(r => r.tournament_id === 'wonga-stress-test');
  const cursor = all[1].updated_at;

  const url = `${base}/rest/v1/tournament_updates?select=${SAFE_COLUMNS}` +
    `&tournament_id=eq.wonga-stress-test&updated_at=gte.${encodeURIComponent(cursor)}` +
    `&order=updated_at.asc,id.asc&limit=500`;
  const body = await (await fetch(url)).json();
  assert.equal(body.length, 1, 'gte is inclusive of the cursor row only');
  assert.equal(body[0].value, '2');
});

test('field-history query shape (eq. on player_id + desc order + limit) works', async () => {
  await insert({ player_id: 0, value: '10' });
  await insert({ player_id: 1, value: '20' });
  await insert({ player_id: 0, value: '30' });
  const url = `${base}/rest/v1/tournament_updates?select=${SAFE_COLUMNS}` +
    `&tournament_id=eq.wonga-stress-test&update_type=eq.day3_stableford` +
    `&player_id=eq.0&order=updated_at.desc&limit=200`;
  const body = await (await fetch(url)).json();
  assert.equal(body.length, 2);
  assert.equal(body[0].value, '30', 'newest first');
});

test('limit is capped at 500 even when a larger limit is requested', async () => {
  for (let i = 0; i < 600; i++) await insert({ value: String(i % 60) });
  const url = `${base}/rest/v1/tournament_updates?select=${SAFE_COLUMNS}&limit=1000`;
  const body = await (await fetch(url)).json();
  assert.equal(body.length, 500);
});

test('timestamps are strictly increasing so (updated_at,id) is a total order', async () => {
  for (let i = 0; i < 50; i++) await insert();
  const ts = mock.rows.map(r => r.updated_at);
  for (let i = 1; i < ts.length; i++) {
    assert.ok(ts[i] > ts[i - 1], `timestamp ${i} must be strictly after ${i - 1}`);
  }
});

test('rollback needs BOTH tokens and deletes only rows after the cutoff', async () => {
  await insert({ value: 'keep' });
  const cutoff = mock.rows[0].updated_at;
  await insert({ value: 'delete-me' });

  const wrongAdmin = await fetch(`${base}/rest/v1/rpc/rollback_tournament_updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_tournament_id: 'wonga-stress-test', p_cutoff: cutoff, p_write_token: 'test-token', p_admin_token: 'wrong' })
  });
  assert.equal(wrongAdmin.status, 401);
  assert.equal(mock.rows.length, 2, 'nothing deleted on a bad admin token');

  const wrongWrite = await fetch(`${base}/rest/v1/rpc/rollback_tournament_updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_tournament_id: 'wonga-stress-test', p_cutoff: cutoff, p_write_token: 'wrong', p_admin_token: 'admin-token' })
  });
  assert.equal(wrongWrite.status, 401);
  assert.equal(mock.rows.length, 2);

  const ok = await fetch(`${base}/rest/v1/rpc/rollback_tournament_updates`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_tournament_id: 'wonga-stress-test', p_cutoff: cutoff, p_write_token: 'test-token', p_admin_token: 'admin-token' })
  });
  assert.equal(ok.status, 204);
  assert.equal(mock.rows.length, 1);
  assert.equal(mock.rows[0].value, 'keep', 'the cutoff row itself survives (delete is > not >=)');
});

test('drop mode applies the write even though the response never arrives', async () => {
  mock.setFaults({ dropRate: 1 });
  const controller = new AbortController();
  const pending = insert({ value: 'ghost' }).catch(() => 'aborted');
  // Give the server time to apply the row, then give up on the response
  // the way a real client eventually would.
  await new Promise(r => setTimeout(r, 150));
  controller.abort();
  assert.equal(mock.rows.length, 1, 'the write landed');
  assert.equal(mock.rows[0].value, 'ghost');
  mock.setFaults({});
  void pending;
});

test('injected 500s are returned as real answers, not dropped sockets', async () => {
  mock.setFaults({ error500Rate: 1 });
  const resp = await insert();
  assert.equal(resp.status, 500);
  assert.equal(mock.rows.length, 0, 'a 500 must not apply the write');
});

test('unknown paths 404 rather than silently succeeding', async () => {
  const resp = await fetch(`${base}/rest/v1/tournament_scores`);
  assert.equal(resp.status, 404);
});
