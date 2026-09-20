"use strict";

const { L1Cache, L2Cache } = require("./cache");
const { NETFLIX_TOP10_TTL_S, NETFLIX_TOP10_FAIL_COOLDOWN_S } = require("../ttl");
const { createCircuitBreaker } = require("./circuitBreaker");

// Netflix publishes this itself, free, no login — the raw data behind
// netflix.com/tudum/top10. There is no per-country or "current week only"
// endpoint: it's one ~30MB TSV covering every country back to 2021, which is
// why the parsed result (a few KB) is what gets cached, not the download.
const DATA_URL = "https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv";
const CACHE_KEY = "netflix:top10:byCountry";

// De-dupes concurrent callers on a cold cache into one download instead of
// each firing its own 30MB request.
let inFlight = null;

// Without this, a flaky/503'ing endpoint (observed live 2026-09-13 — see
// NETFLIX_TOP10_FAIL_COOLDOWN_S) gets hit again on every single cold-cache
// check with zero pause between attempts: peekTop10() fires a background
// ensureLoaded() on every call while byCountry is empty, and each failure
// clears `inFlight` and leaves the very next call free to start a fresh
// ~20s attempt. threshold: 1 because, unlike JustWatch's breaker (called
// constantly, so a couple of blips are tolerated before concluding anything),
// this is one single-purpose fetch asked for rarely enough that one failure
// is already the whole signal.
const breaker = createCircuitBreaker({
  threshold: 1,
  cooldownMs: NETFLIX_TOP10_FAIL_COOLDOWN_S * 1000,
});

/**
 * Parse the TSV into { [countryIso2]: { week, films: [...], tv: [...] } },
 * keeping only each country's own latest week — countries don't necessarily
 * share one global "latest" row (a new market can lag behind).
 */
function parseTsv(text) {
  const lines = text.split("\n");
  const latestWeek = new Map(); // iso2 -> latest week string seen

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const t1 = line.indexOf("\t");
    const t2 = line.indexOf("\t", t1 + 1);
    const t3 = line.indexOf("\t", t2 + 1);
    if (t1 === -1 || t2 === -1 || t3 === -1) continue;
    const iso2 = line.slice(t1 + 1, t2);
    const week = line.slice(t2 + 1, t3);
    if (!latestWeek.has(iso2) || week > latestWeek.get(iso2)) {
      latestWeek.set(iso2, week);
    }
  }

  const byCountry = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split("\t");
    // country_name  country_iso2  week  category  weekly_rank  show_title  season_title  cumulative_weeks_in_top_10
    if (cols.length < 7) continue;
    const [, iso2, week, category, weeklyRank, showTitle, seasonTitle] = cols;
    if (week !== latestWeek.get(iso2)) continue;
    const bucket =
      category === "Films" ? "films" : category === "TV" ? "tv" : null;
    if (!bucket || !showTitle) continue;

    if (!byCountry[iso2]) byCountry[iso2] = { week, films: [], tv: [] };
    byCountry[iso2][bucket].push({
      rank: parseInt(weeklyRank, 10),
      title: showTitle,
      seasonTitle: seasonTitle && seasonTitle !== "N/A" ? seasonTitle : null,
    });
  }

  for (const entry of Object.values(byCountry)) {
    entry.films.sort((a, b) => a.rank - b.rank);
    entry.tv.sort((a, b) => a.rank - b.rank);
  }
  return byCountry;
}

async function fetchAndParse() {
  // Deliberately the platform's own fetch(), not axios (used everywhere else
  // in this codebase): axios intermittently killed this specific ~30MB
  // download mid-stream ("stream has been aborted" / ECONNRESET, confirmed
  // live 2026-09-12) regardless of maxContentLength/timeout tuning, while
  // fetch() pulled it down cleanly every time in the same environment. Node
  // 18+ (this project's floor) ships fetch() built in, no extra dependency.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(DATA_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return parseTsv(text);
  } finally {
    clearTimeout(timer);
  }
}

// Fetches (if not already in flight), caches, and returns the full
// byCountry map. This is the only path that ever pays for the ~30MB
// download — measured around 3-20s end to end when it works — so nothing on
// a live request's critical path may call this directly; see peekTop10()
// below. Skips the attempt entirely while the breaker is open, so a run of
// failures degrades to "no official data" immediately instead of paying the
// fetch timeout again on every call.
async function ensureLoaded() {
  let byCountry = await L1Cache.get(CACHE_KEY);
  if (byCountry) return byCountry;

  byCountry = await L2Cache.get(CACHE_KEY);
  if (byCountry) {
    L1Cache.set(CACHE_KEY, byCountry, NETFLIX_TOP10_TTL_S);
    return byCountry;
  }

  if (breaker.isOpen()) return null;

  if (!inFlight) {
    inFlight = fetchAndParse()
      .then((data) => {
        breaker.recordSuccess();
        L1Cache.set(CACHE_KEY, data, NETFLIX_TOP10_TTL_S);
        L2Cache.set(CACHE_KEY, data, NETFLIX_TOP10_TTL_S);
        return data;
      })
      .catch((err) => {
        breaker.recordFailure();
        console.error(`[netflixTop10] fetch failed: ${err.message}`);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/**
 * Netflix's own official weekly Top 10 (films + TV) for a country — the one
 * ranking in this addon backed by data Netflix itself publishes, rather than
 * JustWatch's own cross-provider popularity metric (see ../domain/netflixTrending
 * for why that distinction matters and how this gets stitched onto JustWatch
 * metadata).
 *
 * Can take ~15-20s on a cold cache (the full ~30MB file has to download and
 * parse before any country can be read out of it) — fine for the cache
 * warmer, never for a live Stremio request. Live catalog requests must use
 * peekTop10() instead.
 *
 * @param {string} countryIso2
 * @returns {Promise<{week: string, films: Array, tv: Array}|null>} null when
 *   Netflix doesn't publish a chart for this country, or the fetch failed —
 *   callers must treat that as "no official data" and fall back, not as an error.
 */
async function getTop10(countryIso2) {
  const code = (countryIso2 || "").toUpperCase();
  if (!code) return null;
  const byCountry = await ensureLoaded();
  return byCountry?.[code] || null;
}

/**
 * Same result as getTop10(), but never pays for the ~30MB download itself —
 * only ever reads L1/in-memory or an L2/Redis round-trip, both fast. On a
 * cold cache it returns null immediately and kicks off ensureLoaded() in the
 * background so the *next* request finds it warm; it does not wait on that
 * fetch. Use this from the live catalog-handling path; use getTop10() from
 * anything allowed to block (the cache warmer, a script, tests).
 *
 * @param {string} countryIso2
 * @returns {Promise<{week: string, films: Array, tv: Array}|null>}
 */
async function peekTop10(countryIso2) {
  const code = (countryIso2 || "").toUpperCase();
  if (!code) return null;

  let byCountry = await L1Cache.get(CACHE_KEY);
  if (!byCountry) {
    byCountry = await L2Cache.get(CACHE_KEY);
    if (byCountry) L1Cache.set(CACHE_KEY, byCountry, NETFLIX_TOP10_TTL_S);
  }

  if (!byCountry) {
    ensureLoaded().catch(() => {}); // warm it for next time; errors already logged there
    return null;
  }
  return byCountry[code] || null;
}

/**
 * Fire-and-forget warm-up: pays for the ~30MB download once, up front,
 * instead of leaving it to whichever live request happens to hit a cold
 * cache first (which peekTop10() would otherwise just skip and defer again).
 * Safe to call unconditionally — never throws, never awaited, breaker-gated
 * like every other path through ensureLoaded().
 *
 * Deliberately NOT called from ../../index.js at startup (it was, briefly —
 * removed 2026-09-13): this endpoint is a large file with no low-latency
 * guarantee (3-20s observed, outright 503s not rare), so firing it
 * unconditionally on every process boot meant every cold start paid for a
 * slow/failing fetch it may not even need yet. peekTop10()'s lazy
 * background warm-on-first-demand, now breaker-protected, covers the same
 * ground without that cost. Exported for a future warmer/script that
 * actually wants to pay this eagerly on its own schedule.
 */
function warm() {
  ensureLoaded().catch(() => {}); // errors already logged in ensureLoaded/fetchAndParse
}

module.exports = {
  getTop10,
  peekTop10,
  warm,
  // Exported for tests and for anyone wanting to inspect/reset upstream state.
  breaker,
};
