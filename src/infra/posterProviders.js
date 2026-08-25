"use strict";

/**
 * Poster provider adapter registry.
 *
 * Most providers here follow the shape popularized by RPDB — a poster image
 * reachable at `{base}/{apiKey}/imdb/poster-default/{imdbId}.jpg`, apiKey a
 * short token dropped into a template we own. BetterPosters (btttr) breaks
 * that assumption on purpose: its "key" is an optional, fully custom URL the
 * user builds elsewhere and pastes in whole. Each provider's own `buildUrl`
 * owns that difference — nothing in catalog.js, userConfig.js's URL
 * encoding, or the configure UI needs to know the specifics of any one
 * provider, they all just read this list and call `resolvePosterUrl`.
 */

/**
 * Returns `pattern` if it contains the literal "{imdb_id}" placeholder — or,
 * failing that, its percent-decoded form if *that* contains it. btttr.cc's
 * own configure page notes that iOS's clipboard sometimes URL-encodes a
 * copied pattern ("{imdb_id}" → "%7Bimdb_id%7D") when it's typed as a URL,
 * so a pattern pasted from an iPhone/iPad can arrive already percent-encoded.
 * Returns null if neither form has the placeholder.
 */
function resolveImdbIdPlaceholder(pattern) {
  if (!pattern) return null;
  if (pattern.includes("{imdb_id}")) return pattern;
  try {
    const decoded = decodeURIComponent(pattern);
    if (decoded.includes("{imdb_id}")) return decoded;
  } catch {
    // malformed percent-encoding — fall through to null
  }
  return null;
}

const PROVIDERS = [
  {
    id: "rpdb",
    name: "RatingPosterDB (RPDB)",
    requiresKey: true,
    keyPlaceholder: "t8-xxxxxxxxxxxxxxxx",
    keyHelpUrl: "https://ratingposterdb.com",
    buildUrl: (imdbId, apiKey) =>
      `https://api.ratingposterdb.com/${apiKey}/imdb/poster-default/${imdbId}.jpg`,
  },
  {
    id: "topposters",
    name: "TOP Posters",
    requiresKey: true,
    keyPlaceholder: "TP-xxxxxxxxxxxxxxxx",
    keyHelpUrl: "https://top-posters.com",
    buildUrl: (imdbId, apiKey) =>
      `https://api.top-posters.com/${apiKey}/imdb/poster-default/${imdbId}.jpg`,
  },
  {
    id: "btttr",
    name: "BetterPosters",
    // Free and keyless by default. But unlike the other two, the "key"
    // field here isn't a token inserted into a fixed template we own — it's
    // an optional, fully custom URL pattern the user builds themselves at
    // btttr.cc/configure (their own style/badge choices baked in) and pastes
    // in whole, containing the literal placeholder "{imdb_id}". Left blank,
    // falls back to the plain default pattern below.
    requiresKey: false,
    keyIsUrlTemplate: true,
    keyPlaceholder: "Pega tu URL pattern de btttr.cc/configure (opcional)",
    keyHelpUrl: "https://btttr.cc/configure",
    buildUrl: (imdbId, urlPattern) => {
      const pattern = resolveImdbIdPlaceholder(urlPattern);
      if (pattern) return pattern.replaceAll("{imdb_id}", imdbId);
      return `https://btttr.cc/poster/imdb/poster-default/${imdbId}.jpg`;
    },
  },
];

const PROVIDERS_BY_ID = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

/**
 * Resolve the poster URL for a title.
 * Order: configured provider (if it's set, and either it doesn't need a key
 * or one was given) → JustWatch's own poster → Metahub as the universal last
 * resort (always works, no key).
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
  // requiresKey must be explicitly false to skip the key check — anything
  // else (true, or missing on a future provider entry) defaults to "needs one".
  if (provider && (provider.requiresKey === false || posterApiKey)) {
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
  return PROVIDERS.map(
    ({ id, name, requiresKey, keyIsUrlTemplate, keyPlaceholder, keyHelpUrl }) => ({
      id,
      name,
      requiresKey,
      keyIsUrlTemplate: keyIsUrlTemplate || false,
      keyPlaceholder,
      keyHelpUrl,
    }),
  );
}

module.exports = { resolvePosterUrl, listProviders };
