"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

// handleCatalog destructures searchTitles at require time, so the infra module
// is replaced in the require cache *before* domain/catalog.js is first loaded.
// node:test runs every test file in its own process, so this stub cannot leak
// into another suite.
const jwPath = require.resolve("../src/infra/justwatch");
const calls = [];
const queries = [];
require.cache[jwPath] = {
  id: jwPath,
  filename: jwPath,
  loaded: true,
  exports: {
    // A bottomless ranked catalog: rank N is always the same title, so any
    // reordering the handler does is entirely its own doing.
    searchTitles: async (args) => {
      const { offset, first } = args;
      calls.push(offset);
      queries.push(args);
      return Array.from({ length: first }, (_, i) => {
        const rank = offset + i;
        return {
          objectType: "MOVIE",
          content: {
            title: `Title ${rank}`,
            shortDescription: "",
            originalReleaseDate: "2000-01-01",
            genres: [],
            externalIds: { imdbId: `tt${String(rank).padStart(7, "0")}` },
            posterUrl: null,
          },
        };
      });
    },
    getPackages: async () => [],
  },
};

const { handleCatalog } = require("../src/domain/catalog");

const CONFIG = { country: "ES", language: "es" };
const RANDOM_ID = "r_jw_pop_nfx";
const PAGE = 50;

const rankOf = (meta) => Number(meta.id.slice(2));
const page = async (id, skip) => {
  const res = await handleCatalog({ type: "movie", id, extra: { skip } }, CONFIG);
  assert.equal(res.ok, true);
  return res.metas;
};

describe("randomized catalogs — block shuffling", () => {
  test("a randomized page costs exactly one upstream call", async () => {
    // The whole point of the 2026-09-01 rework. Stremio asks for page 1 of
    // every catalog at once on a manifest load, so anything above 1 here
    // multiplies that burst — which is what got the addon rate-limited.
    for (const skip of [0, 50, 200, 900]) {
      calls.length = 0;
      await page(RANDOM_ID, skip);
      assert.deepEqual(calls, [skip], `skip=${skip}`);
    }
  });

  test("costs the same as the same page of a plain catalog", async () => {
    calls.length = 0;
    await page("jw_pop_nfx", 0);
    const plain = calls.length;
    calls.length = 0;
    await page(RANDOM_ID, 0);
    assert.equal(calls.length, plain);
  });

  test("a page holds exactly the titles it would have held unshuffled", async () => {
    // Same 50 titles as the ranked page, reordered — nothing gained or lost.
    for (const skip of [0, 50, 200, 900]) {
      const ranks = (await page(RANDOM_ID, skip)).map(rankOf);
      assert.deepEqual(
        [...ranks].sort((a, b) => a - b),
        Array.from({ length: PAGE }, (_, i) => skip + i),
        `skip=${skip}`,
      );
    }
  });

  test("no depth ceiling — deep pages are still shuffled", async () => {
    // The first implementation fell back to plain ranking past offset 150.
    for (const skip of [0, 150, 300, 900]) {
      const ranks = (await page(RANDOM_ID, skip)).map(rankOf);
      const plain = Array.from({ length: PAGE }, (_, i) => skip + i);
      assert.notDeepEqual(ranks, plain, `skip=${skip} came back in ranked order`);
    }
  });

  test("reaching a later page does not disturb an earlier one", async () => {
    const before = await page(RANDOM_ID, 0);
    await page(RANDOM_ID, 50);
    await page(RANDOM_ID, 900);
    assert.deepEqual(await page(RANDOM_ID, 0), before);
  });

  test("different pages get different orders", async () => {
    const a = (await page(RANDOM_ID, 0)).map((m) => rankOf(m));
    const b = (await page(RANDOM_ID, 50)).map((m) => rankOf(m) - 50);
    assert.notDeepEqual(a, b, "both pages shuffled to the same permutation");
  });

  test("a non-randomized catalog is untouched and ranked", async () => {
    const ranks = (await page("jw_pop_nfx", 0)).map(rankOf);
    assert.deepEqual(ranks, Array.from({ length: PAGE }, (_, i) => i));
  });

  test("the r_ prefix is stripped before the id is parsed", async () => {
    // It must not end up in the package filter or change the sort — the two
    // ids differ only in how the results are ordered afterwards.
    queries.length = 0;
    await page("jw_pop_nfx", 0);
    const plain = queries[0];
    queries.length = 0;
    await page(RANDOM_ID, 0);
    const shuffled = queries[0];
    for (const key of ["packages", "sortBy", "objectTypes", "genres"]) {
      assert.deepEqual(shuffled[key], plain[key], key);
    }
    assert.deepEqual(plain.packages, ["nfx"]);
  });
});
