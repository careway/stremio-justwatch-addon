"use strict";

const { searchTitles } = require("../infra/justwatch");
const {
  getGenreCode,
  SORT_MAP,
  GENRES,
  GLOBAL_PACKAGE_ID,
} = require("../data/catalogMeta");
const { resolvePosterUrl } = require("../infra/posterProviders");
const { seedFromString, seededShuffle, seedWindow } = require("./random");
const { TTL_S } = require("../ttl");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };

// A randomized catalog (id "r_jw_…") is shuffled in *blocks*, each seeded
// independently, rather than in one growing pool. There is no depth ceiling:
// paging deeper keeps returning shuffled results instead of dropping back to
// plain ranking.
//
// Per-block seeding is what makes the randomized region extendable at all.
// Growing one pool and re-shuffling it would reorder the pages already served
// — reaching a later page would rearrange an earlier one, so the user would
// see titles twice and miss others. Seeding each block on its own index
// leaves earlier blocks frozen forever.
//
// Stable pagination and an ever-widening pool are mutually exclusive; stable
// pagination wins, because it's the one users notice.
const PAGE_SIZE = 50;

// Titles fetched per shuffle block, in pages. **One**, deliberately.
//
// A randomized catalog has to cost the same upstream as a plain one. When a
// manifest loads, Stremio asks for page 1 of *every* catalog at once, so any
// multiplier here multiplies that entire burst. Fetching 3 pages (150 titles)
// per block is what saturated JustWatch into returning errors (2026-09-01) —
// and nothing bounds the fan-out today, since the concurrency queue in
// infra/justwatch.js is disabled (see its DISABLED note).
//
// The cost, accepted knowingly: the shuffle only permutes *within* a page, so
// a title never moves between pages and page 1 always holds the same top 50 by
// rank, reordered. The randomized region still extends page by page as the
// user scrolls, because each page is its own block with its own seed.
//
// Raising this widens the shuffle and multiplies the manifest-load burst by
// the same factor. It is the one number to change if that trade is ever
// revisited — don't reintroduce a separate "first block" special case.
const RANDOM_BLOCK_PAGES = 1;

// Maps an offset onto its block: where the block starts, how many pages it
// spans, and its index (which seeds it).
//
// Blocks are **fixed domains** — a given offset always lands in the same block
// with the same span, independent of the request. A block whose size depended
// on the offset asked for would shuffle two overlapping requests differently
// and break pagination.
function randomBlockFor(offset) {
  const index = Math.floor(offset / PAGE_SIZE / RANDOM_BLOCK_PAGES);
  return {
    index,
    startPage: index * RANDOM_BLOCK_PAGES,
    pages: RANDOM_BLOCK_PAGES,
  };
}

// The seed rotates on the same cadence the data underneath it does. It used to
// be a fixed UTC day, which outlived the data by 6x: the pool is cached for
// TTL_S, so it was refetched and changed while the seed stayed frozen, and a
// user paging through at that moment got duplicates and gaps. Deriving it from
// TTL_S keeps the two in step — and keeps following if that TTL ever changes,
// including if it ever becomes per-sort.
const RANDOM_SEED_WINDOW_MS = TTL_S * 1000;

/**
 * JustWatch's catalog includes announced/upcoming titles (e.g. sequels with
 * a far-future release date) alongside already-released ones — most visible
 * on the "new" (RELEASE_YEAR) sort, where they'd otherwise surface first.
 * Excludes only titles with a *known* future release date; a missing date
 * is treated as released rather than hidden, so incomplete JustWatch
 * metadata never silently drops legitimate titles.
 */
function isUnreleased(node) {
  const releaseDate = node?.content?.originalReleaseDate;
  if (!releaseDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return releaseDate > today;
}

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
 *   sortKey      = 'pop' | 'tnd' | 'new'
 *   technicalName = JustWatch package technical name (may contain underscores),
 *                    or GLOBAL_PACKAGE_ID for the whole-country, no-provider-filter
 *                    catalogs (see ../data/catalogMeta)
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
  // An "r_" prefix (set by buildManifest for a randomized config) means this
  // catalog is served shuffled — strip it before parsing sort key / package.
  const randomize = id.startsWith("r_");
  const coreId = randomize ? id.slice(2) : id;
  const parts = coreId.split("_");
  const sortKey = parts[1] || "pop";
  const pkgName = parts.slice(2).join("_");
  // "global" catalogs aggregate across every provider — no packages filter.
  const packageFilter =
    pkgName && pkgName !== GLOBAL_PACKAGE_ID ? [pkgName] : [];
  const sortBy = SORT_MAP[sortKey] || "POPULAR";
  const genreCode = genre ? getGenreCode(genre, config.language) : null;

  const fetchPage = (pageOffset) =>
    searchTitles({
      query: "",
      objectTypes: jwType ? [jwType] : [],
      packages: packageFilter,
      genres: genreCode ? [genreCode] : [],
      sortBy,
      country: config.country,
      language: config.language,
      first: 50,
      offset: pageOffset,
    });

  const buildMetas = (nodes) => {
    const seen = new Set();
    return nodes
      .filter((n) => !jwType || n.objectType === jwType)
      .filter((n) => !isUnreleased(n))
      .map((n) => nodeToMeta(n, config.language, config))
      .filter((meta) => {
        if (!meta || !meta.id || seen.has(meta.id)) return false;
        seen.add(meta.id);
        return true;
      });
  };

  try {
    // Fetch only the block this offset falls in, shuffle it against a seed
    // carrying that block's index, and serve the slice. No depth ceiling: the
    // randomized region widens a block at a time as the user pages, while the
    // first page stays at a single upstream call.
    if (randomize) {
      const block = randomBlockFor(offset);
      const blockStart = block.startPage * PAGE_SIZE;
      const pages = await Promise.all(
        Array.from({ length: block.pages }, (_, i) =>
          delay(i * 10).then(() => fetchPage(blockStart + i * PAGE_SIZE)),
        ),
      );
      const seed = seedFromString(
        [
          coreId,
          type,
          genreCode || "",
          block.index,
          seedWindow(RANDOM_SEED_WINDOW_MS),
        ].join("|"),
      );
      const offsetInBlock = offset - blockStart;
      const metas = seededShuffle(buildMetas(pages.flat()), seed).slice(
        offsetInBlock,
        offsetInBlock + PAGE_SIZE,
      );
      if (metas.length) return { ok: true, metas };
      // Empty block → fall through to the plain path's placeholder handling.
    }

    // Calculate batch boundaries
    const batchSize = 50;
    const batchStart1 = Math.floor(offset / batchSize) * batchSize;

    // If offset is perfectly aligned (e.g., 0, 50, 100), we only need 1 call.
    // If offset is misaligned (e.g., 98), we need 2 calls to fulfill the 50 items.
    const needsSecondBatch = offset % batchSize !== 0;

    // Set up the first request
    const requests = [fetchPage(batchStart1)];

    // Conditionally add the second request ONLY if needed
    if (needsSecondBatch) {
      requests.push(delay(10).then(() => fetchPage(batchStart1 + batchSize)));
    }

    // Execute the requests
    // If there's only 1 request, titles2 will safely default to an empty array []
    const [titles1, titles2 = []] = await Promise.all(requests);

    const metas = buildMetas([...titles1, ...titles2]);
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
