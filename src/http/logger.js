"use strict";
const fs = require("fs");
const path = require("path");

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

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(formatArg).join(" ")}\n`;
  process.stdout.write(line);
  if (logStream) logStream.write(line);
}

function logError(...args) {
  const line = `[${new Date().toISOString()}] ERROR ${args.map(formatArg).join(" ")}\n`;
  process.stderr.write(line);
  if (logStream) logStream.write(line);
}

// Redirect console so module-level logs also go to file
const rawConsoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const _consoleWarn = console.warn.bind(console);
console.log = (...a) => log(...a);
console.error = (...a) => logError(...a);
console.warn = (...a) => log("[WARN]", ...a);

module.exports = { log, logError, LOG_FILE, rawConsoleLog };
