/* ─────────────────────────────────────
   SEEDED PRNG — the ONE source of randomness
   for the whole stress harness (issue #176
   ground rule 4). Nothing in test/stress/
   may call Math.random(); every random
   decision comes from a stream created here,
   so a run is fully reproducible from its
   seed alone.
───────────────────────────────────── */

// mulberry32 — tiny, fast, good enough distribution for behaviour
// sampling, and (crucially) deterministic across Node versions since it's
// pure uint32 arithmetic with no float bit tricks.
export function makeRng(seed) {
  let a = (hashSeed(seed) >>> 0);
  const rng = function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Convenience helpers — all derived from the same stream, so adding a
  // helper call anywhere shifts that stream deterministically.
  rng.int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  rng.pick = arr => arr[Math.floor(rng() * arr.length)];
  rng.chance = p => rng() < p;
  rng.shuffle = arr => {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return rng;
}

// Derives a stable uint32 from a seed of any type (number or string), so
// per-agent streams can be built as makeRng(`${seed}:${agentId}`) and one
// agent's action count never shifts another agent's stream (issue #176
// Step 4).
export function hashSeed(seed) {
  const str = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
