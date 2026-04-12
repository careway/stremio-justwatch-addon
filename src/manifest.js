"use strict";

const { version } = require("../package.json");
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
  const country = config?.country || null;
  const language = config?.language || "en";
  const packages = config?.packages || [];

  const catalogs = [];

  for (const shortName of packages) {
    const info = pkgInfoMap[shortName] || { clearName: shortName };

    for (const [sortKey, sortLabel] of Object.entries(SORT_LABELS)) {
      for (const type of ["movie", "series"]) {
        catalogs.push({
          type,
          id: `jw_${sortKey}_${shortName}`,
          name: `${info.clearName} · ${sortLabel}${country ? ` · ${country}` : ""}`,
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
    id: "community.omnicatalogs.stremio.addon",
    version,
    name: country ? `OmniCatalogs · ${country}` : "OmniCatalogs",
    description: `Every service. Every country. Select the catalogs you want and enjoy searching through them.${country ? ` Country: ${country}.` : ""}`,
    logo: `${addonBaseUrl}/static/logo.svg`,
    background: "https://images.metahub.space/background/medium/tt0111161/img",
    resources: ["catalog"],
    types: ["movie", "series"],
    catalogs,
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
      adult: false,
    },
    stremioAddonsConfig: {
      issuer: "https://stremio-addons.net",
      signature:
        "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..mYHVDNfGpE4TWZpkJMjESQ.ZI4xkMsaQSltf44wKy0DwvIue-bGBHz8Yjp_a11AJf9s_qZh71KPmc5aZYA07l25X5D9wh7cJ79DNWdwCTBN13_3pCAATX6zYcZQoqb92eUMmDmZYxoEPsNHAYnJq_Jy.1WiprE3OamyVsYgR_t2FaA",
    },
  };
}

module.exports = { buildManifest };
