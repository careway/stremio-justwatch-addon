"use strict";
const fs = require("fs");
const path = require("path");
const { L1Cache, L2Cache } = require("../infra/cache");

const { trackCatalogRequest } = require("../infra/analytics");
const stats = require("../infra/stats");
const { breaker } = require("../infra/justwatch");

const { decodeConfig } = require("../domain/userConfig");
const {
  fetchCountriesFromJustWatch,
  getSupportedLanguages,
  MAX_PACKAGES,
  GLOBAL_PACKAGE_ID,
} = require("../data/catalogMeta");
const { getUiStrings, RTL_UI_LANGUAGES } = require("../data/uiStrings");
const { buildManifest } = require("../domain/manifest");
const { handleCatalog } = require("../domain/catalog");
const { getPackages } = require("../infra/justwatch");
const {
  listProviders: listPosterProviders,
} = require("../infra/posterProviders");
const { TTL_S, PACKAGES_TTL_S } = require("../ttl");
const { respond, respondHtml, redirect } = require("./responses");
const {
  parseExtra,
  getAddonBaseUrl,
  getLanguageFromRequest,
} = require("./request");

const isProduction = process.env.NODE_ENV === "production";

// HTTP Cache-Control strings, derived from the same TTL_H base as the
// server-side L1/L2 cache (see ../ttl) — one place controls both.
const CATALOG_CACHE_CONTROL = `s-maxage=${TTL_S}, stale-while-revalidate=${TTL_S}`;
const STATIC_CACHE_CONTROL = `s-maxage=${PACKAGES_TTL_S}, stale-while-revalidate=${PACKAGES_TTL_S * 2}`;

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

  // Normalised before any route matching. Two things, both of which were
  // silently 404-ing real requests:
  //   - runs of slashes collapse to one, so "//{config}/manifest.json" and
  //     "/{config}//catalog/…" route the same as the single-slash form. The
  //     config route matches `^/([A-Za-z0-9_-]+)/`, and a second slash simply
  //     isn't in that character class, so the whole request fell through to
  //     the 404.
  //   - **all** trailing slashes go, not just one. That single `/$` was also
  //     what left the invalidation route reachable at "/api/inv//" (below).
  // Collapsing does not weaken the /static/ guard: that checks for ".." in the
  // filename *and* resolves the result back against staticDir.
  const rawPath = req.url
    .replace(/\?.*$/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
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
    const staticDir = path.resolve(__dirname, "..", "..", "static");
    const filePath = path.resolve(staticDir, fileName);
    const ext = path.extname(fileName).toLowerCase();
    const mime =
      {
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".webp": "image/webp",
        ".ico": "image/x-icon",
        ".webmanifest": "application/manifest+json",
      }[ext] || "application/octet-stream";
    if (!filePath.startsWith(staticDir + path.sep) && filePath !== staticDir) {
      res.writeHead(400, {
        "Content-Type": mime,
        "Cache-Control": "public, max-age=31104000",
      });
      return res.end();
    }
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
    return respond(
      res,
      buildManifest(null, null, {}, getAddonBaseUrl(req)),
      200,
      STATIC_CACHE_CONTROL,
    );
  }

  // ── /api/countries?lang=xx  (addon-defined country list, no external call) ───
  if (rawPath === "/api/countries") {
    try {
      const countries = await fetchCountriesFromJustWatch(
        qs.get("lang") || "es",
      );

      // No external call here despite the function name (FALLBACK_COUNTRIES
      // is a hardcoded list, see data/catalogMeta.js) — nothing costly to
      // protect by caching this at the edge. Caching it anyway is what
      // caused a real incident: BeamUp sits behind Cloudflare, and an
      // edge-cached response can outlive a deploy by up to 3 days
      // (s-maxage + stale-while-revalidate), so a data change here would
      // silently not show up for anyone hitting the cached edge response —
      // same class of bug already fixed for /configure (see respondHtml).
      return respond(res, countries, 200, "no-store");
    } catch (err) {
      console.error("[api/countries] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/languages  (addon-defined language list, no external call) ────────────
  if (rawPath === "/api/languages") {
    try {
      const languages = getSupportedLanguages();
      // See the /api/countries comment above — same reasoning, same fix.
      return respond(res, languages, 200, "no-store");
    } catch (err) {
      console.error("[api/languages] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/ui-strings?lang=xx  (translations for the /configure page) ─────────
  if (rawPath === "/api/ui-strings") {
    const lang = (qs.get("lang") || "es").toLowerCase();
    if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(lang)) {
      return respond(res, { error: "Invalid language code" }, 400, "no-store");
    }
    const code = lang.split("-")[0];
    // See the /api/countries comment above — same reasoning, same fix.
    return respond(
      res,
      {
        lang: code,
        rtl: RTL_UI_LANGUAGES.includes(code),
        strings: getUiStrings(code),
      },
      200,
      "no-store",
    );
  }

  // ── /api/poster-providers  (poster provider adapters for the configure UI) ──
  if (rawPath === "/api/poster-providers") {
    try {
      const providers = listPosterProviders();
      // See the /api/countries comment above — same reasoning, same fix.
      // (This is literally what surfaced the bug: BetterPosters shipped and
      // stayed invisible on production behind a stale Cloudflare-cached
      // response for this exact route.)
      return respond(res, providers, 200, "no-store");
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
      return respond(res, pkgs, 200, STATIC_CACHE_CONTROL);
    } catch (err) {
      console.error("[api/packages] Error:", err);
      return respond(res, [], 200, "no-store");
    }
  }

  // ── /api/stats/{INV_KEY} ─────────────────────────────────RUNTIME COUNTERS ─────
  // The reason this endpoint exists: the host's log buffer is cyclic, so
  // "what has been failing?" cannot be answered from log lines — they scroll
  // away. Counters and a ring of recent errors do not.
  //
  // Behind the same secret as the invalidation route, and closed when it is
  // unset, for the same reason: the error ring quotes request variables, which
  // reveal which providers users pick.
  if (process.env.INV_KEY && rawPath === `/api/stats/${process.env.INV_KEY}`) {
    return respond(
      res,
      { ...stats.snapshot(), upstreamCircuit: breaker.state() },
      200,
      "no-store",
    );
  }

  // ── /api/inv/$env:{key}?key=xxxxxx ───────────────────────INVALIDATE CACHE ─────────────────────
  // The `inv_key &&` guard is load-bearing, not defensive noise. Without it an
  // unset INV_KEY makes the route `/api/inv/`, and rawPath's
  // `.replace(/\/$/, "")` strips only ONE trailing slash — so `/api/inv//`
  // normalises straight onto it and the endpoint is open to anyone. It was
  // long assumed unreachable ("safe by accident"); it wasn't, verified
  // 2026-09-02. An open purge endpoint is an amplification vector: repeated
  // invalidation forces refetches from JustWatch, which is exactly what got
  // the addon rate-limited before.
  const inv_key = process.env.INV_KEY || "";
  if (inv_key && rawPath === `/api/inv/${inv_key}`) {
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

  // Over the package ceiling → refuse everything except the way out.
  //
  // Deliberately placed **after** the /configure redirect above, so a user in
  // this state can still reach the page that fixes it. Refusing rather than
  // silently truncating is the point: a truncated manifest looks like it
  // worked while quietly dropping providers the user picked.
  // "global" is excluded from the count: it is a pseudo-package, not something
  // picked from the provider grid, so counting it would make 35 grid selections
  // plus global fail a limit the UI says they are within. It still generates
  // catalogs, so the true worst case is 35 × 3 × 2 + 6 = 216.
  const selectedPackages = config.packages.filter(
    (p) => p !== GLOBAL_PACKAGE_ID,
  ).length;
  if (selectedPackages > MAX_PACKAGES) {
    return respond(
      res,
      {
        error:
          `Too many providers selected: ${selectedPackages}. ` +
          `The maximum is ${MAX_PACKAGES}. Reconfigure the addon at ` +
          `${getAddonBaseUrl(req)}/${encodedConfig}/configure and install it again.`,
        selected: selectedPackages,
        max: MAX_PACKAGES,
        configure: `${getAddonBaseUrl(req)}/${encodedConfig}/configure`,
      },
      400,
      "no-store",
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

module.exports = { router };
