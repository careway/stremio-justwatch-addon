"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { L1Cache, L2Cache } = require("./cache");

const { trackCatalogRequest } = require("./analytics");

const {
  decodeConfig,
  encodeConfig,
  fetchCountriesFromJustWatch,
  getSupportedLanguages,
} = require("./config");
const { buildManifest } = require("./manifest");
const { handleCatalog } = require("./catalog");
const { getPackages } = require("./justwatch");
const { listProviders: listPosterProviders } = require("./posterProviders");
const { TTL_S, PACKAGES_TTL_S } = require("./ttl");

// HTTP Cache-Control strings, derived from the same TTL_H base as the
// server-side L1/L2 cache (see ./ttl) — one place controls both.
const CATALOG_CACHE_CONTROL = `s-maxage=${TTL_S}, stale-while-revalidate=${TTL_S}`;
const STATIC_CACHE_CONTROL = `s-maxage=${PACKAGES_TTL_S}, stale-while-revalidate=${PACKAGES_TTL_S * 2}`;

const PORT = Number(process.env.PORT) || 7000;
const isProduction = process.env.NODE_ENV === "production";

const CONFIGURE_HTML_PATH = path.join(__dirname, "configure.html");
// Production caches it once at startup (cheap, and every deploy restarts the
// process anyway). Dev re-reads on every request so editing configure.html
// shows up immediately — no restart needed to see the change.
const CONFIGURE_HTML_CACHED = isProduction
  ? fs.readFileSync(CONFIGURE_HTML_PATH, "utf8")
  : null;

function getConfigureHtml() {
  if (CONFIGURE_HTML_CACHED !== null) return CONFIGURE_HTML_CACHED;
  return fs.readFileSync(CONFIGURE_HTML_PATH, "utf8");
}

// BeamUp's nginx doesn't set an explicit Host header on proxy_pass, so it
// defaults to the internal upstream name with no domain (e.g.
// "5cfe2edf73d5-omnicatalogs" instead of "5cfe2edf73d5-omnicatalogs.baby-beamup.club").
// req.headers.host/x-forwarded-host are therefore unusable for self-referencing
// URLs (manifest logo/background) on that host. ADDON_PUBLIC_URL lets a
// deployment declare its own real public URL explicitly to work around it;
// Vercel doesn't need it since its headers are already correct.
const ADDON_PUBLIC_URL = process.env.ADDON_PUBLIC_URL
  ? process.env.ADDON_PUBLIC_URL.replace(/\/+$/, "")
  : null;

// ─── Logger ───────────────────────────────────────────────────────────────────

const LOG_FILE = path.join(__dirname, "..", "addon.log");

// File logging only in local dev (Vercel's filesystem is read-only)
let logStream = null;
if (!isProduction && !process.env.VERCEL) {
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
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const _consoleWarn = console.warn.bind(console);
console.log = (...a) => log(...a);
console.error = (...a) => logError(...a);
console.warn = (...a) => log("[WARN]", ...a);

// ─── Response helpers ─────────────────────────────────────────────────────────

function respond(
  res,
  data,
  status = 200,
  cacheControl = "max-age=300, stale-while-revalidate=600",
) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Cache-Control": cacheControl,
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
  if (ADDON_PUBLIC_URL) return ADDON_PUBLIC_URL;
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
    return respondHtml(res, getConfigureHtml());
  }

  // ── /favicon.ico ─────────────────────────────────────────────────────────────
  if (rawPath === "/favicon.ico") {
    return redirect(res, "/static/favicon.ico");
  }

  // ── /static/*  (static assets) ───────────────────────────────────────────────
  if (rawPath.startsWith("/static/")) {
    const fileName = rawPath.slice("/static/".length);
    if (!fileName || fileName.includes("..")) {
      res.writeHead(400);
      return res.end();
    }
    const staticDir = path.resolve(__dirname, "..", "static");
    const filePath = path.resolve(staticDir, fileName);
    if (!filePath.startsWith(staticDir + path.sep) && filePath !== staticDir) {
      res.writeHead(400, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31104000",
      });
      return res.end();
    }
    const ext = path.extname(fileName).toLowerCase();
    const mime =
      {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json",
      }[ext] || "application/octet-stream";
    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31104000",
      });
      return res.end(data);
    } catch {
      res.writeHead(404);
      return res.end("Not found");
    }
  }

  // ── /manifest.json  (no-config manifest) ──────────────────────────────────
  if (rawPath === "/manifest.json") {
    res.setHeader("Vercel-Cache-Tag", `manifest`);
    return respond(
      res,
      buildManifest(null, null, {}, getAddonBaseUrl(req)),
      200,
      STATIC_CACHE_CONTROL,
    );
  }

  // ── /api/countries  (fetch supported countries from JustWatch) ─────────────────
  if (rawPath === "/api/countries") {
    try {
      const countries = await fetchCountriesFromJustWatch();

      res.setHeader("Vercel-Cache-Tag", `countries`);
      return respond(
        res,
        countries,
        200,
        STATIC_CACHE_CONTROL,
      );
    } catch (err) {
      console.error("[api/countries] Error:", err);
      // Never cache an error response — a transient failure must not turn
      // into an empty list stuck behind the CDN for anyone else.
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/languages  (get supported languages) ──────────────────────────────────
  if (rawPath === "/api/languages") {
    try {
      const languages = getSupportedLanguages();
      res.setHeader("Vercel-Cache-Tag", `languages`);
      return respond(
        res,
        languages,
        200,
        STATIC_CACHE_CONTROL,
      );
    } catch (err) {
      console.error("[api/languages] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/poster-providers  (poster provider adapters for the configure UI) ──
  if (rawPath === "/api/poster-providers") {
    try {
      const providers = listPosterProviders();
      res.setHeader("Vercel-Cache-Tag", `poster-providers`);
      return respond(res, providers, 200, STATIC_CACHE_CONTROL);
    } catch (err) {
      console.error("[api/poster-providers] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/packages?country=XX ─────────────────────────────────────────────────
  if (rawPath === "/api/packages") {
    const country = (qs.get("country") || "US").toUpperCase();
    if (!/^[A-Z]{2,3}$/.test(country)) {
      return respond(res, { error: "Invalid country code" }, 400);
    }
    try {
      const pkgs = await getPackages(country);
      res.setHeader("Vercel-Cache-Tag", `packages-${country}`);
      return respond(
        res,
        pkgs,
        200,
        STATIC_CACHE_CONTROL,
      );
    } catch (err) {
      console.error("[api/packages] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/inv/$env:{key}?key=xxxxxx ───────────────────────INVALIDATE CACHE ─────────────────────
  const inv_key = process.env.INV_KEY || "";
  if (rawPath == `/api/inv/${inv_key}`) {
    const key = qs.get("key");
    if (key) {
      console.log(`[INV_KEY] Key : ${key}`);
      await L1Cache.invalidate(key);
      await L2Cache.invalidate(key);

      return respond(res, { error: `[INV_KEY] Key : ${key}` }, 202);
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
    let packagesOk = true;
    try {
      const pkgs = await getPackages(config.country);
      pkgInfoMap = Object.fromEntries(pkgs.map((p) => [p.shortName, p]));
    } catch (e) {
      console.error("[manifest] Could not fetch packages:", e);
      packagesOk = false;
    }

    res.setHeader("Vercel-Cache-Tag", `manifest`);
    return respond(
      res,
      buildManifest(config, encodedConfig, pkgInfoMap, getAddonBaseUrl(req)),
      200,
      // Packages fetch failed → manifest has degraded (technical, not clear)
      // names. Don't let that stick around; retry on the next request.
      packagesOk ? CATALOG_CACHE_CONTROL : "no-store",
    );
  }

  // /{config}/catalog/{type}/{id}[/{extra}].json
  const catalogRx = /^catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;
  const cm = rest.match(catalogRx);
  if (cm) {
    const [, type, id, extraRaw] = cm;

    res.setHeader(
      "Vercel-Cache-Tag",
      `catalog-${config.country}-${type}-${id},catalog,catalog-${config.country}`,
    );
    trackCatalogRequest(req);

    let result;
    try {
      result = await handleCatalog(
        { type, id, extra: parseExtra(extraRaw) },
        config,
      );
    } catch (e) {
      // handleCatalog already catches its own errors — this is only a safety
      // net for an unexpected bug, so it never gets cached either.
      console.error("[catalog] Unexpected error:", e);
      result = { ok: false, metas: [] };
    }

    // Catalogs refresh every 4h. A failed/degraded fetch (result.ok === false)
    // is never cached — otherwise the fallback placeholder would replace the
    // real catalog for the full TTL instead of just this one request.
    return respond(
      res,
      { metas: result.metas },
      200,
      result.ok ? CATALOG_CACHE_CONTROL : "no-store",
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
