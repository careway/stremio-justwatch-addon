"use strict";

// Deterministic shuffle: the same (array, seed) always yields the same order,
// so a randomized catalog paginates without gaps or repeats within one seed
// window. Callers derive the seed from the catalog id plus a day counter, so
// the order is stable while a user browses and refreshes once a day.

// FNV-1a — a small string hash, enough to spread catalog-id/day strings into
// distinct 32-bit seeds.
function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 — a compact seeded PRNG. Returns a function producing floats in
// [0, 1).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates driven by a seeded PRNG. Does not mutate the input.
function seededShuffle(items, seed) {
  const rand = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Whole-day counter (UTC). The seed rotates at midnight UTC so a randomized
// catalog reshuffles daily rather than on every request.
function currentDaySeed(now = Date.now()) {
  return Math.floor(now / 86400000);
}

module.exports = { seedFromString, mulberry32, seededShuffle, currentDaySeed };
