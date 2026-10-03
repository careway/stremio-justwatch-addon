"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// Stub both upstreams before domain/netflixTrending.js pulls them in — same
// require.cache-substitution pattern as test/randomBlocks.test.js. Keyed by
// resolved absolute path, so this also covers the same module however
// something else (e.g. domain/catalog.js) requires it via a different
// relative path.
const jwPath = require.resolve("../src/infra/justwatch");
const top10Path = require.resolve("../src/infra/netflixTop10");
const tmdbFallbackPath = require.resolve("../src/infra/tmdbFallback");

let searchResults; // raw Top10 title string -> JustWatch nodes[]
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    searchTitlesWithOriginal: async ({ query }) => searchResults[query] || [],
  },
};

let chart; // what peekTop10() returns
require.cache[top10Path] = {
  id: top10Path,
  filename: top10Path,
  loaded: true,
  exports: {
    peekTop10: async () => chart,
    getTop10: async () => chart,
    warm: () => {},
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

const { getOfficialNetflixTrending } = require("../src/domain/netflixTrending");

function node(title, imdbId = "tt0000001", objectType = "MOVIE") {
  return {
    objectType,
    content: {
      title,
      shortDescription: "desc",
      genres: [],
      externalIds: { imdbId },
      posterUrl: "/poster.jpg",
    },
  };
}

const call = (jwType = "MOVIE", country = "MY") =>
  getOfficialNetflixTrending({ jwType, country, language: "en", config: {} });

describe("domain/netflixTrending", () => {
  beforeEach(() => {
    searchResults = {};
    chart = null;
    fallbackImdbIds = {};
  });

  test("null when Netflix publishes no chart for the country", async () => {
    chart = null;
    assert.equal(await call(), null);
  });

  test("null when the chart has nothing for this content type", async () => {
    chart = { films: [], tv: [] };
    assert.equal(await call("MOVIE"), null);
  });

  test("matches an entry back onto JustWatch by normalized title", async () => {
    chart = { films: [{ rank: 1, title: "Nar'Sata: Sekutu Setan" }], tv: [] };
    // JustWatch's own casing differs (lowercase "sata") — must still match.
    searchResults["Nar'Sata: Sekutu Setan"] = [
      node("Nar'sata: Sekutu Setan", "tt999"),
    ];
    const metas = await call();
    assert.deepEqual(
      metas.map((m) => m.id),
      ["tt999"],
    );
  });

  test("drops an entry with no result on JustWatch, rather than guessing", async () => {
    chart = { films: [{ rank: 1, title: "Mousetrap" }], tv: [] };
    searchResults["Mousetrap"] = [];
    assert.deepEqual(await call(), []);
  });

  test("drops an entry whose only results don't match the title", async () => {
    chart = { films: [{ rank: 1, title: "Bulan Henti Bicara" }], tv: [] };
    // JustWatch stores this local show under an unrelated English alias.
    searchResults["Bulan Henti Bicara"] = [node("Veil of Shadows", "tt1")];
    assert.deepEqual(await call(), []);
  });

  test("drops a title match with no IMDb id — nodeToMeta's rule, same as every catalog", async () => {
    chart = { films: [{ rank: 1, title: "Gandhari" }], tv: [] };
    searchResults["Gandhari"] = [node("Gandhari", null)];
    assert.deepEqual(await call(), []);
  });

  test("preserves the official rank order, not JustWatch's own", async () => {
    chart = {
      films: [
        { rank: 1, title: "A" },
        { rank: 2, title: "B" },
      ],
      tv: [],
    };
    searchResults.A = [node("A", "tt1")];
    searchResults.B = [node("B", "tt2")];
    const metas = await call();
    assert.deepEqual(
      metas.map((m) => m.id),
      ["tt1", "tt2"],
    );
  });

  test("dedupes when two rank entries resolve to the same title", async () => {
    chart = {
      films: [
        { rank: 1, title: "A" },
        { rank: 2, title: "A2" },
      ],
      tv: [],
    };
    searchResults.A = [node("A", "tt1")];
    searchResults.A2 = [node("A", "tt1")];
    const metas = await call();
    assert.equal(metas.length, 1);
  });

  test("reads the TV bucket for jwType SHOW, films for MOVIE", async () => {
    chart = {
      films: [{ rank: 1, title: "AFilm" }],
      tv: [{ rank: 1, title: "AShow" }],
    };
    searchResults.AFilm = [node("AFilm", "tt1")];
    searchResults.AShow = [node("AShow", "tt2", "SHOW")];
    assert.deepEqual(
      (await call("MOVIE")).map((m) => m.id),
      ["tt1"],
    );
    assert.deepEqual(
      (await call("SHOW")).map((m) => m.id),
      ["tt2"],
    );
  });

  test("a TMDb-resolved match is kept, not dropped, when JustWatch has no imdbId yet", async () => {
    chart = { films: [{ rank: 1, title: "Enfrentados: Marfil" }], tv: [] };
    searchResults["Enfrentados: Marfil"] = [
      node("Enfrentados: Marfil", null), // JustWatch: no imdbId linked yet
    ];
    fallbackImdbIds["Enfrentados: Marfil"] = "tt36073210";
    const metas = await call();
    assert.deepEqual(
      metas.map((m) => m.id),
      ["tt36073210"],
    );
  });

  test("a fallback-resolved entry is demoted below every confident entry, official rank or not", async () => {
    chart = {
      films: [
        { rank: 1, title: "NoImdbYet" }, // ranked #1 on Netflix, but only fallback-resolvable
        { rank: 2, title: "Confident" },
      ],
      tv: [],
    };
    searchResults.NoImdbYet = [node("NoImdbYet", null)];
    searchResults.Confident = [node("Confident", "tt2")];
    fallbackImdbIds.NoImdbYet = "tt1";
    const metas = await call();
    assert.deepEqual(
      metas.map((m) => m.id),
      ["tt2", "tt1"], // confident first despite ranking below on the real chart
    );
  });
});
