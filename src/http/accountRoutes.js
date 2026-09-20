"use strict";

// HTTP surface of the account system:
//   POST   /api/auth/request        send a sign-in link
//   POST   /api/auth/verify         exchange the link's token for a session cookie
//   POST   /api/auth/logout
//   GET    /api/me                  profile, install URL, plan limits
//   PUT    /api/me/config           save configuration (validated against the plan)
//   DELETE /api/me/sources/{CC}     remove one country
//   PUT    /api/me/tmdb-key         set/clear the account's own TMDb key
//   POST   /api/me/rotate-uid       new install URL; the old one stops working
//   DELETE /api/me                  delete the account
//   GET    /api/{uid}/manifest.json     what Stremio installs
//   GET    /api/{uid}/catalog/…         what Stremio browses
//
// Everything under /api/auth and /api/me is same-origin JSON authenticated by
// a session cookie: no CORS headers, no caching, JSON content-type required
// on writes (the CSRF gate, see readJson), and an Origin check on top.
// /api/{uid}/… is the opposite: cross-origin by design (Stremio), and the uid
// in the path *is* the credential, since Stremio can't send any header.

const { respond, redirect } = require("./responses");
const {
  readJson,
  parseCookies,
  parseExtra,
  getClientIp,
  getAddonBaseUrl,
  isSecureRequest,
} = require("./request");
const accounts = require("../domain/accounts");
const { buildAccountManifest } = require("../domain/manifest");
const { handleCatalog } = require("../domain/catalog");
const { getPackages } = require("../infra/justwatch");
const { getStore } = require("../infra/userStore");
const { createRateLimiter } = require("../infra/rateLimit");
const { trackCatalogRequest } = require("../infra/analytics");
const usage = require("../infra/usage");
const { TTL_S } = require("../ttl");

const SESSION_COOKIE = "oc_session";
// Catalog ids embed everything a catalog's contents depend on, so the
// catalog cache policy is the anonymous one. A manifest, though, changes when
// the owner edits their config — keep it short so an edit shows up promptly.
const CATALOG_CACHE_CONTROL = `s-maxage=${TTL_S}, stale-while-revalidate=${TTL_S}`;
const MANIFEST_CACHE_CONTROL = "s-maxage=60, stale-while-revalidate=60";

const UID_ROUTE = /^\/api\/([A-Za-z0-9_-]{22})\/(.*)$/;
const CATALOG_ROUTE = /^catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/;

const limiter = createRateLimiter();
const LIMITS = {
  loginRequestIp: { burst: 5, perMin: 2 },
  loginRequestEmail: { burst: 3, perMin: 0.2 },
  loginVerifyIp: { burst: 10, perMin: 5 },
  profile: { burst: 30, perMin: 30 },
};

const json = (res, data, status = 200, headers) =>
  respond(res, data, status, "no-store", { cors: false, headers });

function tooMany(res, r) {
  return json(res, { error: "Too many requests", retryAfter: r.retryAfterS }, 429, {
    "Retry-After": String(r.retryAfterS),
  });
}

// A refused body (bad JSON, wrong type, too large). For an oversized one the
// rest of the upload is still coming: answer, then drop the connection rather
// than read the remainder.
function bodyFailure(req, res, body) {
  if (body.status === 413) res.once("finish", () => req.destroy());
  return json(res, { error: body.error }, body.status, body.status === 413 ? { Connection: "close" } : undefined);
}

function cookieHeader(req, value, maxAgeS) {
  const attrs = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (isSecureRequest(req)) attrs.push("Secure");
  return attrs.join("; ");
}

// A browser always sends Origin on a cross-site POST; requiring it to match
// ours (when present) closes the door on a page on another site driving a
// logged-in user's session. Non-browser clients send none and are let through:
// without the cookie they can do nothing anyway.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(getAddonBaseUrl(req)).origin;
  } catch {
    return false;
  }
}

// ─── /api/auth/* and /api/me* ────────────────────────────────────────────────

async function handleUserApi(req, res, path) {
  const store = await getStore(); // null → accounts not configured
  if (!store) return json(res, { error: "Not found" }, 404);

  const method = req.method;
  const write = method !== "GET" && method !== "HEAD";
  if (write && !sameOrigin(req)) return json(res, { error: "Forbidden" }, 403);

  const allow = (methods) => {
    if (methods.includes(method)) return true;
    json(res, { error: "Method not allowed" }, 405, { Allow: methods.join(", ") });
    return false;
  };
  const ip = getClientIp(req);

  if (path === "/api/auth/request") {
    if (!allow(["POST"])) return;
    const body = await readJson(req, 2048);
    if (!body.ok) return bodyFailure(req, res, body);

    const email = accounts.normalizeEmail(body.value?.email);
    if (!email) return json(res, { error: "Invalid email", code: "invalid_email" }, 400);

    const byIp = limiter.take(`login:ip:${ip}`, LIMITS.loginRequestIp);
    if (!byIp.ok) return tooMany(res, byIp);
    const byEmail = limiter.take(`login:email:${email}`, LIMITS.loginRequestEmail);
    if (!byEmail.ok) return tooMany(res, byEmail);

    try {
      await accounts.requestLogin(email, getAddonBaseUrl(req));
    } catch (err) {
      console.error("[accounts] could not send sign-in link:", err.message);
      return json(res, { error: "Could not send the email. Try again later." }, 503);
    }
    // Same answer whether or not the address already has an account.
    return json(res, { ok: true });
  }

  if (path === "/api/auth/verify") {
    if (!allow(["POST"])) return;
    const rl = limiter.take(`verify:ip:${ip}`, LIMITS.loginVerifyIp);
    if (!rl.ok) return tooMany(res, rl);
    const body = await readJson(req, 2048);
    if (!body.ok) return bodyFailure(req, res, body);

    const session = await accounts.verifyLogin(body.value?.token);
    if (!session) return json(res, { error: "This link is invalid or has expired", code: "invalid_token" }, 401);

    const maxAgeS = Math.floor(accounts.SESSION_TTL_MS / 1000);
    return json(
      res,
      { ok: true, me: await accounts.describeAccount(session.user, getAddonBaseUrl(req)) },
      200,
      { "Set-Cookie": cookieHeader(req, session.sessionToken, maxAgeS) },
    );
  }

  const sessionToken = parseCookies(req)[SESSION_COOKIE];

  if (path === "/api/auth/logout") {
    if (!allow(["POST"])) return;
    await accounts.logout(sessionToken);
    return json(res, { ok: true }, 200, { "Set-Cookie": cookieHeader(req, "", 0) });
  }

  // Everything below needs a session.
  const user = await accounts.userFromSession(sessionToken);
  if (!user) return json(res, { error: "Not signed in", code: "unauthenticated" }, 401);
  const rl = limiter.take(`profile:${user.id}`, LIMITS.profile);
  if (!rl.ok) return tooMany(res, rl);

  if (path === "/api/me") {
    if (!allow(["GET", "DELETE"])) return;
    if (method === "DELETE") {
      await accounts.deleteAccount(user);
      return json(res, { ok: true }, 200, { "Set-Cookie": cookieHeader(req, "", 0) });
    }
    return json(res, await accounts.describeAccount(user, getAddonBaseUrl(req)));
  }

  if (path === "/api/me/config") {
    if (!allow(["PUT"])) return;
    const body = await readJson(req, 32 * 1024);
    if (!body.ok) return bodyFailure(req, res, body);
    // Either a full config ({ sources: [...] }) or one country as the
    // configure page builds it ({ legacy: "ES_es_…", merge: true }).
    const result = typeof body.value?.legacy === "string"
      ? await accounts.saveLegacySource(user, body.value.legacy, { merge: body.value.merge !== false })
      : await accounts.saveConfig(user, body.value);
    if (!result.ok) return json(res, { error: result.error, code: result.code }, 400);
    return json(res, await accounts.describeAccount(user, getAddonBaseUrl(req)));
  }

  if (path === "/api/me/tmdb-key") {
    if (!allow(["PUT"])) return;
    const body = await readJson(req, 2048);
    if (!body.ok) return bodyFailure(req, res, body);
    const result = await accounts.setTmdbKey(user, body.value?.key);
    if (!result.ok) return json(res, { error: result.error, code: result.code }, 400);
    return json(res, await accounts.describeAccount(user, getAddonBaseUrl(req)));
  }

  const removeMatch = path.match(/^\/api\/me\/sources\/([A-Za-z]{2})$/);
  if (removeMatch) {
    if (!allow(["DELETE"])) return;
    const result = await accounts.removeSource(user, removeMatch[1]);
    if (!result.ok) return json(res, { error: result.error, code: result.code }, result.code === "not_found" ? 404 : 400);
    return json(res, await accounts.describeAccount(user, getAddonBaseUrl(req)));
  }

  if (path === "/api/me/rotate-uid") {
    if (!allow(["POST"])) return;
    await accounts.rotateUid(user);
    const fresh = await (await getStore()).findById(user.id);
    return json(res, await accounts.describeAccount(fresh, getAddonBaseUrl(req)));
  }

  return json(res, { error: "Not found" }, 404);
}

// ─── /api/{uid}/* ────────────────────────────────────────────────────────────

async function handleUidRoute(req, res, uid, rest) {
  let account;
  try {
    account = await accounts.getAccountByUid(uid);
  } catch (err) {
    // Configured but unreachable. 503, not 404: a 404 says "this install
    // doesn't exist" and a client may act on it; this is "try again".
    console.error("[accounts] lookup failed:", err.message);
    return respond(res, { error: "Service temporarily unavailable" }, 503, "no-store");
  }
  if (!account) return respond(res, { error: "Not found" }, 404, "no-store");

  const rl = limiter.take(`uid:${account.user.id}`, account.plan.rateLimit);
  if (!rl.ok) {
    return respond(res, { error: "Too many requests", retryAfter: rl.retryAfterS }, 429, "no-store", {
      headers: { "Retry-After": String(rl.retryAfterS) },
    });
  }

  // Stremio builds this URL itself from the manifest's `configurable` hint.
  if (rest === "configure") return redirect(res, "/configure");

  if (rest === "manifest.json") {
    const sources = account.config.sources;
    let packagesOk = true;
    const byCountry = {};
    await Promise.all(
      sources.map(async (source) => {
        try {
          const pkgs = await getPackages(source.country);
          byCountry[source.country] = Object.fromEntries(pkgs.map((p) => [p.shortName, p]));
        } catch (err) {
          console.error("[manifest] Could not fetch packages:", err.message);
          packagesOk = false;
        }
      }),
    );
    return respond(
      res,
      buildAccountManifest(account.config, byCountry, getAddonBaseUrl(req)),
      200,
      // A failed package lookup leaves technical (not clear) names in place;
      // don't let that stick around.
      packagesOk ? MANIFEST_CACHE_CONTROL : "no-store",
    );
  }

  const cm = rest.match(CATALOG_ROUTE);
  if (cm) {
    const [, type, id, extraRaw] = cm;
    // Only catalogs this account's manifest declares — see loadAccount.
    if (!account.catalogKeys.has(`${type}|${id}`)) {
      return respond(res, { error: "Not found" }, 404, "no-store");
    }
    trackCatalogRequest(req);
    usage.bump(account.user.id);

    let result;
    try {
      result = await handleCatalog(
        { type, id, extra: parseExtra(extraRaw) },
        account.handlerConfig,
        { maxOffset: account.plan.maxOffset },
      );
    } catch (err) {
      console.error("[catalog] Unexpected error:", err);
      result = { ok: false, metas: [] };
    }
    return respond(res, { metas: result.metas }, 200, result.ok ? CATALOG_CACHE_CONTROL : "no-store");
  }

  return respond(res, { error: "Not found" }, 404, "no-store");
}

/**
 * @returns {Promise<boolean>} true when the request was an account route and
 *   has been answered; false to let the router carry on.
 */
async function handleAccountRoute(req, res, rawPath) {
  try {
    if (rawPath.startsWith("/api/auth/") || rawPath === "/api/me" || rawPath.startsWith("/api/me/")) {
      await handleUserApi(req, res, rawPath);
      return true;
    }
    const m = rawPath.match(UID_ROUTE);
    if (!m) return false;

    const store = await getStore().catch(() => undefined);
    if (store === null) return false; // accounts off → falls through, as before
    if (store) usage.start(store);
    await handleUidRoute(req, res, m[1], m[2]);
    return true;
  } catch (err) {
    console.error("[accounts] unexpected error:", err);
    if (!res.headersSent) respond(res, { error: "Service temporarily unavailable" }, 503, "no-store");
    return true;
  }
}

module.exports = { handleAccountRoute, SESSION_COOKIE };
