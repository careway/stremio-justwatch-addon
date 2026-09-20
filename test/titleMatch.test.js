"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { normalizeTitle } = require("../src/data/titleMatch");

describe("data/titleMatch — normalizeTitle", () => {
  test("strips accents, casing and punctuation for Latin scripts", () => {
    assert.equal(normalizeTitle("Enfrentados: Marfil"), "enfrentados marfil");
    assert.equal(normalizeTitle("Acción"), "accion");
    assert.equal(normalizeTitle("Nevertheless,"), "nevertheless");
  });

  test("preserves non-Latin scripts instead of erasing them", () => {
    // The bug this module fixes: the previous [a-z0-9]-only whitelist
    // reduced every non-Latin title to "", making any two different titles
    // in that script compare equal.
    assert.notEqual(normalizeTitle("鬼滅の刃"), "");
    assert.notEqual(normalizeTitle("لعبة الحبار"), "");
    assert.notEqual(normalizeTitle("दंगल"), "");
    assert.notEqual(normalizeTitle("오징어 게임"), "");
  });

  test("two different titles in the same non-Latin script are not equal", () => {
    // Confirmed live 2026-09-20 with a fabricated TMDb response: before this
    // fix, resolveImdbId() accepted Demon Slayer as a "match" for a query of
    // Attack on Titan because both normalized to "".
    assert.notEqual(normalizeTitle("鬼滅の刃"), normalizeTitle("進撃の巨人"));
    assert.notEqual(
      normalizeTitle("오징어 게임"),
      normalizeTitle("사랑의 불시착"),
    );
  });

  test("the same non-Latin title still compares equal to itself", () => {
    assert.equal(normalizeTitle("鬼滅の刃"), normalizeTitle("鬼滅の刃"));
  });

  test("empty/missing input stays empty, not a false match against another empty title", () => {
    assert.equal(normalizeTitle(""), "");
    assert.equal(normalizeTitle(undefined), "");
    assert.equal(normalizeTitle(null), "");
  });
});
