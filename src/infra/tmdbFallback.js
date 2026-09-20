"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { TMDB_FALLBACK_TTL_S } = require("../ttl");
const { createCircuitBreaker } = require("./circuitBreaker");
const { normalizeTitle } = require("../data/titleMatch");

const TMDB_BASE = "https://api.themoviedb.org/3";
// Read once at module load — same "unset → feature is off" contract as
// DATABASE_URL/UPSTASH_REDIS_* elsewhere in ../infra. A free key is enough:
// themoviedb.org/settings/api.
const API_KEY = process.env.TMDB_API_KEY;

// Unlike ../infra/netflixTop10's breaker (threshold 1 — one big file, one
// failure is the whole signal), resolveImdbId() runs inline in the live
// catalog request path (nodeToMetaWithFallback awaits it), so a handful of
// genuinely transient blips are worth tolerating before giving up — opening
// too eagerly would mean flipping every missing-imdbId title's fate on one
// bad request. Once open, though, skip straight to null: without this, a
// down TMDb would add its own timeout to every catalog request holding a
// title with no imdbId, for as long as it stayed down.
const breaker = createCircuitBreaker({ threshold: 3, cooldownMs: 2 * 60 * 1000 });

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
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Throws on a genuine failure (network/timeout/non-2xx) so the caller can
// tell that apart from "TMDb answered, this title just isn't there" — only
// the former should count against the breaker.
async function lookup({ title, year, type }) {
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
  //
  // Checked against both the (display) title and original_title/name: TMDb
  // defaults to an en-US display title with no `language` param — confirmed
  // live 2026-09-20 on the exact case this fallback was built for,
  // "Enfrentados: Marfil" (original_title), which TMDb's `title` field
  // answers as "Drawn Together" — comparing only `title` rejected it and
  // this fallback failed on its own motivating example.
  const match = (data?.results || [])
    .slice(0, 5)
    .find((r) => {
      const display = normalizeTitle(r.title || r.name);
      const original = normalizeTitle(r.original_title || r.original_name);
      return display === target || original === target;
    });
  if (!match) return null;

  const ids = await tmdbGet(
    isTv ? `/tv/${match.id}/external_ids` : `/movie/${match.id}/external_ids`,
    {},
  );
  return ids?.imdb_id || null;
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

  // Open breaker → skip straight to null instead of paying up to 8s of
  // timeout on a TMDb that's already known to be down right now.
  if (breaker.isOpen()) return null;

  let imdbId;
  try {
    imdbId = await lookup({ title, year, type });
    breaker.recordSuccess();
  } catch (err) {
    breaker.recordFailure();
    console.warn(`[tmdbFallback] lookup failed for "${title}": ${err.message}`);
    return null; // not cached — a real outage shouldn't poison this title for 24h
  }

  const toStore = { imdbId };
  L1Cache.set(cacheKey, toStore, TMDB_FALLBACK_TTL_S);
  L2Cache.set(cacheKey, toStore, TMDB_FALLBACK_TTL_S);
  return imdbId;
}

module.exports = {
  resolveImdbId,
  // Exported for tests and for anyone wanting to inspect/reset upstream state.
  breaker,
};
