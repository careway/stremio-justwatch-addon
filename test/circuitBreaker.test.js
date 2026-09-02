"use strict";

const assert = require("node:assert/strict");
const { test, describe } = require("node:test");
const { createCircuitBreaker } = require("../src/infra/circuitBreaker");

// Clock is injected, so none of this needs timers or sleeps.
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}
const build = (clock, over = {}) =>
  createCircuitBreaker({
    threshold: 5,
    cooldownMs: 60_000,
    now: clock.now,
    ...over,
  });

describe("circuit breaker", () => {
  test("starts closed", () => {
    assert.equal(build(makeClock()).isOpen(), false);
  });

  test("stays closed below the threshold", () => {
    const b = build(makeClock());
    for (let i = 0; i < 4; i++) assert.equal(b.recordFailure(), false);
    assert.equal(b.isOpen(), false);
  });

  test("opens exactly on the threshold failure", () => {
    const b = build(makeClock());
    for (let i = 0; i < 4; i++) b.recordFailure();
    assert.equal(b.recordFailure(), true, "5th should be the one that opens it");
    assert.equal(b.isOpen(), true);
  });

  test("a success resets the streak", () => {
    const b = build(makeClock());
    for (let i = 0; i < 4; i++) b.recordFailure();
    b.recordSuccess();
    for (let i = 0; i < 4; i++) b.recordFailure();
    assert.equal(b.isOpen(), false, "streak should have restarted");
  });

  test("closes again once the cooldown elapses", () => {
    const clock = makeClock();
    const b = build(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    assert.equal(b.isOpen(), true);
    clock.advance(59_999);
    assert.equal(b.isOpen(), true, "still open one ms early");
    clock.advance(1);
    assert.equal(b.isOpen(), false);
  });

  test("a failed half-open probe re-arms the full cooldown", () => {
    // Otherwise one request per tick would keep leaking through to an upstream
    // that is still refusing — which is the whole thing we're preventing.
    const clock = makeClock();
    const b = build(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    clock.advance(60_000);
    assert.equal(b.isOpen(), false);
    b.recordFailure();
    assert.equal(b.isOpen(), true);
    assert.equal(b.remainingMs(), 60_000);
  });

  test("a successful half-open probe closes it for good", () => {
    const clock = makeClock();
    const b = build(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    clock.advance(60_000);
    b.recordSuccess();
    for (let i = 0; i < 4; i++) b.recordFailure();
    assert.equal(b.isOpen(), false);
  });

  test("remainingMs counts down and never goes negative", () => {
    const clock = makeClock();
    const b = build(clock);
    for (let i = 0; i < 5; i++) b.recordFailure();
    assert.equal(b.remainingMs(), 60_000);
    clock.advance(20_000);
    assert.equal(b.remainingMs(), 40_000);
    clock.advance(100_000);
    assert.equal(b.remainingMs(), 0);
  });

  test("state() reports what the logs print", () => {
    const clock = makeClock();
    const b = build(clock);
    b.recordFailure();
    assert.deepEqual(b.state(), {
      open: false,
      consecutiveFailures: 1,
      remainingMs: 0,
    });
  });

  test("reset clears everything", () => {
    const b = build(makeClock());
    for (let i = 0; i < 5; i++) b.recordFailure();
    b.reset();
    assert.equal(b.isOpen(), false);
    assert.equal(b.state().consecutiveFailures, 0);
  });

  test("the wired-up breaker uses the configured numbers", () => {
    const { UPSTREAM_FAIL_THRESHOLD, UPSTREAM_COOLDOWN_S } = require("../src/ttl");
    assert.equal(UPSTREAM_FAIL_THRESHOLD, 5);
    assert.equal(UPSTREAM_COOLDOWN_S, 60);
  });
});
