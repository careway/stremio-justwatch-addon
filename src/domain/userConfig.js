"use strict";

// ─── Poster key encoding ──────────────────────────────────────────────────────
// The whole config string is one URL path segment, so it (and every part of
// it, once "_"-split) is restricted to [A-Za-z0-9_-]. Most provider keys are
// short tokens that already fit that charset and stay human-readable in the
// URL. But BetterPosters' "key" (see ../infra/posterProviders) can be an
// entire custom URL pasted from btttr.cc/configure — colons, slashes, dots,
// braces, none of that survives raw. SAFE_KEY_RE keys pass through unchanged
// (keeps existing RPDB/TOP Posters links human-readable); anything else gets
// hex-encoded behind a "url-" marker.
//
// A plain key that itself happens to look like "url-{even-length hex}" would
// be ambiguous — encode leaves it raw (it's charset-safe), but decode would
// then wrongly treat it as hex and corrupt it. looksLikeEncodedKey() is the
// single predicate both directions share, so that class of collision can't
// exist: encode forces such a key through hex-encoding too (instead of
// passing it through), and decode only ever decodes what that same check
// recognizes — there's no way for the two to disagree on what "encoded"
// means.
function looksLikeEncodedKey(value) {
  if (!value.startsWith("url-")) return false;
  const hex = value.slice(4);
  return hex.length > 0 && hex.length % 2 === 0 && /^[0-9a-f]+$/.test(hex);
}

const SAFE_KEY_RE = /^[A-Za-z0-9-]+$/;

function encodePosterKey(raw) {
  return SAFE_KEY_RE.test(raw) && !looksLikeEncodedKey(raw)
    ? raw
    : `url-${Buffer.from(raw, "utf8").toString("hex")}`;
}

function decodePosterKey(encoded) {
  if (looksLikeEncodedKey(encoded)) {
    try {
      return Buffer.from(encoded.slice(4), "hex").toString("utf8");
    } catch {
      // fall through to the literal value below
    }
  }
  return encoded;
}

// ─── Config encode / decode ───────────────────────────────────────────────────

/**
 * Encode config as a human-readable URL segment.
 * Format: {COUNTRY}_{language}_{poster-provider[-key]}_{pkg1}_{pkg2}…
 * e.g. ES_es_poster-rpdb-t8-xxxx_nfx_dnp_prv, or ES_es_poster-btttr_nfx for a
 * keyless provider (see ../infra/posterProviders — not every provider needs
 * an API key, so the "-{key}" suffix is only appended when one is set).
 * The key itself is run through encodePosterKey() — see above.
 */
function encodeConfig(config) {
  const parts = [config.country, config.language || "en"];
  if (config.posterProvider) {
    parts.push(
      config.posterApiKey
        ? `poster-${config.posterProvider}-${encodePosterKey(config.posterApiKey)}`
        : `poster-${config.posterProvider}`,
    );
  }
  parts.push(...config.packages);
  return parts.join("_");
}

/**
 * Decode a plain config string back to a config object.
 * Format: {COUNTRY}_{language}_{poster-provider-key}_{pkg1}_{pkg2}…
 * Returns null if the string is missing required fields.
 */
function decodeConfig(encoded) {
  try {
    const parts = encoded.split("_");
    if (parts.length < 2) return null;

    const country =
      parts[0]
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, 4) || null;
    const language =
      parts[1]
        .toLowerCase()
        .replace(/[^a-z]/g, "")
        .slice(0, 5) || "en";

    // Poster provider segment: "poster-{providerId}-{apiKey}", or just
    // "poster-{providerId}" for a keyless provider (e.g. BetterPosters —
    // see ../infra/posterProviders), plus the legacy "rpdb-{apiKey}" shape
    // from before the provider adapter existed — old installed links must
    // keep working.
    let posterProvider = null;
    let posterApiKey = null;
    const posterSegment = parts
      .slice(2)
      .find((p) => p.startsWith("poster-") || p.startsWith("rpdb-"));
    if (posterSegment?.startsWith("rpdb-")) {
      posterProvider = "rpdb";
      posterApiKey = decodePosterKey(posterSegment.slice(5)) || null;
    } else if (posterSegment) {
      const rest = posterSegment.slice("poster-".length);
      const sep = rest.indexOf("-");
      if (sep === -1) {
        posterProvider = rest || null;
      } else if (sep > 0 && sep < rest.length - 1) {
        posterProvider = rest.slice(0, sep);
        posterApiKey = decodePosterKey(rest.slice(sep + 1));
      }
    }

    const packages = parts
      .slice(2)
      .filter(
        (p) =>
          /^[a-z0-9-]{1,30}$/.test(p) &&
          !p.startsWith("rpdb-") &&
          !p.startsWith("poster-"),
      )
      .slice(0, 200);

    if (!country) return null;

    return { country, language, packages, posterProvider, posterApiKey };
  } catch {
    return null;
  }
}

module.exports = {
  encodeConfig,
  decodeConfig,
  // Exported for the client/server codec-agreement test (test/posterKeyCodec.test.js)
  // — configure.html carries an independent mirror of these two (browser, no
  // Buffer) that must stay byte-for-byte compatible with this one.
  encodePosterKey,
  decodePosterKey,
};
