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

module.exports = { TTL_H, TTL_S, PACKAGES_TTL_H, PACKAGES_TTL_S };
