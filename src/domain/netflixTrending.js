"use strict";

const { searchTitles } = require("../infra/justwatch");
const { peekTop10 } = require("../infra/netflixTop10");
const { nodeToMetaWithFallback } = require("./meta");
const { normalizeTitle } = require("../data/titleMatch");

const NETFLIX_PACKAGE = "nfx";

/**
 * Netflix's official weekly Top 10 (see ../infra/netflixTop10) is the one
 * part of this addon's catalogs backed by data Netflix itself publishes,
 * rather than JustWatch's own cross-provider popularity metric — which is
 * what every other sort/provider still runs on, and which a country-by-country
 * check (2026-09-12) showed can rank titles nowhere near what's actually
 * trending on Netflix locally (JustWatch's POPULAR/TRENDING sort reflects
 * traffic on justwatch.com itself, skewed toward internationally known
 * English-language titles, not Netflix's own per-country viewership — e.g.
 * Malaysia's JustWatch "trending" surfaced Yellowstone/Breaking Bad/Rick and
 * Morty while Netflix's own chart that week was almost entirely local Malay
 * content).
 *
 * Netflix ships no metadata alongside the ranking — just a bare title per
 * rank, no poster/synopsis/genres/IMDb id — so each entry is matched back
 * onto JustWatch (restricted to Netflix's own catalog, `packages: ["nfx"]`)
 * by normalized title to fill those in via the same nodeToMetaWithFallback()
 * every other catalog uses (see ../domain/meta and ../infra/tmdbFallback for
 * the TMDb-backed fallback when JustWatch has the title but no IMDb id
 * linked yet — a brand-new release, most often). An entry that still can't
 * be matched to an IMDb id even after that is dropped rather than guessed
 * at, and any entry that only resolved through the fallback is demoted below
 * every confidently-matched entry, official rank or not — this only ever
 * ranks ~10 titles to begin with, so a lower-confidence one sitting at the
 * bottom of that short list is a small cost for not silently dropping it.
 *
 * Only ever covers the ~10 titles Netflix ranks that week per content type —
 * callers should use this for offset 0 of the Netflix "Trending" catalog only
 * and keep paging with the regular JustWatch-backed path beyond that.
 *
 * Uses peekTop10() rather than getTop10(): on a cold cache the ~30MB Netflix
 * file can take 15-20s to download, which is fine for a background warm but
 * would stall this request past what Stremio tolerates — so a cold cache
 * here just means "no official data *yet*", same as any other miss, while
 * peekTop10() warms it in the background for the next request.
 *
 * @param {object} opts
 * @param {"MOVIE"|"SHOW"} opts.jwType
 * @param {string} opts.country   - ISO country code
 * @param {string} opts.language  - BCP47 language code, for the matched meta's genre names
 * @param {object} opts.config    - poster provider config, forwarded to nodeToMeta
 * @returns {Promise<Array|null>} metas in official rank order, or null when
 *   there's no official chart available for this country right now — caller
 *   should fall back to the plain JustWatch path.
 */
async function getOfficialNetflixTrending({ jwType, country, language, config }) {
  const chart = await peekTop10(country);
  if (!chart) return null;

  const bucket = jwType === "MOVIE" ? chart.films : chart.tv;
  if (!bucket || !bucket.length) return null;

  const matches = await Promise.all(
    bucket.map((entry) =>
      matchOnJustWatch(entry.title, jwType, country, language),
    ),
  );

  const resolved = await Promise.all(
    matches.map((node) =>
      node ? nodeToMetaWithFallback(node, language, config) : null,
    ),
  );

  const seen = new Set();
  const confident = [];
  const fallback = [];
  for (const r of resolved) {
    if (!r?.meta?.id || seen.has(r.meta.id)) continue;
    seen.add(r.meta.id);
    (r.viaFallback ? fallback : confident).push(r.meta);
  }
  return [...confident, ...fallback];
}

async function matchOnJustWatch(title, jwType, country, language) {
  const nodes = await searchTitles({
    query: title,
    objectTypes: [jwType],
    packages: [NETFLIX_PACKAGE],
    country,
    language,
    first: 5,
    offset: 0,
  });
  const target = normalizeTitle(title);
  return nodes.find((n) => normalizeTitle(n?.content?.title) === target) || null;
}

module.exports = { getOfficialNetflixTrending };
