"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { TMDB_FALLBACK_TTL_S } = require("../ttl");
const { createCircuitBreaker } = require("./circuitBreaker");
const { normalizeTitle } = require("../data/titleMatch");

const TMDB_BASE = "https://api.themoviedb.org/3";
// The operator's own key, read once at module load — same "unset → feature is
// off" contract as DATABASE_URL/UPSTASH_REDIS_* elsewhere in ../infra. It only
// serves callers that don't bring a key (the anonymous /{config} flow). An
// account brings its own (see resolveImdbId's `apiKey`), so a paid service
// never runs on a free key that TMDb licenses for non-commercial use.
const ENV_KEY = process.env.TMDB_API_KEY;

// TMDb issues two credentials for the same account: the 32-hex "API key"
// (sent as ?api_key=) and the long JWT "API Read Access Token" (sent as a
// Bearer header). People routinely paste the wrong one, so both are accepted.
const V3_KEY = /^[a-f0-9]{32}$/i;
const V4_TOKEN = /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/;
const isValidKeyFormat = (key) =>
  typeof key === "string" && key.length <= 600 && (V3_KEY.test(key) || V4_TOKEN.test(key));

// Failure state is **per key**. With one shared breaker, a single user's
// mistyped or revoked key would open it and switch the fallback off for every
// other account; and a key TMDb has said is invalid (401) shouldn't be asked
// again on every catalog request either.
//
// The breaker itself is unchanged in intent: resolveImdbId() runs inline in
// the live catalog request path (nodeToMetaWithFallback awaits it), so a
// handful of genuinely transient blips are worth tolerating (threshold 3)
// before skipping straight to null for a cooldown — without it a down TMDb
// would add its own timeout to every catalog request holding a title with no
// imdbId, for as long as it stayed down.
const INVALID_KEY_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_TRACKED_KEYS = 5000;
const keyStates = new Map(); // key -> { breaker, invalidUntil }

function newState() {
  return { breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 2 * 60 * 1000 }), invalidUntil: 0 };
}
function stateFor(key) {
  let st = keyStates.get(key);
  if (!st) {
    if (keyStates.size >= MAX_TRACKED_KEYS) keyStates.clear();
    st = newState();
    keyStates.set(key, st);
  }
  return st;
}
// Exported for tests: the state behind the operator's key (or a standalone one
// when none is configured), which is what the pre-account tests inspect.
const breaker = (ENV_KEY ? stateFor(ENV_KEY) : newState()).breaker;

class TmdbHttpError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function tmdbGet(path, params, key) {
  const url = new URL(`${TMDB_BASE}${path}`);
  const headers = {};
  if (V4_TOKEN.test(key)) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(name, String(value));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw new TmdbHttpError(res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask TMDb whether a key works. Used when a user saves one, so a typo is
 * reported to them then and there instead of silently disabling the fallback.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: "format"|"invalid"|"unreachable"}>}
 *   "unreachable" means TMDb couldn't be asked (network, 5xx) — not a verdict
 *   on the key, so callers should let it through.
 */
async function verifyKey(key) {
  if (!isValidKeyFormat(key)) return { ok: false, reason: "format" };
  try {
    await tmdbGet("/authentication", {}, key);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.status === 401 ? "invalid" : "unreachable" };
  }
}

// Throws on a genuine failure (network/timeout/non-2xx) so the caller can
// tell that apart from "TMDb answered, this title just isn't there" — only
// the former should count against the breaker.
async function lookup({ title, year, type, key }) {
  const isTv = type === "tv";
  const data = await tmdbGet(isTv ? "/search/tv" : "/search/movie", {
    query: title,
    [isTv ? "first_air_date_year" : "year"]: year,
  }, key);
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
    key,
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
 * A no-op (always null, no network) without a key — same "off unless
 * configured" contract as the L2 Redis cache and the Postgres cache warmer.
 * The key is the caller's: an account passes its own (or null when it hasn't
 * set one, which turns the fallback off for it); a caller that passes nothing
 * (`apiKey` undefined, the anonymous flow) falls back to TMDB_API_KEY.
 *
 * Both a match and a confident "no match" are cached (see TMDB_FALLBACK_TTL_S
 * in ../ttl) — a title JustWatch never links is not rare, and without a
 * negative cache it would retry the same failed lookup on every catalog
 * fetch, forever. The cache is shared across keys (it maps a title to a
 * public IMDb id and is never served to a caller that has no key of its own).
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {number|null} [opts.year]  - release year, if known; narrows the TMDb search
 * @param {"movie"|"tv"} opts.type
 * @param {string|null} [opts.apiKey] - the caller's TMDb key; null disables, undefined → TMDB_API_KEY
 * @returns {Promise<string|null>}
 */
async function resolveImdbId({ title, year, type, apiKey }) {
  const key = apiKey === undefined ? ENV_KEY : apiKey;
  if (!key || !title) return null;

  const state = stateFor(key);
  // TMDb already told us this key is bad; don't ask again until the cooldown.
  if (Date.now() < state.invalidUntil) return null;

  const cacheKey = `tmdbFallback:${type}:${year || ""}:${normalizeTitle(title)}`;
  let cached = await L1Cache.get(cacheKey);
  if (!cached) {
    cached = await L2Cache.get(cacheKey);
    if (cached) L1Cache.set(cacheKey, cached, TMDB_FALLBACK_TTL_S);
  }
  if (cached) return cached.imdbId; // may itself be a cached "no match" (null)

  // Open breaker → skip straight to null instead of paying up to 8s of
  // timeout on a TMDb that's already known to be down for this key right now.
  if (state.breaker.isOpen()) return null;

  let imdbId;
  try {
    imdbId = await lookup({ title, year, type, key });
    state.breaker.recordSuccess();
  } catch (err) {
    if (err.status === 401) {
      // The key is the problem, not TMDb: park the key, leave the breaker
      // alone (nothing is wrong with the upstream).
      state.invalidUntil = Date.now() + INVALID_KEY_COOLDOWN_MS;
      console.warn("[tmdbFallback] TMDb rejected an API key; pausing lookups for it for 1h");
      return null;
    }
    state.breaker.recordFailure();
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
  verifyKey,
  isValidKeyFormat,
  // Exported for tests and for anyone wanting to inspect/reset upstream state.
  breaker,
};
