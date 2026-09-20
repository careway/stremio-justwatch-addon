"use strict";

// Per-account request counters. Kept in memory and flushed to the store in
// batches: a catalog request is the hottest path in the addon, and one
// database write per request would be the most expensive thing on it.
// Losing up to FLUSH_MS of counts on a crash is the accepted cost — this
// feeds dashboards and, later, plan enforcement by volume, not billing.

const FLUSH_MS = 60_000;

const counts = new Map(); // `${userId}|${YYYY-MM-DD}` -> n
let timer = null;

const today = () => new Date().toISOString().slice(0, 10);

function bump(userId) {
  const key = `${userId}|${today()}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}

async function flush(store) {
  if (!counts.size) return;
  const batch = [...counts];
  counts.clear();
  for (const [key, n] of batch) {
    const [userId, day] = key.split("|");
    try {
      await store.addUsage(userId, day, n);
    } catch (err) {
      // Put it back rather than lose it; the next flush retries.
      counts.set(key, (counts.get(key) || 0) + n);
      console.warn("[usage] flush failed:", err.message);
      return;
    }
  }
}

function start(store) {
  if (timer || !store) return;
  timer = setInterval(() => flush(store).catch(() => {}), FLUSH_MS);
  timer.unref();
}

module.exports = { bump, flush, start, _counts: counts };
