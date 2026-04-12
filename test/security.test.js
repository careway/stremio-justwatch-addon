"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const http = require("node:http");
const path = require("node:path");

const handler = require("../src/index");

// ─── Test server helpers ──────────────────────────────────────────────────────

function startServer() {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function req(server, urlPath) {
  const { address, port } = server.address();
  return new Promise((resolve, reject) => {
    http
      .get(`http://${address}:${port}${urlPath}`, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
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
  test("rejects config longer than 200 chars", async () => {
    const server = await startServer();
    try {
      const longConfig = "a".repeat(201);
      const r = await req(server, `/${longConfig}/manifest.json`);
      assert.equal(r.status, 404);
    } finally {
      server.close();
    }
  });

  test("accepts config within 200 chars", async () => {
    const server = await startServer();
    try {
      // Valid config: ES_es_nfx
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
