"use strict";
const fs = require("fs");
const path = require("path");
const stats = require("../infra/stats");

const isProduction = process.env.NODE_ENV === "production";

const LOG_FILE = path.join(__dirname, "..", "..", "addon.log");

// File logging only in local dev — a production host's filesystem may be
// read-only or ephemeral, and the write is best-effort either way.
let logStream = null;
if (!isProduction) {
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    logStream.on("error", () => {
      logStream = null;
    });
  } catch {
    /* ignore */
  }
}

function formatArg(a) {
  if (a instanceof Error) return a.stack || String(a);
  if (typeof a === "object" && a !== null) {
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

// ─── Levels ───────────────────────────────────────────────────────────────────
// In production only warnings and errors reach stdout. The informational
// chatter — every request line, every cache hit and miss — is what makes a
// cyclic log buffer roll over before you can read the one line that mattered,
// and it is exactly the traffic the counters in ../infra/stats already
// summarise. Nothing is lost: `info` still goes to the dev log file, and the
// numbers survive in the snapshot.
//
// Override with LOG_LEVEL=debug|info|warn|error to get the chatter back on a
// production host while diagnosing something.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold =
  LEVELS[process.env.LOG_LEVEL] ?? (isProduction ? LEVELS.warn : LEVELS.debug);

function emit(level, prefix, stream, args) {
  const line = `[${new Date().toISOString()}] ${prefix}${args.map(formatArg).join(" ")}\n`;
  // The dev file gets everything regardless of level — it is not the thing
  // that scrolls away, and grepping it is how local debugging works.
  if (logStream) logStream.write(line);
  if (LEVELS[level] < threshold) return;
  stream.write(line);
}

function debug(...args) {
  emit("debug", "", process.stdout, args);
}

function log(...args) {
  emit("info", "", process.stdout, args);
}

function logWarn(...args) {
  stats.recordError(args.map(formatArg).join(" "), "warn");
  emit("warn", "WARN ", process.stdout, args);
}

function logError(...args) {
  // Counted and ringed *before* the level check: an error must land in the
  // snapshot even if something later silences the output.
  stats.recordError(args.map(formatArg).join(" "), "error");
  emit("error", "ERROR ", process.stderr, args);
}

// Redirect console so module-level logs also go to the file and the counters.
const rawConsoleLog = console.log.bind(console);
console.log = (...a) => log(...a);
console.error = (...a) => logError(...a);
console.warn = (...a) => logWarn(...a);

module.exports = {
  log,
  debug,
  logWarn,
  logError,
  LOG_FILE,
  rawConsoleLog,
  LEVELS,
  threshold,
};
