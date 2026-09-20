"use strict";

const PORT = Number(process.env.PORT) || 7000;

// BeamUp's nginx doesn't set an explicit Host header on proxy_pass, so it
// defaults to the internal upstream name with no domain (e.g.
// "5cfe2edf73d5-omnicatalogs" instead of "5cfe2edf73d5-omnicatalogs.baby-beamup.club").
// req.headers.host/x-forwarded-host are therefore unusable for self-referencing
// URLs (manifest logo/background) on that host. ADDON_PUBLIC_URL lets a
// deployment declare its own real public URL explicitly to work around it.
// Hosts that forward a correct Host / x-forwarded-host don't need it.
const ADDON_PUBLIC_URL = process.env.ADDON_PUBLIC_URL
  ? process.env.ADDON_PUBLIC_URL.replace(/\/+$/, "")
  : null;

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

/**
 * Reads and parses a JSON body, refusing anything larger than `maxBytes`.
 * Resolves to `{ ok: true, value }` or `{ ok: false, status, error }` — a bad
 * body is an expected outcome for an endpoint that takes user input, not an
 * exception. The size cap is enforced while streaming, so an oversized body
 * is cut off rather than buffered.
 */
function readJson(req, maxBytes = 16 * 1024) {
  return new Promise((resolve) => {
    const type = String(req.headers["content-type"] || "").toLowerCase();
    // Requiring a JSON content type is also the CSRF gate: a cross-site form
    // can't send it, and a cross-site fetch that does triggers a preflight.
    if (!type.startsWith("application/json")) {
      return resolve({ ok: false, status: 415, error: "Content-Type must be application/json" });
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    req.on("data", (chunk) => {
      if (done) return; // already refused — discard the rest, don't buffer it
      size += chunk.length;
      if (size > maxBytes) {
        chunks.length = 0;
        finish({ ok: false, status: 413, error: "Body too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        finish({ ok: true, value: text ? JSON.parse(text) : {} });
      } catch {
        finish({ ok: false, status: 400, error: "Invalid JSON" });
      }
    });
    req.on("error", () => finish({ ok: false, status: 400, error: "Request error" }));
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * The client's IP as seen through the proxy chain: first x-forwarded-for hop,
 * else the socket. Same rule as infra/visitors. Spoofable if the proxy
 * appends rather than replaces, so it is used to throttle (a spoofed value
 * only ever hurts the spoofer's own bucket), never to authorize.
 */
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

/** True when the request reached us over HTTPS, directly or via the proxy. */
function isSecureRequest(req) {
  if (ADDON_PUBLIC_URL) return ADDON_PUBLIC_URL.startsWith("https://");
  return (req.headers["x-forwarded-proto"] || "http") === "https";
}

module.exports = {
  PORT,
  parseExtra,
  getAddonBaseUrl,
  getLanguageFromRequest,
  readJson,
  parseCookies,
  getClientIp,
  isSecureRequest,
};
