/* ─────────────────────────────────────
   SUPAMOCK — a PostgREST-subset stand-in for Supabase
   (issue #176, Step 1)

   Implements exactly the surface scorecard-live.html uses, and nothing
   more. Deliberately mirrors the production RLS *column* grants (see
   supabase/migrations/002): a `select=*`, or any select naming
   write_token, is rejected — so a regression that reintroduces `select=*`
   in the app fails loudly here instead of silently leaking the shared
   token in the real deployment.

   Fault injection (POST /__faults) exists so the harness can reproduce
   the conditions of issues #66/#114/#141: added latency, 500s, and the
   nastiest case of all — a write that LANDS but whose response never
   comes back, which is what makes "did my score save?" ambiguous for the
   retry queue.
───────────────────────────────────── */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { makeRng } from './rng.mjs';

const DEFAULT_WRITE_TOKEN = process.env.MOCK_WRITE_TOKEN || 'test-token';
const DEFAULT_ADMIN_TOKEN = process.env.MOCK_ADMIN_TOKEN || 'admin-token';

// PostgREST's own hard page cap for this table's queries. The app pages
// until it sees a short page (issue #110), so this MUST be enforced for
// the late-joiner replay path (T11) to be exercised at all.
const PAGE_CAP = 500;

export function createMock(opts = {}) {
  const writeToken = opts.writeToken || DEFAULT_WRITE_TOKEN;
  const adminToken = opts.adminToken || DEFAULT_ADMIN_TOKEN;

  let rows = [];
  let rng = makeRng(opts.seed ?? 'supamock');
  let faults = { latencyMs: 0, error500Rate: 0, dropRate: 0 };
  // Per-request journal — lets oracles cross-reference what each device
  // actually fetched/wrote against what it ended up believing.
  const journal = [];
  const hungSockets = new Set();

  // updated_at must be strictly increasing per row so the app's
  // (updated_at, id) ordering is total and replay order is unambiguous.
  // Real Postgres now() has microsecond resolution; JS Date.now() has
  // millisecond, and this harness inserts far faster than a real
  // tournament does, so ties would otherwise be common and the cursor
  // boundary logic (issue #111) would be exercised by an artifact of the
  // mock rather than by anything real. Monotonic counter fixes that while
  // staying a valid ISO timestamp.
  let lastMs = 0;
  function nextTimestamp() {
    const now = Date.now();
    lastMs = now > lastMs ? now : lastMs + 1;
    return new Date(lastMs).toISOString();
  }

  function json(res, status, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      ...headers
    });
    res.end(payload);
  }

  // Mirrors the RLS column grant: anon may SELECT every column EXCEPT
  // write_token, and must name its columns explicitly.
  const GRANTED_COLUMNS = new Set([
    'id', 'tournament_id', 'update_type', 'match_idx',
    'player_id', 'field_key', 'value', 'updated_by', 'updated_at'
  ]);

  function checkSelect(select) {
    if (!select) return { ok: false, why: 'no select= column list (bare * is denied)' };
    if (select.includes('*')) return { ok: false, why: 'select=* is denied by column grant' };
    const cols = select.split(',').map(s => s.trim());
    for (const c of cols) {
      if (!GRANTED_COLUMNS.has(c)) return { ok: false, why: `permission denied for column ${c}` };
    }
    return { ok: true, cols };
  }

  function project(row, cols) {
    const out = {};
    cols.forEach(c => { out[c] = row[c]; });
    return out;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (req.method === 'OPTIONS') return json(res, 204);

    /* ── control plane (not part of the emulated API) ── */
    if (path === '/__rows') return json(res, 200, rows);
    if (path === '/__journal') return json(res, 200, journal);
    if (path === '/__faults' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      faults = {
        latencyMs: body.latencyMs ?? 0,
        error500Rate: body.error500Rate ?? 0,
        dropRate: body.dropRate ?? 0
      };
      return json(res, 200, { ok: true, faults });
    }
    if (path === '/__seed' && req.method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      rng = makeRng(body.seed ?? 'supamock');
      return json(res, 200, { ok: true });
    }
    if (path === '/__reset' && req.method === 'POST') {
      rows = [];
      journal.length = 0;
      faults = { latencyMs: 0, error500Rate: 0, dropRate: 0 };
      return json(res, 200, { ok: true });
    }

    if (!path.startsWith('/rest/v1/')) return json(res, 404, { message: 'not found' });

    /* ── fault injection, applied to the emulated API only ── */
    if (faults.latencyMs > 0) await new Promise(r => setTimeout(r, faults.latencyMs));
    if (faults.error500Rate > 0 && rng.chance(faults.error500Rate)) {
      journal.push({ ts: Date.now(), path, method: req.method, fault: '500' });
      return json(res, 500, { message: 'injected server error' });
    }
    // Drop mode: for a POST the write is applied FIRST (below) and only
    // the response is withheld — that is the whole point, an ambiguous
    // write. For a GET we simply never answer.
    const dropThis = faults.dropRate > 0 && rng.chance(faults.dropRate);

    if (path === '/rest/v1/tournament_updates' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { message: 'invalid json' }); }

      if (body.write_token !== writeToken) {
        journal.push({ ts: Date.now(), path, method: 'POST', result: 'auth' });
        // Matches the shape the app's 'auth' classification keys off
        // (issue #141): a real answer with a 4xx, not a dropped socket.
        return json(res, 401, { code: '42501', message: 'new row violates row-level security policy' });
      }

      const row = {
        id: randomUUID(),
        tournament_id: body.tournament_id ?? null,
        update_type: body.update_type ?? null,
        match_idx: body.match_idx ?? null,
        player_id: body.player_id ?? null,
        field_key: body.field_key ?? null,
        value: body.value ?? null,
        updated_by: body.updated_by ?? null,
        write_token: body.write_token,
        updated_at: nextTimestamp()
      };
      rows.push(row);
      journal.push({ ts: Date.now(), path, method: 'POST', result: dropThis ? 'applied-then-dropped' : 'ok', id: row.id, by: row.updated_by, type: row.update_type });

      if (dropThis) {
        // Landed, but the client will never hear about it. Hold the
        // socket open so the client sees a hang (and eventually its own
        // timeout / navigation), not a clean connection reset.
        hungSockets.add(res);
        // unref'd: a hung socket must not by itself keep the process (or a
        // `node --test` run) alive for its full 60s timeout.
        setTimeout(() => { hungSockets.delete(res); try { res.destroy(); } catch {} }, 60000).unref();
        return;
      }

      const prefer = String(req.headers['prefer'] || '');
      if (prefer.includes('return=representation')) {
        const sel = checkSelect(url.searchParams.get('select'));
        if (!sel.ok) return json(res, 401, { message: sel.why });
        return json(res, 201, [project(row, sel.cols)]);
      }
      return json(res, 201, undefined);
    }

    if (path === '/rest/v1/tournament_updates' && req.method === 'GET') {
      const sel = checkSelect(url.searchParams.get('select'));
      if (!sel.ok) {
        journal.push({ ts: Date.now(), path, method: 'GET', result: 'select-denied', why: sel.why });
        return json(res, 401, { code: '42501', message: sel.why });
      }
      if (dropThis) {
        hungSockets.add(res);
        setTimeout(() => { hungSockets.delete(res); try { res.destroy(); } catch {} }, 60000).unref();
        return;
      }

      let out = rows;
      // Every filter the app actually sends: eq. on tournament_id /
      // update_type / match_idx / player_id / field_key (field history),
      // and gte. on updated_at (the sync cursor).
      for (const [key, raw] of url.searchParams.entries()) {
        if (['select', 'order', 'limit', 'offset'].includes(key)) continue;
        const m = /^(eq|gte|gt|lte|lt)\.(.*)$/s.exec(raw);
        if (!m) continue;
        const [, op, valRaw] = m;
        out = out.filter(r => {
          const v = r[key];
          if (op === 'eq') return String(v) === valRaw;
          if (op === 'gte') return String(v) >= valRaw;
          if (op === 'gt') return String(v) > valRaw;
          if (op === 'lte') return String(v) <= valRaw;
          if (op === 'lt') return String(v) < valRaw;
          return true;
        });
      }

      const order = url.searchParams.get('order') || 'updated_at.asc,id.asc';
      const terms = order.split(',').map(t => {
        const [col, dir] = t.split('.');
        return { col, desc: dir === 'desc' };
      });
      out = [...out].sort((x, y) => {
        for (const t of terms) {
          const a = String(x[t.col] ?? ''), b = String(y[t.col] ?? '');
          if (a < b) return t.desc ? 1 : -1;
          if (a > b) return t.desc ? -1 : 1;
        }
        return 0;
      });

      const askedLimit = parseInt(url.searchParams.get('limit') || String(PAGE_CAP), 10);
      const limit = Math.min(isNaN(askedLimit) ? PAGE_CAP : askedLimit, PAGE_CAP);
      out = out.slice(0, limit);

      journal.push({ ts: Date.now(), path, method: 'GET', result: 'ok', returned: out.length });
      return json(res, 200, out.map(r => project(r, sel.cols)));
    }

    if (path === '/rest/v1/rpc/rollback_tournament_updates' && req.method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch { return json(res, 400, { message: 'invalid json' }); }
      // Two distinct tokens, re-checked server-side (issue #146) — the
      // shared scoring PIN alone must never be enough to wipe the log.
      if (body.p_write_token !== writeToken) {
        return json(res, 401, { message: 'invalid write token' });
      }
      if (body.p_admin_token !== adminToken) {
        return json(res, 401, { message: 'invalid admin token' });
      }
      const before = rows.length;
      const cutoff = String(body.p_cutoff);
      rows = rows.filter(r => !(r.tournament_id === body.p_tournament_id && r.updated_at > cutoff));
      journal.push({ ts: Date.now(), path, method: 'POST', result: 'rollback', deleted: before - rows.length, cutoff });
      return json(res, 204, undefined);
    }

    return json(res, 404, { message: 'not found' });
  });

  return {
    server,
    listen: (port = 0) => new Promise(resolve => {
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise(resolve => {
      hungSockets.forEach(r => { try { r.destroy(); } catch {} });
      hungSockets.clear();
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
    get rows() { return rows; },
    get journal() { return journal; },
    setFaults: f => { faults = { latencyMs: 0, error500Rate: 0, dropRate: 0, ...f }; },
    reset: () => { rows = []; journal.length = 0; }
  };
}

// Standalone mode: `node supamock.mjs --port 5555 --seed 42`
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = name => {
    const i = process.argv.indexOf(`--${name}`);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const mock = createMock({ seed: arg('seed') });
  const port = await mock.listen(parseInt(arg('port') || '0', 10));
  console.log(`supamock listening on http://127.0.0.1:${port}`);
}
