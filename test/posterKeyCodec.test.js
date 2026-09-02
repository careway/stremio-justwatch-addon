"use strict";

const assert = require("node:assert/strict");
const { test, describe, before } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const {
  encodeConfig,
  decodeConfig,
  encodePosterKey: serverEncode,
  decodePosterKey: serverDecode,
} = require("../src/domain/userConfig");

// ─── Extract the client-side mirror out of configure.html ─────────────────────
//
// configure.html carries its own copy of encodePosterKey/decodePosterKey
// (browser: TextEncoder/TextDecoder, no Buffer) that must stay byte-for-byte
// compatible with src/domain/userConfig.js's server-side version — nothing
// enforces that at the source level, so this test extracts the actual
// <script> source and runs it in a sandbox instead of hand-copying the logic
// into the test (which would just test itself agreeing with itself).
function loadClientPosterKeyCodec() {
  const html = fs.readFileSync(
    path.join(__dirname, "../src/http/configure.html"),
    "utf8",
  );
  const start = html.indexOf("const SAFE_POSTER_KEY_RE");
  const end = html.indexOf("function parsePosterSegment");
  assert.ok(
    start !== -1 && end !== -1 && end > start,
    "Could not locate encodePosterKey/decodePosterKey in configure.html — " +
      "did the surrounding markers (SAFE_POSTER_KEY_RE / parsePosterSegment) move or get renamed?",
  );
  const snippet = html.slice(start, end);

  const sandbox = { TextEncoder, TextDecoder };
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);

  assert.equal(
    typeof sandbox.encodePosterKey,
    "function",
    "encodePosterKey wasn't extracted from configure.html as a function",
  );
  assert.equal(
    typeof sandbox.decodePosterKey,
    "function",
    "decodePosterKey wasn't extracted from configure.html as a function",
  );

  return {
    clientEncode: sandbox.encodePosterKey,
    clientDecode: sandbox.decodePosterKey,
  };
}

// Representative keys: safe plain tokens (RPDB/TOP Posters shape), a full
// BetterPosters custom URL pattern (the reason this codec exists at all),
// unicode, and edge cases (empty string, something that merely looks like
// our own "url-" + hex marker).
const SAMPLE_KEYS = [
  "t8-abc123xyz", // RPDB-style token — must stay untouched (human-readable)
  "TP-XXXXXXXXXXXXXXXX", // TOP Posters-style token
  "https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=es-ES&rs=IM",
  "https://btttr.cc/poster/imdb/poster-default/{imdb_id}.jpg", // no query string
  "clave-con-ñ-y-emoji-🎬", // non-ASCII, exercises UTF-8 byte encoding
  "url-deadbeef", // looks like our own marker but isn't one we produced
];

describe("poster key codec — client (configure.html) vs server (userConfig.js)", () => {
  let clientEncode, clientDecode;

  before(() => {
    ({ clientEncode, clientDecode } = loadClientPosterKeyCodec());
  });

  for (const key of SAMPLE_KEYS) {
    test(`encode agrees byte-for-byte: ${JSON.stringify(key)}`, () => {
      assert.equal(clientEncode(key), serverEncode(key));
    });

    test(`server decode(server encode(x)) === x: ${JSON.stringify(key)}`, () => {
      assert.equal(serverDecode(serverEncode(key)), key);
    });

    test(`client decode(client encode(x)) === x: ${JSON.stringify(key)}`, () => {
      assert.equal(clientDecode(clientEncode(key)), key);
    });

    test(`cross-compatible — server can decode what the client encoded: ${JSON.stringify(key)}`, () => {
      assert.equal(serverDecode(clientEncode(key)), key);
    });

    test(`cross-compatible — client can decode what the server encoded: ${JSON.stringify(key)}`, () => {
      assert.equal(clientDecode(serverEncode(key)), key);
    });
  }

  test("plain safe tokens are left human-readable, not hex-encoded", () => {
    assert.equal(serverEncode("t8-abc123xyz"), "t8-abc123xyz");
    assert.equal(clientEncode("t8-abc123xyz"), "t8-abc123xyz");
  });

  test("a URL pattern is hex-encoded behind the 'url-' marker", () => {
    const pattern = "https://btttr.cc/poster/imdb/poster-default/{imdb_id}.jpg";
    const encoded = serverEncode(pattern);
    assert.ok(encoded.startsWith("url-"));
    assert.match(encoded.slice(4), /^[0-9a-f]+$/);
  });
});

// ─── encodeConfig / decodeConfig round trips through the full URL segment ────

describe("encodeConfig / decodeConfig — poster provider segment", () => {
  test("keyless provider: no trailing -{key}", () => {
    const cfg = {
      country: "ES",
      language: "es",
      posterProvider: "btttr",
      posterApiKey: null,
      packages: ["nfx"],
    };
    const encoded = encodeConfig(cfg);
    assert.equal(encoded, "ES_es_poster-btttr_nfx");
    const decoded = decodeConfig(encoded);
    assert.equal(decoded.posterProvider, "btttr");
    assert.equal(decoded.posterApiKey, null);
    assert.deepEqual(decoded.packages, ["nfx"]);
  });

  test("plain-token provider round-trips human-readable", () => {
    const cfg = {
      country: "US",
      language: "en",
      posterProvider: "rpdb",
      posterApiKey: "t8-xxxx",
      packages: ["nfx", "dnp"],
    };
    const encoded = encodeConfig(cfg);
    assert.equal(encoded, "US_en_poster-rpdb-t8-xxxx_nfx_dnp");
    assert.deepEqual(decodeConfig(encoded), {
      country: "US",
      language: "en",
      packages: ["nfx", "dnp"],
      posterProvider: "rpdb",
      posterApiKey: "t8-xxxx",
      sorts: ["pop", "tnd", "new"],
      globalSorts: ["pop", "tnd", "new"],
      // No m-/s- or gm-/gs- segment: everything generates both content types.
      packageTypes: {},
      globalTypes: {},
      // Bare flags, both off.
      randomize: false,
      hideCountry: false,
      randomize: false,
    });
  });

  test("URL-pattern key round-trips through hex encoding", () => {
    const pattern =
      "https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=es-ES";
    const cfg = {
      country: "ES",
      language: "es",
      posterProvider: "btttr",
      posterApiKey: pattern,
      packages: ["nfx"],
    };
    const encoded = encodeConfig(cfg);
    // The whole config remains a single valid URL path segment.
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    const decoded = decodeConfig(encoded);
    assert.equal(decoded.posterProvider, "btttr");
    assert.equal(decoded.posterApiKey, pattern);
  });

  test("legacy 'rpdb-{key}' links (pre-adapter) still decode", () => {
    const decoded = decodeConfig("ES_es_rpdb-legacykey_nfx");
    assert.equal(decoded.posterProvider, "rpdb");
    assert.equal(decoded.posterApiKey, "legacykey");
    assert.deepEqual(decoded.packages, ["nfx"]);
  });

  test("no poster segment at all", () => {
    const decoded = decodeConfig("US_en_nfx_prv");
    assert.equal(decoded.posterProvider, null);
    assert.equal(decoded.posterApiKey, null);
    assert.deepEqual(decoded.packages, ["nfx", "prv"]);
  });
});
