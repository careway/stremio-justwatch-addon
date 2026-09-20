"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// Stub the platform fetch() *before* requiring the module under test — same
// idea as the axios require.cache stub in test/partialResponse.test.js, but
// this module deliberately uses fetch() instead of axios (see its own
// comment: axios intermittently killed this specific ~30MB download).
let nextResponse; // string TSV body, or an Error to make fetch() reject
let fetchCalls;
global.fetch = async (...args) => {
  fetchCalls.push(args);
  if (nextResponse instanceof Error) throw nextResponse;
  return { ok: true, status: 200, text: async () => nextResponse };
};

const netflixTop10 = require("../src/infra/netflixTop10");
const { L1Cache, L2Cache } = require("../src/infra/cache");

const CACHE_KEY = "netflix:top10:byCountry";

const HEADER =
  "country_name\tcountry_iso2\tweek\tcategory\tweekly_rank\tshow_title\tseason_title\tcumulative_weeks_in_top_10";

function row(country, iso2, week, category, rank, title, season = "N/A") {
  return [country, iso2, week, category, rank, title, season, 1].join("\t");
}

describe("infra/netflixTop10", () => {
  beforeEach(async () => {
    fetchCalls = [];
    netflixTop10.breaker.reset();
    await L1Cache.invalidate(CACHE_KEY);
    await L2Cache.invalidate(CACHE_KEY);
  });

  test("parses the TSV and keeps only each country's own latest week", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-08-30", "Films", 1, "Old Movie"),
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "New Movie"),
      row(
        "Malaysia",
        "MY",
        "2026-09-06",
        "TV",
        1,
        "New Show",
        "New Show: Season 1",
      ),
      row("Spain", "ES", "2026-08-30", "Films", 1, "Spain Movie"),
    ].join("\n");

    const my = await netflixTop10.getTop10("MY");
    assert.equal(my.week, "2026-09-06");
    assert.deepEqual(
      my.films.map((f) => f.title),
      ["New Movie"],
    );
    assert.deepEqual(my.tv[0], {
      rank: 1,
      title: "New Show",
      seasonTitle: "New Show: Season 1",
    });

    // A different country's own latest week is independent — a country
    // that lags behind must not be pulled forward to another's date.
    const es = await netflixTop10.getTop10("ES");
    assert.equal(es.week, "2026-08-30");
  });

  test("a country Netflix doesn't cover resolves to null, not an error", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    assert.equal(await netflixTop10.getTop10("ZZ"), null);
  });

  test("a fetch failure degrades to null instead of throwing", async () => {
    nextResponse = new Error("network down");
    assert.equal(await netflixTop10.getTop10("MY"), null);
  });

  test("concurrent callers on a cold cache share one download", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    await Promise.all([
      netflixTop10.getTop10("MY"),
      netflixTop10.getTop10("MY"),
      netflixTop10.getTop10("MY"),
    ]);
    assert.equal(fetchCalls.length, 1);
  });

  test("peekTop10 never blocks a live request on the download", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    const result = await netflixTop10.peekTop10("MY");
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 0);
  });

  test("peekTop10 warms the cache in the background for the next call", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    await netflixTop10.peekTop10("MY"); // cold: null, but kicks off a background fetch
    await new Promise((resolve) => setTimeout(resolve, 20)); // let it settle
    const warmed = await netflixTop10.peekTop10("MY");
    assert.ok(warmed);
    assert.equal(warmed.films[0].title, "X");
  });

  test("peekTop10 does not re-fetch once warm", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    await netflixTop10.getTop10("MY"); // blocking warm
    fetchCalls = [];
    await netflixTop10.peekTop10("MY");
    assert.equal(fetchCalls.length, 0);
  });
});

describe("infra/netflixTop10 — breaker protects a flaky endpoint", () => {
  beforeEach(async () => {
    fetchCalls = [];
    netflixTop10.breaker.reset();
    await L1Cache.invalidate(CACHE_KEY);
    await L2Cache.invalidate(CACHE_KEY);
  });

  test("a single failure opens the breaker — no immediate retry on the next call", async () => {
    nextResponse = new Error("network down");
    await netflixTop10.getTop10("MY"); // fails, opens the breaker (threshold: 1)

    fetchCalls = [];
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n"); // even though the endpoint "recovered"...
    assert.equal(await netflixTop10.getTop10("MY"), null);
    assert.equal(fetchCalls.length, 0, "must not hit the network while open");
  });

  test("peekTop10 also skips the background warm while the breaker is open", async () => {
    nextResponse = new Error("network down");
    await netflixTop10.getTop10("MY");

    fetchCalls = [];
    await netflixTop10.peekTop10("MY");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fetchCalls.length, 0);
  });

  test("a success clears the breaker for the next failure to reopen it", async () => {
    nextResponse = [
      HEADER,
      row("Malaysia", "MY", "2026-09-06", "Films", 1, "X"),
    ].join("\n");
    await netflixTop10.getTop10("MY");
    assert.equal(netflixTop10.breaker.isOpen(), false);
  });
});
