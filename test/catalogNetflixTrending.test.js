"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// Same require.cache-substitution pattern as test/randomBlocks.test.js: stub
// both upstreams before domain/catalog.js (via domain/netflixTrending.js)
// pulls them in.
const jwPath = require.resolve("../src/infra/justwatch");
const top10Path = require.resolve("../src/infra/netflixTop10");

let queries; // every searchTitles()/searchTitlesWithOriginal() call, in order
let chart; // what peekTop10()/getTop10() returns
let peekCalls;
let peekShouldThrow; // checked at call time — netflixTrending.js destructures
// peekTop10 once at require time, so reassigning exports.peekTop10 later
// would not reach it; this flag lets a single already-bound stub misbehave
// on demand instead.

require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    // The plain JustWatch-ranked path (blank query, paged).
    searchTitles: async (args) => {
      queries.push(args);
      return Array.from({ length: 5 }, (_, i) => ({
        objectType: "MOVIE",
        content: {
          title: `JW ${args.offset + i}`,
          shortDescription: "",
          genres: [],
          externalIds: { imdbId: `tt${String(args.offset + i).padStart(7, "0")}` },
          posterUrl: null,
        },
      }));
    },
    // The Top10-enrichment path's title lookup (see ../src/domain/netflixTrending).
    searchTitlesWithOriginal: async (args) => {
      queries.push(args);
      return [
        {
          objectType: args.objectTypes[0] || "MOVIE",
          content: {
            title: args.query,
            shortDescription: "",
            genres: [],
            externalIds: { imdbId: `tt-${args.query}` },
            posterUrl: null,
          },
          original: { title: args.query },
        },
      ];
    },
    getPackages: async () => [],
  },
};

require.cache[top10Path] = {
  id: top10Path,
  filename: top10Path,
  loaded: true,
  exports: {
    peekTop10: async (country) => {
      peekCalls.push(country);
      if (peekShouldThrow) throw new Error("boom");
      return chart;
    },
    getTop10: async (country) => {
      peekCalls.push(country);
      return chart;
    },
    warm: () => {},
  },
};

const { handleCatalog } = require("../src/domain/catalog");

const CONFIG = { country: "MY", language: "en" };
const CHART = {
  films: [
    { rank: 1, title: "Top Film A" },
    { rank: 2, title: "Top Film B" },
  ],
  tv: [{ rank: 1, title: "Top Show A" }],
};

describe("catalog.js — official Netflix Top10 wiring", () => {
  beforeEach(() => {
    queries = [];
    peekCalls = [];
    chart = CHART;
    peekShouldThrow = false;
  });

  test("Netflix Trending, page 1, no genre, not randomized: uses the official chart", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_nfx", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.metas.map((m) => m.name),
      ["Top Film A", "Top Film B"],
    );
    // Only per-title lookups, never the blank-query ranked fetch.
    assert.ok(queries.every((q) => q.query));
    assert.deepEqual(peekCalls, ["MY"]);
  });

  test("series type reads the tv bucket", async () => {
    const res = await handleCatalog(
      { type: "series", id: "jw_tnd_nfx", extra: {} },
      CONFIG,
    );
    assert.deepEqual(
      res.metas.map((m) => m.name),
      ["Top Show A"],
    );
  });

  test("paging past page 1 falls back to the plain JustWatch path", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_nfx", extra: { skip: "50" } },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === "" && q.offset === 50));
    assert.deepEqual(peekCalls, [], "must not even check the chart past page 1");
  });

  test("a genre filter falls back to the plain JustWatch path", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_nfx", extra: { genre: "Action" } },
      { ...CONFIG, language: "en" },
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === ""));
    assert.deepEqual(peekCalls, []);
  });

  test("a randomized catalog falls back to the plain (shuffled) path", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "r_jw_tnd_nfx", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === ""));
    assert.deepEqual(peekCalls, []);
  });

  test("a non-Netflix provider is never routed through the Top10 path", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_dnp", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === "" && q.packages[0] === "dnp"));
    assert.deepEqual(peekCalls, []);
  });

  test("the Popular sort is unaffected — only Trending is enriched", async () => {
    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_nfx", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === "" && q.sortBy === "POPULAR"));
    assert.deepEqual(peekCalls, []);
  });

  test("no official chart for the country: falls back cleanly", async () => {
    chart = null;
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_nfx", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === ""));
  });

  test("a lookup failure degrades to the plain path instead of failing the request", async () => {
    peekShouldThrow = true;
    const res = await handleCatalog(
      { type: "movie", id: "jw_tnd_nfx", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.ok(queries.some((q) => q.query === ""));
  });
});
