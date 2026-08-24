"use strict";

// ─── Config encode / decode ───────────────────────────────────────────────────

/**
 * Encode config as a human-readable URL segment.
 * Format: {COUNTRY}_{language}_{poster-provider-key}_{pkg1}_{pkg2}…
 * e.g. ES_es_poster-rpdb-t8-xxxx_nfx_dnp_prv
 */
function encodeConfig(config) {
  const parts = [config.country, config.language || "en"];
  if (config.posterProvider && config.posterApiKey) {
    parts.push(`poster-${config.posterProvider}-${config.posterApiKey}`);
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

    // Poster provider segment: "poster-{providerId}-{apiKey}", plus the
    // legacy "rpdb-{apiKey}" shape from before the provider adapter existed
    // (see ./posterProviders) — old installed links must keep working.
    let posterProvider = null;
    let posterApiKey = null;
    const posterSegment = parts
      .slice(2)
      .find((p) => p.startsWith("poster-") || p.startsWith("rpdb-"));
    if (posterSegment?.startsWith("rpdb-")) {
      posterProvider = "rpdb";
      posterApiKey = posterSegment.slice(5) || null;
    } else if (posterSegment) {
      const rest = posterSegment.slice("poster-".length);
      const sep = rest.indexOf("-");
      if (sep > 0 && sep < rest.length - 1) {
        posterProvider = rest.slice(0, sep);
        posterApiKey = rest.slice(sep + 1);
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
};
