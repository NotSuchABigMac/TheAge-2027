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
2. Run **all three** migrations in `supabase/migrations/`, in order,
   by hand, via the Supabase dashboard's SQL Editor:
   - `001_lock_down_tournament_updates.sql`
   - `002_restrict_write_token_column_and_admin_secret.sql`
   - `003_move_secrets_off_database_guc.sql`

   Nothing client-side applies these — this is a manual, one-time
   (per-project) setup step, and all three must land before the app is
   safe to point at the project.
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

## More

`ARCHITECTURE.md` covers the data model in depth: the transaction-log
sync design, the RLS lockdown, the rollback marker protocol, and where
each scoring rule (scramble handicap divisors, anthem house rule, etc.)
came from.
