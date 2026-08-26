"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { getSupportedLanguages } = require("../src/data/catalogMeta");
const {
  UI_STRINGS,
  RTL_UI_LANGUAGES,
  DEFAULT_UI_LANGUAGE,
  getUiStrings,
} = require("../src/data/uiStrings");

const KEYS = Object.keys(UI_STRINGS.en);

describe("UI strings dataset", () => {
  test("covers every language offered by the catalogs", () => {
    for (const { code } of getSupportedLanguages()) {
      assert.ok(UI_STRINGS[code], `Missing UI translations for '${code}'`);
    }
  });

  test("offers no language the catalogs can't serve", () => {
    const supported = new Set(getSupportedLanguages().map((l) => l.code));
    for (const code of Object.keys(UI_STRINGS)) {
      assert.ok(supported.has(code), `'${code}' is not a catalog language`);
    }
  });

  test("every language has every key, non-empty", () => {
    for (const [code, strings] of Object.entries(UI_STRINGS)) {
      for (const key of KEYS) {
        assert.ok(
          strings[key] && strings[key].trim().length > 0,
          `'${code}' is missing or has an empty '${key}'`,
        );
      }
    }
  });

  test("no language defines keys English doesn't", () => {
    for (const [code, strings] of Object.entries(UI_STRINGS)) {
      for (const key of Object.keys(strings)) {
        assert.ok(KEYS.includes(key), `'${code}' has unknown key '${key}'`);
      }
    }
  });

  test("loadMore keeps its {n} placeholder in every language", () => {
    for (const [code, strings] of Object.entries(UI_STRINGS)) {
      assert.ok(
        strings.loadMore.includes("{n}"),
        `'${code}' loadMore lost the {n} placeholder`,
      );
    }
  });

  test("RTL languages are part of the dataset", () => {
    for (const code of RTL_UI_LANGUAGES) {
      assert.ok(UI_STRINGS[code], `RTL language '${code}' has no translations`);
    }
  });
});

describe("getUiStrings", () => {
  test("returns the requested language", () => {
    assert.equal(getUiStrings("de").copy, UI_STRINGS.de.copy);
  });

  test("handles BCP47 tags like 'pt-BR' by using the primary subtag", () => {
    assert.deepEqual(getUiStrings("pt-BR"), getUiStrings("pt"));
  });

  test("falls back to English for an unknown language", () => {
    assert.deepEqual(getUiStrings("xx"), getUiStrings("en"));
  });

  test("defaults to Spanish when no language is given", () => {
    assert.equal(DEFAULT_UI_LANGUAGE, "es");
    assert.deepEqual(getUiStrings(), getUiStrings("es"));
  });
});
