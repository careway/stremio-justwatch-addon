"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");

// TMDB_API_KEY must be set *before* the module under test is required — it's
// read once at module load, same "off unless configured" contract as
// DATABASE_URL/UPSTASH_REDIS_* elsewhere.
process.env.TMDB_API_KEY = "test-key";

let responses; // url pathname -> response body object, an Error to reject with, or { __status } for an HTTP error
let fetchCalls;
let fetchHeaders;
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  fetchCalls.push(u.pathname + u.search);
  fetchHeaders.push(opts.headers || {});
  const body = responses[u.pathname];
  if (body instanceof Error) throw body;
  if (body === undefined) return { ok: false, status: 404 };
  if (body.__status) return { ok: false, status: body.__status };
  return { ok: true, status: 200, json: async () => body };
};

const { resolveImdbId, breaker, verifyKey, isValidKeyFormat } = require("../src/infra/tmdbFallback");

describe("infra/tmdbFallback", () => {
  beforeEach(async () => {
    fetchCalls = [];
    fetchHeaders = [];
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
    fetchHeaders = [];
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

describe("infra/tmdbFallback — the caller's own key", () => {
  // Failure state is per key and lives for the process, so every test that
  // makes a key fail (or is judged on one that could have) gets its own.
  const key = (n) => n.toString(16).padStart(32, "0");
  const MINE = key(1);
  const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhYmMxMjMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const hit = (title, id, imdb) => {
    responses["/3/search/movie"] = { results: [{ id, title }] };
    responses[`/3/movie/${id}/external_ids`] = { imdb_id: imdb };
  };
  beforeEach(() => {
    fetchCalls = [];
    fetchHeaders = [];
    responses = {};
    breaker.reset();
  });

  test("an account's key is the one sent to TMDb, not the operator's", async () => {
    hit("Own Key Title", 11, "tt11");
    const id = await resolveImdbId({ title: "Own Key Title", year: null, type: "movie", apiKey: MINE });
    assert.equal(id, "tt11");
    assert.ok(fetchCalls.every((c) => c.includes(`api_key=${MINE}`)), fetchCalls.join(" "));
    assert.ok(!fetchCalls.some((c) => c.includes("test-key")));
  });

  test("apiKey: null switches the fallback off even though the operator has a key", async () => {
    hit("No Key Title", 12, "tt12");
    assert.equal(await resolveImdbId({ title: "No Key Title", year: null, type: "movie", apiKey: null }), null);
    assert.equal(fetchCalls.length, 0);
  });

  test("apiKey left undefined is the anonymous flow: the operator's key", async () => {
    hit("Anon Title", 13, "tt13");
    assert.equal(await resolveImdbId({ title: "Anon Title", year: null, type: "movie" }), "tt13");
    assert.ok(fetchCalls[0].includes("api_key=test-key"));
  });

  test("a v4 read-access token goes in an Authorization header, not the URL", async () => {
    hit("Bearer Title", 14, "tt14");
    await resolveImdbId({ title: "Bearer Title", year: null, type: "movie", apiKey: JWT });
    assert.ok(fetchHeaders.every((h) => h.Authorization === `Bearer ${JWT}`));
    assert.ok(!fetchCalls.some((c) => c.includes("api_key")));
  });

  test("a key TMDb rejects (401) is parked: no repeat calls, and the breaker is untouched", async () => {
    const REJECTED = key(2);
    responses["/3/search/movie"] = { __status: 401 };
    assert.equal(await resolveImdbId({ title: "Rejected A", year: null, type: "movie", apiKey: REJECTED }), null);
    const callsAfterFirst = fetchCalls.length;
    assert.equal(await resolveImdbId({ title: "Rejected B", year: null, type: "movie", apiKey: REJECTED }), null);
    assert.equal(fetchCalls.length, callsAfterFirst, "must not ask TMDb again with a key it refused");
  });

  test("one account's bad key does not stop another account's lookups", async () => {
    responses["/3/search/movie"] = { __status: 401 };
    await resolveImdbId({ title: "Bad Key Owner", year: null, type: "movie", apiKey: key(3) });

    hit("Good Key Title", 15, "tt15");
    assert.equal(await resolveImdbId({ title: "Good Key Title", year: null, type: "movie", apiKey: key(4) }), "tt15");
    assert.equal(breaker.isOpen(), false);
  });

  test("one key's outage opens only that key's breaker", async () => {
    const FAILING = key(5);
    responses["/3/search/movie"] = new Error("down");
    for (const t of ["A1", "A2", "A3"]) {
      await resolveImdbId({ title: t, year: null, type: "movie", apiKey: FAILING });
    }
    fetchCalls = [];
    responses["/3/search/movie"] = { results: [] };
    await resolveImdbId({ title: "Still Works", year: null, type: "movie", apiKey: key(6) });
    assert.ok(fetchCalls.length > 0, "another key must still reach TMDb");
    await resolveImdbId({ title: "Skipped", year: null, type: "movie", apiKey: FAILING });
    assert.ok(!fetchCalls.some((c) => c.includes("Skipped")), "the failing key is skipped");
  });

  test("results are cached across keys, but a caller with no key never sees the cache", async () => {
    hit("Shared Cache Title", 16, "tt16");
    await resolveImdbId({ title: "Shared Cache Title", year: null, type: "movie", apiKey: key(7) });
    fetchCalls = [];
    assert.equal(await resolveImdbId({ title: "Shared Cache Title", year: null, type: "movie", apiKey: key(8) }), "tt16");
    assert.equal(fetchCalls.length, 0, "cache hit, no network");
    assert.equal(await resolveImdbId({ title: "Shared Cache Title", year: null, type: "movie", apiKey: null }), null);
  });
});

describe("infra/tmdbFallback — key format and verification", () => {
  const V3 = "0123456789abcdef0123456789abcdef";
  beforeEach(() => {
    fetchCalls = [];
    fetchHeaders = [];
    responses = {};
  });

  test("accepts a 32-hex key and a JWT, refuses everything else", () => {
    assert.equal(isValidKeyFormat(V3), true);
    assert.equal(isValidKeyFormat(V3.toUpperCase()), true);
    assert.equal(isValidKeyFormat("eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJhYmMxMjMifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ"), true);
    for (const bad of ["", "abc", V3 + "0", "g".repeat(32), "a b".repeat(11), null, undefined, 42, "x".repeat(700)]) {
      assert.equal(isValidKeyFormat(bad), false, String(bad));
    }
  });

  test("verifyKey: ok, invalid (401), unreachable (5xx / network), format", async () => {
    responses["/3/authentication"] = { success: true };
    assert.deepEqual(await verifyKey(V3), { ok: true });
    responses["/3/authentication"] = { __status: 401 };
    assert.deepEqual(await verifyKey(V3), { ok: false, reason: "invalid" });
    responses["/3/authentication"] = { __status: 503 };
    assert.deepEqual(await verifyKey(V3), { ok: false, reason: "unreachable" });
    responses["/3/authentication"] = new Error("network down");
    assert.deepEqual(await verifyKey(V3), { ok: false, reason: "unreachable" });
    fetchCalls = [];
    assert.deepEqual(await verifyKey("nope"), { ok: false, reason: "format" });
    assert.equal(fetchCalls.length, 0, "a malformed key never reaches TMDb");
  });
});
