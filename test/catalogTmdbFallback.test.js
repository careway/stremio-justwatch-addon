"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// Same require.cache-substitution pattern as test/randomBlocks.test.js.
const jwPath = require.resolve("../src/infra/justwatch");
const tmdbFallbackPath = require.resolve("../src/infra/tmdbFallback");

// Real-world case this reproduces: "Enfrentados: Marfil" ("Drawn Together")
// on Amazon Prime Video Spain — JustWatch has the title but no imdbId linked
// yet (confirmed live 2026-09-13), TMDb already does (tt36073210).
function jwNode(title, imdbId, objectType = "MOVIE") {
  return {
    objectType,
    content: {
      title,
      shortDescription: "",
      genres: [],
      externalIds: { imdbId },
      posterUrl: null,
    },
  };
}

let pageNodes; // what searchTitles() returns for the plain ranked fetch
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    searchTitles: async () => pageNodes,
    getPackages: async () => [],
  },
};

let fallbackImdbIds; // JustWatch node title -> IMDb id the TMDb fallback "resolves"
require.cache[tmdbFallbackPath] = {
  id: tmdbFallbackPath,
  filename: tmdbFallbackPath,
  loaded: true,
  exports: {
    resolveImdbId: async ({ title }) => fallbackImdbIds[title] || null,
  },
};

const { handleCatalog } = require("../src/domain/catalog");

const CONFIG = { country: "ES", language: "es" };

describe("catalog.js — TMDb fallback for a missing imdbId", () => {
  beforeEach(() => {
    fallbackImdbIds = {};
  });

  test("a title JustWatch has but with no imdbId is kept when TMDb resolves one", async () => {
    pageNodes = [jwNode("Enfrentados: Marfil", null)];
    fallbackImdbIds["Enfrentados: Marfil"] = "tt36073210";

    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_amazonprimevideo", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    assert.deepEqual(
      res.metas.map((m) => m.id),
      ["tt36073210"],
    );
  });

  test("stays dropped when TMDb has no confident match either — no regression", async () => {
    pageNodes = [jwNode("Enfrentados: Marfil", null)];
    // fallbackImdbIds left empty: TMDb fallback finds nothing.
    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_amazonprimevideo", extra: {} },
      CONFIG,
    );
    assert.equal(res.ok, true);
    // The empty-catalog placeholder kicks in — same as before this feature existed.
    assert.equal(res.metas[0].id, "tt0427229");
  });

  test("a fallback-resolved title is ranked after every confidently-matched title", async () => {
    pageNodes = [
      jwNode("No IMDb Yet", null), // ranked first by JustWatch, but only fallback-resolvable
      jwNode("Confident A", "tt1"),
      jwNode("Confident B", "tt2"),
    ];
    fallbackImdbIds["No IMDb Yet"] = "tt99";

    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_amazonprimevideo", extra: {} },
      CONFIG,
    );
    assert.deepEqual(
      res.metas.map((m) => m.id),
      ["tt1", "tt2", "tt99"],
    );
  });
});
