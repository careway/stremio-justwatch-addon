'use strict';

const axios = require('axios');

const GRAPHQL_URL = 'https://apis.justwatch.com/graphql';

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const SEARCH_TITLES_QUERY = `
  query GetSearchTitles(
    $searchTitlesFilter: TitleFilter!
    $country: Country!
    $language: Language!
    $first: Int!
    $profile: PosterProfile
    $formatPoster: ImageFormat
  ) {
    popularTitles(
      country: $country
      filter: $searchTitlesFilter
      first: $first
      sortBy: POPULAR
      sortRandomSeed: 0
    ) {
      edges {
        node {
          id
          objectType
          content(country: $country, language: $language) {
            title
            originalReleaseYear
            shortDescription
            genres {
              shortName
            }
            externalIds {
              imdbId
            }
            posterUrl(profile: $profile, format: $formatPoster)
          }
        }
      }
    }
  }
`;

/**
 * Builds the GetTitleOffers query dynamically for a single country.
 * The country alias in the query must match the variable injection syntax.
 */
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
 * Search (or browse popular) titles on JustWatch.
 *
 * @param {object} opts
 * @param {string}   opts.query       - Text to search. Pass '' for popular.
 * @param {string[]} opts.objectTypes - ['MOVIE'] | ['SHOW'] | []
 * @param {string}   opts.country     - ISO country code (e.g. 'ES')
 * @param {number}   opts.first       - Max results (default 20)
 * @returns {Promise<Array>} Array of JustWatch title nodes
 */
async function searchTitles({ query = '', objectTypes = [], country = 'US', first = 20 } = {}) {
  const cacheKey = `search:${query}:${objectTypes.join(',')}:${country}:${first}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const filter = {};
  if (query) filter.searchQuery = query;
  if (objectTypes.length) filter.objectTypes = objectTypes;

  const data = await gql(SEARCH_TITLES_QUERY, {
    searchTitlesFilter: filter,
    country,
    language: 'en',
    first,
    profile: 'S718',
    formatPoster: 'JPG',
  });

  const nodes = (data?.popularTitles?.edges || []).map((e) => e.node);
  cacheSet(cacheKey, nodes);
  return nodes;
}

/**
 * Get streaming offers for a JustWatch node.
 *
 * @param {string} nodeId   - JustWatch internal node ID
 * @param {string} country  - ISO country code (e.g. 'ES')
 * @returns {Promise<Array>} Array of offer objects
 */
async function getTitleOffers(nodeId, country = 'US') {
  const cacheKey = `offers:${nodeId}:${country}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const data = await gql(buildOffersQuery(country), {
    nodeId,
    language: 'en',
    filterBuy: {},
    platform: 'WEB',
  });

  const offers = data?.node?.[country.toLowerCase()] || [];
  cacheSet(cacheKey, offers);
  return offers;
}

module.exports = { searchTitles, getTitleOffers };
