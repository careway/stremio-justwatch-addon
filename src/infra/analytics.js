"use strict";

const stats = require("./stats");
const { debug } = require("../http/logger");

// ─── Cache / request instrumentation ──────────────────────────────────────────
// This was a wrapper around Vercel Web Analytics. Vercel support was removed
// (2026-09-02) and with it the only backend these events had, so what remains
// is structured logging: the "[L1 - Hit]" / "[Cache MISS]" lines are what make
// cache behaviour visible in `addon.log` and are relied on when diagnosing
// upstream load.
//
// It is kept as a module rather than inlined so there stays exactly one seam to
// wire a real analytics backend into, should one ever be added.

/**
 * Record a cache hit.
 * @param {string} level - "L1" | "L2"
 * @param {string} key - Cache key
 */
function trackCacheHit(level, key) {
  stats.bump(`cache.${level.toLowerCase()}Hit`);
  debug(`[${level} - Hit] ${key}`);
}

/**
 * Record a cache miss.
 * @param {string} level - "L1" | "L2"
 * @param {string} key - Cache key
 */
function trackCacheMiss(level, key) {
  stats.bump("cache.miss");
  debug(`[Cache MISS] ${key}`);
}

/**
 * Record a catalog request. Deliberately does not read geo headers any more —
 * those were `x-vercel-ip-*`, which no host we target sets.
 */
function trackCatalogRequest(req) {
  stats.bump("requests.catalog");
  debug(`[catalog] ${req.method} ${req.url}`);
}

module.exports = { trackCacheHit, trackCacheMiss, trackCatalogRequest };
