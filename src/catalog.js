'use strict';

const { searchTitles } = require('./justwatch');

const COUNTRY = process.env.JUSTWATCH_COUNTRY || 'ES';

// Map Stremio types → JustWatch objectType values
const TYPE_TO_JW = { movie: 'MOVIE', series: 'SHOW' };

/**
 * Convert a JustWatch title node to a Stremio Meta object.
 * Returns null when there is no IMDB ID (Stremio requires a resolvable ID).
 */
function nodeToMeta(node) {
  const imdbId = node?.content?.externalIds?.imdbId;
  if (!imdbId) return null;

  const posterUrl = node.content.posterUrl
    ? `https://images.justwatch.com${node.content.posterUrl}`
    : undefined;

  return {
    id: imdbId,
    type: node.objectType === 'MOVIE' ? 'movie' : 'series',
    name: node.content.title,
    poster: posterUrl,
    description: node.content.shortDescription || undefined,
    releaseInfo: node.content.originalReleaseYear
      ? String(node.content.originalReleaseYear)
      : undefined,
    genres: (node.content.genres || []).map((g) => g.shortName),
  };
}

/**
 * Catalog handler for stremio-addon-sdk.
 * Handles both "popular" and "search" modes.
 */
async function handleCatalog({ type, extra }) {
  const { search, skip } = extra || {};
  const jwType = TYPE_TO_JW[type];

  try {
    const titles = await searchTitles({
      query: search || '',
      objectTypes: jwType ? [jwType] : [],
      country: COUNTRY,
      first: 20,
    });

    const metas = titles
      // Client-side type filter as safety net
      .filter((n) => !jwType || n.objectType === jwType)
      .map(nodeToMeta)
      .filter(Boolean);

    return { metas };
  } catch (err) {
    console.error('[catalog] Error:', err.message);
    return { metas: [] };
  }
}

module.exports = { handleCatalog };
