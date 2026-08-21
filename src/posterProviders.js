"use strict";

/**
 * Poster provider adapter registry.
 *
 * Every provider here follows the same shape popularized by RPDB — a poster
 * image reachable at `{base}/{apiKey}/imdb/poster-default/{imdbId}.jpg` — so
 * "buildUrl" is trivial for now. The registry exists so that assumption
 * doesn't leak elsewhere: adding a differently-shaped provider later only
 * means adding an entry with its own buildUrl here. Nothing in catalog.js,
 * config.js's URL encoding, or the configure UI needs to know the specifics
 * of any one provider — they all just read this list.
 */
const PROVIDERS = [
  {
    id: "rpdb",
    name: "RatingPosterDB (RPDB)",
    keyPlaceholder: "t8-xxxxxxxxxxxxxxxx",
    keyHelpUrl: "https://ratingposterdb.com",
    buildUrl: (imdbId, apiKey) =>
      `https://api.ratingposterdb.com/${apiKey}/imdb/poster-default/${imdbId}.jpg`,
  },
  {
    id: "topposters",
    name: "TOP Posters",
    keyPlaceholder: "TP-xxxxxxxxxxxxxxxx",
    keyHelpUrl: "https://top-posters.com",
    buildUrl: (imdbId, apiKey) =>
      `https://api.top-posters.com/${apiKey}/imdb/poster-default/${imdbId}.jpg`,
  },
];

const PROVIDERS_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

/**
 * Resolve the poster URL for a title.
 * Order: configured provider (if both an id and a key are set) → JustWatch's
 * own poster → Metahub as the universal last resort (always works, no key).
 *
 * @param {object} opts
 * @param {string} opts.imdbId
 * @param {string} [opts.jwPosterUrl]     - JustWatch's relative poster path
 * @param {string} [opts.posterProvider]  - provider id from config, e.g. 'rpdb'
 * @param {string} [opts.posterApiKey]    - user's API key for that provider
 */
function resolvePosterUrl({
  imdbId,
  jwPosterUrl,
  posterProvider,
  posterApiKey,
}) {
  const provider = posterProvider ? PROVIDERS_BY_ID[posterProvider] : null;
  if (provider && posterApiKey) {
    return provider.buildUrl(imdbId, posterApiKey);
  }
  if (jwPosterUrl) return `https://images.justwatch.com${jwPosterUrl}`;
  return `https://images.metahub.space/poster/medium/${imdbId}/img`;
}

/**
 * Public provider list for the configure UI — no internal fields like
 * buildUrl leak out.
 */
function listProviders() {
  return PROVIDERS.map(({ id, name, keyPlaceholder, keyHelpUrl }) => ({
    id,
    name,
    keyPlaceholder,
    keyHelpUrl,
  }));
}

module.exports = { resolvePosterUrl, listProviders };
