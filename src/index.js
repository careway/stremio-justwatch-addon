"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const { decodeConfig, encodeConfig } = require("./config");
const { buildManifest } = require("./manifest");
const { handleCatalog } = require("./catalog");
const { handleStream } = require("./stream");
const { getPackages } = require("./justwatch");

const PORT = Number(process.env.PORT) || 7000;
const CONFIGURE_HTML = fs.readFileSync(
  path.join(__dirname, "configure.html"),
  "utf8",
);

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, "..", "addon.log");
const isProduction = process.env.NODE_ENV === "production";

// File logging only in local dev (Vercel's filesystem is read-only)
let logStream = null;
if (!isProduction && !process.env.VERCEL) {
  try {
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    logStream.on("error", () => { logStream = null; });
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
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const _consoleWarn = console.warn.bind(console);
console.log = (...a) => log(...a);
console.error = (...a) => logError(...a);
console.warn = (...a) => log("[WARN]", ...a);

// ─── Response helpers ─────────────────────────────────────────────────────────

function respond(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": "max-age=300, stale-while-revalidate=600",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function respondHtml(res, html) {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": buf.length,
  });
  res.end(buf);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function parseExtra(raw) {
  if (!raw) return {};
  return Object.fromEntries(
    raw
      .split("&")
      .filter((p) => p.includes("="))
      .map((pair) => {
        const eq = pair.indexOf("=");
        return [
          decodeURIComponent(pair.slice(0, eq)),
          decodeURIComponent(pair.slice(eq + 1)),
        ];
      }),
  );
}

function getAddonBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host =
    req.headers["x-forwarded-host"] ||
    req.headers["host"] ||
    `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

/**
 * Primary language for each supported country.
 * Used as fallback when the Accept-Language header is absent or returns 'en'
 * but the configured country speaks a different language.
 */
const COUNTRY_LANGUAGE = {
  // Spanish
  ES: "es",
  MX: "es",
  AR: "es",
  CL: "es",
  CO: "es",
  PE: "es",
  VE: "es",
  UY: "es",
  BO: "es",
  PY: "es",
  EC: "es",
  // Portuguese
  BR: "pt",
  PT: "pt",
  // German
  DE: "de",
  AT: "de",
  CH: "de",
  // French
  FR: "fr",
  BE: "fr",
  LU: "fr",
  // Italian
  IT: "it",
  // Dutch
  NL: "nl",
  // Nordic
  SE: "sv",
  NO: "no",
  DK: "da",
  FI: "fi",
  // Other
  PL: "pl",
  JP: "ja",
  KR: "ko",
};

/**
 * Parse the primary language tag from the Accept-Language header.
 * Falls back to the country's primary language, then 'en'.
 * @param {object} req
 * @param {string} [countryCode] - ISO country code from config, used as fallback
 */
function getLanguageFromRequest(req, countryCode) {
  const header = req.headers["accept-language"] || "";
  const primary = header
    .split(",")[0]
    .trim()
    .split(/[-;]/)[0]
    .trim()
    .toLowerCase();
  if (/^[a-z]{2,3}$/.test(primary) && primary !== "en") return primary;
  // Header absent, malformed, or English — fall back to country
  return COUNTRY_LANGUAGE[countryCode] || primary || "en";
}

// ─── Router ───────────────────────────────────────────────────────────────────

async function router(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  const rawPath = req.url.replace(/\?.*$/, "").replace(/\/$/, "");
  const qs = req.url.includes("?")
    ? new URLSearchParams(req.url.split("?")[1])
    : new URLSearchParams();

  // ── /configure  (config UI) ──────────────────────────────────────────────────
  if (rawPath === "" || rawPath === "/configure") {
    return respondHtml(res, CONFIGURE_HTML);
  }

  // ── /manifest.json  (redirect to configure) ──────────────────────────────────
  if (rawPath === "/manifest.json") {
    return redirect(res, "/configure");
  }

  // ── /api/packages?country=XX ─────────────────────────────────────────────────
  if (rawPath === "/api/packages") {
    const country = (qs.get("country") || "US").toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(country)) {
      return respond(res, { error: "Invalid country code" }, 400);
    }
    try {
      return respond(res, await getPackages(country));
    } catch (err) {
      console.error("[api/packages] Error:", err);
      return respond(res, []);
    }
  }

  // ── /{config}/* ───────────────────────────────────────────────────────────────
  // Config segment is base64url: [A-Za-z0-9_-]+
  const configMatch = rawPath.match(/^\/([A-Za-z0-9_-]+)\/(.*)/);
  if (!configMatch) {
    return respond(res, { error: "Not found" }, 404);
  }

  const [, encodedConfig, rest] = configMatch;
  const config = decodeConfig(encodedConfig);
  if (!config) {
    return respond(res, { error: "Invalid configuration" }, 400);
  }
  // Inject language: explicit config language → Accept-Language header → country default
  if (!config.language) {
    config.language = getLanguageFromRequest(req, config.country);
  }

  // /{config}/configure  (Stremio builds this URL itself from the manifest path)
  if (rest === "configure") {
    return redirect(
      res,
      `/configure?config=${encodeURIComponent(encodedConfig)}`,
    );
  }

  // /{config}/manifest.json
  if (rest === "manifest.json") {
    let pkgInfoMap = {};
    try {
      const pkgs = await getPackages(config.country);
      pkgInfoMap = Object.fromEntries(pkgs.map((p) => [p.shortName, p]));
    } catch (e) {
      console.error("[manifest] Could not fetch packages:", e);
    }
    return respond(
      res,
      buildManifest(config, encodedConfig, pkgInfoMap, getAddonBaseUrl(req)),
    );
  }

  // /{config}/catalog/{type}/{id}[/{extra}].json
  const catalogRx = /^catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;
  const cm = rest.match(catalogRx);
  if (cm) {
    const [, type, id, extraRaw] = cm;
    return respond(
      res,
      await handleCatalog({ type, id, extra: parseExtra(extraRaw) }, config),
    );
  }

  // /{config}/stream/{type}/{id}.json
  const streamRx = /^stream\/([^/]+)\/(.+?)\.json$/;
  const sm = rest.match(streamRx);
  if (sm) {
    const [, type, id] = sm;
    return respond(
      res,
      await handleStream({ type, id: decodeURIComponent(id) }, config),
    );
  }

  return respond(res, { error: "Not found" }, 404);
}

// ─── Handler (exported for Vercel / other serverless runtimes) ──────────────

async function handler(req, res) {
  const start = Date.now();
  try {
    await router(req, res);
    log(
      `${req.method} ${req.url} → ${res.statusCode} (${Date.now() - start}ms)`,
    );
  } catch (err) {
    logError(
      `[server] Unhandled error on ${req.method} ${req.url}:`,
      err.stack || err.message,
    );
    if (!res.headersSent) respond(res, { error: "Internal server error" }, 500);
  }
}

module.exports = handler;

// ─── Local dev server ─────────────────────────────────────────────────────────

if (require.main === module) {
  http.createServer(handler).listen(PORT, () => {
    log(`Addon listening on port ${PORT} — log: ${LOG_FILE}`);
    _consoleLog(`
╔══════════════════════════════════════════╗
║       Stremio JustWatch Addon            ║
╠══════════════════════════════════════════╣
║  Puerto      : ${String(PORT).padEnd(26)}║
╠══════════════════════════════════════════╣
║  Configurar → http://127.0.0.1:${PORT}/configure
║  Log         : addon.log
╚══════════════════════════════════════════╝
`);
  });
}
