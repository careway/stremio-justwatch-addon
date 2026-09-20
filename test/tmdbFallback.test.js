"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// TMDB_API_KEY must be set *before* the module under test is required — it's
// read once at module load, same "off unless configured" contract as
// DATABASE_URL/UPSTASH_REDIS_* elsewhere.
process.env.TMDB_API_KEY = "test-key";

let responses; // url pathname -> response body object, or an Error to reject with
let fetchCalls;
global.fetch = async (url) => {
  const u = new URL(url);
  fetchCalls.push(u.pathname + u.search);
  const body = responses[u.pathname];
  if (body instanceof Error) throw body;
  if (body === undefined) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => body };
};

const { resolveImdbId, breaker } = require("../src/infra/tmdbFallback");

describe("infra/tmdbFallback", () => {
  beforeEach(async () => {
    fetchCalls = [];
    responses = {};
    breaker.reset();
    // Every test uses its own title so cache entries from earlier tests
    // (same process) can't leak in — cheaper than reaching into L1/L2
    // internals to flush by prefix.
  });

  test("resolves an IMDb id when TMDb's title matches (normalized)", async () => {
    responses["/3/search/movie"] = {
      results: [{ id: 999, title: "Drawn Together" }],
    };
    responses["/3/movie/999/external_ids"] = { imdb_id: "tt36073210" };

    const imdbId = await resolveImdbId({
      title: "Drawn Together",
      year: 2026,
      type: "movie",
    });
    assert.equal(imdbId, "tt36073210");
  });

  test("matches via original_title when TMDb's display title is localized — the exact case this fallback was built for", async () => {
    // Confirmed live 2026-09-20: with no `language` param, TMDb's search
    // returns an en-US display `title` ("Drawn Together") even for a title
    // whose original language/title is what JustWatch and the catalog query
    // actually use ("Enfrentados: Marfil", in original_title) — comparing
    // only `title` rejected this and the fallback failed on its own
    // motivating example (see infra/tmdbFallback's resolveImdbId doc).
    responses["/3/search/movie"] = {
      results: [
        {
          id: 999,
          title: "Drawn Together",
          original_title: "Enfrentados: Marfil",
        },
      ],
    };
    responses["/3/movie/999/external_ids"] = { imdb_id: "tt36073210" };

    const imdbId = await resolveImdbId({
      title: "Enfrentados: Marfil",
      year: 2026,
      type: "movie",
    });
    assert.equal(imdbId, "tt36073210");
  });

  test("same original_name fallback for a TV search", async () => {
    responses["/3/search/tv"] = {
      results: [{ id: 42, name: "English Marketing Name", original_name: "Título Original" }],
    };
    responses["/3/tv/42/external_ids"] = { imdb_id: "tt42" };

    const imdbId = await resolveImdbId({
      title: "Título Original",
      year: null,
      type: "tv",
    });
    assert.equal(imdbId, "tt42");
  });

  test("matches ignoring case/accents/punctuation, same as the Netflix Top10 matcher", async () => {
    responses["/3/search/movie"] = {
      results: [{ id: 1, title: "Enfrentados: Marfil" }],
    };
    responses["/3/movie/1/external_ids"] = { imdb_id: "tt1" };

    const imdbId = await resolveImdbId({
      title: "enfrentados marfil", // no colon, lowercase
      year: null,
      type: "movie",
    });
    assert.equal(imdbId, "tt1");
  });

  test("refuses to guess: a same-topic but different title is not accepted", async () => {
    responses["/3/search/tv"] = {
      results: [{ id: 2, name: "Some Unrelated Show" }],
    };
    const imdbId = await resolveImdbId({
      title: "Bulan Henti Bicara",
      year: null,
      type: "tv",
    });
    assert.equal(imdbId, null);
    // Never even asked for external_ids on a title it didn't accept.
    assert.ok(!fetchCalls.some((c) => c.includes("external_ids")));
  });

  test("two different non-Latin-script titles are never accepted as a match for each other", async () => {
    // Regression test for a real false-positive confirmed live 2026-09-20:
    // the matcher used to whitelist only [a-z0-9], which reduced any
    // non-Latin title (Japanese here) to "" — making it accept *any* other
    // title in the same script as a "match". Querying for Attack on Titan
    // (進撃の巨人) with only a Demon Slayer (鬼滅の刃) candidate available
    // used to wrongly return Demon Slayer's IMDb id.
    responses["/3/search/tv"] = {
      results: [
        { id: 999, name: "Demon Slayer: Kimetsu no Yaiba", original_name: "鬼滅の刃" },
      ],
    };
    responses["/3/tv/999/external_ids"] = { imdb_id: "tt9335498" };

    const imdbId = await resolveImdbId({
      title: "進撃の巨人", // Attack on Titan — a different show entirely
      year: null,
      type: "tv",
    });
    assert.equal(imdbId, null);
  });

  test("no TMDb results at all resolves to null", async () => {
    responses["/3/search/movie"] = { results: [] };
    assert.equal(
      await resolveImdbId({ title: "Nothing Like This Exists", year: null, type: "movie" }),
      null,
    );
  });

  test("a network failure degrades to null instead of throwing", async () => {
    responses["/3/search/movie"] = new Error("network down");
    assert.equal(
      await resolveImdbId({ title: "Whatever Fails Today", year: null, type: "movie" }),
      null,
    );
  });

  test("a genuine failure is not cached — a real outage shouldn't poison a title for 24h", async () => {
    responses["/3/search/movie"] = new Error("network down");
    await resolveImdbId({ title: "Transient Outage", year: null, type: "movie" });

    responses["/3/search/movie"] = { results: [{ id: 7, title: "Transient Outage" }] };
    responses["/3/movie/7/external_ids"] = { imdb_id: "tt7" };
    const second = await resolveImdbId({ title: "Transient Outage", year: null, type: "movie" });
    assert.equal(second, "tt7", "must retry once TMDb recovers, not serve a stale null");
  });

  test("caches a positive result — second lookup does not hit the network", async () => {
    responses["/3/search/movie"] = { results: [{ id: 5, title: "Cached Hit" }] };
    responses["/3/movie/5/external_ids"] = { imdb_id: "tt5" };

    await resolveImdbId({ title: "Cached Hit", year: null, type: "movie" });
    fetchCalls = [];
    const second = await resolveImdbId({ title: "Cached Hit", year: null, type: "movie" });
    assert.equal(second, "tt5");
    assert.equal(fetchCalls.length, 0);
  });

  test("caches a negative result too — a title TMDb never links doesn't retry forever", async () => {
    responses["/3/search/movie"] = { results: [] };
    await resolveImdbId({ title: "Cached Miss", year: null, type: "movie" });
    fetchCalls = [];
    const second = await resolveImdbId({ title: "Cached Miss", year: null, type: "movie" });
    assert.equal(second, null);
    assert.equal(fetchCalls.length, 0);
  });

  test("without a title, resolves to null without touching the network", async () => {
    assert.equal(await resolveImdbId({ title: "", year: null, type: "movie" }), null);
    assert.equal(fetchCalls.length, 0);
  });
});

describe("infra/tmdbFallback — breaker protects a flaky TMDb", () => {
  beforeEach(() => {
    fetchCalls = [];
    responses = {};
    breaker.reset();
  });

  test("tolerates isolated failures — does not open on the first or second", async () => {
    responses["/3/search/movie"] = new Error("blip");
    await resolveImdbId({ title: "Blip One", year: null, type: "movie" });
    await resolveImdbId({ title: "Blip Two", year: null, type: "movie" });
    assert.equal(breaker.isOpen(), false);
  });

  test("opens after 3 consecutive failures and skips the network while open", async () => {
    responses["/3/search/movie"] = new Error("down");
    for (const title of ["A", "B", "C"]) {
      await resolveImdbId({ title, year: null, type: "movie" });
    }
    assert.equal(breaker.isOpen(), true);

    fetchCalls = [];
    responses["/3/search/movie"] = { results: [{ id: 1, title: "D" }] }; // "recovered"
    const result = await resolveImdbId({ title: "D", year: null, type: "movie" });
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 0, "must not hit the network while open");
  });

  test("a success in between resets the failure count", async () => {
    responses["/3/search/movie"] = new Error("down");
    await resolveImdbId({ title: "Fail One", year: null, type: "movie" });
    await resolveImdbId({ title: "Fail Two", year: null, type: "movie" });

    responses["/3/search/movie"] = { results: [] }; // answers cleanly, just no match
    await resolveImdbId({ title: "Clean Miss", year: null, type: "movie" });

    responses["/3/search/movie"] = new Error("down");
    await resolveImdbId({ title: "Fail Three", year: null, type: "movie" });
    assert.equal(breaker.isOpen(), false, "the clean answer should have reset the streak");
  });
});

describe("infra/tmdbFallback — disabled without TMDB_API_KEY", () => {
  test("is a no-op, no network call, when the key is unset", async () => {
    // Simulate the "unset" contract in-process: reload the module with no
    // key. require.cache substitution keeps this isolated to this describe.
    delete process.env.TMDB_API_KEY;
    delete require.cache[require.resolve("../src/infra/tmdbFallback")];
    const { resolveImdbId: resolveWithoutKey } = require("../src/infra/tmdbFallback");

    fetchCalls = [];
    const result = await resolveWithoutKey({
      title: "Anything",
      year: null,
      type: "movie",
    });
    assert.equal(result, null);
    assert.equal(fetchCalls.length, 0);

    process.env.TMDB_API_KEY = "test-key"; // restore for any test file re-run
  });
});
