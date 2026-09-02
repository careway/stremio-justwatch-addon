"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const handler = require("../src/index");

// ─── Test server helpers ──────────────────────────────────────────────────────

function startServer() {
  const server = http.createServer(handler);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

function req(server, urlPath) {
  const { address, port } = server.address();
  return new Promise((resolve, reject) => {
    http
      .get(`http://${address}:${port}${urlPath}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

// ─── Path traversal ──────────────────────────────────────────────────────────

describe("Path traversal protection", () => {
  test("rejects ../ in static path", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/static/../../package.json");
      assert.notEqual(r.status, 200, "Should not serve files outside static/");
    } finally {
      server.close();
    }
  });

  test("rejects URL-encoded ../ in static path", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/static/%2e%2e%2fpackage.json");
      assert.notEqual(r.status, 200);
    } finally {
      server.close();
    }
  });

  test("serves legitimate static file", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/static/logo.svg");
      assert.equal(r.status, 200);
    } finally {
      server.close();
    }
  });
});

// ─── Config length limit ─────────────────────────────────────────────────────

describe("Config segment length limit", () => {
  test("accepts long config with many providers", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/ES_es_nfx/manifest.json");
      assert.equal(r.status, 200);
    } finally {
      server.close();
    }
  });
});

// ─── Country validation ───────────────────────────────────────────────────────

describe("Country query param validation", () => {
  test("rejects invalid country code", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/api/packages?country=<script>");
      assert.equal(r.status, 400);
    } finally {
      server.close();
    }
  });

  test("rejects country with special chars", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/api/packages?country=ES;DROP");
      assert.equal(r.status, 400);
    } finally {
      server.close();
    }
  });

  test("accepts valid 2-letter country code", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/api/packages?country=ES");
      assert.equal(r.status, 200);
    } finally {
      server.close();
    }
  });
});

// ─── Config injection ─────────────────────────────────────────────────────────

describe("Config segment injection", () => {
  test("rejects config with special chars", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/ES_es_<script>/manifest.json");
      assert.equal(r.status, 404);
    } finally {
      server.close();
    }
  });

  test("rejects config with path separators", async () => {
    const server = await startServer();
    try {
      const r = await req(server, "/ES%2Fes%2Fnfx/manifest.json");
      assert.equal(r.status, 404);
    } finally {
      server.close();
    }
  });
});

describe("Package ceiling", () => {
  // Stremio requests page 1 of every catalog when a manifest loads, so the
  // package count times (sorts × types) is the burst this addon fires at
  // JustWatch at once. A 200-package config produced 1200 catalogs and that
  // fan-out got the deploy's IP 403-blocked on 2026-09-02.
  const { MAX_PACKAGES } = require("../src/data/catalogMeta");
  const pkgs = (n) =>
    Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, "0")}`).join("_");

  test("the ceiling is 35", () => {
    assert.equal(MAX_PACKAGES, 35);
  });

  test(`${35} packages is accepted`, async () => {
    const server = await startServer();
    try {
      const r = await req(server, `/ES_es_${pkgs(35)}/manifest.json`);
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).catalogs.length, 35 * 3 * 2);
    } finally {
      server.close();
    }
  });

  test("the global pseudo-package does not count toward it", async () => {
    // Otherwise 35 grid selections plus global would fail a limit the UI says
    // the user is within.
    const server = await startServer();
    try {
      const r = await req(server, `/ES_es_${pkgs(35)}_global/manifest.json`);
      assert.equal(r.status, 200);
    } finally {
      server.close();
    }
  });

  for (const [n, what] of [[36, "one over"], [200, "the old cap"]]) {
    test(`${n} packages is refused (${what})`, async () => {
      const server = await startServer();
      try {
        const r = await req(server, `/ES_es_${pkgs(n)}/manifest.json`);
        assert.equal(r.status, 400);
        const body = JSON.parse(r.body);
        assert.equal(body.selected, n);
        assert.equal(body.max, 35);
        assert.match(body.error, /Reconfigure/);
        assert.ok(body.configure.endsWith("/configure"));
      } finally {
        server.close();
      }
    });
  }

  test("catalog requests are refused too, not just the manifest", async () => {
    const server = await startServer();
    try {
      const r = await req(
        server,
        `/ES_es_${pkgs(36)}/catalog/movie/jw_pop_p00.json`,
      );
      assert.equal(r.status, 400);
    } finally {
      server.close();
    }
  });

  test("but /configure stays reachable, or there's no way out", async () => {
    const server = await startServer();
    try {
      const r = await req(server, `/ES_es_${pkgs(200)}/configure`);
      assert.equal(r.status, 302);
      assert.match(r.headers.location, /^\/configure\?config=/);
    } finally {
      server.close();
    }
  });

  test("the refusal is never cached", async () => {
    const server = await startServer();
    try {
      const r = await req(server, `/ES_es_${pkgs(36)}/manifest.json`);
      assert.match(r.headers["cache-control"] || "", /no-store/);
    } finally {
      server.close();
    }
  });

  test("configure.html mirrors the same number", () => {
    const html = fs.readFileSync(
      path.join(__dirname, "..", "src", "http", "configure.html"),
      "utf8",
    );
    const m = html.match(/const MAX_PACKAGES = (\d+);/);
    assert.ok(m, "configure.html must declare MAX_PACKAGES");
    assert.equal(Number(m[1]), MAX_PACKAGES);
  });
});

describe("Path normalisation", () => {
  // A duplicated slash anywhere used to 404: the config route matches
  // `^/([A-Za-z0-9_-]+)/` and a second slash isn't in that class, so the
  // request fell through. Reported from a real Stremio URL.
  for (const urlPath of [
    "//EG_ar_sha_tod/manifest.json",
    "///EG_ar_sha_tod/manifest.json",
    "/EG_ar_sha_tod//manifest.json",
    "/EG_ar_sha_tod/manifest.json/",
    "/EG_ar_sha_tod/manifest.json//",
  ]) {
    test(`routes despite the slashes: ${urlPath}`, async () => {
      const server = await startServer();
      try {
        const r = await req(server, urlPath);
        assert.equal(r.status, 200, urlPath);
        assert.equal(JSON.parse(r.body).id, "community.omnicatalogs.stremio.addon");
      } finally {
        server.close();
      }
    });
  }

  // Collapsing slashes must not open a way past the static guard.
  for (const urlPath of [
    "/static//../package.json",
    "/static/..//package.json",
    "/static//..//..//package.json",
  ]) {
    test(`traversal still blocked: ${urlPath}`, async () => {
      const server = await startServer();
      try {
        const r = await req(server, urlPath);
        assert.notEqual(r.status, 200, urlPath);
      } finally {
        server.close();
      }
    });
  }

  test("a legitimate static file still serves", async () => {
    const server = await startServer();
    try {
      assert.equal((await req(server, "/static/logo.svg")).status, 200);
      assert.equal((await req(server, "//static//logo.svg")).status, 200);
    } finally {
      server.close();
    }
  });
});

describe("Cache-invalidation route", () => {
  // The route is `/api/inv/${INV_KEY}`. With INV_KEY unset that is
  // `/api/inv/`, and rawPath strips only ONE trailing slash — so `/api/inv//`
  // used to normalise onto it and purge the cache for anyone who asked. An
  // open purge endpoint forces refetches from JustWatch, which is the same
  // upstream pressure that got the addon rate-limited on 2026-09-01.
  const paths = [
    "/api/inv/",
    "/api/inv",
    "/api/inv//?key=packages:v2:ES",
    "/api/inv///?key=packages:v2:ES",
    "/api/inv/?key=packages:v2:ES",
    "/api/inv/undefined?key=packages:v2:ES",
  ];

  for (const urlPath of paths) {
    test(`is closed with INV_KEY unset: ${urlPath}`, async () => {
      const previous = process.env.INV_KEY;
      delete process.env.INV_KEY;
      const server = await startServer();
      try {
        const r = await req(server, urlPath);
        assert.notEqual(r.status, 202, "should not have invalidated");
        assert.ok(!String(r.body).includes("INV_KEY"));
      } finally {
        server.close();
        if (previous !== undefined) process.env.INV_KEY = previous;
      }
    });
  }

  test("works when INV_KEY is set, and only on the exact path", async () => {
    const previous = process.env.INV_KEY;
    process.env.INV_KEY = "s3cr3t";
    const server = await startServer();
    try {
      const ok = await req(server, "/api/inv/s3cr3t?key=packages:v2:ES");
      assert.equal(ok.status, 202);
      const wrong = await req(server, "/api/inv/nope?key=packages:v2:ES");
      assert.notEqual(wrong.status, 202);
    } finally {
      server.close();
      if (previous === undefined) delete process.env.INV_KEY;
      else process.env.INV_KEY = previous;
    }
  });
});
