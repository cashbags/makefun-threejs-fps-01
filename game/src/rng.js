// rng.js — EMBERLINE Foundry 7
//
// Module contract: the ONLY source of randomness in the simulation. Every
// random draw in the game (bot aim error, spawn picks, spread jitter, grenade
// bounce) comes from a mulberry32 stream seeded from `?seed=` (default 1).
// Design rationale: a tiny, fast, seedable PRNG keeps the whole match
// reproducible — two runs with the same seed produce byte-identical sim
// state, which is what the deterministic replay check requires. Rendering
// and audio never touch this module. `Math.random` and `Date.now` are
// banned from sim code; this file is the enforcement point.
//
// Tuning notes: mulberry32 has a 2^32 period, far beyond a 15-round match
// (~54,000 ticks). `range`/`int`/`pick`/`chance` are the only helpers the
// rest of the sim is allowed to call, so a grep for Math.random in sim
// files (excluding this one) must come back empty.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Create the game's master RNG plus a small toolbox bound to it.
export function createRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    // Uniform float in [min, max).
    range(min, max) {
      return min + (max - min) * next();
    },
    // Uniform integer in [min, max] inclusive.
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    // Random element of a non-empty array.
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    // True with probability p (0..1).
    chance(p) {
      return next() < p;
    },
    // Fisher-Yates shuffle, in place, using this stream.
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
    // Gaussian-ish jitter in [-1, 1] (sum of two uniforms, cheap and smooth).
    gauss() {
      return next() + next() - 1;
    },
  };
}
