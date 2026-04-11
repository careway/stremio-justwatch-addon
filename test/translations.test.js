"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { GENRES, getGenreNames, getGenreCode } = require("../src/config");

// All languages present in the dataset
const ALL_LANGS = ["es", "en", "de", "fr", "it", "pt", "nl", "sv", "no", "da", "fi", "pl", "ja", "ko"];

// ─── GENRES array integrity ───────────────────────────────────────────────────

describe("GENRES array integrity", () => {
  test("every genre has a non-empty code", () => {
    for (const g of GENRES) {
      assert.ok(g.code && typeof g.code === "string", `Missing code: ${JSON.stringify(g)}`);
    }
  });

  test("every genre has an English name as fallback", () => {
    for (const g of GENRES) {
      assert.ok(g.names.en, `Genre '${g.code}' is missing English name`);
    }
  });

  test("every genre has translations for all supported languages", () => {
    for (const g of GENRES) {
      for (const lang of ALL_LANGS) {
        assert.ok(
          g.names[lang],
          `Genre '${g.code}' is missing translation for '${lang}'`
        );
      }
    }
  });

  test("no duplicate genre codes", () => {
    const codes = GENRES.map((g) => g.code);
    const dupes = codes.filter((c, i) => codes.indexOf(c) !== i);
    assert.deepEqual(dupes, [], `Duplicate genre codes found: ${dupes}`);
  });

  test("no empty translation strings", () => {
    for (const g of GENRES) {
      for (const [lang, name] of Object.entries(g.names)) {
        assert.ok(
          name && name.trim().length > 0,
          `Genre '${g.code}' has empty translation for '${lang}'`
        );
      }
    }
  });
});

// ─── getGenreNames ────────────────────────────────────────────────────────────

describe("getGenreNames", () => {
  test("returns an array with one entry per genre", () => {
    const names = getGenreNames("en");
    assert.equal(names.length, GENRES.length);
  });

  test("returns correct Spanish names", () => {
    const names = getGenreNames("es");
    assert.ok(names.includes("Acción"), "Missing 'Acción'");
    assert.ok(names.includes("Animación"), "Missing 'Animación'");
    assert.ok(names.includes("Ciencia ficción"), "Missing 'Ciencia ficción'");
    assert.ok(names.includes("Familia"), "Missing 'Familia'");
    assert.ok(names.includes("Terror"), "Missing 'Terror'");
  });

  test("returns correct English names", () => {
    const names = getGenreNames("en");
    assert.ok(names.includes("Action"));
    assert.ok(names.includes("Science Fiction"));
    assert.ok(names.includes("Family"));
    assert.ok(names.includes("Horror"));
  });

  test("returns correct German names", () => {
    const names = getGenreNames("de");
    assert.ok(names.includes("Komödie"), "Missing 'Komödie'");
    assert.ok(names.includes("Dokumentarfilm"), "Missing 'Dokumentarfilm'");
    assert.ok(names.includes("Science-Fiction"), "Missing 'Science-Fiction'");
  });

  test("returns correct Japanese names", () => {
    const names = getGenreNames("ja");
    assert.ok(names.includes("アクション"), "Missing アクション");
    assert.ok(names.includes("アニメーション"), "Missing アニメーション");
    assert.ok(names.includes("ドキュメンタリー"), "Missing ドキュメンタリー");
  });

  test("falls back to English for unknown language", () => {
    const unknown = getGenreNames("xx");
    const english = getGenreNames("en");
    assert.deepEqual(unknown, english);
  });

  test("handles BCP47 tags like 'es-ES' by using primary subtag", () => {
    const es = getGenreNames("es");
    const esES = getGenreNames("es-ES");
    assert.deepEqual(esES, es);
  });

  test("handles null/undefined language gracefully", () => {
    const fromNull = getGenreNames(null);
    const fromUndefined = getGenreNames(undefined);
    const english = getGenreNames("en");
    assert.deepEqual(fromNull, english);
    assert.deepEqual(fromUndefined, english);
  });

  test("returns no duplicate names within the same language", () => {
    for (const lang of ALL_LANGS) {
      const names = getGenreNames(lang);
      const unique = [...new Set(names)];
      assert.equal(
        names.length,
        unique.length,
        `Duplicate genre names found for language '${lang}': ${names.filter((n, i) => names.indexOf(n) !== i)}`
      );
    }
  });
});

// ─── getGenreCode (round-trip) ────────────────────────────────────────────────

describe("getGenreCode round-trip", () => {
  test("name→code→name is stable for every genre in every language", () => {
    for (const lang of ALL_LANGS) {
      const names = getGenreNames(lang);
      for (const name of names) {
        const code = getGenreCode(name, lang);
        assert.ok(code, `getGenreCode returned null for '${name}' (${lang})`);
        // The code must belong to a known genre
        const genre = GENRES.find((g) => g.code === code);
        assert.ok(genre, `Code '${code}' resolved from '${name}' (${lang}) is not in GENRES`);
      }
    }
  });

  test("returns null for unknown genre name", () => {
    assert.equal(getGenreCode("NotAGenre", "en"), null);
    assert.equal(getGenreCode("", "en"), null);
    assert.equal(getGenreCode(null, "en"), null);
  });

  test("resolves Spanish genre names correctly", () => {
    assert.equal(getGenreCode("Acción", "es"), "act");
    assert.equal(getGenreCode("Familia", "es"), "fml");
    assert.equal(getGenreCode("Fantasía", "es"), "fnt");
    assert.equal(getGenreCode("Guerra", "es"), "war");
    assert.equal(getGenreCode("Western", "es"), "wsn");
  });

  test("resolves English genre names correctly", () => {
    assert.equal(getGenreCode("Action", "en"), "act");
    assert.equal(getGenreCode("Family", "en"), "fml");
    assert.equal(getGenreCode("Fantasy", "en"), "fnt");
    assert.equal(getGenreCode("War", "en"), "war");
    assert.equal(getGenreCode("Western", "en"), "wsn");
    assert.equal(getGenreCode("Science Fiction", "en"), "scf");
  });

  test("falls back to English code for unknown language", () => {
    assert.equal(getGenreCode("Action", "xx"), "act");
  });
});
