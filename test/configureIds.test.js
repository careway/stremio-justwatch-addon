"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "../src/http/configure.html"), "utf8");

// configure.html is one big hand-written page whose script looks elements up by
// id. A typo, or moving a block and dropping an id, only shows up as a
// TypeError in a browser — so check the two sides against each other here.
// Commented-out code (there is some) doesn't count as a lookup.
const code = html.replace(/^\s*\/\/.*$/gm, "");
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

// Ids the script creates at runtime rather than the markup declaring them.
const DYNAMIC = new Set([]);

test("every id the script looks up exists in the markup", () => {
  const used = new Set();
  for (const m of code.matchAll(/\$acc\("([^"]+)"\)/g)) used.add(m[1]);
  for (const m of code.matchAll(/getElementById\("([^"]+)"\)/g)) used.add(m[1]);
  const missing = [...used].filter((id) => !ids.has(id) && !DYNAMIC.has(id));
  assert.deepEqual(missing, []);
});

test("every data-acc key has text in both languages", () => {
  const keys = new Set([...html.matchAll(/data-acc="([^"]+)"/g)].map((m) => m[1]));
  const block = html.slice(html.indexOf("const ACC_TEXT = {"), html.indexOf("const acc = (key, vars)"));
  const [es, en] = block.split(/\n      en: \{/);
  for (const key of keys) {
    assert.match(es, new RegExp(`\\n        ${key}:`), `es is missing "${key}"`);
    assert.match(en, new RegExp(`\\n        ${key}:`), `en is missing "${key}"`);
  }
});

test("es and en define the same keys", () => {
  const block = html.slice(html.indexOf("const ACC_TEXT = {"), html.indexOf("const acc = (key, vars)"));
  const [es, en] = block.split(/\n      en: \{/);
  const keysOf = (s) => new Set([...s.matchAll(/\n        (\w+):/g)].map((m) => m[1]));
  const esKeys = keysOf(es);
  const enKeys = keysOf(en);
  assert.deepEqual([...esKeys].filter((k) => !enKeys.has(k)), [], "in es only");
  assert.deepEqual([...enKeys].filter((k) => !esKeys.has(k)), [], "in en only");
});

test("every acc(...) key used by the script exists", () => {
  const block = html.slice(html.indexOf("const ACC_TEXT = {"), html.indexOf("const acc = (key, vars)"));
  const defined = new Set([...block.matchAll(/\n        (\w+):/g)].map((m) => m[1]));
  const used = new Set([...code.matchAll(/(?<![$\w])acc\("(\w+)"/g)].map((m) => m[1]));
  // Keys are also picked by name ("save"/"add"/...) through acc(cond ? "a" : "b").
  for (const m of code.matchAll(/(?<![$\w])acc\([^"()]*\?\s*"(\w+)"\s*:\s*"(\w+)"\)/g)) { used.add(m[1]); used.add(m[2]); }
  assert.deepEqual([...used].filter((k) => !defined.has(k)), []);
});

test("the script parses", () => {
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(m[1]));
  }
});
