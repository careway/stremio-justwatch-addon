"use strict";

const { GENRES } = require("../data/catalogMeta");
const { resolvePosterUrl } = require("../infra/posterProviders");

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

module.exports = { nodeToMeta };
