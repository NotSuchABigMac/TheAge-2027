/* ── Issue #24: shared fetchWithTimeout()/fetchAllRows() ──
   These used to be duplicated (byte-for-byte, in fetchAllRows's case)
   across tv.html, ribbon-status.js and scorecard-live.html. Moved into
   scoring.js as pure, parameterised helpers so they get direct Node test
   coverage with a stub fetchImpl -- neither copy had that before. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fetchWithTimeout, fetchAllRows } = require('../scoring.js');

test('fetchWithTimeout resolves normally when fetch settles well within the timeout', async () => {
  global.fetch = async (url, options) => {
    assert.equal(options.signal instanceof AbortSignal, true);
    return { ok: true, status: 200 };
  };
  try {
    const resp = await fetchWithTimeout('http://example.test', {}, 5000);
    assert.equal(resp.ok, true);
  } finally { delete global.fetch; }
});

test('fetchWithTimeout aborts and rejects if fetch never settles before the timeout', async () => {
  global.fetch = (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  try {
    await assert.rejects(() => fetchWithTimeout('http://example.test', {}, 30));
  } finally { delete global.fetch; }
});

test('fetchWithTimeout falls back to a 15s default when no timeoutMs is given', async () => {
  let sawSignal = false;
  global.fetch = async (url, options) => { sawSignal = options.signal instanceof AbortSignal; return { ok: true }; };
  try {
    await fetchWithTimeout('http://example.test', {});
    assert.equal(sawSignal, true);
  } finally { delete global.fetch; }
});

function makeFetchImpl(pages) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url) => {
      calls.push(url);
      const page = pages.shift() || [];
      return { ok: true, json: async () => page };
    }
  };
}

test('fetchAllRows pages through results until a partial page ends the loop', async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ id: i, updated_at: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z` }));
  const partial = [{ id: 500, updated_at: '2026-01-01T00:10:00.000Z' }];
  const { fetchImpl, calls } = makeFetchImpl([full.slice(), partial.slice()]);
  const rows = await fetchAllRows({ baseUrl: 'https://x.test', apiKey: 'k', tournamentId: 't', columns: 'id,updated_at', fetchImpl });
  assert.equal(rows.length, 501);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /updated_at=gte\.1970-01-01T00%3A00%3A00\.000Z/);
});

test('fetchAllRows stops immediately on the first page if it is already under the page size', async () => {
  const { fetchImpl, calls } = makeFetchImpl([[{ id: 1, updated_at: '2026-01-01T00:00:00.000Z' }]]);
  const rows = await fetchAllRows({ baseUrl: 'https://x.test', apiKey: 'k', tournamentId: 't', columns: 'id,updated_at', fetchImpl });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
});

test('fetchAllRows throws on a non-ok response instead of silently returning partial data', async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  await assert.rejects(
    () => fetchAllRows({ baseUrl: 'https://x.test', apiKey: 'k', tournamentId: 't', columns: 'id', fetchImpl }),
    /HTTP 503/
  );
});

test('fetchAllRows: an explicit cursor starts the read from there instead of the epoch, for incremental callers', async () => {
  const { fetchImpl, calls } = makeFetchImpl([[{ id: 1, updated_at: '2026-08-09T12:00:00.000Z' }]]);
  const rows = await fetchAllRows({ baseUrl: 'https://x.test', apiKey: 'k', tournamentId: 't', columns: 'id,updated_at', fetchImpl, cursor: '2026-08-09T11:00:00.000Z' });
  assert.equal(rows.length, 1);
  assert.match(calls[0], /updated_at=gte\.2026-08-09T11%3A00%3A00\.000Z/);
});

test('fetchAllRows raises a bounded error instead of looping forever if every page shares one updated_at', async () => {
  const stuckImpl = async () => ({ ok: true, json: async () => Array.from({ length: 500 }, (_, i) => ({ id: i, updated_at: '2026-01-01T00:00:00.000Z' })) });
  await assert.rejects(
    () => fetchAllRows({ baseUrl: 'https://x.test', apiKey: 'k', tournamentId: 't', columns: 'id', fetchImpl: stuckImpl }),
    /exceeded \d+ pages/
  );
});
