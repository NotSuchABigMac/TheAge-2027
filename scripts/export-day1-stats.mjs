#!/usr/bin/env node
/* ─────────────────────────────────────
   WONGA CUP — DAY 1 STATS EXPORT (backend data only, no UI wiring yet)

   Replays snapshots/tournament-updates.json (the committed disaster-
   recovery log, see scripts/snapshot-tournament-updates.mjs) through the
   exact same scoring.js glue the live scorecard itself uses
   (normalizeState/applyUpdateToState, then the Day 1 stats functions:
   day1HoleDifficultyFor, day1PlayerReportCardsFor, day1Superlatives --
   the same functions tv.html's Stat Board renders live), and writes the
   result to four CSVs under stats/ plus a stats/README.md describing
   every column. Nothing here touches the UI directly -- this is an
   archival/analysis export, kept for later (the eventual "Ultimate
   Team"-style player cards idea) and as a base to extend with Day 2/3
   equivalents once those are played.

   No dependencies -- Node built-ins only.

   Usage: node scripts/export-day1-stats.mjs
   Writes stats/day1-hole-difficulty.csv, stats/day1-player-report-cards.csv,
   stats/day1-match-results.csv, stats/day1-superlatives.csv, and
   (re)writes stats/README.md.
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
    lopsided_nine: c.lopsidedNine ?? '',
    net_par_or_better_count: c.netParOrBetterCount,
    net_to_par_std_dev: c.netToParStdDev === null ? '' : Number(c.netToParStdDev.toFixed(3)),
    par3_holes_played: c.parTypeStats[3].holesPlayed,
    par3_avg_to_par: c.parTypeStats[3].avgToPar === null ? '' : Number(c.parTypeStats[3].avgToPar.toFixed(3)),
    par3_avg_net_to_par: c.parTypeStats[3].avgNetToPar === null ? '' : Number(c.parTypeStats[3].avgNetToPar.toFixed(3)),
    par4_holes_played: c.parTypeStats[4].holesPlayed,
    par4_avg_to_par: c.parTypeStats[4].avgToPar === null ? '' : Number(c.parTypeStats[4].avgToPar.toFixed(3)),
    par4_avg_net_to_par: c.parTypeStats[4].avgNetToPar === null ? '' : Number(c.parTypeStats[4].avgNetToPar.toFixed(3)),
    par5_holes_played: c.parTypeStats[5].holesPlayed,
    par5_avg_to_par: c.parTypeStats[5].avgToPar === null ? '' : Number(c.parTypeStats[5].avgToPar.toFixed(3)),
    par5_avg_net_to_par: c.parTypeStats[5].avgNetToPar === null ? '' : Number(c.parTypeStats[5].avgNetToPar.toFixed(3)),
    worst_win_hole: c.worstWinHole ? c.worstWinHole.hole : '',
    worst_win_gross: c.worstWinHole ? c.worstWinHole.gross : '',
    worst_win_par: c.worstWinHole ? c.worstWinHole.par : '',
    worst_win_to_par: c.worstWinHole ? c.worstWinHole.toPar : '',
    worst_win_opponent_gross: c.worstWinHole ? c.worstWinHole.opponentGross : '',
    best_loss_hole: c.bestLossHole ? c.bestLossHole.hole : '',
    best_loss_gross: c.bestLossHole ? c.bestLossHole.gross : '',
    best_loss_par: c.bestLossHole ? c.bestLossHole.par : '',
    best_loss_to_par: c.bestLossHole ? c.bestLossHole.toPar : '',
    best_loss_opponent_gross: c.bestLossHole ? c.bestLossHole.opponentGross : '',
    nailbiter_count: c.nailbiterCount,
    biggest_comeback: c.biggestComeback,
    fast_start_avg_net_to_par: c.fastStartAvgNetToPar === null ? '' : Number(c.fastStartAvgNetToPar.toFixed(3)),
    closer_avg_net_to_par: c.closerAvgNetToPar === null ? '' : Number(c.closerAvgNetToPar.toFixed(3))
  }));
}

// One row per day1Superlatives() leaderboard -- the same "who holds this
// record" board tv.html's Stat Board renders, kept here too so it's
// archived/diffable rather than only ever computed live in the browser.
// Deliberately excludes the hand-curated joke award (e.g. "Most
// Kangaroos Scared") that lives only in tv.html's FUN_AWARDS constant --
// this file is real computed data, and mixing in a fabricated entry
// would misrepresent it as such.
export function superlativeRows(cards) {
  const s = Scoring.day1Superlatives(cards);
  const blank = { player_name: '', value: '', hole: '', gross: '', par: '', to_par: '', opponent_name: '', opponent_gross: '' };
  function simple(stat, entry) {
    if (!entry) return { stat, ...blank };
    return { stat, ...blank, player_name: entry.name, value: typeof entry.value === 'number' ? Number(entry.value.toFixed(3)) : entry.value };
  }
  function hole(stat, entry) {
    if (!entry) return { stat, ...blank };
    return {
      stat, ...blank, player_name: entry.name,
      hole: entry.hole, gross: entry.gross, par: entry.par, to_par: entry.toPar,
      opponent_name: entry.opponentName, opponent_gross: entry.opponentGross
    };
  }
  return [
    simple('most_net_pars_or_better', s.mostNetParsOrBetter),
    simple('most_consistent_net_scorer', s.mostConsistentNetScorer),
    simple('least_consistent_net_scorer', s.leastConsistentNetScorer),
    hole('worst_score_to_win_hole', s.worstScoreToWinHole),
    hole('best_score_to_lose_hole', s.bestScoreToLoseHole),
    simple('best_par3_player', s.bestPar3Player),
    simple('best_par4_player', s.bestPar4Player),
    simple('best_par5_player', s.bestPar5Player),
    simple('serial_peacemaker', s.serialPeacemaker),
    simple('nailbiter_king', s.nailbiterKing),
    simple('comeback_king', s.comebackKing),
    simple('fast_starter', s.fastStarter),
    simple('closer', s.closer)
  ];
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
| \`net_par_or_better_count\` | Holes where this player's NET score was par or better (net par/birdie/eagle) |
| \`net_to_par_std_dev\` | Population standard deviation of net-to-par across every hole played -- lower = more consistent round. Blank with fewer than 2 holes played (a single point has no real "spread") |
| \`par3_holes_played\` / \`par3_avg_to_par\` / \`par3_avg_net_to_par\` | Same, repeated for \`par4_*\` and \`par5_*\` -- gross- and net-to-par averages broken down by hole par. All three par buckets always present; blank averages mean that bucket has no holes played yet |
| \`worst_win_hole\` / \`worst_win_gross\` / \`worst_win_par\` / \`worst_win_to_par\` / \`worst_win_opponent_gross\` | The worst hole (by **gross** score-to-par) this player won on NET, with the opponent's gross score on that same hole for context -- "what a way to win that". Blank if this player never won a hole |
| \`best_loss_hole\` / \`best_loss_gross\` / \`best_loss_par\` / \`best_loss_to_par\` / \`best_loss_opponent_gross\` | The best hole (by gross score-to-par) this player still lost on NET. Blank if this player never lost a hole |
| \`nailbiter_count\` | Holes decided by exactly 1 net stroke -- the closest possible margin short of a halve |
| \`biggest_comeback\` | Largest deficit (in holes) this player was ever down by within a nine they went on to at least halve. 0 if never behind, or if every nine they were ever behind in they ultimately lost outright |
| \`fast_start_avg_net_to_par\` / \`closer_avg_net_to_par\` | Average net-to-par over holes 1-3 and holes 16-18 respectively -- how this player started vs. finished. Blank if that range isn't played yet |

### \`day1-match-results.csv\`

One row per Day 1 match that has both players assigned (the box score).

| Column | Meaning |
|---|---|
| \`match_number\` | 1-6 |
| \`team_a\` / \`player_a\` / \`team_b\` / \`player_b\` | Who played, and for which team |
| \`front9_result\` / \`back9_result\` | \`A\`, \`B\`, \`T\` (halved), or blank if that nine isn't decided yet |
| \`points_a\` / \`points_b\` | Points each side actually won from this match (0-2 each) |
| \`lopsided\` | \`true\` if either nine finished 5-up-or-more |

### \`day1-superlatives.csv\`

One row per leaderboard stat -- "who currently holds this record" --
reduced from \`day1-player-report-cards.csv\` via \`day1Superlatives()\`.
This is the same data tv.html's Stat Board renders live in the browser,
archived here as a snapshot. Ties keep whichever player's row comes
first in the report-cards file (match order, side A before side B).

| Column | Meaning |
|---|---|
| \`stat\` | Which leaderboard: \`most_net_pars_or_better\`, \`most_consistent_net_scorer\`, \`least_consistent_net_scorer\`, \`worst_score_to_win_hole\`, \`best_score_to_lose_hole\`, \`best_par3_player\`, \`best_par4_player\`, \`best_par5_player\`, \`serial_peacemaker\` (most holes halved), \`nailbiter_king\` (most 1-net-stroke holes), \`comeback_king\` (biggest deficit overcome), \`fast_starter\`, \`closer\` |
| \`player_name\` | Who holds it. Blank if nobody qualifies yet (e.g. nobody's lost a hole yet) |
| \`value\` | The stat's number, for stats that are a single count/average (e.g. net-par count, std dev, par-type average) |
| \`hole\` / \`gross\` / \`par\` / \`to_par\` / \`opponent_name\` / \`opponent_gross\` | Only populated for the two hole-specific stats (\`worst_score_to_win_hole\`/\`best_score_to_lose_hole\`) |

**Not included here**: tv.html's Stat Board also shows a hand-curated
joke award ("Most Kangaroos Scared") with no \`tournament_updates\` data
behind it at all -- it lives only in tv.html's \`FUN_AWARDS\` constant,
deliberately kept out of this file so a real computed-data export never
mixes in a fabricated entry.
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
      'match_points_for', 'match_points_against', 'ntp_h8', 'ntp_h17', 'lopsided_nine',
      'net_par_or_better_count', 'net_to_par_std_dev',
      'par3_holes_played', 'par3_avg_to_par', 'par3_avg_net_to_par',
      'par4_holes_played', 'par4_avg_to_par', 'par4_avg_net_to_par',
      'par5_holes_played', 'par5_avg_to_par', 'par5_avg_net_to_par',
      'worst_win_hole', 'worst_win_gross', 'worst_win_par', 'worst_win_to_par', 'worst_win_opponent_gross',
      'best_loss_hole', 'best_loss_gross', 'best_loss_par', 'best_loss_to_par', 'best_loss_opponent_gross',
      'nailbiter_count', 'biggest_comeback', 'fast_start_avg_net_to_par', 'closer_avg_net_to_par'],
    playerReportCardRows(state, PLAYERS, COURSES)
  );
  const matchesCsv = toCsv(
    ['match_number', 'team_a', 'player_a', 'team_b', 'player_b', 'front9_result', 'back9_result', 'points_a', 'points_b', 'lopsided'],
    matchResultRows(state, PLAYERS, COURSES)
  );
  const cards = Scoring.day1PlayerReportCardsFor(state, PLAYERS, COURSES);
  const superlativesCsv = toCsv(
    ['stat', 'player_name', 'value', 'hole', 'gross', 'par', 'to_par', 'opponent_name', 'opponent_gross'],
    superlativeRows(cards)
  );

  await writeFile(path.join(STATS_DIR, 'day1-hole-difficulty.csv'), holeCsv);
  await writeFile(path.join(STATS_DIR, 'day1-player-report-cards.csv'), cardsCsv);
  await writeFile(path.join(STATS_DIR, 'day1-match-results.csv'), matchesCsv);
  await writeFile(path.join(STATS_DIR, 'day1-superlatives.csv'), superlativesCsv);
  await writeFile(path.join(STATS_DIR, 'README.md'), README_CONTENT);

  console.log(`Replayed ${rowCount} rows. Wrote day1-hole-difficulty.csv, day1-player-report-cards.csv, day1-match-results.csv, day1-superlatives.csv, and README.md to stats/.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
