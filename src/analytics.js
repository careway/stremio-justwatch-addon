"use strict";

let track = null;
try {
  ({ track } = require("@vercel/analytics/node"));
} catch (e) {
  // Vercel Analytics not available (local dev)
  track = () => {};
}

/**
 * Track a cache hit/miss event.
 * @param {string} level - "L1" | "L2" | "L3"
 * @param {string} key - Cache key
 */
function trackCacheHit(level, key) {
  try {
    track(`cache_${level.toLowerCase()}_hit`, {
      level,
      key_prefix: key.split(":")[0],
    });
  } catch (e) {
    // Silently fail
  }
}

/**
 * Track api catalog request.
 */
function trackCatalogRequest(req) {
  try {
    /* Track visitor */
    const country = req.headers["x-vercel-ip-country"] || "Unknown";
    const city = req.headers["x-vercel-ip-city"] || "Unknown";

    track("Backend_Route_Hit", {
      path: "/api/dashboard",
      method: "GET",
      country: country, // e.g., "US"
      city: city, // e.g., "New York"
    });
  } catch (e) {
    // Silently fail
  }
}

module.exports = {
  track,
  trackCacheHit,
};
