#!/usr/bin/env node
/* ─────────────────────────────────────
   WONGA CUP — DAY 1 STATS EXPORT (backend data only, no UI wiring yet)

   Replays snapshots/tournament-updates.json (the committed disaster-
   recovery log, see scripts/snapshot-tournament-updates.mjs) through the
   exact same scoring.js glue the live scorecard itself uses
   (normalizeState/applyUpdateToState, then the Day 1 stats functions:
   day1HoleDifficultyFor, day1PlayerReportCardsFor), and writes the
   result to three CSVs under stats/ plus a stats/README.md describing
   every column. Nothing here touches the UI -- this is purely an
   archival/analysis export, kept for later (the eventual "Ultimate
   Team"-style player cards idea) and as a base to extend with Day 2/3
   equivalents once those are played.

   No dependencies -- Node built-ins only.

   Usage: node scripts/export-day1-stats.mjs
   Writes stats/day1-hole-difficulty.csv, stats/day1-player-report-cards.csv,
   stats/day1-match-results.csv, and (re)writes stats/README.md.
───────────────────────────────────── */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT_PATH = path.join(ROOT, 'snapshots', 'tournament-updates.json');
const STATS_DIR = path.join(ROOT, 'stats');

const Scoring = require(path.join(ROOT, 'scoring.js'));
const { PLAYERS } = require(path.join(ROOT, 'players.js'));
const { COURSES } = require(path.join(ROOT, 'courses.js'));

// Same seed the live app itself boots from (scorecard-live.html's
// DEFAULT_A/DEFAULT_B) -- a player who's never been explicitly
// drag-and-dropped onto a team has no player_team/team_assign row in the
// log at all, so a replay starting from empty sets would silently lose
// their team.
const DEFAULT_A = new Set([0, 2, 4, 6, 8, 10, 12]);
const DEFAULT_B = new Set([1, 3, 5, 7, 9, 11, 13]);

export async function replayState() {
  const raw = await readFile(SNAPSHOT_PATH, 'utf8');
  const rows = JSON.parse(raw);
  rows.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : (a.id < b.id ? -1 : 1)));
  const state = { teamNameA: 'Team A', teamNameB: 'Team B', teamA: new Set(DEFAULT_A), teamB: new Set(DEFAULT_B) };
  Scoring.normalizeState(state);
  for (const row of rows) {
    try { Scoring.applyUpdateToState(state, row); } catch { /* malformed row, skip it -- same tolerance the live sync path gives */ }
  }
  return { state, rowCount: rows.length };
}

// Minimal RFC 4180-ish escaping -- wraps a field in quotes (doubling any
// internal quote) whenever it contains a comma, quote, or newline; every
// other field is written bare. Good enough for player names/plain
// numbers, the only data these exports ever contain.
function csvField(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvField).join(',')];
  rows.forEach((row) => lines.push(headers.map((h) => csvField(row[h])).join(',')));
  return lines.join('\n') + '\n';
}

export function holeDifficultyRows(state, players, courses) {
  return Scoring.day1HoleDifficultyFor(state.day1.matches, players, courses).map((h) => ({
    hole: h.hole,
    par: h.par,
    stroke_index: h.si,
    avg_net_to_par: h.avgNetToPar === null ? '' : Number(h.avgNetToPar.toFixed(3)),
    sample_size: h.sampleSize
  }));
}

export function playerReportCardRows(state, players, courses) {
  return Scoring.day1PlayerReportCardsFor(state, players, courses).map((c) => ({
    player_id: c.id,
    player_name: c.name,
    team: c.team === 'A' ? state.teamNameA : c.team === 'B' ? state.teamNameB : '',
    match_number: c.matchIdx + 1,
    opponent_name: c.opponentName,
    holes_won: c.holesWon,
    holes_lost: c.holesLost,
    holes_halved: c.holesHalved,
    holes_played: c.holesPlayed,
    net_to_par_avg: c.netToParAvg === null ? '' : Number(c.netToParAvg.toFixed(3)),
    handicap_badge: c.handicapBadge ?? '',
    hot_streak: c.hotStreak,
    cold_streak: c.coldStreak,
    eagles: c.eagles,
    birdies: c.birdies,
    net_eagles: c.netEagles,
    net_birdies: c.netBirdies,
    blow_up_hole: c.blowUpHole ? c.blowUpHole.hole : '',
    blow_up_gross: c.blowUpHole ? c.blowUpHole.gross : '',
    blow_up_par: c.blowUpHole ? c.blowUpHole.par : '',
    blow_up_to_par: c.blowUpHole ? c.blowUpHole.toPar : '',
    match_points_for: c.matchPointsFor,
    match_points_against: c.matchPointsAgainst,
    ntp_h8: c.ntpH8,
    ntp_h17: c.ntpH17,
    lopsided_nine: c.lopsidedNine ?? ''
  }));
}

export function matchResultRows(state, players, courses) {
  const day1SI = Scoring.day1StrokeIndexesFor(courses);
  const murray = courses && courses[1];
  return state.day1.matches
    .map((match, idx) => {
      const pAid = match.pA[0], pBid = match.pB[0];
      if (pAid === null || pAid === undefined || pBid === null || pBid === undefined) return null;
      const pA = players.find((p) => p.id === pAid);
      const pB = players.find((p) => p.id === pBid);
      const strokes = Scoring.matchStrokesForPlayers(match, players, day1SI, murray);
      const frontResults = Array.from({ length: 9 }, (_, i) => Scoring.holeResult(match.holesA[i], match.holesB[i], strokes.a[i], strokes.b[i]));
      const backResults = Array.from({ length: 9 }, (_, i) => Scoring.holeResult(match.holesA[9 + i], match.holesB[9 + i], strokes.a[9 + i], strokes.b[9 + i]));
      const frontStatus = Scoring.nineStatus(frontResults);
      const backStatus = Scoring.nineStatus(backResults);
      const eff = Scoring.effectiveMatchFor(match, players, day1SI, murray);
      const pts = Scoring.matchPoints(eff);
      const teamA = Scoring.teamOfSets(pAid, state.teamA, state.teamB);
      const teamB = Scoring.teamOfSets(pBid, state.teamA, state.teamB);
      return {
        match_number: idx + 1,
        team_a: teamA === 'A' ? state.teamNameA : teamA === 'B' ? state.teamNameB : '',
        player_a: pA ? pA.name : '',
        team_b: teamB === 'A' ? state.teamNameA : teamB === 'B' ? state.teamNameB : '',
        player_b: pB ? pB.name : '',
        front9_result: eff.front9 ?? '',
        back9_result: eff.back9 ?? '',
        points_a: pts.a,
        points_b: pts.b,
        lopsided: Scoring.isLopsidedNine(frontStatus) || Scoring.isLopsidedNine(backStatus)
      };
    })
    .filter(Boolean);
}

const README_CONTENT = `# Day 1 stats exports

Backend data only -- nothing here is wired into any page UI (yet). Kept
for later use (the eventual "Ultimate Team"-style player cards idea) and
as a base to extend with Day 2/Day 3 equivalents once those are played.

## Provenance

- **Source**: \`snapshots/tournament-updates.json\` (the committed
  disaster-recovery log -- see \`scripts/snapshot-tournament-updates.mjs\`
  and the README's "Backup & restore" section).
- **Generated by**: \`scripts/export-day1-stats.mjs\` -- re-run it any time
  to regenerate these three files from whatever the snapshot currently
  contains (e.g. after refreshing \`snapshots/tournament-updates.json\`
  with a later commit).
- **Day covered**: Day 1 only (Murray Course, Singles Match Play, Friday
  7 August 2026). Day 2 (Black Bull scramble) and Day 3 (Lake Stableford)
  need their own export scripts and CSV sets, since their scoring shapes
  don't fit these columns -- not built yet ("update the data with day 2"
  is a future ask, not something this script auto-detects).
- **Regeneration is a full overwrite**, not an append -- each run replays
  the entire snapshot from scratch and rewrites all three files, so an
  older run's numbers never linger alongside newer ones.

## Files

### \`day1-hole-difficulty.csv\`

One row per Murray hole (1-18). Average **net**-to-par (gross score minus
handicap strokes received, minus par) across every hole actually played
by either side of every assigned match -- how hard each hole played out
relative to what a player "should" have shot on it, after handicap.

| Column | Meaning |
|---|---|
| \`hole\` | Hole number, 1-18 |
| \`par\` | Hole's par |
| \`stroke_index\` | Hole's stroke index (lower = harder, gets strokes first) |
| \`avg_net_to_par\` | Average net-to-par across every sample; negative = played easier than handicap predicts, positive = harder. Blank if nobody has a score on that hole yet |
| \`sample_size\` | Number of individual hole-scores this average is built from |

### \`day1-player-report-cards.csv\`

One row per player per assigned match (so a player who played exactly
one Day 1 match has exactly one row).

| Column | Meaning |
|---|---|
| \`player_id\` | Numeric id, matches \`players.js\` |
| \`player_name\` | Full name |
| \`team\` | Team name at export time (Flamingos/Gorillas this year) |
| \`match_number\` | 1-6, which Day 1 match slot |
| \`opponent_name\` | Who they played |
| \`holes_won\` / \`holes_lost\` / \`holes_halved\` | Net-of-handicap result per hole, summed across both nines |
| \`holes_played\` | Holes where BOTH players have a score in (won+lost+halved) |
| \`net_to_par_avg\` | This player's own average net-to-par across every hole they've entered a score for (their pace, not the head-to-head result) |
| \`handicap_badge\` | \`above\` (net_to_par_avg <= -0.5, played better than handicap), \`below\` (>= +0.5), \`on\` (in between), blank if no holes played |
| \`hot_streak\` / \`cold_streak\` | Longest run of consecutive holes won / lost in a row (front 9 into back 9 -- doesn't reset at the turn) |
| \`eagles\` / \`birdies\` | Gross score classification (par courses.js data) |
| \`net_eagles\` / \`net_birdies\` | Same, but on net score (gross minus handicap strokes received on that hole) |
| \`blow_up_hole\` / \`blow_up_gross\` / \`blow_up_par\` / \`blow_up_to_par\` | The single worst hole of the round **by gross score-to-par** (a real "blow-up", not handicap-adjusted) -- hole number, the gross score taken, that hole's par, and how many over par it was. Ties keep the earliest hole. Blank if no holes played yet |
| \`match_points_for\` / \`match_points_against\` | This player's side's point split for the whole match (0-2 each, halves possible) |
| \`ntp_h8\` / \`ntp_h17\` | \`true\`/\`false\` -- did this player hold the Day 1 nearest-the-pin claim on that hole at export time |
| \`lopsided_nine\` | \`won\`/\`lost\`/\`split\`/blank -- did either nine of this match finish 5-up-or-more (see \`DAY1_LOPSIDED_LEAD\` in scoring.js)? \`split\` means one nine was lopsided for this player and the other against |

### \`day1-match-results.csv\`

One row per Day 1 match that has both players assigned (the box score).

| Column | Meaning |
|---|---|
| \`match_number\` | 1-6 |
| \`team_a\` / \`player_a\` / \`team_b\` / \`player_b\` | Who played, and for which team |
| \`front9_result\` / \`back9_result\` | \`A\`, \`B\`, \`T\` (halved), or blank if that nine isn't decided yet |
| \`points_a\` / \`points_b\` | Points each side actually won from this match (0-2 each) |
| \`lopsided\` | \`true\` if either nine finished 5-up-or-more |
`;

async function main() {
  const { state, rowCount } = await replayState();
  await mkdir(STATS_DIR, { recursive: true });

  const holeCsv = toCsv(
    ['hole', 'par', 'stroke_index', 'avg_net_to_par', 'sample_size'],
    holeDifficultyRows(state, PLAYERS, COURSES)
  );
  const cardsCsv = toCsv(
    ['player_id', 'player_name', 'team', 'match_number', 'opponent_name', 'holes_won', 'holes_lost', 'holes_halved',
      'holes_played', 'net_to_par_avg', 'handicap_badge', 'hot_streak', 'cold_streak', 'eagles', 'birdies',
      'net_eagles', 'net_birdies', 'blow_up_hole', 'blow_up_gross', 'blow_up_par', 'blow_up_to_par',
      'match_points_for', 'match_points_against', 'ntp_h8', 'ntp_h17', 'lopsided_nine'],
    playerReportCardRows(state, PLAYERS, COURSES)
  );
  const matchesCsv = toCsv(
    ['match_number', 'team_a', 'player_a', 'team_b', 'player_b', 'front9_result', 'back9_result', 'points_a', 'points_b', 'lopsided'],
    matchResultRows(state, PLAYERS, COURSES)
  );

  await writeFile(path.join(STATS_DIR, 'day1-hole-difficulty.csv'), holeCsv);
  await writeFile(path.join(STATS_DIR, 'day1-player-report-cards.csv'), cardsCsv);
  await writeFile(path.join(STATS_DIR, 'day1-match-results.csv'), matchesCsv);
  await writeFile(path.join(STATS_DIR, 'README.md'), README_CONTENT);

  console.log(`Replayed ${rowCount} rows. Wrote day1-hole-difficulty.csv, day1-player-report-cards.csv, day1-match-results.csv, and README.md to stats/.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
