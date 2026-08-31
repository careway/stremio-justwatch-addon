"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { encodeConfig, decodeConfig } = require("../src/domain/userConfig");
const { buildManifest } = require("../src/domain/manifest");

const PKG_INFO = {
  nfx: { clearName: "Netflix" },
  dnp: { clearName: "Disney+" },
  prv: { clearName: "Prime Video" },
};

describe("encodeConfig / decodeConfig — per-package content types", () => {
  test("no restriction emits neither segment (same URL as before)", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["nfx", "dnp"],
    });
    assert.equal(encoded, "ES_es_nfx_dnp");
    assert.deepEqual(decodeConfig(encoded).packageTypes, {});
  });

  test("an empty packageTypes map is the same as none at all", () => {
    assert.equal(
      encodeConfig({
        country: "ES",
        language: "es",
        packages: ["nfx"],
        packageTypes: {},
      }),
      "ES_es_nfx",
    );
  });

  test("mov-/ser- segments round-trip", () => {
    const cfg = {
      country: "ES",
      language: "es",
      packages: ["nfx", "dnp", "prv"],
      packageTypes: { nfx: "movie", prv: "series" },
    };
    const encoded = encodeConfig(cfg);
    assert.equal(encoded, "ES_es_m-nfx_s-prv_nfx_dnp_prv");
    const decoded = decodeConfig(encoded);
    assert.deepEqual(decoded.packages, ["nfx", "dnp", "prv"]);
    assert.deepEqual(decoded.packageTypes, { nfx: "movie", prv: "series" });
  });

  test("several packages share one segment", () => {
    const encoded = encodeConfig({
      country: "US",
      language: "en",
      packages: ["nfx", "dnp", "prv"],
      packageTypes: { nfx: "movie", dnp: "movie", prv: "movie" },
    });
    assert.equal(encoded, "US_en_m-nfx-dnp-prv_nfx_dnp_prv");
    assert.deepEqual(decodeConfig(encoded).packageTypes, {
      nfx: "movie",
      dnp: "movie",
      prv: "movie",
    });
  });

  test("the whole config stays one valid URL path segment", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      posterProvider: "rpdb",
      posterApiKey: "t8-xxxx",
      sorts: ["tnd"],
      globalSorts: ["pop"],
      packages: ["global", "nfx"],
      packageTypes: { nfx: "series" },
    });
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(
      encoded,
      "ES_es_poster-rpdb-t8-xxxx_sorts-tnd_gsorts-pop_s-nfx_global_nfx",
    );
    const decoded = decodeConfig(encoded);
    assert.deepEqual(decoded.packages, ["global", "nfx"]);
    assert.deepEqual(decoded.packageTypes, { nfx: "series" });
    assert.equal(decoded.posterApiKey, "t8-xxxx");
    assert.deepEqual(decoded.sorts, ["tnd"]);
    assert.deepEqual(decoded.globalSorts, ["pop"]);
  });

  test("the segments are not swallowed as package names", () => {
    const decoded = decodeConfig("ES_es_m-nfx_s-dnp_nfx_dnp");
    assert.deepEqual(decoded.packages, ["nfx", "dnp"]);
  });

  test("a package named in both segments falls back to both types", () => {
    const decoded = decodeConfig("ES_es_m-nfx_s-nfx_nfx");
    assert.deepEqual(decoded.packageTypes, {});
  });

  test("a restriction for an unselected package is ignored", () => {
    assert.deepEqual(decodeConfig("ES_es_m-xyz_nfx").packageTypes, {});
  });

  test("the global pseudo-package can be restricted like any other", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["global"],
      packageTypes: { global: "movie" },
    });
    assert.equal(encoded, "ES_es_m-global_global");
    assert.deepEqual(decodeConfig(encoded).packageTypes, { global: "movie" });
  });

  test("pre-feature URLs still decode to both types", () => {
    for (const legacy of [
      "ES_es_nfx_dnp",
      "ES_es_rpdb-legacykey_nfx",
      "US_en_poster-rpdb-t8-xxxx_sorts-tnd-new_gsorts-pop_global_nfx",
    ]) {
      const decoded = decodeConfig(legacy);
      assert.deepEqual(decoded.packageTypes, {}, legacy);
      assert.deepEqual(decoded.globalTypes, {}, legacy);
    }
  });
});

describe("encodeConfig / decodeConfig — global per-sort content types", () => {
  test("gm-/gs- segments round-trip", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["global"],
      globalTypes: { pop: "movie", new: "series" },
    });
    assert.equal(encoded, "ES_es_gm-pop_gs-new_global");
    assert.deepEqual(decodeConfig(encoded).globalTypes, {
      pop: "movie",
      new: "series",
    });
  });

  test("nothing narrowed emits neither segment", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["global"],
      globalTypes: {},
    });
    assert.equal(encoded, "ES_es_global");
    assert.deepEqual(decodeConfig(encoded).globalTypes, {});
  });

  test("gm-/gs- are dropped when global isn't selected", () => {
    const encoded = encodeConfig({
      country: "ES",
      language: "es",
      packages: ["nfx"],
      globalTypes: { pop: "movie" },
    });
    assert.equal(encoded, "ES_es_nfx");
    assert.deepEqual(decodeConfig("ES_es_gm-pop_nfx").globalTypes, {});
  });

  test("a restriction for a sort global isn't showing is ignored", () => {
    // gsorts- limits global to Popular, so the New restriction is meaningless.
    const decoded = decodeConfig("ES_es_gsorts-pop_gs-new_global");
    assert.deepEqual(decoded.globalSorts, ["pop"]);
    assert.deepEqual(decoded.globalTypes, {});
  });

  test("a sort named under both types falls back to both", () => {
    assert.deepEqual(decodeConfig("ES_es_gm-pop_gs-pop_global").globalTypes, {});
  });

  test("a sort repeated inside one segment stays narrowed", () => {
    assert.deepEqual(decodeConfig("ES_es_gm-pop-pop_global").globalTypes, {
      pop: "movie",
    });
  });

  test("gs- is not confused with the gsorts- segment", () => {
    const decoded = decodeConfig("ES_es_gsorts-pop-new_gs-new_global");
    assert.deepEqual(decoded.globalSorts, ["pop", "new"]);
    assert.deepEqual(decoded.globalTypes, { new: "series" });
    assert.deepEqual(decoded.packages, ["global"]);
  });

  test("s- is not confused with the sorts- segment", () => {
    const decoded = decodeConfig("ES_es_sorts-tnd_s-nfx_nfx");
    assert.deepEqual(decoded.sorts, ["tnd"]);
    assert.deepEqual(decoded.packageTypes, { nfx: "series" });
    assert.deepEqual(decoded.packages, ["nfx"]);
  });

  test("package and global types coexist in one URL", () => {
    const cfg = {
      country: "ES",
      language: "es",
      packages: ["global", "nfx"],
      globalSorts: ["pop", "new"],
      packageTypes: { nfx: "movie" },
      globalTypes: { new: "series" },
    };
    const encoded = encodeConfig(cfg);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.equal(encoded, "ES_es_gsorts-pop-new_m-nfx_gs-new_global_nfx");
    const decoded = decodeConfig(encoded);
    assert.deepEqual(decoded.packages, ["global", "nfx"]);
    assert.deepEqual(decoded.packageTypes, { nfx: "movie" });
    assert.deepEqual(decoded.globalTypes, { new: "series" });
  });
});

describe("buildManifest — global per-sort content types", () => {
  const idsOf = (config) =>
    buildManifest(config, "x", PKG_INFO, "http://x").catalogs.map(
      (c) => `${c.type} ${c.id}`,
    );

  test("each global sort declares only its own type", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["global"],
        globalSorts: ["pop", "tnd", "new"],
        globalTypes: { pop: "movie", new: "series" },
      }),
      [
        "movie jw_pop_global",
        "movie jw_tnd_global",
        "series jw_tnd_global",
        "series jw_new_global",
      ],
    );
  });

  test("the per-sort entry beats a package-level one for global", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["global"],
        globalSorts: ["pop", "tnd"],
        packageTypes: { global: "movie" },
        globalTypes: { pop: "series" },
      }),
      // pop follows globalTypes; tnd falls back to the package-level "movie".
      ["series jw_pop_global", "movie jw_tnd_global"],
    );
  });

  test("globalTypes never touches a real provider's catalogs", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["nfx"],
        sorts: ["pop"],
        globalTypes: { pop: "movie" },
      }),
      ["movie jw_pop_nfx", "series jw_pop_nfx"],
    );
  });

  test("an unknown global restriction falls back to both", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["global"],
        globalSorts: ["pop"],
        globalTypes: { pop: "bogus" },
      }),
      ["movie jw_pop_global", "series jw_pop_global"],
    );
  });
});

describe("buildManifest — per-package content types", () => {
  const idsOf = (config) =>
    buildManifest(config, "x", PKG_INFO, "http://x").catalogs.map(
      (c) => `${c.type} ${c.id}`,
    );

  test("an unrestricted package still declares both catalogs", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["nfx"],
        sorts: ["pop"],
      }),
      ["movie jw_pop_nfx", "series jw_pop_nfx"],
    );
  });

  test("a restricted package declares only its own type", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["nfx", "dnp", "prv"],
        sorts: ["pop"],
        packageTypes: { nfx: "movie", prv: "series" },
      }),
      [
        "movie jw_pop_nfx",
        "movie jw_pop_dnp",
        "series jw_pop_dnp",
        "series jw_pop_prv",
      ],
    );
  });

  test("the restriction applies across every selected sort", () => {
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["nfx"],
        sorts: ["pop", "tnd", "new"],
        packageTypes: { nfx: "series" },
      }),
      ["series jw_pop_nfx", "series jw_tnd_nfx", "series jw_new_nfx"],
    );
  });

  test("restricting one package leaves the manifest's own types alone", () => {
    const manifest = buildManifest(
      {
        country: "ES",
        language: "es",
        packages: ["nfx"],
        sorts: ["pop"],
        packageTypes: { nfx: "movie" },
      },
      "x",
      PKG_INFO,
      "http://x",
    );
    assert.deepEqual(manifest.types, ["movie", "series"]);
    assert.deepEqual(manifest.resources, ["catalog"]);
  });

  test("an unknown restriction value is ignored, not trusted blindly", () => {
    // decodeConfig can only ever produce "movie"/"series", but buildManifest is
    // also called with configs assembled elsewhere.
    assert.deepEqual(
      idsOf({
        country: "ES",
        language: "es",
        packages: ["nfx"],
        sorts: ["pop"],
        packageTypes: { nfx: "bogus" },
      }),
      ["movie jw_pop_nfx", "series jw_pop_nfx"],
    );
  });
});

// ─── Client (configure.html) vs server (userConfig.js) agreement ──────────────
//
// configure.html carries its own browser copy of the "mov-"/"ser-" segment
// handling, exactly like it does for the poster-key codec (see
// test/posterKeyCodec.test.js). Nothing forces the two to stay in step, so
// this extracts the real source text out of the page — between
// `const PKG_TYPE_PREFIX` and `function generateUrl` — runs it in a vm, and
// pushes the same vectors through both sides. Renaming either anchor or
// moving that block breaks this on purpose.
describe("configure.html ↔ userConfig.js — type segments agree", () => {
  const html = fs.readFileSync(
    path.join(__dirname, "..", "src", "http", "configure.html"),
    "utf8",
  );
  const start = html.indexOf("const PKG_TYPE_PREFIX");
  const end = html.indexOf("function generateUrl");
  assert.ok(start !== -1, "anchor 'const PKG_TYPE_PREFIX' not found");
  assert.ok(end > start, "anchor 'function generateUrl' not found after it");

  const sandbox = {};
  vm.createContext(sandbox);
  // Top-level `const`s live in the script's lexical scope, not on the vm's
  // global object, so the two prefix tables have to be published explicitly.
  // That doubles as an assertion that the extracted block really declares them.
  vm.runInContext(
    html.slice(start, end) +
      "\nglobalThis.PKG_TYPE_PREFIX = PKG_TYPE_PREFIX;" +
      "\nglobalThis.GLOBAL_TYPE_PREFIX = GLOBAL_TYPE_PREFIX;",
    sandbox,
  );
  const {
    encodeTypeSegments,
    parseTypeSegments,
    PKG_TYPE_PREFIX,
    GLOBAL_TYPE_PREFIX,
  } = sandbox;

  test("the client's prefix tables match the server's URL format", () => {
    assert.deepEqual({ ...PKG_TYPE_PREFIX }, { movie: "m-", series: "s-" });
    assert.deepEqual({ ...GLOBAL_TYPE_PREFIX }, { movie: "gm-", series: "gs-" });
  });

  const VECTORS = [
    { packages: ["nfx", "dnp"], packageTypes: {} },
    { packages: ["nfx"], packageTypes: { nfx: "movie" } },
    { packages: ["nfx"], packageTypes: { nfx: "series" } },
    {
      packages: ["nfx", "dnp", "prv"],
      packageTypes: { nfx: "movie", prv: "series" },
    },
    {
      packages: ["nfx", "dnp", "prv"],
      packageTypes: { nfx: "movie", dnp: "movie", prv: "movie" },
    },
    {
      packages: ["global", "nfx"],
      packageTypes: { global: "series", nfx: "movie" },
    },
  ];

  test("client encodes the same segments the server does", () => {
    for (const v of VECTORS) {
      const cfg = { country: "ES", language: "es", ...v };
      const serverSegments = encodeConfig(cfg)
        .split("_")
        .filter((p) => /^(m|s|gm|gs)-/.test(p));
      const clientSegments = encodeTypeSegments(v.packages, v.packageTypes, PKG_TYPE_PREFIX)
        .split("_")
        .filter(Boolean);
      assert.deepEqual(clientSegments, serverSegments, JSON.stringify(v));
    }
  });

  test("client parses what the server encoded, and vice versa", () => {
    for (const v of VECTORS) {
      const encoded = encodeConfig({ country: "ES", language: "es", ...v });
      const serverTypes = decodeConfig(encoded).packageTypes;
      // Spread the sandbox's object into this realm first: it is structurally
      // plain but has the vm context's Object.prototype, which deepEqual
      // (strict) treats as a mismatch on its own.
      const clientTypes = {
        ...parseTypeSegments(encoded.split("_"), v.packages, PKG_TYPE_PREFIX),
      };
      // The client spells "both types" as "all"; the server spells it by
      // leaving the package out. Normalize before comparing.
      for (const [pkg, type] of Object.entries(clientTypes)) {
        if (type === "all") delete clientTypes[pkg];
      }
      assert.deepEqual(clientTypes, serverTypes, encoded);
    }
  });

  test("both sides agree a package in m- and s- means both types", () => {
    const encoded = "ES_es_m-nfx_s-nfx_nfx";
    assert.deepEqual(decodeConfig(encoded).packageTypes, {});
    assert.equal(parseTypeSegments(encoded.split("_"), ["nfx"], PKG_TYPE_PREFIX).nfx, "all");
  });

  test("both sides ignore a restriction for an unselected package", () => {
    const encoded = "ES_es_m-xyz_nfx";
    assert.deepEqual(decodeConfig(encoded).packageTypes, {});
    assert.deepEqual({ ...parseTypeSegments(encoded.split("_"), ["nfx"], PKG_TYPE_PREFIX) }, {});
  });

  const GLOBAL_VECTORS = [
    { globalSorts: ["pop", "tnd", "new"], globalTypes: {} },
    { globalSorts: ["pop", "tnd", "new"], globalTypes: { pop: "movie" } },
    {
      globalSorts: ["pop", "tnd", "new"],
      globalTypes: { pop: "movie", new: "series" },
    },
    { globalSorts: ["pop", "new"], globalTypes: { new: "series" } },
  ];

  test("client and server agree on the global per-sort segments", () => {
    for (const v of GLOBAL_VECTORS) {
      const encoded = encodeConfig({
        country: "ES",
        language: "es",
        packages: ["global"],
        ...v,
      });
      const serverSegments = encoded
        .split("_")
        .filter((p) => p.startsWith("gm-") || p.startsWith("gs-"));
      const clientSegments = encodeTypeSegments(
        v.globalSorts,
        v.globalTypes,
        GLOBAL_TYPE_PREFIX,
      )
        .split("_")
        .filter(Boolean);
      assert.deepEqual(clientSegments, serverSegments, JSON.stringify(v));

      const clientTypes = {
        ...parseTypeSegments(
          encoded.split("_"),
          v.globalSorts,
          GLOBAL_TYPE_PREFIX,
        ),
      };
      for (const [key, type] of Object.entries(clientTypes)) {
        if (type === "all") delete clientTypes[key];
      }
      assert.deepEqual(clientTypes, decodeConfig(encoded).globalTypes, encoded);
    }
  });

  test("the client keeps gs- and gsorts- apart", () => {
    // "gsorts-pop-new" must not be read as a gs- segment naming "orts-pop-new".
    const parts = "ES_es_gsorts-pop-new_gs-new_global".split("_");
    const types = {
      ...parseTypeSegments(parts, ["pop", "new"], GLOBAL_TYPE_PREFIX),
    };
    assert.deepEqual(types, { new: "series" });
  });

  test("client emits nothing when no package is narrowed", () => {
    assert.equal(
      encodeTypeSegments(["nfx", "dnp"], {}, PKG_TYPE_PREFIX),
      "",
    );
  });
});
