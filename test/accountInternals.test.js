"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { redact } = require("../src/http/logger");
const { createMemoryStore } = require("../src/infra/userStore");
const { normalizeEmail } = require("../src/domain/accounts");

describe("log redaction — the uid is a bearer token", () => {
  const UID = "AbCdEfGhIjKlMnOpQrStUv";

  test("keeps four characters of the uid, drops the rest", () => {
    assert.equal(redact(`GET /api/${UID}/manifest.json → 200`), "GET /api/AbCd…/manifest.json → 200");
  });

  test("redacts it wherever it appears in a line, and in a catalog path", () => {
    const out = redact(`a /api/${UID}/catalog/movie/ES_es_jw_pop_nfx.json b /api/${UID}/manifest.json`);
    assert.doesNotMatch(out, /EfGhIjKlMnOpQrStUv/);
    assert.equal(out.match(/AbCd…/g).length, 2);
  });

  test("leaves the other /api routes alone", () => {
    for (const p of ["/api/countries", "/api/packages", "/api/me/config", "/api/auth/request", "/api/stats/abc"]) {
      assert.equal(redact(p), p);
    }
  });

  test("does not eat a longer segment that merely starts like a uid", () => {
    const longer = `/api/${UID}EXTRA/manifest.json`;
    assert.equal(redact(longer), longer);
  });
});

describe("infra/userStore (memory) — magic links", () => {
  const hash = "h".repeat(64);
  const in15 = (t) => new Date(t + 15 * 60 * 1000);

  test("a link works once", async () => {
    const store = createMemoryStore({ now: () => 0 });
    await store.createMagicLink({ tokenHash: hash, email: "a@b.co", expiresAt: in15(0) });
    assert.equal(await store.consumeMagicLink(hash), "a@b.co");
    assert.equal(await store.consumeMagicLink(hash), null);
  });

  test("a link expires", async () => {
    let t = 0;
    const store = createMemoryStore({ now: () => t });
    await store.createMagicLink({ tokenHash: hash, email: "a@b.co", expiresAt: in15(0) });
    t = 15 * 60 * 1000 + 1;
    assert.equal(await store.consumeMagicLink(hash), null);
  });

  test("two racing consumers can't both win", async () => {
    const store = createMemoryStore({ now: () => 0 });
    await store.createMagicLink({ tokenHash: hash, email: "a@b.co", expiresAt: in15(0) });
    const results = await Promise.all([store.consumeMagicLink(hash), store.consumeMagicLink(hash)]);
    assert.equal(results.filter(Boolean).length, 1);
  });

  test("sessions expire too", async () => {
    let t = 0;
    const store = createMemoryStore({ now: () => t });
    const user = await store.createUser({ email: "a@b.co" });
    await store.createSession({ tokenHash: "s", userId: user.id, expiresAt: new Date(1000) });
    assert.equal((await store.findSessionUser("s")).id, user.id);
    t = 1001;
    assert.equal(await store.findSessionUser("s"), null);
  });

  test("uids are 22 url-safe chars and unique", async () => {
    const store = createMemoryStore();
    const a = await store.createUser({ email: "a@b.co" });
    const b = await store.createUser({ email: "c@d.co" });
    assert.match(a.uid, /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(a.uid, b.uid);
  });

  test("deleting a user removes their config and sessions", async () => {
    const store = createMemoryStore();
    const u = await store.createUser({ email: "a@b.co" });
    await store.setConfig(u.id, { sources: [] });
    await store.createSession({ tokenHash: "s", userId: u.id, expiresAt: new Date(Date.now() + 1000) });
    await store.deleteUser(u.id);
    assert.equal(await store.findByUid(u.uid), null);
    assert.equal(await store.getConfig(u.id), null);
    assert.equal(await store.findSessionUser("s"), null);
  });
});

describe("normalizeEmail", () => {
  test("lowercases and trims", () => {
    assert.equal(normalizeEmail("  Foo@Example.COM "), "foo@example.com");
  });

  test("refuses what can't be an address", () => {
    for (const bad of ["", "nope", "a@b", "a b@c.co", "@c.co", "a@@c.co", null, undefined, 42, "a@b.co\nBcc: x@y.z"]) {
      assert.equal(normalizeEmail(bad), null, String(bad));
    }
  });

  test("refuses an absurd length", () => {
    assert.equal(normalizeEmail(`${"a".repeat(300)}@example.com`), null);
  });
});
