"use strict";

const { searchTitles } = require("../infra/justwatch");
const { peekTop10 } = require("../infra/netflixTop10");
const { nodeToMeta } = require("./meta");

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
 * by normalized title to fill those in via the exact same nodeToMeta() every
 * other catalog uses. An entry that can't be matched confidently, or whose
 * match has no IMDb id, is dropped rather than guessed at.
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

  const seen = new Set();
  const metas = [];
  for (const node of matches) {
    if (!node) continue;
    const meta = nodeToMeta(node, language, config);
    if (!meta || seen.has(meta.id)) continue;
    seen.add(meta.id);
    metas.push(meta);
  }
  return metas;
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

// Netflix's Top10 export has quirks plain JustWatch title text doesn't (a
// trailing comma on "Nevertheless,", accents, punctuation) — strip down to
// bare alnum tokens on both sides before comparing so those don't cause a
// real match to be missed.
function normalizeTitle(title) {
  return (title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

module.exports = { getOfficialNetflixTrending };
