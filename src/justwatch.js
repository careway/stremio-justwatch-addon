'use strict';

const axios = require('axios');

const GRAPHQL_URL = 'https://apis.justwatch.com/graphql';

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const GET_POPULAR_TITLES_QUERY = `
  query GetPopularTitles(
    $country: Country!
    $first: Int! = 70
    $format: ImageFormat
    $language: Language!
    $after: String
    $popularTitlesFilter: TitleFilter
    $popularTitlesSortBy: PopularTitlesSorting! = POPULAR
    $profile: PosterProfile
    $sortRandomSeed: Int! = 0
    $watchNowFilter: WatchNowOfferFilter!
    $offset: Int = 0
  ) {
    popularTitles(
      country: $country
      filter: $popularTitlesFilter
      first: $first
      sortBy: $popularTitlesSortBy
      sortRandomSeed: $sortRandomSeed
      offset: $offset
      after: $after
    ) {
      edges {
        node {
          ...PopularTitleGraphql
          __typename
        }
      }
      pageInfo {
        startCursor
        endCursor
        hasPreviousPage
        hasNextPage
      }
      totalCount
    }
  }

  fragment PopularTitleGraphql on MovieOrShow {
    id
    objectId
    objectType
    content(country: $country, language: $language) {
      title
      fullPath
      originalReleaseYear
      shortDescription
      genres {
        shortName
      }
      externalIds {
        imdbId
      }
      scoring {
        imdbVotes
        imdbScore
        tmdbPopularity
        tmdbScore
      }
      posterUrl(profile: $profile, format: $format)
      isReleased
      runtime
    }
    watchNowOffer(country: $country, platform: WEB, filter: $watchNowFilter) {
      id
      standardWebURL
      streamUrl
      streamUrlExternalPlayer
      package {
        id
        packageId
        clearName
        shortName
        technicalName
        icon
      }
      retailPrice(language: $language)
      retailPriceValue
      currency
      presentationType
      monetizationType
      availableTo
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

// ─── Simple in-memory cache ───────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return hit.data;
}

function cacheSet(key, data) {
  _cache.set(key, { data, ts: Date.now() });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function gql(query, variables) {
  const { data } = await axios.post(
    GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: 10_000,
    }
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
 * @param {number}   opts.first       - Max results (capped at 50)
 */
async function searchTitles({
  query = '',
  objectTypes = [],
  packages = [],
  genres = [],
  sortBy = 'POPULAR',
  country = 'US',
  language = 'en',
  first = 50,
} = {}) {
  const cacheKey = `search:${query}:${objectTypes.join(',')}:${packages.join(',')}:${genres.join(',')}:${sortBy}:${country}:${language}:${first}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const filter = {};
  if (query) filter.searchQuery = query;
  if (objectTypes.length) filter.objectTypes = objectTypes;
  if (packages.length) filter.packages = packages;
  if (genres.length) filter.genres = genres;

  const data = await gql(GET_POPULAR_TITLES_QUERY, {
    popularTitlesFilter: filter,
    country,
    language,
    first: Math.min(first, 50),
    popularTitlesSortBy: sortBy,
    sortRandomSeed: 0,
    watchNowFilter: {},
    profile: 'S718',
    format: 'JPG',
  });

  const nodes = (data?.popularTitles?.edges || []).map((e) => e.node);
  cacheSet(cacheKey, nodes);
  return nodes;
}

/**
 * Get streaming offers for a JustWatch node.
 *
 * @param {string} nodeId    - JustWatch internal node ID
 * @param {string} country   - ISO country code (e.g. 'ES')
 * @param {string} language  - BCP47 language code (e.g. 'es')
 */
async function getTitleOffers(nodeId, country = 'US', language = 'en') {
  const cacheKey = `offers:${nodeId}:${country}:${language}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await gql(buildOffersQuery(country), {
    nodeId,
    language,
    filterBuy: {},
    platform: 'WEB',
  });

  const offers = data?.node?.[country.toLowerCase()] || [];
  cacheSet(cacheKey, offers);
  return offers;
}

/**
 * Get available streaming packages for a country.
 *
 * @param {string} country - ISO country code (e.g. 'ES')
 * @returns {Promise<Array>} Array of package objects with iconUrl resolved
 */
async function getPackages(country = 'US') {
  const cacheKey = `packages:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await gql(GET_PACKAGES_QUERY, { country, platform: 'WEB' });
  const pkgs = (data?.packages || []).map((pkg) => ({
    ...pkg,
    iconUrl: pkg.icon
      ? `https://images.justwatch.com${pkg.icon.replace('{format}', 'webp')}`
      : null,
  }));
  cacheSet(cacheKey, pkgs);
  return pkgs;
}

module.exports = { searchTitles, getTitleOffers, getPackages };
