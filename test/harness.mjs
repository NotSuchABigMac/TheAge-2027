/* ─────────────────────────────────────
   SHARED REPRO-SCRIPT HARNESS

   The two helpers every test/repro-*.mjs script needs before it can do
   anything. Both were previously copy-pasted into all 59 of them --
   loadChromium() byte-identically 59 times (~1000 lines), fail() 58 times
   -- which is the shape that lets one copy drift silently, exactly what
   issue #6 is about for the scripts themselves.

   Deliberately NOT named repro-*.mjs: run-repro.sh globs `test/repro-*.mjs`
   and would try to execute this module as if it were a test. It's declared
   as a helper in test/workflow-repro-scripts.test.mjs's runner-partition
   assertion instead, so it can't be mistaken for an unrun test either.

   Scope is deliberately narrow. Each script's static file server stays its
   own, because they genuinely differ (different MIME maps, routes, and
   Supabase stubs per script) -- sharing those would mean a parameter for
   every difference, which is not an improvement.
───────────────────────────────────── */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

/* Resolve Playwright from a local install if there is one, otherwise from
   the global root (`npm install -g playwright`, which is what
   .github/workflows/repro-scripts.yml sets up -- this repo has no
   package.json by design, so there's no local node_modules/ to find).

   Throws rather than skipping when Playwright is missing: a repro script
   that silently no-ops when it can't find a browser is indistinguishable
   from one that passed, which would defeat the point of running them. */
export async function loadChromium() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  try { candidates.push(require.resolve('playwright')); } catch { /* no local install */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(`${globalRoot}/playwright/index.js`);
  } catch { /* npm unavailable */ }
  for (const c of candidates) {
    try {
      const mod = await import(c);
      const resolved = mod.chromium ? mod : mod.default;
      if (resolved?.chromium) return resolved.chromium;
    } catch { /* try the next candidate */ }
  }
  throw new Error('Could not resolve Playwright locally or via `npm root -g`.');
}

/* Report an assertion failure and abort the script. Logs before throwing so
   the reason is visible in run-repro.sh's per-script output even though the
   throw is what makes the process exit non-zero. */
export function fail(msg) {
  console.log('FAIL:', msg);
  throw new Error(msg);
}
