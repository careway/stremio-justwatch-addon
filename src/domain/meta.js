"use strict";

const { GENRES } = require("../data/catalogMeta");
const { resolvePosterUrl } = require("../infra/posterProviders");
const { resolveImdbId } = require("../infra/tmdbFallback");

/**
 * Map a JustWatch popularTitles node to a Stremio meta object. Shared by the
 * plain JustWatch catalog path (../domain/catalog) and the official-Netflix-
 * Top10 enrichment path (./netflixTrending), which both need the exact same
 * shape.
 */
function nodeToMeta(node, language, config) {
  const imdbId = node?.content?.externalIds?.imdbId;
  if (!imdbId) return null;

  const lang = (language || "en").toLowerCase().split("-")[0];

  return {
    id: imdbId,
    type: node.objectType === "MOVIE" ? "movie" : "series",
    name: node.content.title,
    poster: resolvePosterUrl({
      imdbId,
      jwPosterUrl: node.content.posterUrl,
      posterProvider: config?.posterProvider,
      posterApiKey: config?.posterApiKey,
    }),
    description: node.content.shortDescription || undefined,
    genres: (node.content.genres || []).map((g) => {
      const entry = GENRES.find((e) => e.code === g.shortName);
      return entry ? entry.names[lang] || entry.names.en : g.shortName;
    }),
  };
}

function extractYear(dateStr) {
  const year = parseInt((dateStr || "").slice(0, 4), 10);
  return Number.isFinite(year) ? year : null;
}

/**
 * Same result as nodeToMeta(), but when JustWatch hasn't linked an IMDb id
 * yet (nodeToMeta's one drop condition) tries to resolve one via TMDb before
 * giving up — see ../infra/tmdbFallback for why that happens and how
 * conservative the match is. A no-op when TMDB_API_KEY isn't configured, so
 * this always resolves to exactly what nodeToMeta() would have.
 *
 * Callers MUST treat a `viaFallback: true` result as lower-confidence than a
 * native JustWatch match and rank it below every non-fallback result in the
 * same batch — this function only reports which kind of match was found, it
 * makes no ranking decision itself. See ../domain/catalog's buildMetas and
 * ./netflixTrending for where that ranking is actually enforced.
 *
 * @returns {Promise<{meta: object, viaFallback: boolean}|null>}
 */
async function nodeToMetaWithFallback(node, language, config) {
  const direct = nodeToMeta(node, language, config);
  if (direct) return { meta: direct, viaFallback: false };

  const title = node?.content?.title;
  if (!title) return null;

  const imdbId = await resolveImdbId({
    title,
    year: extractYear(node?.content?.originalReleaseDate),
    type: node?.objectType === "MOVIE" ? "movie" : "tv",
  });
  if (!imdbId) return null;

  const patched = {
    ...node,
    content: { ...node.content, externalIds: { imdbId } },
  };
  const meta = nodeToMeta(patched, language, config);
  return meta ? { meta, viaFallback: true } : null;
}

module.exports = { nodeToMeta, nodeToMetaWithFallback };
