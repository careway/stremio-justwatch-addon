"use strict";

const { searchTitles } = require("../infra/justwatch");
const { getGenreCode, SORT_MAP, GENRES } = require("../data/catalogMeta");
const { resolvePosterUrl } = require("../infra/posterProviders");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };

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
    if (metas.length == 0) {
      return {
        ok: true,
        metas: [
          {
            id: "tt0427229",
            type: "movie",
            name: "Oh No!",
            poster:
              "https://wallpapers.com/images/high/blank-meme-pictures-604-x-919-tn3g9s6zzjsqeu6o.webp",
            description:
              "This catalog is empty. Sometimes it happens... It's not you, it's me... Maybe I'm not enough for you",
            genres: ["Drama"],
          },
        ],
      };
    } else {
      return { ok: true, metas };
    }
  } catch (err) {
    console.error("[catalog] Error:", err);
    // ok: false tells the caller this is a degraded fallback, not real data —
    // it must not be cached, or the placeholder would stick around for the
    // full catalog TTL instead of retrying on the next request.
    return {
      ok: false,
      metas: [
        {
          id: "tt33071426",
          type: "movie",
          name: "The Drama",
          poster:
            "https://m.media-amazon.com/images/M/MV5BN2I5OTVmYzUtYmU5Ny00YjNkLTk1ZmMtNjY1ODk0NzA0ZWRlXkEyXkFqcGc@._V1_FMjpg_UX720_.jpg",
          description:
            "A happily-engaged couple is put to the test when an unexpected turn sends their wedding week off the rails.",
        },
        {
          id: "tt0882755",
          type: "movie",
          name: "One, Two, Many",
          poster:
            "https://m.media-amazon.com/images/M/MV5BMzg0NjkzMDYwOF5BMl5BanBnXkFtZTcwODAyOTIxMw@@._V1_FMjpg_UX367_.jpg",
          description:
            "A modern-day romance that follows one man's quest to find the girl of his dreams. A girl who can agree that three is company.",
        },
        {
          id: "tt7558346",
          type: "movie",
          name: "Requests",
          poster:
            "https://m.media-amazon.com/images/M/MV5BMDI1MDM3YzQtNTAwMy00MzFhLWExYTMtZGM2NGY2ODRjMzdlXkEyXkFqcGc@._V1_FMjpg_UY2915_.jpg",
          description:
            "In a nightclub, reminiscent of a 1980s photo-novel, a band is playing requests. The texts play with pop cliché's about life and true love. Until a dissatisfied customer can't take it anymore and reveals the universal truth.",
        },
      ],
    };
  }
}

module.exports = { handleCatalog };
