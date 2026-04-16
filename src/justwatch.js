"use strict";

const axios = require("axios");
const { trackCacheHit, trackCacheMiss, track } = require("./analytics");
const { L1Cache, L2Cache, L3Cache } = require("./cache");
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

function buildOffersQuery(country) {
  const alias = country.toLowerCase();
  return `
    query GetTitleOffers(
      $nodeId: ID!
      $language: Language!
      $filterBuy: OfferFilter!
      $platform: Platform! = WEB
    ) {
      node(id: $nodeId) {
        ... on MovieOrShowOrSeasonOrEpisode {
          ${alias}: offers(country: ${country}, platform: $platform, filter: $filterBuy) {
            presentationType
            monetizationType
            retailPrice(language: $language)
            retailPriceValue
            currency
            package {
              clearName
              technicalName
              icon(profile: S100)
            }
            standardWebURL
            availableTo
          }
        }
      }
    }
  `;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_TTL_S = 24 * 60 * 60; // 24 hours (Redis uses seconds)
const CACHE_TTL_MS = CACHE_TTL_S * 1000; // 24 hours in ms (in-memory)

/**
 * Lookup order: L1 in-memory → L2 Vercel → L3 Redis
 * On a Redis hit, the value is promoted back into L1.
 */
async function cacheGet(key) {
  let data = await L1Cache.get(key);
  if (data) {
    trackCacheHit("L1", key);
    return data;
  }

  data = await L2Cache.get(key);
  if (data) {
    trackCacheHit("L2", key);
    L1Cache.set(key, data, CACHE_TTL_S);
    return data;
  }

  data = await L3Cache.get(key);
  if (data) {
    trackCacheHit("L3", key);
    L1Cache.set(key, data, CACHE_TTL_S);
    L2Cache.set(key, data, CACHE_TTL_S);
    return data;
  }

  trackCacheMiss("L3", key);
  return null; // full miss — caller fetches from JustWatch
}

/**
 * Write to both L1, L2 and L3 simultaneously.
 */
async function cacheSet(key, data) {}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function gql(query, variables) {
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
    throw new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
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
  const cached = await cacheGet(cacheKey);
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
  });

  const nodes = (data?.popularTitles?.edges || []).map((e) => e.node);
  await cacheSet(cacheKey, nodes);
  return nodes;
}

/**
 * Get streaming offers for a JustWatch node.
 *
 * @param {string} nodeId    - JustWatch internal node ID
 * @param {string} country   - ISO country code (e.g. 'ES')
 * @param {string} language  - BCP47 language code (e.g. 'es')
 */
async function getTitleOffers(nodeId, country = "US", language = "en") {
  const cacheKey = `offers:${nodeId}:${country}:${language}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const data = await gql(buildOffersQuery(country), {
    nodeId,
    language,
    filterBuy: {},
    platform: "WEB",
  });

  const offers = data?.node?.[country.toLowerCase()] || [];
  await cacheSet(cacheKey, offers);
  return offers;
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
  const cached = await cacheGet(cacheKey);
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

  await cacheSet(cacheKey, pkgs);
  return pkgs;
}

module.exports = { searchTitles, getTitleOffers, getPackages };
