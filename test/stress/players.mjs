/* ─────────────────────────────────────
   PLAYER ROSTER — extracted from scorecard-live.html at load time.

   Deliberately NOT a copy. A hardcoded duplicate would drift the moment
   a handicap changed, and the oracle would then "prove" a scoreboard
   wrong using stale handicaps — a false failure that costs far more to
   diagnose than this parse costs to maintain.
───────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = fs.readFileSync(path.join(REPO_ROOT, 'scorecard-live.html'), 'utf8');

function extractArray(name) {
  const start = html.indexOf(`const ${name} = [`);
  if (start === -1) throw new Error(`[players.mjs] could not find "const ${name} = [" in scorecard-live.html`);
  const open = html.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error(`[players.mjs] unbalanced brackets reading ${name}`);
  const literal = html.slice(open, end + 1);
  // The literal is plain data (object literals with string/number/boolean
  // values); Function is the least fragile way to read it without pulling
  // in a JS parser, and the input is a file in this repo, not user input.
  return Function(`"use strict"; return (${literal});`)();
}

export const PLAYERS = extractArray('PLAYERS');

// Sanity: the whole harness assumes 14 golfers with ids 0..13.
if (PLAYERS.length !== 14) {
  throw new Error(`[players.mjs] expected 14 players, parsed ${PLAYERS.length}`);
}
PLAYERS.forEach((p, i) => {
  if (p.id !== i) throw new Error(`[players.mjs] player ${i} has id ${p.id}; ids must be 0..13 in order`);
});

/* ── the app's client-side default state ──
   A fresh device does NOT start empty: scorecard-live.html seeds
   teamA/teamB from DEFAULT_A/DEFAULT_B and names the teams, all
   client-side with no rows in the log behind it. A from-epoch replay must
   therefore start from this same seed, or it will "prove" that every
   device is wrong about a roster no row ever set.

   (This is a real property of the design worth being aware of: with no
   player_team rows in the log, team membership is whatever the shipped
   bundle says — so two devices on different app versions would disagree
   with no log evidence to explain it.) */
function extractIdSet(name) {
  const m = new RegExp(`const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(html);
  if (!m) throw new Error(`[players.mjs] could not find "const ${name} = new Set([...])"`);
  return m[1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

function extractStringConst(prop) {
  const m = new RegExp(`${prop}: '([^']*)'`).exec(html);
  if (!m) throw new Error(`[players.mjs] could not find default ${prop}`);
  return m[1];
}

export const DEFAULT_TEAM_A = extractIdSet('DEFAULT_A');
export const DEFAULT_TEAM_B = extractIdSet('DEFAULT_B');
export const DEFAULT_TEAM_NAME_A = extractStringConst('teamNameA');
export const DEFAULT_TEAM_NAME_B = extractStringConst('teamNameB');

// The exact starting point of a device that has never seen a single
// update row — the correct base for a from-epoch replay.
export function defaultState() {
  return {
    teamNameA: DEFAULT_TEAM_NAME_A,
    teamNameB: DEFAULT_TEAM_NAME_B,
    teamA: new Set(DEFAULT_TEAM_A),
    teamB: new Set(DEFAULT_TEAM_B)
  };
}

export const FRIDAY_PLAYERS = PLAYERS.filter(p => p.friday);
export const playerById = id => PLAYERS.find(p => p.id === id);
export const shortOf = id => (playerById(id) || {}).short;
export const nameOf = id => (playerById(id) || {}).name;
