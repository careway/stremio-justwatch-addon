"use strict";

const { getGenreNames, SORT_MAP } = require("./config");

// Human-readable sort labels shown in Stremio's catalog header
const SORT_LABELS = {
  pop: "Popular",
  tnd: "Tendencias",
  new: "Nuevo",
};

/**
 * Build a Stremio manifest dynamically for a given user config.
 *
 * Catalog ID format: jw_{sortKey}_{shortName}
 *   sortKey   = 'pop' | 'new'
 *   shortName = JustWatch package shortName (e.g. nfx, dnp, prv)
 *
 * 4 catalogs are generated per selected provider (2 sorts × 2 types).
 *
 * @param {object}  config          - { country, language, packages: string[] }
 * @param {string}  encodedConfig   - base64url-encoded config (for URLs)
 * @param {object}  pkgInfoMap      - technicalName → { clearName, iconUrl, ... }
 * @param {string}  addonBaseUrl    - Full origin e.g. https://my-addon.onrender.com
 */
function buildManifest(config, encodedConfig, pkgInfoMap, addonBaseUrl) {
  const { country, language, packages } = config;

  const catalogs = [];

  for (const shortName of packages) {
    const info = pkgInfoMap[shortName] || { clearName: shortName };

    for (const [sortKey, sortLabel] of Object.entries(SORT_LABELS)) {
      for (const type of ["movie", "series"]) {
        catalogs.push({
          type,
          id: `jw_${sortKey}_${shortName}`,
          name: `${info.clearName} · ${sortLabel} · ${country}`,
          extra: [
            {
              name: "genre",
              options: getGenreNames(language),
              isRequired: false,
            },
            { name: "search", isRequired: false },
            { name: "skip", isRequired: false },
          ],
        });
      }
    }
  }

  return {
    id: "community.omnicatalog.stremio.addon",
    version: "1.0.0",
    name: `OmniCatalog · ${country}`,
    description: `Every service. Every country. Select the catalogs you want and enjoy searching through them. Country: ${country}.`,
    logo: `${addonBaseUrl}/static/logo.svg`,
    background: "https://images.metahub.space/background/medium/tt0111161/img",
    resources: [
      "catalog",
      { name: "stream", types: ["movie"], idPrefixes: ["tt"] },
      { name: "stream", types: ["series"], idPrefixes: ["tt"] },
    ],
    types: ["movie", "series"],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      adult: false,
    },
  };
}

module.exports = { buildManifest };
