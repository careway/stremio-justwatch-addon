"use strict";

// ─── Circuit breaker ──────────────────────────────────────────────────────────
// Stops calling an upstream that is refusing us, instead of asking it again on
// every single request.
//
// Why a breaker and not a negative cache per key: when JustWatch 403-blocked
// the deploy's IP (2026-09-02), the amplification came from the *catalog* path,
// and a manifest can hold 1200 catalogs — 1200 distinct cache keys. Caching each
// failure would still let 1200 outbound calls through before the last key was
// poisoned, and each one is another knock on a door that just closed. The state
// that matters is not "this key failed", it's "the upstream is down".
//
// Deliberately blunt: consecutive failures only, no error classification. A 403,
// a 429 and a timeout all mean "stop asking for a moment", and guessing which
// deserves a backoff is how you end up hammering through the one case you
// didn't enumerate.
//
// One targeted exception: recordFailure() takes an optional cooldown override.
// A 403 specifically is a known, named case (DataDome blocking the IP) with a
// penalty that runs much longer than a transient blip — see
// UPSTREAM_BLOCK_COOLDOWN_S in ../ttl. That's a fact about JustWatch's bot
// detection, not a guess about failure severity, so it doesn't reopen the
// "classify everything" trap this comment warns against.
//
// Scope is one process. On a single-instance host that's the whole fleet; with
// several instances each learns independently. Sharing it through L2 was
// considered and skipped — it would add a Redis round trip to every upstream
// call to solve a problem this deployment doesn't have.

/**
 * @param {object}   opts
 * @param {number}   opts.threshold  - consecutive failures before opening
 * @param {number}   opts.cooldownMs - how long to stay open
 * @param {Function} [opts.now]      - clock, injectable so tests need no timers
 */
function createCircuitBreaker({ threshold, cooldownMs, now = Date.now }) {
  let consecutiveFailures = 0;
  let openUntil = 0;

  return {
    /** True while the breaker is refusing calls. */
    isOpen() {
      return now() < openUntil;
    },

    /** Milliseconds left in the cooldown, 0 when closed. */
    remainingMs() {
      return Math.max(0, openUntil - now());
    },

    recordSuccess() {
      consecutiveFailures = 0;
      openUntil = 0;
    },

    /**
     * @param {number} [cooldownMsOverride] - use this cooldown instead of the
     *   default (e.g. a longer one for a known-lengthy block like a 403).
     * @returns {boolean} true when this failure is the one that opened it
     */
    recordFailure(cooldownMsOverride) {
      consecutiveFailures++;
      if (consecutiveFailures < threshold) return false;
      // Re-arm on every failure at or past the threshold, so the half-open
      // probe that fails puts us straight back into a full cooldown rather
      // than letting one request through per tick.
      openUntil = now() + (cooldownMsOverride ?? cooldownMs);
      return true;
    },

    /** For logs and tests. */
    state() {
      return {
        open: now() < openUntil,
        consecutiveFailures,
        remainingMs: Math.max(0, openUntil - now()),
      };
    },

    reset() {
      consecutiveFailures = 0;
      openUntil = 0;
    },
  };
}

module.exports = { createCircuitBreaker };
