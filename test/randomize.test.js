"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const {
  seedFromString,
  seededShuffle,
  currentDaySeed,
} = require("../src/domain/random");
const { encodeConfig, decodeConfig } = require("../src/domain/userConfig");
const { buildManifest } = require("../src/domain/manifest");

const PKG_INFO = { nfx: { clearName: "Netflix" } };

describe("domain/random — seededShuffle", () => {
  const items = Array.from({ length: 50 }, (_, i) => i);

  test("is deterministic for a given seed", () => {
    const seed = seedFromString("jw_pop_nfx|movie||20000");
    assert.deepEqual(seededShuffle(items, seed), seededShuffle(items, seed));
  });

  test("different seeds give different orders", () => {
    const a = seededShuffle(items, seedFromString("a"));
    const b = seededShuffle(items, seedFromString("b"));
    assert.notDeepEqual(a, b);
  });

  test("is a permutation — same multiset, not mutating input", () => {
    const copy = items.slice();
    const out = seededShuffle(items, 12345);
    assert.deepEqual(items, copy);
    assert.deepEqual([...out].sort((x, y) => x - y), copy);
  });

  test("currentDaySeed changes once per UTC day", () => {
    const d1 = currentDaySeed(Date.UTC(2026, 0, 1, 23, 59));
    const d2 = currentDaySeed(Date.UTC(2026, 0, 2, 0, 1));
    assert.equal(d2 - d1, 1);
  });
});

describe("encodeConfig / decodeConfig — randomize flag", () => {
  test("absent by default, no segment emitted", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["nfx"],
    });
    assert.equal(encoded, "ES_es_nfx");
    assert.equal(decodeConfig(encoded).randomize, false);
  });

  test("round-trips as a bare 'rnd' segment", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["nfx"],
      randomize: true,
    });
    assert.equal(encoded, "ES_es_rnd_nfx");
    assert.equal(decodeConfig(encoded).randomize, true);
    assert.deepEqual(decodeConfig(encoded).packages, ["nfx"]);
  });

  test("'rnd' is not mistaken for a package name", () => {
    const decoded = decodeConfig("ES_es_rnd_nfx_dnp");
    assert.deepEqual(decoded.packages, ["nfx", "dnp"]);
    assert.equal(decoded.randomize, true);
  });

  test("coexists with poster, sorts and type markers", () => {
    const cfg = {
      country: "ES",
      language: "es",
      posterProvider: "rpdb",
      posterApiKey: "t8-x",
      sorts: ["pop"],
      packages: ["nfx"],
      packageTypes: { nfx: "movie" },
      randomize: true,
    };
    const decoded = decodeConfig(encodeConfig(cfg));
    assert.equal(decoded.randomize, true);
    assert.deepEqual(decoded.sorts, ["pop"]);
    assert.deepEqual(decoded.packageTypes, { nfx: "movie" });
  });
});

describe("buildManifest — randomized catalog ids", () => {
  const idsOf = (config) =>
    buildManifest(config, "x", PKG_INFO, "http://x").catalogs.map((c) => c.id);

  test("plain ids when randomize is off", () => {
    const ids = idsOf({
      country: "ES",
      language: "es",
      packages: ["nfx"],
      sorts: ["pop"],
    });
    assert.ok(ids.every((id) => id.startsWith("jw_")));
  });

  test("every id gets an r_ prefix when randomize is on", () => {
    const ids = idsOf({
      country: "ES",
      language: "es",
      packages: ["nfx"],
      sorts: ["pop"],
      randomize: true,
    });
    assert.ok(ids.every((id) => id.startsWith("r_jw_")));
  });
});
