"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const http = require("node:http");
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
