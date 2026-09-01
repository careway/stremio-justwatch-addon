"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  seedFromString,
  seededShuffle,
  seedWindow,
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

  test("seedWindow is stable inside a window and moves across one", () => {
    const W = 4 * 3600 * 1000; // the catalog TTL, which is what catalog.js passes
    const base = Date.UTC(2026, 0, 1, 0, 0);
    assert.equal(seedWindow(W, base), seedWindow(W, base + W - 1));
    assert.equal(seedWindow(W, base) + 1, seedWindow(W, base + W));
  });

  test("seedWindow tracks the window length it is given", () => {
    const hour = 3600 * 1000;
    const t = Date.UTC(2026, 0, 1, 7, 0);
    // A 4h window has already rotated 7 times by 07:00; a 24h one has not.
    assert.notEqual(seedWindow(4 * hour, t), seedWindow(4 * hour, t - 4 * hour));
    assert.equal(seedWindow(24 * hour, t), seedWindow(24 * hour, t - 4 * hour));
  });

  test("the seed window is derived from the catalog TTL, not a hardcoded day", () => {
    const { TTL_S } = require("../src/ttl");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "domain", "catalog.js"),
      "utf8",
    );
    // Pins the intent: if someone reintroduces a fixed period here, the data
    // and the shuffle drift apart again.
    assert.match(src, /RANDOM_SEED_WINDOW_MS = TTL_S \* 1000/);
    assert.doesNotMatch(src, /86400000/);
    assert.equal(typeof TTL_S, "number");
  });

  test("a day-long window would outlive the catalog TTL", () => {
    const d1 = seedWindow(86400000, Date.UTC(2026, 0, 1, 23, 59));
    const d2 = seedWindow(86400000, Date.UTC(2026, 0, 2, 0, 1));
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
