"use strict";

// ─── Runtime counters ─────────────────────────────────────────────────────────
// In-process tallies of what the addon has been doing, plus a ring of the most
// recent errors.
//
// The reason this exists: the host's log buffer is **cyclic**. BeamUp's `logs`
// command returns a partial, rolling window — asking for 4000 lines returned
// 337 spread over three non-contiguous minutes, and a burst visible in one dump
// was gone from the next. So log lines cannot be used to answer "what has been
// failing?", because the evidence scrolls away. Counters don't scroll.
//
// Everything here is process-local and resets on restart. That is a real limit
// worth remembering when reading a snapshot: a container that just restarted
// reports a clean slate, not a healthy one — check `uptimeS`.

const MAX_RECENT_ERRORS = 25;

const counters = Object.create(null);
const recentErrors = [];
let startedAt = Date.now();

/** Increment a dotted counter, e.g. bump("upstream.403"). */
function bump(key, n = 1) {
  counters[key] = (counters[key] || 0) + n;
}

/**
 * Record an error for the ring. Kept deliberately small and oldest-first
 * evicted: this is "what went wrong recently", not an audit trail.
 */
function recordError(message, level = "error") {
  bump(`log.${level}`);
  recentErrors.push({ at: new Date().toISOString(), level, message: String(message).slice(0, 400) });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

/** Expand "a.b" keys into nested objects so a snapshot reads well. */
function nest(flat) {
  const out = {};
  for (const [key, value] of Object.entries(flat)) {
    const parts = key.split(".");
    let node = out;
    for (const part of parts.slice(0, -1)) {
      node[part] = node[part] || {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = value;
  }
  return out;
}

function snapshot() {
  return {
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    startedAt: new Date(startedAt).toISOString(),
    counters: nest(counters),
    recentErrors: [...recentErrors].reverse(), // newest first
  };
}

function reset() {
  for (const key of Object.keys(counters)) delete counters[key];
  recentErrors.length = 0;
  startedAt = Date.now();
}

module.exports = { bump, recordError, snapshot, reset, MAX_RECENT_ERRORS };
