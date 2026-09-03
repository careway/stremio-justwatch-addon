"use strict";

const axios = require("axios");
const { trackCacheHit, trackCacheMiss } = require("./analytics");
const { L1Cache, L2Cache } = require("./cache");
const {
  TTL_S,
  PACKAGES_TTL_S,
  UPSTREAM_FAIL_THRESHOLD,
  UPSTREAM_COOLDOWN_S,
} = require("../ttl");
const { createCircuitBreaker } = require("./circuitBreaker");
const stats = require("./stats");
const warmCache = require("./warmCache");
const {
  keepPackage,
  annotateChannels,
} = require("../data/packageFilters");
const GRAPHQL_URL = "https://apis.justwatch.com/graphql";

// ─── GraphQL Queries ──────────────────────────────────────────────────────────

const GET_POPULAR_TITLES_QUERY = `
  query GetPopularTitles(
    $country: Country!
    $first: Int! = 70
    $popularTitlesFilter: TitleFilter
    $popularTitlesSortBy: PopularTitlesSorting! = POPULAR
    $language: Language!
    $sortRandomSeed: Int! = 0
    $offset: Int = 0
  ) {
    popularTitles(
      country: $country
      filter: $popularTitlesFilter
      first: $first
      sortBy: $popularTitlesSortBy
      sortRandomSeed: $sortRandomSeed
      offset: $offset
    ) {
      edges {
        node {
          objectType
          content(country: $country, language: $language) {
            title
            shortDescription
            originalReleaseDate
            genres {
              shortName
            }
            externalIds {
              imdbId
            }
            posterUrl(profile: S718, format: JPG)
          }
        }
      }
    }
  }
`;

// includeAddons pulls in the channel/add-on packages — the "X Amazon Channel"
// and "X Roku Premium Channel" entries. Without it JustWatch simply omits them
// from `packages`, even though they are real, filterable providers: a title
// query with packages:["asb"] returns Screambox's catalogue correctly, and
// justwatch.com/us/provider/screambox-amazon-channel exists. They were
// invisible in /configure purely because the grid is built from this query.
// Impact when it was added (2026-09-02): US 348 -> 422, DE 160 -> 268,
// ES 99 -> 125, and it brings in HBO Max / Crunchyroll / AMC+ / Shudder /
// MUBI / Discovery+ Amazon Channels among others.
const GET_PACKAGES_QUERY = `
  query GetPackages(
    $country: Country!
    $platform: Platform! = WEB
    $includeAddons: Boolean! = true
  ) {
    packages(
      country: $country
      platform: $platform
      includeAddons: $includeAddons
    ) {
      id
      packageId
      clearName
      technicalName
      shortName
      monetizationTypes
      hasTitles(country: $country, platform: $platform)
      hasSport(country: $country, platform: $platform)
      icon(profile: S100)
      addonParent(country: $country, platform: $platform) {
        shortName
        clearName
      }
    }
  }
`;

// ─── Cache ────────────────────────────────────────────────────────────────────

// Catalog/search results (TTL_S) and provider/package lists (PACKAGES_TTL_S)
// refresh on the cadence defined in ./ttl — everything derives from TTL_H
// there, nothing is redefined here. There's no cron/scheduler in this
// deployment (BeamUp has none), so freshness is driven purely by TTL expiry +
// stale-while-revalidate, not by an active refresh job.

/**
 * Lookup order: L1 in-memory → L2 Redis
 * On a Redis hit, the value is promoted back into L1 with the same TTL.
 */
async function cacheGet(key, ttl_s) {
  let data = await L1Cache.get(key);
  if (data) {
    trackCacheHit("L1", key);
    return data;
  }

  data = await L2Cache.get(key);
  if (data) {
    trackCacheHit("L2", key);
    L1Cache.set(key, data, ttl_s);
    return data;
  }

  trackCacheMiss("L2", key);
  return null; // full miss — caller fetches from JustWatch
}

/**
 * Write to both L1 and L2 simultaneously.
 */
async function cacheSet(key, data, ttl_s) {
  L1Cache.set(key, data, ttl_s);
  L2Cache.set(key, data, ttl_s);
}

// ─── Concurrency queue ────────────────────────────────────────────────────────
// Bounds how many outbound GraphQL calls to JustWatch can be in flight at
// once. Measured directly against JustWatch (see project memory): no 429s at
// any concurrency up to 256 in a single burst — failures only show up past
// ~150-190 as request latency balloons and calls start missing the 10s
// axios timeout below. MAX_CONCURRENCY=100 stays well under that knee while
// still bounding worst-case fan-out (e.g. many catalogs loading at once on a
// manifest fetch).
//
// Caveat: this only bounds concurrency within a single process (like the L1
// cache in ./cache). Any host that runs more than one instance — or restarts
// one — has them fanning out independently, and production IP reputation may
// behave differently than the environment this was tested from. There's no
// cross-instance coordination point (the L2 Redis could be one, but isn't
// used for it).
//
// DISABLED (2026-08-24): real Stremio usage showed some requests hanging for
// a long time on a cache miss, causing client-side timeouts in Stremio
// itself. Suspected cause — on BeamUp this module lives in one long-running
// process shared by every request, so a single task that never settles
// (hung TCP connection, an edge case axios' timeout doesn't catch) would
// permanently occupy one of the 100 slots and never free it; repeated over
// time that leaks capacity and eventually piles up requests behind it. Not
// confirmed yet, just the leading theory. `enqueue()` now bypasses the
// semaphore and runs tasks immediately (unbounded, like before any queue
// existed) while the semaphore itself (`runNext`/`MAX_CONCURRENCY`/
// `pending`) stays in place to keep iterating on it without ripping it out.
const QUEUE_ENABLED = false;
const MAX_CONCURRENCY = 100;
let activeCount = 0;
const pending = [];

function runNext() {
  if (activeCount >= MAX_CONCURRENCY || pending.length === 0) return;
  activeCount++;
  const { task, resolve, reject } = pending.shift();
  task().then(
    (result) => {
      activeCount--;
      resolve(result);
      runNext();
    },
    (err) => {
      activeCount--;
      reject(err);
      runNext();
    },
  );
}

function enqueue(task) {
  if (!QUEUE_ENABLED) return task();
  return new Promise((resolve, reject) => {
    pending.push({ task, resolve, reject });
    runNext();
  });
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

// Shared by every outbound call — see ./circuitBreaker for why it's one gate
// and not a negative cache per key.
const breaker = createCircuitBreaker({
  threshold: UPSTREAM_FAIL_THRESHOLD,
  cooldownMs: UPSTREAM_COOLDOWN_S * 1000,
});

/**
 * True when a GraphQL payload still carries something worth returning.
 *
 * Null propagation is all-or-nothing per field: a failed non-nullable resolver
 * nulls its nearest nullable ancestor, so a partial response is either "one
 * top-level field is null, the rest are fine" or "data is null". Anything with
 * a non-null top-level field is worth serving.
 */
function usablePayload(payload) {
  return (
    payload != null &&
    typeof payload === "object" &&
    Object.values(payload).some((v) => v != null)
  );
}

/**
 * Count a failed call and open the breaker if this was the one that tips it.
 * Both failure paths go through here so they can't drift apart.
 */
function noteFailure(kind) {
  stats.bump(`upstream.fail.${kind}`);
  if (breaker.recordFailure()) {
    console.error(
      `[justwatch] ${UPSTREAM_FAIL_THRESHOLD} consecutive failures — ` +
        `pausing all upstream calls for ${UPSTREAM_COOLDOWN_S}s`,
    );
  }
}

// JustWatch's GraphQL sits behind DataDome. A request with no cookie and a
// bare header set is scored as a bot and eventually 403'd. We keep the
// `datadome` cookie it hands back and replay it (so we look like a returning
// session, not a fresh anonymous hit each time), and send a header set that is
// coherent with the Chrome UA we already claim.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

let ddCookie = null; // "datadome=<value>", refreshed from every response

function captureCookie(headers) {
  const raw = headers?.["set-cookie"];
  if (!raw) return;
  const line = Array.isArray(raw) ? raw.join("\n") : String(raw);
  const m = /datadome=([^;\s]+)/.exec(line);
  if (m) ddCookie = `datadome=${m[1]}`;
}

function jwHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent": UA,
    Origin: "https://www.justwatch.com",
    Referer: "https://www.justwatch.com/",
    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    ...(ddCookie ? { Cookie: ddCookie } : {}),
  };
}

async function gql(query, variables) {
  // Fail fast without touching the network. The caller's own fallback still
  // runs, so a manifest degrades and a catalog serves its placeholder — the
  // difference is that JustWatch stops hearing from us while it's refusing.
  if (breaker.isOpen()) {
    stats.bump("upstream.shortCircuited");
    const err = new Error(
      `[justwatch] upstream circuit open, ${Math.ceil(breaker.remainingMs() / 1000)}s left`,
    );
    err.circuitOpen = true;
    throw err;
  }

  return enqueue(async () => {
    try {
      const res = await axios.post(
        GRAPHQL_URL,
        { query, variables },
        { headers: jwHeaders(), timeout: 10_000 },
      );
      captureCookie(res.headers);
      const { data } = res;
      if (data.errors) {
        // GraphQL answers partially on purpose: one resolver can fail and the
        // response still carries every field that resolved. Seen in production
        // as a single `edges[n].node.content` coming back INTERNAL_ERROR out of
        // a 50-title page — throwing there discarded 49 good titles and served
        // the error placeholder for the whole catalog.
        //
        // So the question is not "were there errors" but "is there anything
        // usable". Only when null propagation has eaten the payload is this a
        // real failure. Note this is still an HTTP 200: it must not feed the
        // breaker, which exists to detect an upstream that is refusing us.
        const messages = data.errors.map((e) => e.message).join("; ");
        if (usablePayload(data.data)) {
          breaker.recordSuccess();
          stats.bump("upstream.ok");
          stats.bump("upstream.partial");
          console.warn(
            `[justwatch] partial response, serving what resolved` +
              ` — ${data.errors.length} field error(s): ${messages.slice(0, 200)}` +
              ` | vars: ${JSON.stringify(variables).slice(0, 200)}`,
          );
          return data.data;
        }
        // A 200 whose payload is entirely null is still an upstream that
        // cannot answer, so it feeds the breaker like a 403 or a timeout —
        // the breaker deliberately does not classify failures.
        noteFailure("graphql");
        console.error(
          `[justwatch] HTTP 200 but no usable data` +
            ` — ${data.errors.length} field error(s): ${messages.slice(0, 200)}` +
            ` | vars: ${JSON.stringify(variables).slice(0, 200)}`,
        );
        const err = new Error(`GraphQL errors: ${messages}`);
        err.graphqlErrors = true;
        throw err;
      }
      breaker.recordSuccess();
      stats.bump("upstream.ok");
      return data.data;
    } catch (err) {
      // Already logged and counted in the errors branch; re-reporting it here
      // would print "no response" for a call that answered 200.
      if (err.graphqlErrors) throw err;

      // A DataDome block (403) still carries a fresh `datadome` cookie — keep
      // it so the next attempt presents it instead of starting cold again.
      captureCookie(err.response?.headers);

      // One line, and the **HTTP status first**. Twice now an incident has
      // turned on whether JustWatch replied 403 (edge/WAF IP block), 429
      // (throttle) or nothing at all (timeout), and the old logging dumped the
      // body without ever printing the status — on a WAF block that body is a
      // full HTML page, JSON.stringify'd across dozens of log lines, burying
      // the one fact that mattered. The query and variables went to two more
      // multi-line dumps per failure, which at fan-out is a lot of noise.
      const status = err.response?.status;
      const body =
        typeof err.response?.data === "string"
          ? err.response.data.replace(/\s+/g, " ").slice(0, 200)
          : JSON.stringify(err.response?.data ?? "").slice(0, 200);
      noteFailure(status || err.code || "unknown");
      console.error(
        `[justwatch] ${status ? `HTTP ${status}` : err.code || "no response"}` +
          ` — ${err.message}` +
          ` | vars: ${JSON.stringify(variables).slice(0, 200)}` +
          (err.response ? ` | body: ${body}` : ""),
      );
      throw err;
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Search (or browse) titles on JustWatch.
 *
 * @param {object}   opts
 * @param {string}   opts.query       - Text search. Pass '' for browse.
 * @param {string[]} opts.objectTypes - ['MOVIE'] | ['SHOW'] | []
 * @param {string[]} opts.packages    - JustWatch technicalName filters e.g. ['nfx']
 * @param {string[]} opts.genres      - JustWatch shortName filters e.g. ['act']
 * @param {string}   opts.sortBy      - 'POPULAR' | 'NEWLY_ADDED'
 * @param {string}   opts.country     - ISO country code (e.g. 'ES')
 * @param {string}   opts.language    - BCP47 language code (e.g. 'es')
 * @param {number}   opts.first       - Results per page (max 50)
 * @param {number}   opts.offset      - Pagination offset (0, 50, 100, ...)
 */
async function searchTitles(opts = {}) {
  const {
    query = "",
    objectTypes = [],
    packages = [],
    genres = [],
    sortBy = "POPULAR",
    country = "US",
    language = "en",
    first = 50,
    offset = 0,
    // Set by the cache warmer: skip the L1/L2 read and go straight to the
    // network, so it can refresh an entry that is technically still cached.
    force = false,
  } = opts;
  const cacheKey = `search:${query}:${objectTypes.join(",")}:${packages.join(",")}:${genres.join(",")}:${sortBy}:${country}:${language}:${first}:${offset}`;
  const vars = {
    query,
    objectTypes,
    packages,
    genres,
    sortBy,
    country,
    language,
    first,
    offset,
  };
  warmCache.touch(cacheKey, vars);

  if (!force) {
    const cached = await cacheGet(cacheKey, TTL_S);
    if (cached) return cached;
  }

  const nodes = await fetchSearchNodes(vars);
  await cacheSet(cacheKey, nodes, TTL_S);
  warmCache.store(cacheKey, nodes);
  return nodes;
}

// Just the network + shaping half of searchTitles — no cache, no registry.
// Shared by the live path above and by the warmer's replay (_warmRefetch).
async function fetchSearchNodes({
  query = "",
  objectTypes = [],
  packages = [],
  genres = [],
  sortBy = "POPULAR",
  country = "US",
  language = "en",
  first = 50,
  offset = 0,
} = {}) {
  const filter = {};
  if (query) filter.searchQuery = query;
  if (objectTypes.length) filter.objectTypes = objectTypes;
  if (packages.length) filter.packages = packages;
  if (genres.length) filter.genres = genres;
  // JustWatch's RELEASE_YEAR sort puts announced/upcoming titles first,
  // sometimes years out (e.g. Avatar sequels dated 2029/2031) — without
  // this, a full page of "new" results could be almost entirely titles
  // nobody can watch yet, filtered out client-side (see isUnreleased() in
  // domain/catalog.js) down to a handful of survivors. This is a coarse,
  // year-level pre-filter (confirmed live against the real API) that keeps
  // that waste from happening in the first place; the exact-date filter
  // still catches the remainder (this-year-but-not-yet-released titles).
  filter.releaseYear = { max: new Date().getFullYear() };

  const data = await gql(GET_POPULAR_TITLES_QUERY, {
    popularTitlesFilter: filter,
    country,
    first: Math.min(first, 50),
    offset,
    popularTitlesSortBy: sortBy,
    language,
    sortRandomSeed: 0,
    platform: "WEB",
  });

  // `|| []` is not enough on a partial response: null propagation from a failed
  // field leaves a null *entry* in an otherwise fine list, so drop those too.
  return (data?.popularTitles?.edges || [])
    .map((e) => e?.node)
    .filter(Boolean);
}

/**
 * Get available streaming packages for a country.
 *
 * Fetches and resolves icons; **which** packages survive and how they are
 * classified is not decided here — that's ../data/packageFilters, so the rules
 * can be added to or removed without touching the API client.
 *
 * @param {string} country - ISO country code (e.g. 'ES')
 * @returns {Promise<Array>} packages with iconUrl, isAddon and addonParent* set
 */
async function getPackages(country = "US", { force = false } = {}) {
  const cacheKey = `packages:${country}`;
  warmCache.touch(cacheKey, { country });

  if (!force) {
    const cached = await cacheGet(cacheKey, PACKAGES_TTL_S);
    if (cached) return cached;
  }

  const pkgs = await fetchPackages(country);
  await cacheSet(cacheKey, pkgs, PACKAGES_TTL_S);
  warmCache.store(cacheKey, pkgs);
  return pkgs;
}

// Network + shaping half of getPackages — shared with the warmer's replay.
async function fetchPackages(country = "US") {
  const rawData = await gql(GET_PACKAGES_QUERY, {
    country,
    platform: "WEB",
    includeAddons: true,
  });
  return annotateChannels(
    (rawData?.packages || []).filter(keepPackage).map((pkg) => ({
      ...pkg,
      iconUrl: pkg.icon
        ? `https://images.justwatch.com${pkg.icon.replace("{format}", "webp")}`
        : null,
    })),
  );
}

// (key, vars) => Promise<payload>, handed to warmCache.start(). Replays the
// stored query straight against the network, bypassing the cache entirely.
function _warmRefetch(key, vars) {
  return key.startsWith("packages:")
    ? fetchPackages(vars.country)
    : fetchSearchNodes(vars);
}

module.exports = {
  searchTitles,
  getPackages,
  // Handed to warmCache.start() in index.js so the warmer can replay queries.
  _warmRefetch,
  // Exported for tests and for anyone wanting to inspect/reset upstream state.
  breaker,
};
