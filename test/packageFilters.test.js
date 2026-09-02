"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const {
  keepPackage,
  annotateChannels,
  classifyChannel,
  EXCLUSIONS,
  CHANNEL_RULES,
} = require("../src/data/packageFilters");

const pkg = (over = {}) => ({
  shortName: "xxx",
  clearName: "Something",
  technicalName: "something",
  monetizationTypes: ["FLATRATE"],
  hasTitles: true,
  addonParent: null,
  ...over,
});

describe("packageFilters — exclusions", () => {
  test("keeps an ordinary VOD provider", () => {
    assert.equal(keepPackage(pkg({ clearName: "Netflix" })), true);
  });

  test("drops cinema-only packages", () => {
    assert.equal(keepPackage(pkg({ monetizationTypes: ["CINEMA"] })), false);
  });

  test("keeps a package that also sells cinema tickets", () => {
    // Only *pure* cinema packages go — one that also streams has a catalogue.
    assert.equal(
      keepPackage(pkg({ monetizationTypes: ["CINEMA", "FLATRATE"] })),
      true,
    );
  });

  test("drops sports/live-only providers", () => {
    assert.equal(keepPackage(pkg({ hasTitles: false })), false);
  });

  test("a missing hasTitles is not treated as false", () => {
    // The check is `=== false` on purpose: absent means unknown, not empty.
    assert.equal(keepPackage(pkg({ hasTitles: undefined })), true);
  });

  test("every rule is documented and callable", () => {
    for (const rule of EXCLUSIONS) {
      assert.ok(rule.id, "rule needs an id");
      assert.ok(rule.why, `${rule.id} needs a why`);
      assert.equal(typeof rule.drop, "function");
    }
  });
});

describe("packageFilters — channel classification", () => {
  test("JustWatch's own addonParent wins", () => {
    const hit = classifyChannel(
      pkg({
        clearName: "HBO Max Amazon Channel",
        addonParent: { shortName: "amp", clearName: "Amazon Prime Video" },
      }),
    );
    assert.equal(hit.ruleId, "addon-parent");
    assert.equal(hit.parentShortName, "amp");
  });

  // The reason this module exists: addonParent is null for all of these.
  for (const [name, parent] of [
    ["Paramount Plus Apple TV channel", "Apple TV"],
    ["Cinemax Apple TV channel", "Apple TV"],
    ["BBC Select Apple Tv channel", "Apple TV"],
    ["The Coda Collection Amazon channel", "Amazon Prime Video"],
    ["Echoboom Amazon Channel ", "Amazon Prime Video"],
    ["Outside TV Features Amzon channel", "Amazon Prime Video"],
    ["AMC+ Roku Premium Channel", "The Roku Channel"],
  ]) {
    test(`classifies "${name.trim()}" as a channel`, () => {
      const hit = classifyChannel(pkg({ clearName: name }));
      assert.ok(hit, "should have matched");
      assert.equal(hit.ruleId, "name-suffix");
      assert.equal(hit.parentName, parent);
    });
  }

  // Real providers whose name merely ends in "Channel". A bare /channel/i rule
  // would swallow every one of them.
  for (const name of [
    "The Roku Channel",
    "RokuChannel Live TV",
    "Criterion Channel",
    "Science Channel",
    "Travel Channel",
    "Plex Channel",
    "Channel 4",
    "Channel 4 Plus",
    "Super Channel Plus",
    "Apple TV",
    "Amazon Prime Video",
  ]) {
    test(`leaves "${name}" as a provider`, () => {
      assert.equal(classifyChannel(pkg({ clearName: name })), null);
    });
  }

  test("every rule is documented and callable", () => {
    for (const rule of CHANNEL_RULES) {
      assert.ok(rule.id, "rule needs an id");
      assert.ok(rule.why, `${rule.id} needs a why`);
      assert.equal(typeof rule.match, "function");
    }
  });
});

describe("packageFilters — annotateChannels", () => {
  test("resolves the parent to the real package so chips don't split", () => {
    // One channel linked by the API, one only by name, same parent service.
    const pkgs = annotateChannels([
      pkg({ shortName: "atp", clearName: "Apple TV", technicalName: "appletvplus" }),
      pkg({ shortName: "amp", clearName: "Amazon Prime Video", technicalName: "amazonprime" }),
      pkg({
        shortName: "aho",
        clearName: "HBO Max Amazon Channel",
        addonParent: { shortName: "amp", clearName: "Amazon Prime Video" },
      }),
      pkg({ shortName: "ccl", clearName: "The Coda Collection Amazon channel" }),
      pkg({ shortName: "ppa", clearName: "Paramount Plus Apple TV channel" }),
    ]);
    const by = Object.fromEntries(pkgs.map((p) => [p.shortName, p]));
    assert.equal(by.aho.addonParentShortName, "amp");
    assert.equal(by.ccl.addonParentShortName, "amp", "must share amp, not a second chip");
    assert.equal(by.ppa.addonParentShortName, "atp");
    assert.equal(by.atp.isAddon, false, "the parent itself is a provider");
    assert.equal(by.amp.isAddon, false);
  });

  test("falls back to the literal name when the parent isn't in this country", () => {
    const [ch] = annotateChannels([
      pkg({ shortName: "ppa", clearName: "Paramount Plus Apple TV channel" }),
    ]);
    assert.equal(ch.isAddon, true);
    assert.equal(ch.addonParentName, "Apple TV");
    assert.equal(ch.addonParentShortName, "appletvplus");
  });

  test("providers get the fields explicitly set, not left undefined", () => {
    const [p] = annotateChannels([pkg({ clearName: "Netflix" })]);
    assert.equal(p.isAddon, false);
    assert.equal(p.addonParentName, null);
    assert.equal(p.addonParentShortName, null);
  });
});
