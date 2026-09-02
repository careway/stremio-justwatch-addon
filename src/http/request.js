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

module.exports = { PORT, parseExtra, getAddonBaseUrl, getLanguageFromRequest };
