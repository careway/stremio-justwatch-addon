"use strict";

const { searchTitles } = require("./justwatch");
const { getGenreCode, SORT_MAP, GENRES } = require("./config");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };

function getPoster(imdbId, jwPosterUrl, rpdbKey) {
  if (rpdbKey)
    return `https://api.ratingposterdb.com/${rpdbKey}/imdb/poster-default/${imdbId}.jpg`;
  if (jwPosterUrl) return `https://images.justwatch.com${jwPosterUrl}`;
  return `https://images.metahub.space/poster/medium/${imdbId}/img`;
}

function nodeToMeta(node, language, config) {
  const imdbId = node?.content?.externalIds?.imdbId;
  if (!imdbId) return null;

  const lang = (language || "en").toLowerCase().split("-")[0];

  return {
    id: imdbId,
    type: node.objectType === "MOVIE" ? "movie" : "series",
    name: node.content.title,
    poster: getPoster(imdbId, node.content.posterUrl, config?.rpdbKey),
    description: node.content.shortDescription || undefined,
    genres: (node.content.genres || []).map((g) => {
      const entry = GENRES.find((e) => e.code === g.shortName);
      return entry ? entry.names[lang] || entry.names.en : g.shortName;
    }),
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
 * @param {object} args.extra  - { genre?, skip? } from Stremio
 * @param {object} config      - { country, language, packages }
 */
async function handleCatalog({ type, id, extra }, config) {
  const { genre, skip, search } = extra || {};

  // We only serve catalogs — search is handled by Cinemeta, not this addon
  if (search !== undefined) return null;

  // Improved batching: fetch both the batch containing skip and the next batch, then merge and deduplicate
  let offset = Math.max(0, parseInt(skip, 10) || 0);
  const jwType = TYPE_TO_JW[type];
  const parts = id.split("_");
  const sortKey = parts[1] || "pop";
  const pkgName = parts.slice(2).join("_");
  const sortBy = SORT_MAP[sortKey] || "POPULAR";
  const genreCode = genre ? getGenreCode(genre, config.language) : null;

  try {
    // Calculate batch boundaries
    const batchSize = 50;
    const batchStart1 = Math.floor(offset / batchSize) * batchSize;

    // If offset is perfectly aligned (e.g., 0, 50, 100), we only need 1 call.
    // If offset is misaligned (e.g., 98), we need 2 calls to fulfill the 50 items.
    const needsSecondBatch = offset % batchSize !== 0;

    // Set up the first request
    const requests = [
      searchTitles({
        query: "",
        objectTypes: jwType ? [jwType] : [],
        packages: pkgName ? [pkgName] : [],
        genres: genreCode ? [genreCode] : [],
        sortBy,
        country: config.country,
        language: config.language,
        first: batchSize,
        offset: batchStart1,
      }),
    ];

    // Conditionally add the second request ONLY if needed
    if (needsSecondBatch) {
      const batchStart2 = batchStart1 + batchSize;
      requests.push(
        delay(10).then(() =>
          searchTitles({
            query: "",
            objectTypes: jwType ? [jwType] : [],
            packages: pkgName ? [pkgName] : [],
            genres: genreCode ? [genreCode] : [],
            sortBy,
            country: config.country,
            language: config.language,
            first: batchSize,
            offset: batchStart2,
          }),
        ),
      );
    }

    // Execute the requests
    // If there's only 1 request, titles2 will safely default to an empty array []
    const [titles1, titles2 = []] = await Promise.all(requests);

    // Merge and deduplicate by imdbId
    const seen = new Set();
    const metas = [...titles1, ...titles2]
      .filter((n) => !jwType || n.objectType === jwType)
      .map((n) => nodeToMeta(n, config.language, config))
      .filter((meta) => {
        if (!meta || !meta.id) return false;
        if (seen.has(meta.id)) return false;
        seen.add(meta.id);
        return true;
      });

    return { metas };
  } catch (err) {
    console.error("[catalog] Error:", err);
    return { metas: [] };
  }
}

module.exports = { handleCatalog };
