"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(
  path.join(__dirname, "../src/http/configure.html"),
  "utf8",
);

// Pull the two real functions out of the page rather than restating them, so
// this test fails if the page's logic changes underneath it.
function extract(fromAnchor, toAnchor) {
  const start = html.indexOf(fromAnchor);
  const end = html.indexOf(toAnchor);
  assert.ok(start !== -1, `missing anchor: ${fromAnchor}`);
  assert.ok(end > start, `missing anchor: ${toAnchor}`);
  return html.slice(start, end);
}

const SOURCE =
  extract("function applyVisibility(name) {", "function visibleCount(pane)") +
  extract("function buildParentFilter() {", "const ALL_SORT_KEYS");

// Minimum DOM the two functions touch: hidden flags, a checkbox, data-parent.
function makeItem(parent, checked = false) {
  return {
    dataset: { parent },
    hidden: false,
    querySelector: () => ({ checked }),
  };
}

function makeHarness(channels) {
  const items = channels.map((c) => makeItem(c.parent, c.checked));
  const sandbox = {
    activeParent: null,
    INITIAL_ITEMS: 10,
    t: () => "",
    channelParents: {
      innerHTML: "",
      querySelectorAll: () => [],
    },
    PANES: {
      channels: {
        grid: { querySelectorAll: () => items },
        all: channels.map((c) => ({
          addonParentShortName: c.parent,
          addonParentName: c.parent,
        })),
        expanded: true,
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  return {
    sandbox,
    items,
    visible: () => items.filter((i) => !i.hidden).length,
    rebuild: () => vm.runInContext("buildParentFilter()", sandbox),
  };
}

// Real shortNames, measured 2026-09-03: the two countries share only `atp`.
const US = [
  ...Array(6).fill({ parent: "amp" }),
  ...Array(3).fill({ parent: "atp" }),
  { parent: "rkc" },
];
const ES = [
  ...Array(4).fill({ parent: "prv" }),
  ...Array(2).fill({ parent: "atp" }),
];

describe("channels parent filter across country changes", () => {
  test("a filter that still exists in the new country is kept", () => {
    const h = makeHarness(US);
    h.sandbox.activeParent = "atp";
    h.sandbox.PANES.channels.all = ES.map((c) => ({
      addonParentShortName: c.parent,
      addonParentName: c.parent,
    }));
    h.rebuild();
    assert.equal(h.sandbox.activeParent, "atp", "atp exists in ES too");
  });

  test("a filter absent from the new country is dropped", () => {
    const h = makeHarness(US);
    h.sandbox.activeParent = "amp"; // Amazon in US
    h.sandbox.PANES.channels.all = ES.map((c) => ({
      addonParentShortName: c.parent,
      addonParentName: c.parent,
    }));
    h.rebuild();
    assert.equal(h.sandbox.activeParent, null, "amp does not exist in ES");
  });

  test("the tab is not left empty after switching country", () => {
    // The reported bug: filter by Amazon in US, switch to ES, every channel
    // hidden and no chip active until the page was reloaded.
    const h = makeHarness(ES);
    h.sandbox.activeParent = "amp";
    h.rebuild();
    assert.equal(h.visible(), ES.length, "all channels visible again");
  });

  test("a stale filter hides everything if it is not reset", () => {
    // Guards the guard: without the reset this is what the user saw.
    const h = makeHarness(ES);
    h.sandbox.activeParent = "amp";
    vm.runInContext('applyVisibility("channels")', h.sandbox);
    assert.equal(h.visible(), 0, "reproduces the empty tab");
  });

  test("an explicit filter still narrows the list", () => {
    const h = makeHarness(ES);
    h.sandbox.activeParent = "atp";
    vm.runInContext('applyVisibility("channels")', h.sandbox);
    assert.equal(h.visible(), 2);
  });

  test("a country with no channels at all clears the filter", () => {
    const h = makeHarness([]);
    h.sandbox.activeParent = "amp";
    h.rebuild();
    assert.equal(h.sandbox.activeParent, null);
    assert.equal(h.sandbox.channelParents.innerHTML, "");
  });
});
