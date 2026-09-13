"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { TMDB_FALLBACK_TTL_S } = require("../ttl");

const TMDB_BASE = "https://api.themoviedb.org/3";
// Read once at module load — same "unset → feature is off" contract as
// DATABASE_URL/UPSTASH_REDIS_* elsewhere in ../infra. A free key is enough:
// themoviedb.org/settings/api.
const API_KEY = process.env.TMDB_API_KEY;

// Same normalization ../domain/netflixTrending uses to compare a Netflix
// Top10 title against JustWatch's — reused here for the same reason: TMDb's
// own title text has its own casing/punctuation quirks.
function normalizeTitle(title) {
  return (title || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining accents after NFKD decomposition
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function tmdbGet(path, params) {
  const url = new URL(`${TMDB_BASE}${path}`);
  url.searchParams.set("api_key", API_KEY);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookup({ title, year, type }) {
  try {
    const isTv = type === "tv";
    const data = await tmdbGet(isTv ? "/search/tv" : "/search/movie", {
      query: title,
      [isTv ? "first_air_date_year" : "year"]: year,
    });
    const target = normalizeTitle(title);
    // Only the top 5 — and only an exact normalized-title match among them,
    // never just "TMDb's top hit by relevance". A caller surfaces anything
    // this returns as a real catalog entry, so a same-genre-different-title
    // false positive here would misattribute a totally different title's
    // poster/synopsis/streams, not just misorder something.
    const match = (data?.results || [])
      .slice(0, 5)
      .find((r) => normalizeTitle(r.title || r.name) === target);
    if (!match) return null;

    const ids = await tmdbGet(
      isTv ? `/tv/${match.id}/external_ids` : `/movie/${match.id}/external_ids`,
      {},
    );
    return ids?.imdb_id || null;
  } catch (err) {
    console.warn(`[tmdbFallback] lookup failed for "${title}": ${err.message}`);
    return null;
  }
}

/**
 * Resolve an IMDb id for a title JustWatch hasn't linked one for yet — most
 * often a title released in the last few days, where JustWatch's own catalog
 * feed lands before its own cross-reference-with-IMDb job runs. Confirmed
 * live 2026-09-13: "Enfrentados: Marfil" ("Drawn Together") on Amazon Prime
 * Video Spain, released 4 days earlier, already had an IMDb page — tt36073210
 * — JustWatch's `externalIds.imdbId` for it was still null.
 *
 * A no-op (always null, no network) unless TMDB_API_KEY is set — same
 * "off unless configured" contract as the L2 Redis cache and the Postgres
 * cache warmer. TMDb is free to use with a personal API key.
 *
 * Both a match and a confident "no match" are cached (see TMDB_FALLBACK_TTL_S
 * in ../ttl) — a title JustWatch never links is not rare, and without a
 * negative cache it would retry the same failed lookup on every catalog
 * fetch, forever.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {number|null} [opts.year]  - release year, if known; narrows the TMDb search
 * @param {"movie"|"tv"} opts.type
 * @returns {Promise<string|null>}
 */
async function resolveImdbId({ title, year, type }) {
  if (!API_KEY || !title) return null;

  const cacheKey = `tmdbFallback:${type}:${year || ""}:${normalizeTitle(title)}`;
  let cached = await L1Cache.get(cacheKey);
  if (!cached) {
    cached = await L2Cache.get(cacheKey);
    if (cached) L1Cache.set(cacheKey, cached, TMDB_FALLBACK_TTL_S);
  }
  if (cached) return cached.imdbId; // may itself be a cached "no match" (null)

  const imdbId = await lookup({ title, year, type });
  const toStore = { imdbId };
  L1Cache.set(cacheKey, toStore, TMDB_FALLBACK_TTL_S);
  L2Cache.set(cacheKey, toStore, TMDB_FALLBACK_TTL_S);
  return imdbId;
}

module.exports = { resolveImdbId };
