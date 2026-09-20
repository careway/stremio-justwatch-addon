"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");

const { createRateLimiter } = require("../src/infra/rateLimit");

describe("infra/rateLimit — token bucket", () => {
  const LIMIT = { burst: 3, perMin: 60 }; // 1 token per second

  test("allows a burst up to capacity, then refuses", () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    for (let i = 0; i < 3; i++) assert.equal(rl.take("k", LIMIT).ok, true);
    const r = rl.take("k", LIMIT);
    assert.equal(r.ok, false);
    assert.ok(r.retryAfterS >= 1);
  });

  test("refills over time", () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    for (let i = 0; i < 3; i++) rl.take("k", LIMIT);
    assert.equal(rl.take("k", LIMIT).ok, false);
    t += 1000;
    assert.equal(rl.take("k", LIMIT).ok, true);
    assert.equal(rl.take("k", LIMIT).ok, false);
  });

  test("never refills past the burst size", () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    rl.take("k", LIMIT);
    t += 60 * 60 * 1000;
    for (let i = 0; i < 3; i++) assert.equal(rl.take("k", LIMIT).ok, true);
    assert.equal(rl.take("k", LIMIT).ok, false);
  });

  test("keys are independent", () => {
    const rl = createRateLimiter({ now: () => 0 });
    for (let i = 0; i < 3; i++) rl.take("a", LIMIT);
    assert.equal(rl.take("a", LIMIT).ok, false);
    assert.equal(rl.take("b", LIMIT).ok, true);
  });

  test("retryAfter tells the truth: waiting that long is enough", () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t });
    for (let i = 0; i < 3; i++) rl.take("k", { burst: 3, perMin: 6 }); // 1 per 10s
    const r = rl.take("k", { burst: 3, perMin: 6 });
    assert.equal(r.ok, false);
    t += r.retryAfterS * 1000;
    assert.equal(rl.take("k", { burst: 3, perMin: 6 }).ok, true);
  });

  test("idle buckets are swept once the map is full, not before", () => {
    let t = 0;
    const rl = createRateLimiter({ now: () => t, maxKeys: 3 });
    for (const k of ["a", "b", "c"]) rl.take(k, LIMIT);
    assert.equal(rl.size(), 3);
    t += 60 * 60 * 1000; // all idle long enough to be full again
    rl.take("d", LIMIT); // map at capacity → sweep
    assert.equal(rl.size(), 1);
  });
});
