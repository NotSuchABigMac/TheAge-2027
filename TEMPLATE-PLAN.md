# Template conversion plan

How to turn this site from "the Wonga Cup 2026 site, copied" into a
tournament template: one config file per edition for our own weekends,
and a sellable product if that's worth doing.

Read alongside `ARCHITECTURE.md` — this plan doesn't restate the sync
design, it just says which parts of it are edition-specific and which
aren't.

---

## 1. What is actually hardcoded

The site copied cleanly into this repo, which hides how much of it is
2026-specific. Three layers, with wildly different conversion costs.

### Layer A — data pretending to be code (cheap)

Small, well-isolated, already in DOM-free modules. This is the layer
that makes goal 1 (rebuild for a new weekend) easy.

| What | Where |
|---|---|
| Player roster, handicaps, seeds, `friday:` late-arrival flag | `players.js` (whole file) |
| Course scorecards, ratings, slopes | `courses.js` `COURSES` |
| Nearest-the-pin holes | `courses.js` `NTP_HOLES` |
| Tournament dates → day mapping | `scoring.js:34` `TOURNAMENT_DAY_DATES` |
| Countdown/final cutover date | `scoring.js:1426`, `scoring.js:1439` |
| Day-1 tee-off instant | `scorecard-live.html:7727` |
| Supabase project + `tournamentId` | `scorecard-live.html:1650` |
| ~20 `localStorage`/`sessionStorage` keys carrying `wongaCup2026` | `scorecard-live.html:1656`–`7240` |
| Admin allowlist | `scorecard-live.html:1901` `ADMIN_NAMES` |
| Default team split (even/odd player ids) | `scorecard-live.html:1980` |
| Course hero images | `scorecard-live.html:2087` `COURSE_IMAGES` |
| Photo album link | `scorecard-live.html:1985` |
| Supabase project + tournament id, again | `scripts/snapshot-tournament-updates.mjs:31` |
| Backup schedule pinned to 7–9 August | `.github/workflows/snapshot.yml:12` |

One structural wrinkle worth naming: `courses.js` is keyed by **day
number**, not course identity — `COURSES[1]` means "the course played on
day 1", and `courseForDay()` cements that. A template needs a course
*library* keyed by course, plus a schedule that points at it. Two
editions at the same venue should share one transcribed scorecard.

### Layer B — branding and prose (medium, tedious)

- "Wonga" appears 64× in `scorecard-live.html`, ~20× in each brochure
  page, and in CSS class names and storage keys.
- The nav is hand-duplicated in **7 pages × 2 blocks** (desktop `<nav>` +
  `.mobile-menu`). `site.js` extracted the *behaviour* in issue #182 but
  not the markup.
- `format.html`, `practical.html` and `index2026.html` are narrative
  prose with edition facts welded in: "Cayden Woods & Ben Lepore join the
  field Saturday", "Holes 4, 5 and 6 are the self-styled Bull Ring",
  check-in times, the Silly Goose Hat. Some of that is *config* (who
  arrives late), some is *house voice* (the Bull Ring) and some is *this
  group's in-jokes* (Silly Goose, the anthem rule). Those three need
  different treatment — see §5.

### Layer C — the format is the schema (expensive)

This is the real work, and the reason to stage the project rather than
attempt it in one pass.

The three formats aren't configuration, they're the data model:

- State is literally `state.day1` / `state.day2` / `state.day3`, each a
  different shape (matches / groups / per-player scores).
- All 19 `update_type` values are day-prefixed: `day1_hole`, `day2_anthem`,
  `day3_washout`, …
- Day 2 assumes exactly two teams each fielding a 4-ball and a 3-ball —
  `GROUP_CODES = ['a4','a3','b4','b3']` (`scoring.js:2245`,
  `scorecard-live.html:4335`). Fourteen players is baked into the group
  codes, not just the roster.
- `day1`/`day2`/`day3` appear ~353× in `scoring.js` and ~677× in
  `scorecard-live.html`.

Changing *dates and courses* is a config problem. Changing *"three days,
two teams, matchplay + scramble + Stableford"* is a rewrite of the state
machine. Don't conflate them, and don't price them the same.

---

## 2. The one architectural decision

Today there is no build step: `deploy.yml` runs a `sed` for
`__CACHEBUST__` and copies an explicit file list. Zero npm dependencies,
by design (`CLAUDE.md`).

**Recommendation: add a tiny zero-dependency Node build step, run in
`deploy.yml` alongside the existing `sed`.** ~150 lines of Node, no
package.json, no npm install. It reads `tournament.config.js`, expands
`{{tokens}}` and `<!--#include-->` partials into HTML, and writes to
`_site/`.

Why not the two alternatives:

- **Runtime config injection** (ship `config.js`, populate the DOM on
  load) keeps the no-build purity but pushes brand text into JS, which
  breaks the no-JS fallback, hurts SEO on the brochure pages, and causes
  a flash of unbranded content on the exact pages a prospective buyer
  looks at first.
- **A real static site generator** (Eleventy/Astro) is the right answer
  for a product with ten customers and the wrong answer for a repo whose
  main virtue is that it has no dependency tree to rot between August
  weekends.

The build step must keep `_site/` byte-identical-in-spirit to today's
output, so the service worker, cachebusting and offline shell keep
working unchanged.

---

## 3. Target layout

```
tournament.config.js      ← the one file you edit per edition
content/
  courses/murray.js         course library, keyed by course
  courses/black-bull.js
  copy/format.md            brochure prose, tokenised
  copy/practical.md
partials/
  head.html  masthead.html  nav.html  footer.html
formats/                    (stage 3 only)
  matchplay-singles.js
  scramble-teams.js
  stableford-individual.js
build.mjs                 ← ~150 lines, no dependencies
```

Sketch of the config — the thing that should be the entire per-edition
diff:

```js
export default {
  brand: {
    name: 'The A.G.E.', year: 2027, domain: 'theage.golf',
    cupName: 'The A.G.E. Cup', tagline: '…',
    storageNamespace: 'age2027',      // replaces every wongaCup2026 key
  },
  supabase: { url: '…', publishableKey: '…', tournamentId: 'age-2027' },
  timezone: 'Australia/Melbourne',
  days: [
    { date: '2027-08-06', course: 'murray',     format: 'matchplay-singles',
      teeOff: '12:00', ntp: [8, 17] },
    { date: '2027-08-07', course: 'black-bull', format: 'scramble-teams',
      teeOff: '12:00', ntp: [4, 16] },
    { date: '2027-08-08', course: 'lake',       format: 'stableford-individual',
      teeOff: '10:00', ntp: [7, 14] },
  ],
  teams: { count: 2, draft: 'captains-snake' },
  players: [ /* moved out of players.js unchanged */ ],
  admins: ['James McIntyre', 'Scott Rumbelow', 'Nathan Freestun'],
  houseRules: { anthem: true, sillyGoose: true, captainsChallenge: true },
  links: { photoAlbum: '…' },
};
```

---

## 4. Stage 1 — one config file runs the weekend

**This is the whole of goal 1.** Format structure stays hardcoded to
three days / two teams. Nothing in this stage requires knowing whether
we ever sell it.

1. **Create `tournament.config.js`** with today's 2026 values, and a
   `config.test.mjs` that asserts shape (3 days, dates ascending, every
   `course` resolves, every player id unique and contiguous).
2. **Re-key the course library.** `courses.js` becomes a loader over
   `content/courses/*.js`; `courseForDay(day)` becomes
   `courseForDay(day, config)`. Keep the printed OUT/IN/TOT cross-check
   in `test/courses.test.mjs` — it's caught transcription errors before.
3. **Make dates injectable.** `TOURNAMENT_DAY_DATES`, `phaseFor()` and
   `daysUntilDay1()` take dates from config instead of the three
   hardcoded literals. `scoring.js` stays DOM-free and `require()`-able;
   pass config in rather than importing it, so tests can pass a fixture.
4. **Roster from config.** `players.js` becomes a thin re-export;
   `WongaPlayers.PLAYERS` keeps its name until stage 2's rename sweep.
   Generalise `friday:` to `joinsOnDay: 2`.
5. **Namespace the storage keys.** All ~20 `wongaCup2026` keys derive
   from `config.brand.storageNamespace`. This is what stops a phone that
   scored 2026 from resuming 2026 state on the 2027 site — worth a
   dedicated repro script.
6. **Config the Supabase/admin/media constants**: `SUPABASE_CONFIG`,
   `ADMIN_NAMES`, `DEFAULT_A`/`DEFAULT_B`, `COURSE_IMAGES`,
   `PHOTO_ALBUM_URL`, day-1 tee-off instant.
7. **Un-hardcode the backup job.** `scripts/snapshot-tournament-updates.mjs`
   reads the config; `snapshot.yml`'s `0 */2 7-9 8 *` window is generated
   from `config.days` (or widened to the whole month — simpler, and the
   commit-only-if-changed guard already makes empty runs free).

Exit test: change five lines of config, get a working 2027 site with a
fresh Supabase tournament id and no 2026 bleed-through.

## 5. Stage 2 — chrome and copy

Only now does the build step earn its keep.

1. **`build.mjs`**: `{{brand.name}}` token expansion +
   `<!--#include partials/nav.html-->`. Runs before the existing
   `__CACHEBUST__` `sed` so the cachebusting still applies to the output.
2. **Extract the 7×2 duplicated navs**, masthead and footer into
   `partials/`. Nav items come from config, so a customer without a
   Records page doesn't ship a dead link.
3. **Tokenise brochure prose.** Split it three ways, deliberately:
   - *Config facts* ("Cayden and Ben join Saturday") → generated from
     `joinsOnDay`, so they can't drift from the scorecard.
   - *House rules* (anthem, Silly Goose, Bull Ring) → flags in config
     with default copy, overridable per edition.
   - *Voice* — the jokes, the dinner-story line. Leave as prose in
     `content/copy/*.md`. Trying to parameterise humour produces a
     product that sounds like nobody wrote it, which is the main thing
     the site currently has going for it.
4. **Rename sweep**: `WongaScoring`/`WongaPlayers`/`WongaCourses` and
   CSS class prefixes. Mechanical, but touches every file and every
   test — do it as its own commit, no behaviour changes mixed in.
5. **Asset manifest**: favicons, `og-card.jpg`, badge, `TheSong.mp3`
   (6.6 MB, and *very* much this group's joke) become config-referenced
   with defaults, not fixed filenames.

## 6. Stage 3 — pluggable formats

The expensive stage. **Recommendation: define the interface now, convert
one format as proof, and stop until a real second customer needs a
fourth format.** Speculative generality here costs weeks and buys
nothing until someone is paying.

A format module owns exactly five things:

```js
export default {
  id: 'stableford-individual',
  stateSlice(config) { … },              // initial shape for this day
  updateTypes: ['hole', 'ntp', 'washout'],  // auto-namespaced: day3_hole
  apply(slice, row) { … },               // reducer over the log
  score(slice, ctx) { … },               // → { teamPoints, playerRows }
  ui: { entry, leaderboard },            // render fns
};
```

Order of conversion, easiest first:

1. **`stableford-individual`** — per-player, no pairings, no team
   structure. `computeStableford`, `day3PointsThru` and friends are
   already close to pure functions of (scores, strokes, pars).
2. **`matchplay-singles`** — needs pairing generation, but the
   front-9/back-9 point split is self-contained.
3. **`scramble-teams`** — hardest. `['a4','a3','b4','b3']` encodes
   two teams, seven players each, split 4/3. Generalising means groups
   derived from `teams.count` and field size, and the anthem/handicap
   divisor rules following the group rather than the hardcoded code.

Two things fall out of stage 3 and must be planned for, not discovered:

- **`update_type` namespacing.** Today's values are `day1_hole` etc. and
  the log is append-only and already contains 2026 history. Introduce
  `d1_hole`-style generated names *with a compatibility map* in
  `applyUpdateToState`, or the snapshot in `snapshots/` and the archive
  replay path stop rebuilding.
- **The test suite is the safety net and also the bottleneck.**
  21 CI tests plus 58 Playwright repro scripts, and `scoring.test.mjs`
  alone is 100 KB of assertions against the 2026 roster and courses.
  Before stage 3, land a `test/fixtures/tournament.fixture.js` and move
  those tests onto it — otherwise every format refactor looks like a
  thousand-line test diff and nobody can tell a real regression from a
  renamed player.

---

## 7. If you want to sell it

The templating above is necessary but not sufficient. Three things
genuinely block a paying second customer, and one of them is a security
issue rather than a feature gap.

**Blocker 1 — secrets are per-project, not per-tournament.**
`app_secrets` holds exactly one `tournament_secret` and one
`admin_secret` (`003_move_secrets_off_database_guc.sql:20-33`), and
`internal.check_tournament_token(p_token)` takes no tournament id. The
RLS insert policy checks *"is this a valid token"*, never *"is this a
valid token **for the tournament_id on this row**"*. So two tournaments
sharing one Supabase project can write to each other's log, and
`rollback_tournament_updates` lets either one delete the other's day.
Fix is a migration 006: `app_secrets` keyed
`(tournament_id, key)`, both check functions and both policies taking
`tournament_id`, and the rollback RPC verifying the token belongs to the
tournament it's deleting from. Also note migration 005's PIN rate limit
is **global by design** — documented as fine for one tournament and
~14 scorers, but at multi-tenant scale one customer fat-fingering their
PIN locks out everyone else's login. It needs to become per-tournament
in the same migration.

**Blocker 2 — provisioning.** Today's runbook is five hand-run SQL
migrations, two `UPDATE`s to set passphrases, a Supabase project, a
GitHub Pages deploy and a DNS record. That's a fine afternoon for us
and an impossible onboarding for a stranger.

**Blocker 3 — the formats.** Any buyer whose weekend isn't
matchplay/scramble/Stableford across three days needs stage 3 finished,
not started.

**Recommended business shape: done-for-you setup, not self-serve SaaS.**
Sell a configured deployment — they send roster, courses, dates and
format choice; we run the config, provision a project, hand over a URL.
That is a real product at £/$ a few hundred per tournament, needs only
stages 1–2 plus blocker 1's migration, and keeps every customer in their
own Supabase project so multi-tenancy stays a nice-to-have rather than a
prerequisite. Self-serve is a different company: signup, billing,
support during someone else's Saturday, and data-loss liability on a
weekend you can't reschedule.

One honest note on the premise: the *templating* is low-effort side
income; the *support* isn't. A live scorecard fails at the worst
possible moment — mid-round, on a course with no reception, for fourteen
people who can't re-play the hole. Price and scope for that, or cap it
at a handful of customers a season.

---

## 8. Sequencing

| Stage | Delivers | Rough size | Do it when |
|---|---|---|---|
| 1. Config extraction | Goal 1, entirely | ~7 PRs, mostly mechanical | Now |
| 2. Chrome + copy + build | Rebrandable site | ~5 PRs, one big rename | Before showing anyone |
| 3a. Fixture-based tests | Makes stage 3 possible | 1–2 PRs | Before 3b |
| 3b. Format modules | Pluggable formats | Large; 1 format at a time | First customer who needs it |
| 4. Migration 006 + provisioning | Safe multi-customer | 1 migration + runbook | First paying customer |

Keep the repo's existing one-issue-per-PR habit: each numbered item in
§4 is one issue, one branch, one PR, `node --test test/*.test.mjs`
green, plus a `test/repro-NNN-*.mjs` for anything UI-visible.

## 9. Things that will bite

- **Service worker + storage namespace.** `sw.js` precaches the shell
  and the cache name is versioned by `__CACHEBUST__`. Renaming storage
  keys mid-conversion on a device holding an old SW is exactly the
  scenario the README's kill switch exists for. Test the 2026→2027
  upgrade path on a real phone, not just a fresh browser profile.
- **`deploy.yml`'s explicit copy list** (`cp *.html *.js *.css …`) has to
  become "copy the build output" or new directories silently don't ship.
- **The 2026 archive.** `snapshots/tournament-updates.json` (676 KB) must
  still replay through `normalizeState`/`applyUpdateToState` after any
  `update_type` change, or `records.html` loses its history.
- **`test/docs-consistency.test.mjs`** guards the README/ARCHITECTURE
  cross-references. Both need updating as part of stage 1, not after.
- **`index2026.html` is evidence, not clutter** — it's the previous
  edition kept by copy-paste, which is precisely the problem this plan
  removes. Delete it once stage 1 can regenerate it from config, and not
  before.
