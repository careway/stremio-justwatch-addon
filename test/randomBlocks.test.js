"use strict";

const assert = require("node:assert/strict");
const { test, describe, before } = require("node:test");

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
const BLOCK = 150;
const PAGE = 50;

const rankOf = (meta) => Number(meta.id.slice(2));
const page = async (id, skip) => {
  const res = await handleCatalog({ type: "movie", id, extra: { skip } }, CONFIG);
  assert.equal(res.ok, true);
  return res.metas;
};

describe("randomized catalogs — block shuffling", () => {
  before(() => (calls.length = 0));

  test("a page is drawn only from its own block", async () => {
    for (const [skip, lo, hi] of [
      [0, 0, BLOCK],
      [100, 0, BLOCK],
      [150, BLOCK, 2 * BLOCK],
      [250, BLOCK, 2 * BLOCK],
      [900, 6 * BLOCK, 7 * BLOCK],
    ]) {
      const ranks = (await page(RANDOM_ID, skip)).map(rankOf);
      assert.equal(ranks.length, PAGE, `skip=${skip}`);
      assert.ok(
        ranks.every((r) => r >= lo && r < hi),
        `skip=${skip} escaped its block: ${ranks.filter((r) => r < lo || r >= hi)}`,
      );
    }
  });

  test("no depth ceiling — deep pages stay shuffled, not plain ranked", async () => {
    // The old implementation fell back to ranked order past 150.
    for (const skip of [150, 300, 900]) {
      const ranks = (await page(RANDOM_ID, skip)).map(rankOf);
      const plain = Array.from({ length: PAGE }, (_, i) => skip + i);
      assert.notDeepEqual(ranks, plain, `skip=${skip} came back in ranked order`);
    }
  });

  test("the three pages of a block partition it exactly", async () => {
    for (const blockIndex of [0, 1, 4]) {
      const start = blockIndex * BLOCK;
      const seen = [];
      for (let p = 0; p < 3; p++) seen.push(...(await page(RANDOM_ID, start + p * PAGE)).map(rankOf));
      assert.deepEqual(
        [...seen].sort((a, b) => a - b),
        Array.from({ length: BLOCK }, (_, i) => start + i),
        `block ${blockIndex} is not a clean partition`,
      );
    }
  });

  test("reaching a later block does not disturb an earlier page", async () => {
    const before = await page(RANDOM_ID, 0);
    await page(RANDOM_ID, 150);
    await page(RANDOM_ID, 900);
    assert.deepEqual(await page(RANDOM_ID, 0), before);
  });

  test("a block only fetches its own three pages upstream", async () => {
    calls.length = 0;
    await page(RANDOM_ID, 175);
    assert.deepEqual([...calls].sort((a, b) => a - b), [150, 200, 250]);
  });

  test("different blocks get different orders", async () => {
    const a = (await page(RANDOM_ID, 0)).map((m) => rankOf(m) - 0);
    const b = (await page(RANDOM_ID, 150)).map((m) => rankOf(m) - BLOCK);
    assert.notDeepEqual(a, b, "both blocks shuffled to the same permutation");
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
