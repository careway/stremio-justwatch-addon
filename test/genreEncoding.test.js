"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

// Stub the API client before domain/catalog.js destructures searchTitles.
const jwPath = require.resolve("../src/infra/justwatch");
const queries = [];
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    searchTitles: async (args) => {
      queries.push(args);
      return [
        {
          objectType: "MOVIE",
          content: {
            title: "T",
            shortDescription: "",
            originalReleaseDate: "2000-01-01",
            genres: [],
            externalIds: { imdbId: "tt0000001" },
            posterUrl: null,
          },
        },
      ];
    },
    getPackages: async () => [],
  },
};

const { handleCatalog } = require("../src/domain/catalog");
const { getGenreNames, getGenreCode } = require("../src/data/catalogMeta");

// What actually reaches handleCatalog: Stremio encodes the genre twice, and
// parseExtra decodes once — so one layer of encoding is still on it.
const asStremioSends = (name) =>
  decodeURIComponent(encodeURIComponent(encodeURIComponent(name)));

async function genresQueriedFor(name, language) {
  queries.length = 0;
  await handleCatalog(
    {
      type: "movie",
      id: "jw_pop_nfx",
      extra: { genre: asStremioSends(name) },
    },
    { country: "ES", language },
  );
  return queries[0].genres;
}

describe("double-encoded genres from Stremio", () => {
  test("plain ASCII was never affected — that's why it hid so long", () => {
    assert.equal(asStremioSends("Drama"), "Drama");
    assert.notEqual(asStremioSends("Acción"), "Acción");
    // A space is enough; this is not just a non-Latin-script problem.
    assert.equal(asStremioSends("Science Fiction"), "Science%20Fiction");
  });

  test("an accented name still resolves", async () => {
    assert.deepEqual(await genresQueriedFor("Acción", "es"), ["act"]);
  });

  test("a name with a space still resolves", async () => {
    assert.deepEqual(await genresQueriedFor("Science Fiction", "en"), ["scf"]);
  });

  test("non-Latin scripts still resolve", async () => {
    assert.deepEqual(await genresQueriedFor("دراما", "ar"), ["drm"]);
    assert.deepEqual(await genresQueriedFor("ドラマ", "ja"), ["drm"]);
    assert.deepEqual(await genresQueriedFor("액션", "ko"), ["act"]);
  });

  test("a singly-encoded genre keeps working", async () => {
    queries.length = 0;
    await handleCatalog(
      { type: "movie", id: "jw_pop_nfx", extra: { genre: "Acción" } },
      { country: "ES", language: "es" },
    );
    assert.deepEqual(queries[0].genres, ["act"]);
  });

  test("no genre means no genre filter", async () => {
    queries.length = 0;
    await handleCatalog(
      { type: "movie", id: "jw_pop_nfx", extra: {} },
      { country: "ES", language: "es" },
    );
    assert.deepEqual(queries[0].genres, []);
  });

  test("an unresolvable genre stays unfiltered rather than empty", async () => {
    queries.length = 0;
    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_nfx", extra: { genre: "not-a-genre" } },
      { country: "ES", language: "es" },
    );
    assert.deepEqual(queries[0].genres, []);
    assert.equal(res.ok, true);
  });

  test("a malformed escape doesn't throw", async () => {
    queries.length = 0;
    const res = await handleCatalog(
      { type: "movie", id: "jw_pop_nfx", extra: { genre: "%E0%A4" } },
      { country: "ES", language: "es" },
    );
    assert.deepEqual(queries[0].genres, []);
    assert.equal(res.ok, true);
  });

  test("every genre of every language survives the round trip", () => {
    // The regression guard that matters: 140 of 340 pairs were broken.
    const languages = ["es", "en", "de", "fr", "pt", "sv", "pl", "tr",
                       "ar", "hi", "te", "ml", "kn", "ja", "ko"];
    for (const language of languages) {
      for (const name of getGenreNames(language)) {
        const expected = getGenreCode(name, language);
        const viaStremio = getGenreCode(
          decodeURIComponent(asStremioSends(name)),
          language,
        );
        assert.equal(viaStremio, expected, `${language} / ${name}`);
      }
    }
  });
});
