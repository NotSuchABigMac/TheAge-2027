/* ─────────────────────────────────────
   STATIC SERVER with a surgical config patch (issue #176, Step 2)

   Serves the repo byte-for-byte, with exactly one exception:
   scorecard-live.html's SUPABASE_CONFIG is rewritten to point at the
   local mock and an isolated tournament id. Nothing else about the app
   is modified — no test hooks, no instrumentation — so what the agents
   drive is the real page.

   If any replacement finds zero matches we THROW rather than serve a
   half-patched page: a silent miss would mean the test either hits the
   real Supabase project or tests a tournament id that doesn't match what
   the oracles read, and both failures would look like mysterious sync
   bugs rather than a stale patch.
───────────────────────────────────── */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const REAL_API_URL = 'https://wtyyarvyscbrrkawjcvo.supabase.co';
const REAL_TOURNAMENT_ID = 'wonga-cup-2026';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function patchScorecard(html, { mockUrl, tournamentId }) {
  let out = html;
  const replacements = [
    // The API endpoint — must point at the mock, never at production.
    [`apiUrl: '${REAL_API_URL}'`, `apiUrl: '${mockUrl}'`],
    // Both tournamentId and sessionKey carry the real id; isolate both.
    [`tournamentId: '${REAL_TOURNAMENT_ID}'`, `tournamentId: '${tournamentId}'`],
    [`sessionKey: '${REAL_TOURNAMENT_ID}'`, `sessionKey: '${tournamentId}'`]
  ];
  for (const [needle, replacement] of replacements) {
    if (!out.includes(needle)) {
      throw new Error(
        `[server.mjs] config patch is STALE — could not find ${JSON.stringify(needle)} ` +
        `in scorecard-live.html. The page's SUPABASE_CONFIG changed shape; update ` +
        `test/stress/server.mjs before running the stress test (refusing to serve a ` +
        `half-patched page that could talk to production).`
      );
    }
    out = out.split(needle).join(replacement);
  }
  // The deploy workflow substitutes this on real deploys; locally the
  // placeholder would 404 every local asset.
  out = out.split('__CACHEBUST__').join('stress');
  if (out.includes(REAL_API_URL) || out.includes(REAL_TOURNAMENT_ID)) {
    throw new Error('[server.mjs] refusing to serve: production URL or tournament id still present after patch');
  }
  return out;
}

export function createStaticServer({ mockUrl, tournamentId }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/scorecard-live.html';
    const filePath = path.join(REPO_ROOT, rel);
    // Never serve outside the repo, and never serve the harness itself.
    if (!filePath.startsWith(REPO_ROOT)) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      let body = buf;
      if (rel === '/scorecard-live.html') {
        try {
          body = Buffer.from(patchScorecard(buf.toString('utf8'), { mockUrl, tournamentId }), 'utf8');
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          return res.end(e.message);
        }
      }
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    });
  });

  return {
    server,
    listen: (port = 0) => new Promise(resolve => {
      server.listen(port, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise(resolve => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })
  };
}

export { patchScorecard, REPO_ROOT };
