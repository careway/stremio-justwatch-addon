"use strict";

const { version } = require("../package.json");
const { getGenreNames } = require("./config");

// Human-readable sort labels shown in Stremio's catalog header, per language
const SORT_LABELS_I18N = {
  pop: {
    en: "Popular",
    es: "Popular",
    de: "Beliebt",
    fr: "Populaire",
    it: "Popolare",
    pt: "Popular",
    nl: "Populair",
    sv: "Populärt",
    no: "Populært",
    da: "Populært",
    fi: "Suosittu",
    pl: "Popularne",
    ja: "人気",
    ko: "인기",
    ar: "الأكثر شهرة",
  },
  tnd: {
    en: "Trending",
    es: "Tendencias",
    de: "Trending",
    fr: "Tendances",
    it: "Tendenze",
    pt: "Tendências",
    nl: "Trending",
    sv: "Trender",
    no: "Trender",
    da: "Trending",
    fi: "Trendit",
    pl: "Na czasie",
    ja: "トレンド",
    ko: "트렌딩",
    ar: "الشائع",
  },
  new: {
    en: "New",
    es: "Nuevo",
    de: "Neu",
    fr: "Nouveau",
    it: "Nuovo",
    pt: "Novo",
    nl: "Nieuw",
    sv: "Nytt",
    no: "Nytt",
    da: "Nyt",
    fi: "Uusi",
    pl: "Nowe",
    ja: "新着",
    ko: "최신",
    ar: "جديد",
  },
};

function getSortLabel(key, language) {
  const lang = (language || "en").toLowerCase().split("-")[0];
  const map = SORT_LABELS_I18N[key] || {};
  return map[lang] || map.en;
}

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

    for (const sortKey of Object.keys(SORT_LABELS_I18N)) {
      const sortLabel = getSortLabel(sortKey, language);
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
