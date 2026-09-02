"use strict";

const assert = require("node:assert/strict");
const { test, describe, beforeEach } = require("node:test");
const stats = require("../src/infra/stats");

describe("stats counters", () => {
  beforeEach(() => stats.reset());

  test("bump accumulates and nests dotted keys", () => {
    stats.bump("upstream.ok", 3);
    stats.bump("upstream.ok");
    stats.bump("upstream.fail.403");
    assert.deepEqual(stats.snapshot().counters.upstream, {
      ok: 4,
      fail: { 403: 1 },
    });
  });

  test("recordError counts by level and rings the message", () => {
    stats.recordError("boom");
    stats.recordError("careful", "warn");
    const s = stats.snapshot();
    assert.deepEqual(s.counters.log, { error: 1, warn: 1 });
    assert.equal(s.recentErrors.length, 2);
  });

  test("recent errors are newest-first", () => {
    stats.recordError("primero");
    stats.recordError("segundo");
    assert.match(stats.snapshot().recentErrors[0].message, /segundo/);
  });

  test("the ring evicts oldest and never grows past its cap", () => {
    for (let i = 0; i < stats.MAX_RECENT_ERRORS + 15; i++) {
      stats.recordError("e" + i);
    }
    const s = stats.snapshot();
    assert.equal(s.recentErrors.length, stats.MAX_RECENT_ERRORS);
    // The count keeps rising even though the ring doesn't — that's the point
    // of having both: the tally survives what the ring evicts.
    assert.equal(s.counters.log.error, stats.MAX_RECENT_ERRORS + 15);
    assert.match(s.recentErrors.at(-1).message, /^e15$/);
  });

  test("long messages are truncated so one error can't fill the ring", () => {
    stats.recordError("x".repeat(5000));
    assert.ok(stats.snapshot().recentErrors[0].message.length <= 400);
  });

  test("uptime is reported, so a fresh restart isn't mistaken for health", () => {
    const s = stats.snapshot();
    assert.equal(typeof s.uptimeS, "number");
    assert.ok(s.startedAt);
  });

  test("reset clears counters, ring and uptime", () => {
    stats.bump("a.b");
    stats.recordError("x");
    stats.reset();
    const s = stats.snapshot();
    assert.deepEqual(s.counters, {});
    assert.deepEqual(s.recentErrors, []);
  });
});

describe("log levels", () => {
  // The logger reads NODE_ENV/LOG_LEVEL at require time, so each case runs in
  // its own child process rather than trying to re-require a cached module.
  const { execFileSync } = require("node:child_process");
  const path = require("node:path");
  const root = path.join(__dirname, "..");

  const run = (env) =>
    execFileSync(
      process.execPath,
      [
        "-e",
        `require('./src/http/logger');
         console.log('CHATTER');
         console.warn('AVISO');
         console.error('FALLO');`,
      ],
      { cwd: root, env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

  test("development prints everything", () => {
    const out = run({ NODE_ENV: "development", LOG_LEVEL: "" });
    assert.match(out, /CHATTER/);
    assert.match(out, /AVISO/);
  });

  test("production drops info but keeps warn and error", () => {
    const out = run({ NODE_ENV: "production", LOG_LEVEL: "" });
    assert.doesNotMatch(out, /CHATTER/, "info should be suppressed");
    assert.match(out, /WARN AVISO/);
  });

  test("LOG_LEVEL overrides the production default", () => {
    const out = run({ NODE_ENV: "production", LOG_LEVEL: "debug" });
    assert.match(out, /CHATTER/);
  });

  test("warnings and errors carry a level prefix", () => {
    const out = run({ NODE_ENV: "production", LOG_LEVEL: "" });
    assert.match(out, /WARN /);
  });
});
