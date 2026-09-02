"use strict";

// Single source of truth for cache/refresh cadence. Change TTL_H and every
// other TTL below (search/catalog cache, HTTP Cache-Control headers) moves
// with it — nothing else should hardcode a cache duration independently.
const TTL_H = 4;
const TTL_S = TTL_H * 3600;

// Provider/package lists change far less often than catalogs, so they use a
// multiple of the base unit instead of an unrelated magic number.
const PACKAGES_TTL_H = TTL_H * 6; // 24h
const PACKAGES_TTL_S = PACKAGES_TTL_H * 3600;

// How long to stop calling JustWatch after it starts refusing us, and how many
// consecutive failures it takes to decide that. Not derived from TTL_H: this is
// a backoff, not a freshness window. 60s is long enough to stop being a
// nuisance to an edge that just blocked us, short enough that a transient blip
// costs one minute of degraded catalogs rather than an outage.
const UPSTREAM_FAIL_THRESHOLD = 5;
const UPSTREAM_COOLDOWN_S = 60;

module.exports = {
  TTL_H,
  TTL_S,
  PACKAGES_TTL_H,
  PACKAGES_TTL_S,
  UPSTREAM_FAIL_THRESHOLD,
  UPSTREAM_COOLDOWN_S,
};
