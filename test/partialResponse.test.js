"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");
const path = require("node:path");

// Stub axios in the require cache *before* justwatch.js pulls it in, so the
// module under test is the real one and only the network is fake.
const axiosPath = require.resolve("axios");
let nextResponse;
let postCalls;
require.cache[axiosPath] = {
  id: axiosPath,
  filename: axiosPath,
  loaded: true,
  exports: {
    post: async (...args) => {
      postCalls.push(args);
      if (nextResponse instanceof Error) throw nextResponse;
      return { data: nextResponse };
    },
  },
};

const justwatch = require("../src/infra/justwatch");
const { L1Cache } = require("../src/infra/cache");
const stats = require("../src/infra/stats");

// One title's `content` failing is what production actually sent (DK/da,
// popularTitles, edges[39]) — see the comment in gql().
const FIELD_ERROR = {
  message:
    "rpc error: code = Unavailable desc = error reading from server: connection reset by peer",
  path: ["popularTitles", "edges", 39, "node", "content"],
  extensions: { code: "INTERNAL_ERROR" },
};

const node = (id) => ({
  id,
  objectType: "MOVIE",
  content: { title: `T${id}`, fullPath: `/x/${id}` },
});

// Each call needs its own country so it can't be served from a previous
// test's cache entry.
let seq = 0;
const freshCountry = () => `Z${(seq++).toString().padStart(2, "0")}`;

describe("partial GraphQL responses", () => {
  beforeEach(() => {
    postCalls = [];
    justwatch.breaker.reset();
    L1Cache.flush?.();
  });

  test("serves the titles that resolved instead of discarding the page", async () => {
    nextResponse = {
      errors: [FIELD_ERROR],
      data: { popularTitles: { edges: [{ node: node(1) }, { node: node(2) }] } },
    };
    const titles = await justwatch.searchTitles({
      query: "",
      country: freshCountry(),
    });
    assert.equal(titles.length, 2);
  });

  test("drops the null entry null-propagation leaves behind", async () => {
    nextResponse = {
      errors: [FIELD_ERROR],
      data: {
        popularTitles: { edges: [{ node: node(1) }, null, { node: null }] },
      },
    };
    const titles = await justwatch.searchTitles({
      query: "",
      country: freshCountry(),
    });
    assert.deepEqual(
      titles.map((t) => t.id),
      [1],
    );
  });

  test("a partial response does not count as an upstream failure", async () => {
    nextResponse = {
      errors: [FIELD_ERROR],
      data: { popularTitles: { edges: [{ node: node(1) }] } },
    };
    await justwatch.searchTitles({ query: "", country: freshCountry() });
    assert.equal(justwatch.breaker.state().consecutiveFailures, 0);
    assert.equal(justwatch.breaker.isOpen(), false);
  });

  test("repeated partials never open the breaker", async () => {
    nextResponse = {
      errors: [FIELD_ERROR],
      data: { popularTitles: { edges: [{ node: node(1) }] } },
    };
    for (let i = 0; i < 20; i++) {
      await justwatch.searchTitles({ query: "", country: freshCountry() });
    }
    assert.equal(justwatch.breaker.isOpen(), false);
    assert.equal(postCalls.length, 20, "every call reached the network");
  });

  test("errors with no usable data still throw", async () => {
    nextResponse = { errors: [FIELD_ERROR], data: null };
    await assert.rejects(
      justwatch.searchTitles({ query: "", country: freshCountry() }),
      /GraphQL errors/,
    );
  });

  test("a data object whose every field is null is not usable", async () => {
    nextResponse = { errors: [FIELD_ERROR], data: { popularTitles: null } };
    await assert.rejects(
      justwatch.searchTitles({ query: "", country: freshCountry() }),
      /GraphQL errors/,
    );
  });

  test("a total GraphQL failure does feed the breaker", async () => {
    nextResponse = { errors: [FIELD_ERROR], data: null };
    await assert.rejects(
      justwatch.searchTitles({ query: "", country: freshCountry() }),
    );
    assert.equal(justwatch.breaker.state().consecutiveFailures, 1);
  });

  test("counters separate a partial from a clean success", async () => {
    const before = { ...stats.snapshot().counters.upstream };
    nextResponse = {
      errors: [FIELD_ERROR],
      data: { popularTitles: { edges: [{ node: node(1) }] } },
    };
    await justwatch.searchTitles({ query: "", country: freshCountry() });
    const after = stats.snapshot().counters.upstream;
    assert.equal((after.partial || 0) - (before.partial || 0), 1);
    assert.equal((after.ok || 0) - (before.ok || 0), 1);
  });
});
