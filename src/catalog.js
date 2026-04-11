'use strict';

const { searchTitles } = require('./justwatch');
const { getGenreCode, SORT_MAP } = require('./config');

const TYPE_TO_JW = { movie: 'MOVIE', series: 'SHOW' };

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
 * Catalog handler.
 *
 * Catalog ID format: jw_{sortKey}_{technicalName}
 *   sortKey      = 'pop' | 'new'
 *   technicalName = JustWatch package technical name (may contain underscores)
 *
 * @param {object} args
 * @param {string} args.type   - 'movie' | 'series'
 * @param {string} args.id     - Catalog ID (e.g. jw_pop_nfx)
 * @param {object} args.extra  - { search?, genre?, skip? } from Stremio
 * @param {object} config      - { country, language, packages }
 */
async function handleCatalog({ type, id, extra }, config) {
  const { search, genre } = extra || {};
  const jwType = TYPE_TO_JW[type];

  // Parse: jw_{sortKey}_{technicalName...}
  // parts[0] = 'jw', parts[1] = sortKey, parts[2..] = technicalName (joined with _)
  const parts   = id.split('_');
  const sortKey = parts[1] || 'pop';
  const pkgName = parts.slice(2).join('_');

  const sortBy    = SORT_MAP[sortKey] || 'POPULAR';
  const genreCode = genre ? getGenreCode(genre, config.language) : null;

  try {
    const titles = await searchTitles({
      query:       search || '',
      objectTypes: jwType ? [jwType] : [],
      packages:    pkgName ? [pkgName] : [],
      genres:      genreCode ? [genreCode] : [],
      sortBy,
      country:     config.country,
      language:    config.language,
      first:       50,
    });

    const metas = titles
      .filter((n) => !jwType || n.objectType === jwType)
      .map(nodeToMeta)
      .filter(Boolean);

    return { metas };
  } catch (err) {
    console.error('[catalog] Error:', err);
    return { metas: [] };
  }
}

module.exports = { handleCatalog };
