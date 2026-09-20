"use strict";

// In-process token bucket. Enough for the current single-instance deployment
// (the circuit breaker and the L1 cache are per-process for the same
// reason); if this ever runs on several instances the effective limit
// becomes limit × instances, and this is the piece to move to Redis.
//
// A bucket holds up to `burst` tokens and refills at `perMin / 60` per
// second. Every take() costs one. That shape fits Stremio: installing an
// addon fires page 1 of *every* catalog at once (a burst), then traffic is
// sparse — a flat per-minute counter would throttle exactly the install.

function createRateLimiter({ now = () => Date.now(), maxKeys = 50_000 } = {}) {
  const buckets = new Map(); // key -> { tokens, last }

  function sweep(t) {
    // Drop buckets that have been idle long enough to be full again; those
    // are indistinguishable from a fresh one.
    for (const [key, b] of buckets) {
      if (t - b.last > b.idleMs) buckets.delete(key);
    }
  }

  /**
   * @param {string} key
   * @param {{burst:number, perMin:number}} limit
   * @returns {{ok:boolean, retryAfterS:number}}
   */
  function take(key, { burst, perMin }) {
    const t = now();
    const ratePerMs = perMin / 60_000;
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) sweep(t);
      b = { tokens: burst, last: t, idleMs: Math.ceil(burst / ratePerMs) };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(burst, b.tokens + (t - b.last) * ratePerMs);
      b.last = t;
      b.idleMs = Math.ceil(burst / ratePerMs);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
  }

  return { take, size: () => buckets.size };
}

module.exports = { createRateLimiter };
