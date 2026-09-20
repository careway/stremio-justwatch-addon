"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { PLANS, effectivePlanId, getPlan } = require("../src/domain/plans");
const { normalizeAccountConfig, clampToPlan } = require("../src/domain/accountConfig");
const { buildAccountCatalogs, buildAccountManifest } = require("../src/domain/manifest");

const src = (over = {}) => ({
  country: "ES",
  language: "es",
  packages: ["nfx"],
  sorts: ["pop"],
  ...over,
});
const cfg = (sources, over = {}) => ({ sources, ...over });

describe("plans — effective plan", () => {
  test("no user, unknown plan → free", () => {
    assert.equal(effectivePlanId(null), "free");
    assert.equal(effectivePlanId({ plan: "platinum" }), "free");
  });

  test("a paid plan with no expiry is in force", () => {
    assert.equal(effectivePlanId({ plan: "pro" }), "pro");
  });

  test("an expired paid plan falls back to free without touching the row", () => {
    const now = Date.parse("2026-09-20T00:00:00Z");
    assert.equal(effectivePlanId({ plan: "plus", planExpiresAt: "2026-09-19T00:00:00Z" }, now), "free");
    assert.equal(effectivePlanId({ plan: "plus", planExpiresAt: "2026-09-21T00:00:00Z" }, now), "plus");
  });

  test("higher plans are strictly more generous on every limit", () => {
    const { free, plus, pro } = PLANS;
    for (const k of ["maxOffset", "maxCountries", "maxCatalogs"]) {
      assert.ok(free[k] < plus[k] && plus[k] < pro[k], k);
    }
    assert.ok(free.rateLimit.perMin < plus.rateLimit.perMin);
  });

  test("the free plan is not stingier than the anonymous flow it replaces", () => {
    // Anonymous URLs serve MAX_OFFSET=100; an account on the free plan must
    // never get less than that, or signing up would be a downgrade.
    assert.ok(getPlan({ plan: "free" }).maxOffset >= 100);
  });
});

describe("normalizeAccountConfig", () => {
  const free = PLANS.free;
  const pro = PLANS.pro;

  test("accepts a minimal valid config and fills the defaults", () => {
    const r = normalizeAccountConfig(cfg([src()]), free);
    assert.equal(r.ok, true);
    assert.deepEqual(r.config.sources[0].globalSorts, ["pop", "tnd", "new"]);
    assert.equal(r.config.randomize, false);
  });

  test("normalizes case: country upper, language lower", () => {
    const r = normalizeAccountConfig(cfg([src({ country: "es", language: "ES" })]), free);
    assert.equal(r.config.sources[0].country, "ES");
    assert.equal(r.config.sources[0].language, "es");
  });

  test("rejects unknown country, language, sort, provider id and type", () => {
    const bad = (over, code) => {
      const r = normalizeAccountConfig(cfg([src(over)]), pro);
      assert.equal(r.ok, false, JSON.stringify(over));
      assert.equal(r.code, code);
    };
    bad({ country: "ZZ" }, "invalid_country");
    bad({ language: "xx" }, "invalid_language");
    bad({ sorts: ["nope"] }, "invalid_sorts");
    bad({ packages: ["../etc"] }, "invalid_packages");
    bad({ packages: [] }, "invalid_packages");
    bad({ packageTypes: { nfx: "podcast" } }, "invalid_types");
  });

  test("rejects a non-object body and an empty source list", () => {
    assert.equal(normalizeAccountConfig(null, free).ok, false);
    assert.equal(normalizeAccountConfig({ sources: [] }, free).code, "invalid_config");
  });

  test("a plan's country limit is enforced, with a stable code", () => {
    const two = cfg([src(), src({ country: "MY", language: "en" })]);
    assert.equal(normalizeAccountConfig(two, free).code, "plan_countries");
    assert.equal(normalizeAccountConfig(two, PLANS.plus).ok, true);
  });

  test("the same country twice is refused rather than merged", () => {
    const r = normalizeAccountConfig(cfg([src(), src({ language: "en" })]), pro);
    assert.equal(r.code, "duplicate_country");
  });

  test("a plan's catalog limit counts sources × providers × sorts × types", () => {
    // 19 providers × 3 sorts × 2 types = 114 > free's 36
    const many = Array.from({ length: 19 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const r = normalizeAccountConfig(cfg([src({ packages: many, sorts: undefined })]), free);
    assert.equal(r.code, "plan_catalogs");
    assert.equal(normalizeAccountConfig(cfg([src({ packages: many, sorts: undefined })]), pro).ok, true);
  });

  test("randomize needs a plan that has it", () => {
    assert.equal(normalizeAccountConfig(cfg([src()], { randomize: true }), free).code, "plan_feature");
    assert.equal(normalizeAccountConfig(cfg([src()], { randomize: true }), PLANS.plus).ok, true);
  });

  test("a type narrowing for a provider that isn't selected is dropped", () => {
    const r = normalizeAccountConfig(cfg([src({ packageTypes: { nfx: "movie", dnp: "series" } })]), free);
    assert.deepEqual(r.config.sources[0].packageTypes, { nfx: "movie" });
  });

  test("poster provider: unknown, missing key, and non-https template are refused", () => {
    const withPoster = (over) => normalizeAccountConfig(cfg([src()], over), free);
    assert.equal(withPoster({ posterProvider: "nope" }).code, "invalid_poster");
    assert.equal(withPoster({ posterProvider: "rpdb" }).code, "invalid_poster"); // needs a key
    assert.equal(withPoster({ posterProvider: "rpdb", posterApiKey: "t8-abc" }).ok, true);
    assert.equal(withPoster({ posterProvider: "btttr" }).ok, true); // keyless is fine
    assert.equal(withPoster({ posterProvider: "btttr", posterApiKey: "http://x/{imdb_id}" }).code, "invalid_poster");
    assert.equal(withPoster({ posterProvider: "rpdb", posterApiKey: "a b" }).code, "invalid_poster");
  });
});

describe("clampToPlan — a downgrade must shrink the manifest, not break it", () => {
  test("drops countries beyond the plan and switches randomize off", () => {
    const stored = cfg(
      [src(), src({ country: "MY", language: "en" }), src({ country: "US", language: "en" })],
      { randomize: true },
    );
    const c = clampToPlan(stored, PLANS.free);
    assert.deepEqual(c.sources.map((s) => s.country), ["ES"]);
    assert.equal(c.randomize, false);
  });

  test("trims trailing providers until it fits the catalog limit", () => {
    const many = Array.from({ length: 19 }, (_, i) => `p${String(i).padStart(2, "0")}`);
    const c = clampToPlan(cfg([src({ packages: many, sorts: ["pop", "tnd", "new"] })]), PLANS.free);
    assert.ok(buildAccountCatalogs(c).length <= PLANS.free.maxCatalogs);
    assert.deepEqual(c.sources[0].packages, many.slice(0, c.sources[0].packages.length));
  });

  test("does not mutate what it was given", () => {
    const stored = cfg([src({ packages: ["a1a", "b2b"] }), src({ country: "MY" })]);
    const before = JSON.stringify(stored);
    clampToPlan(stored, PLANS.free);
    assert.equal(JSON.stringify(stored), before);
  });
});

describe("account manifest — several countries in one install", () => {
  const two = cfg([src(), src({ country: "MY", language: "en" })]);

  test("has catalogs for every source, ids carrying their own country", () => {
    const ids = buildAccountCatalogs(two).map((c) => c.id);
    assert.ok(ids.some((id) => id.startsWith("ES_es_jw_")));
    assert.ok(ids.some((id) => id.startsWith("MY_en_jw_")));
  });

  test("the country suffix is forced on even when hideCountry is set", () => {
    const names = buildAccountCatalogs({ ...two, hideCountry: true }).map((c) => c.name);
    assert.ok(names.every((n) => / · (ES|MY)$/.test(n)), names.join(" | "));
  });

  test("a single source honours hideCountry", () => {
    const names = buildAccountCatalogs(cfg([src()], { hideCountry: true })).map((c) => c.name);
    assert.ok(names.every((n) => !n.includes(" · ES")));
  });

  test("the envelope is the same manifest the anonymous flow builds", () => {
    const m = buildAccountManifest(two, {}, "http://x");
    assert.equal(m.id, "community.omnicatalogs.stremio.addon");
    assert.deepEqual(m.resources, ["catalog"]);
    assert.equal(m.name, "OmniCatalogs"); // no single country to name
    assert.equal(buildAccountManifest(cfg([src()]), {}, "http://x").name, "OmniCatalogs · ES");
  });

  test("randomize prefixes every id", () => {
    const ids = buildAccountCatalogs({ ...two, randomize: true }).map((c) => c.id);
    assert.ok(ids.every((id) => id.startsWith("r_")));
  });
});
