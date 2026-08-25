"use strict";

const axios = require("axios");
const { trackCacheHit, trackCacheMiss, track } = require("./analytics");
const { L1Cache, L2Cache } = require("./cache");
const { TTL_S, PACKAGES_TTL_S } = require("../ttl");
const GRAPHQL_URL = "https://apis.justwatch.com/graphql";

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const GET_POPULAR_TITLES_QUERY = `
  query GetPopularTitles(
    $country: Country!
    $first: Int! = 70
    $popularTitlesFilter: TitleFilter
    $popularTitlesSortBy: PopularTitlesSorting! = POPULAR
    $language: Language!
    $sortRandomSeed: Int! = 0
    $offset: Int = 0
  ) {
    popularTitles(
      country: $country
      filter: $popularTitlesFilter
      first: $first
      sortBy: $popularTitlesSortBy
      sortRandomSeed: $sortRandomSeed
      offset: $offset
    ) {
      edges {
        node {
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            originalReleaseDate
            genres {
              shortName
            }
            externalIds {
              imdbId
            }
            posterUrl(profile: S718, format: JPG)
          }
        }
      }
    }
  }
`;

const GET_PACKAGES_QUERY = `
  query GetPackages($country: Country!, $platform: Platform! = WEB) {
    packages(country: $country, platform: $platform) {
      id
      packageId
      clearName
      technicalName
      shortName
      monetizationTypes
      hasTitles(country: $country, platform: $platform)
      hasSport(country: $country, platform: $platform)
      icon(profile: S100)
    }
  }
`;

// ─── Cache ────────────────────────────────────────────────────────────────────

// Catalog/search results (TTL_S) and provider/package lists (PACKAGES_TTL_S)
// refresh on the cadence defined in ./ttl — everything derives from TTL_H
// there, nothing is redefined here. There's no cron/scheduler in this
// deployment (Vercel Hobby only guarantees daily cron; BeamUp has none at
// all), so freshness is driven purely by TTL expiry + stale-while-revalidate,
// not by an active refresh job.

/**
 * Lookup order: L1 in-memory → L2 Redis
 * On a Redis hit, the value is promoted back into L1 with the same TTL.
 */
async function cacheGet(key, ttl_s) {
  let data = await L1Cache.get(key);
  if (data) {
    trackCacheHit("L1", key);
    return data;
  }

  data = await L2Cache.get(key);
  if (data) {
    trackCacheHit("L2", key);
    L1Cache.set(key, data, ttl_s);
    return data;
  }

  trackCacheMiss("L2", key);
  return null; // full miss — caller fetches from JustWatch
}

/**
 * Write to both L1 and L2 simultaneously.
 */
async function cacheSet(key, data, ttl_s) {
  L1Cache.set(key, data, ttl_s);
  L2Cache.set(key, data, ttl_s);
}

// ─── Concurrency queue ────────────────────────────────────────────────────────
// Bounds how many outbound GraphQL calls to JustWatch can be in flight at
// once. Measured directly against JustWatch (see project memory): no 429s at
// any concurrency up to 256 in a single burst — failures only show up past
// ~150-190 as request latency balloons and calls start missing the 10s
// axios timeout below. MAX_CONCURRENCY=100 stays well under that knee while
// still bounding worst-case fan-out (e.g. many catalogs loading at once on a
// manifest fetch).
//
// Caveat: this only bounds concurrency within a single warm serverless
// instance (like the L1 cache in ./cache) — Vercel can still spin up several
// instances handling different requests truly in parallel, and production
// IP reputation may behave differently than the environment this was tested
// from. There's no cross-instance coordination point (e.g. a Redis lock).
//
// DISABLED (2026-08-24): real Stremio usage showed some requests hanging for
// a long time on a cache miss, causing client-side timeouts in Stremio
// itself. Suspected cause — on BeamUp this module lives in one long-running
// process shared by every request, so a single task that never settles
// (hung TCP connection, an edge case axios' timeout doesn't catch) would
// permanently occupy one of the 100 slots and never free it; repeated over
// time that leaks capacity and eventually piles up requests behind it. Not
// confirmed yet, just the leading theory. `enqueue()` now bypasses the
// semaphore and runs tasks immediately (unbounded, like before any queue
// existed) while the semaphore itself (`runNext`/`MAX_CONCURRENCY`/
// `pending`) stays in place to keep iterating on it without ripping it out.
const QUEUE_ENABLED = false;
const MAX_CONCURRENCY = 100;
let activeCount = 0;
const pending = [];

function runNext() {
  if (activeCount >= MAX_CONCURRENCY || pending.length === 0) return;
  activeCount++;
  const { task, resolve, reject } = pending.shift();
  task().then(
    (result) => {
      activeCount--;
      resolve(result);
      runNext();
    },
    (err) => {
      activeCount--;
      reject(err);
      runNext();
    },
  );
}

function enqueue(task) {
  if (!QUEUE_ENABLED) return task();
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    runNext();
  });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function gql(query, variables) {
  return enqueue(async () => {
    try {
      const { data } = await axios.post(
        GRAPHQL_URL,
        { query, variables },
        {
          headers: {
            "Content-Type": "application/json",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "application/json",
            "Accept-Language": "en-US,en;q=0.9",
          },
          timeout: 10_000,
        },
      );
      if (data.errors) {
        console.error("GQL Request Query:", JSON.stringify(query, null, 2));
        console.error(
          "GQL Request Variables:",
          JSON.stringify(variables, null, 2),
        );
        console.error("GQL Errors:", JSON.stringify(data.errors, null, 2));
        throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      }
      return data.data;
    } catch (err) {
      console.error("GQL Request Query:", JSON.stringify(query, null, 2));
      console.error(
        "GQL Request Variables:",
        JSON.stringify(variables, null, 2),
      );
      console.error(
        "GQL Request failed:",
        err.response
          ? JSON.stringify(err.response.data, null, 2)
          : err.message,
      );
      throw err;
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search (or browse) titles on JustWatch.
 *
 * @param {object}   opts
 * @param {string}   opts.query       - Text search. Pass '' for browse.
 * @param {string[]} opts.objectTypes - ['MOVIE'] | ['SHOW'] | []
 * @param {string[]} opts.packages    - JustWatch technicalName filters e.g. ['nfx']
 * @param {string[]} opts.genres      - JustWatch shortName filters e.g. ['act']
 * @param {string}   opts.sortBy      - 'POPULAR' | 'NEWLY_ADDED'
 * @param {string}   opts.country     - ISO country code (e.g. 'ES')
 * @param {string}   opts.language    - BCP47 language code (e.g. 'es')
 * @param {number}   opts.first       - Results per page (max 50)
 * @param {number}   opts.offset      - Pagination offset (0, 50, 100, ...)
 */
async function searchTitles({
  query = "",
  objectTypes = [],
  packages = [],
  genres = [],
  sortBy = "POPULAR",
  country = "US",
  language = "en",
  first = 50,
  offset = 0,
} = {}) {
  const cacheKey = `search:${query}:${objectTypes.join(",")}:${packages.join(",")}:${genres.join(",")}:${sortBy}:${country}:${language}:${first}:${offset}`;
  const cached = await cacheGet(cacheKey, TTL_S);
  if (cached) return cached;

  const filter = {};
  if (query) filter.searchQuery = query;
  if (objectTypes.length) filter.objectTypes = objectTypes;
  if (packages.length) filter.packages = packages;
  if (genres.length) filter.genres = genres;

  const data = await gql(GET_POPULAR_TITLES_QUERY, {
    popularTitlesFilter: filter,
    country,
    first: Math.min(first, 50),
    offset,
    popularTitlesSortBy: sortBy,
    language,
    sortRandomSeed: 0,
    platform: "WEB",
  });

  const nodes = (data?.popularTitles?.edges || []).map((e) => e.node);
  await cacheSet(cacheKey, nodes, TTL_S);
  return nodes;
}

/**
 * Get available streaming packages for a country.
 * Excludes cinema-only packages (monetizationTypes = ["CINEMA"]) and\n * sports/live-only providers (hasTitles = false).
 *
 * @param {string} country - ISO country code (e.g. 'ES')
 * @returns {Promise<Array>} Array of package objects with iconUrl resolved
 */
async function getPackages(country = "US") {
  const cacheKey = `packages:${country}`;
  const cached = await cacheGet(cacheKey, PACKAGES_TTL_S);
  if (cached) return cached;

  const rawData = await gql(GET_PACKAGES_QUERY, { country, platform: "WEB" });
  const pkgs = (rawData?.packages || [])
    .filter((pkg) => {
      const types = pkg.monetizationTypes || [];
      // Exclude pure cinema-ticketing packages
      if (types.length === 1 && types[0] === "CINEMA") return false;
      // Exclude sports-only / live-only providers (no VOD movie/series catalog)
      if (pkg.hasTitles === false) return false;
      return true;
    })
    .map((pkg) => ({
      ...pkg,
      iconUrl: pkg.icon
        ? `https://images.justwatch.com${pkg.icon.replace("{format}", "webp")}`
        : null,
    }));

  await cacheSet(cacheKey, pkgs, PACKAGES_TTL_S);
  return pkgs;
}

module.exports = { searchTitles, getPackages };
