"use strict";

const { searchTitles } = require("./justwatch");
const { getGenreCode, SORT_MAP, GENRES } = require("./config");

const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };

function nodeToMeta(node, language) {
  const imdbId = node?.content?.externalIds?.imdbId;
  if (!imdbId) return null;

  const lang = (language || "en").toLowerCase().split("-")[0];

  const posterUrl = node.content.posterUrl
    ? `https://images.justwatch.com${node.content.posterUrl}`
    : undefined;

  return {
    id: imdbId,
    type: node.objectType === "MOVIE" ? "movie" : "series",
    name: node.content.title,
    poster: posterUrl,
    description: node.content.shortDescription || undefined,
    releaseInfo: node.content.originalReleaseYear
      ? String(node.content.originalReleaseYear)
      : undefined,
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

  const offset = Math.max(0, parseInt(skip, 10) || 0);
  const jwType = TYPE_TO_JW[type];

  // Parse: jw_{sortKey}_{technicalName...}
  // parts[0] = 'jw', parts[1] = sortKey, parts[2..] = technicalName (joined with _)
  const parts = id.split("_");
  const sortKey = parts[1] || "pop";
  const pkgName = parts.slice(2).join("_");

  const sortBy = SORT_MAP[sortKey] || "POPULAR";
  const genreCode = genre ? getGenreCode(genre, config.language) : null;

  try {
    const titles = await searchTitles({
      query: "",
      objectTypes: jwType ? [jwType] : [],
      packages: pkgName ? [pkgName] : [],
      genres: genreCode ? [genreCode] : [],
      sortBy,
      country: config.country,
      language: config.language,
      first: 50,
      offset,
    });

    const metas = titles
      .filter((n) => !jwType || n.objectType === jwType)
      .map((n) => nodeToMeta(n, config.language))
      .filter(Boolean);

    return { metas };
  } catch (err) {
    console.error("[catalog] Error:", err);
    return { metas: [] };
  }
}

module.exports = { handleCatalog };
