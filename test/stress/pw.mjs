/* Resolves Playwright without adding it as a repo dependency (issue #176
   ground rule 3 — Node built-ins plus Playwright, nothing else). It's
   installed globally in this environment; fall back to a normal
   resolution if a local install ever exists. */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

let cached = null;

export async function loadPlaywright() {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  const candidates = [];
  try {
    candidates.push(require.resolve('playwright'));
  } catch { /* not local — try the global root below */ }
  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    candidates.push(`${globalRoot}/playwright/index.js`);
  } catch { /* npm unavailable — the local resolution above is all we have */ }

  for (const c of candidates) {
    try {
      const mod = await import(c);
      // Playwright is CommonJS: an ESM `import` of it exposes the real
      // exports under `default`, so `mod.chromium` is undefined and the
      // failure surfaces later as "cannot read 'launch' of undefined".
      cached = mod.chromium ? mod : mod.default;
      if (!cached?.chromium) throw new Error('no chromium export');
      return cached;
    } catch { /* try the next candidate */ }
  }
  throw new Error(
    'Could not resolve Playwright. It must be importable either locally or from `npm root -g`. ' +
    'Do NOT run `playwright install` — Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH.'
  );
}
