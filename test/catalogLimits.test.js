"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const jwPath = require.resolve("../src/infra/justwatch");
const calls = [];
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    searchTitles: async ({ offset, first }) => {
      calls.push(offset);
      return Array.from({ length: first }, (_, i) => ({
        objectType: "MOVIE",
        content: {
          title: `T${offset + i}`,
          shortDescription: "",
          originalReleaseDate: "2000-01-01",
          genres: [],
          externalIds: { imdbId: `tt${String(offset + i).padStart(7, "0")}` },
          posterUrl: null,
        },
      }));
    },
    getPackages: async () => [],
  },
};

const { handleCatalog } = require("../src/domain/catalog");

const CONFIG = { country: "ES", language: "es" };
const get = (skip, limits) =>
  handleCatalog({ type: "movie", id: "jw_pop_nfx", extra: { skip } }, CONFIG, limits);

describe("handleCatalog depth limit", () => {
  test("without limits, the anonymous default (100) applies", async () => {
    calls.length = 0;
    assert.equal((await get(100)).metas.length, 50);
    calls.length = 0;
    const r = await get(150);
    assert.deepEqual(r, { ok: true, metas: [] });
    assert.deepEqual(calls, [], "past the ceiling must not touch the upstream");
  });

  test("a plan's maxOffset replaces the default, in both directions", async () => {
    assert.equal((await get(300, { maxOffset: 400 })).metas.length, 50);
    calls.length = 0;
    assert.deepEqual((await get(100, { maxOffset: 50 })).metas, []);
    assert.deepEqual(calls, []);
  });

  test("the boundary is inclusive: skip == maxOffset is served", async () => {
    assert.equal((await get(200, { maxOffset: 200 })).metas.length, 50);
    assert.deepEqual((await get(201, { maxOffset: 200 })).metas, []);
  });

  test("an empty limits object means the defaults", async () => {
    assert.deepEqual((await get(150, {})).metas, []);
  });
});
