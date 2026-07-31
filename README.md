# Wonga Cup

A static site for the Wonga Cup golf tournament, with a Supabase-backed
live scorecard scorers update from their phones during play.

## Page map

| Page | Purpose |
|---|---|
| `index.html` | Homepage |
| `golfers.html` | Player list / handicaps |
| `format.html` | Tournament format, points system, house rules |
| `records.html` | Past results |
| `practical.html` | Logistics for the weekend |
| `scorecard-live.html` | The live scorecard — score entry, sync, admin tools |
| `tv.html` | Read-only clubhouse TV/spectator leaderboard (issue #187, first pass) |

Static data/logic modules (no DOM, `require()`-able from Node tests):
`scoring.js` (scoring math + sync/state helpers), `courses.js` (course
scorecards), `theme.js` (theme switcher, edit-mode tooling).

## Running tests

Requires Node 22 (no `package.json`/`node_modules` — this repo has zero
npm dependencies by design).

```
node --test test/*.test.mjs
```

A handful of `test/repro-*.mjs` scripts also exist for browser-driven
regression tests (Playwright); they're deliberately excluded from that
glob (no `.test.mjs` suffix) since they need a browser and aren't part of
the fast CI suite. Run one directly, e.g.:

```
node test/repro-212-rollback-race.mjs
```

## Deploys

Push to `trunk` → `.github/workflows/deploy.yml` publishes the repo root
to GitHub Pages. Before upload, it rewrites every `?v=__CACHEBUST__`
placeholder in the HTML's local `<link>`/`<script>` tags to the deploying
commit's short SHA, so a browser that cached an older `styles.css`/
`scorecard.css`/`theme.js`/`scoring.js`/`courses.js` is forced to refetch
the current one instead of running stale JS against fresh HTML.

## Supabase setup (runbook)

The live scorecard syncs through a Supabase project referenced in
`SUPABASE_CONFIG` (`scorecard-live.html`). The publishable key in that
config ships in the page source by design — it is not a secret, so
`supabase/migrations/` locks the table down at the database level instead.

1. Create the `tournament_updates` table (see **Data model** in
   `ARCHITECTURE.md` for the schema).
2. Run **all four** migrations in `supabase/migrations/`, in order,
   by hand, via the Supabase dashboard's SQL Editor:
   - `001_lock_down_tournament_updates.sql`
   - `002_restrict_write_token_column_and_admin_secret.sql`
   - `003_move_secrets_off_database_guc.sql`
   - `004_client_errors.sql`

   Nothing client-side applies these — this is a manual, one-time
   (per-project) setup step, and all four must land before the app is
   safe to point at the project (004 specifically is a prerequisite for
   error-beacon.js's inserts succeeding rather than failing RLS).
3. Set the two passphrases migration 003 expects:
   ```sql
   UPDATE app_secrets SET value = '...' WHERE key = 'tournament_secret';
   UPDATE app_secrets SET value = '...' WHERE key = 'admin_secret';
   ```
   Hand `tournament_secret` out to all scorers as the shared write token,
   and `admin_secret` to the organiser only, out-of-band (chat/in person)
   — neither is ever baked into the client bundle.

See `ARCHITECTURE.md` for why this shape (transaction log + `app_secrets`
+ `SECURITY DEFINER` functions) exists, and the history of what didn't
work before it.

## Backup & restore (issue #207)

Supabase's free tier gives ~7 days of point-in-time recovery at best.
`.github/workflows/snapshot.yml` runs `scripts/snapshot-tournament-updates.mjs`
on a schedule (daily year-round, every 2 hours during 7-9 Aug) and commits
`snapshots/tournament-updates.json` whenever it's actually changed —
a free, offsite, versioned, diffable backup of the whole log, using
only the anon key every device already has. Run it manually any time
via the Actions tab → "Nightly log snapshot" → Run workflow.

**To restore** a fresh Supabase project from a snapshot: run migrations
001-004 against it first (see above), then replay
`snapshots/tournament-updates.json` as a batch `INSERT` into
`tournament_updates` (any tool that can POST JSON works — the Supabase
dashboard's SQL editor with a generated `INSERT` statement, or a small
script hitting `/rest/v1/tournament_updates` with the **service-role**
key, since anon can't backfill historical `updated_at` values through
RLS the way a live client can). This works because the app's state is
a pure function of the log — `normalizeState`/`applyUpdateToState` in
`scoring.js` rebuild identical state from any complete row set, in any
order, replayed on any device. After the tournament weekend, the final
snapshot becomes the permanent 2026 archive.

## Offline app shell (issue #205)

`sw.js` precaches the live scorecard's own shell (`scorecard-live.html`,
its CSS/JS, and the fonts it needs) so a dead spot on the course — no
reception on the 14th tee — doesn't mean a white screen on open. Scoped
narrowly on purpose: not the brochure pages, images, or the background
music, just what's needed to keep scoring. Network-first with cache
fallback, so an online device always gets the freshest deploy; offline
devices get whatever shell was last cached. It never touches Supabase
requests — the app's own `pendingWrites` queue (see above) already owns
that problem.

Its cache name is versioned by the same `__CACHEBUST__` commit-SHA sed
substitution every `<script src>`/`<link>` tag already gets (see
`deploy.yml`), and `checkForUpdate()` (issue #196) keeps the SW
registration's own update check warm on the same 30s poll cadence, so a
new version is already installed and waiting by the time someone taps
the "Site updated" toast.

**Kill switch.** A broken service worker can brick every phone still
holding the old one, since it's what serves the shell the next time
they open the tab — worth having this written down *before* it's ever
needed, not looked up mid-incident:

1. Replace the contents of `sw.js` (repo root) with:
   ```js
   self.addEventListener('install', () => self.skipWaiting());
   self.addEventListener('activate', () => {
     self.registration.unregister()
       .then(() => self.clients.matchAll())
       .then((clients) => clients.forEach((client) => client.navigate(client.url)));
   });
   ```
2. Commit and push to `trunk` as normal — `deploy.yml`'s existing sed
   still cachebusts it, so every open tab picks up this new SW on its
   next poll cycle exactly like any other update, unregisters itself,
   and reloads straight from the network from then on.
3. Once every device has recovered, revert the commit to restore the
   real `sw.js` and redeploy — the cache name is per-version, so there's
   no stale-cache risk picking the offline shell back up afterward.

## More

`ARCHITECTURE.md` covers the data model in depth: the transaction-log
sync design, the RLS lockdown, the rollback marker protocol, and where
each scoring rule (scramble handicap divisors, anthem house rule, etc.)
came from.
