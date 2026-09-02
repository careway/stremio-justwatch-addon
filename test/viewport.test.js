"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

// The adaptive-viewport snippet is the first <script> in configure.html's head.
// Extracted and run rather than copied, so it can't drift from what ships.
const html = fs.readFileSync(
  path.join(__dirname, "..", "src", "http", "configure.html"),
  "utf8",
);
const snippet = html.match(/<script>([\s\S]*?)<\/script>/)[1];
assert.match(snippet, /MIN_WIDTH/, "first script should be the viewport one");

/** Run the real snippet against a simulated device, return the meta content. */
function viewportFor(shortSide, longSide, landscape = false) {
  const meta = { _c: "", setAttribute: (_k, v) => (meta._c = v) };
  const screen = {
    width: landscape ? longSide : shortSide,
    height: landscape ? shortSide : longSide,
    orientation: { type: landscape ? "landscape-primary" : "portrait-primary" },
  };
  new Function("document", "screen", "window", snippet)(
    { getElementById: () => meta },
    screen,
    { addEventListener() {} },
  );
  return meta._c;
}

describe("adaptive viewport", () => {
  test("mirrors the layout floor", () => {
    // 570px .app-wrapper min-width + 12px padding either side.
    assert.match(snippet, /MIN_WIDTH = 594/);
    assert.match(html, /min-width: 570px/);
  });

  for (const [name, w, h] of [
    ["iPhone SE", 375, 667],
    ["iPhone 15", 393, 852],
    ["Pixel 8", 412, 915],
    ["iPhone 15 Pro Max", 430, 932],
  ]) {
    test(`${name} portrait gets the fixed width, so the browser scales to fit`, () => {
      assert.equal(viewportFor(w, h), "width=594");
    });

    test(`${name} landscape goes back to 1:1`, () => {
      assert.match(viewportFor(w, h, true), /width=device-width/);
    });
  }

  for (const [name, w, h] of [
    ["iPad mini", 744, 1133],
    ["iPad Pro", 1024, 1366],
    ["desktop", 1080, 1920],
  ]) {
    test(`${name} is never scaled`, () => {
      assert.match(viewportFor(w, h), /width=device-width/);
      assert.match(viewportFor(w, h, true), /width=device-width/);
    });
  }

  test("the boundary is exact: 593 scales, 594 does not", () => {
    assert.equal(viewportFor(593, 1200), "width=594");
    assert.match(viewportFor(594, 1200), /width=device-width/);
  });

  test("it re-evaluates on rotation", () => {
    assert.match(snippet, /addEventListener\("orientationchange"/);
  });

  test("it reads screen.width, never innerWidth", () => {
    // innerWidth is a product of the viewport being set here, so reading it
    // would feed back on itself. Comments are stripped first — the snippet
    // explains that reasoning in prose, and prose isn't a usage.
    const code = snippet.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /innerWidth/);
    assert.match(code, /screen\.width/);
  });
});
