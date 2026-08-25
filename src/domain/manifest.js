"use strict";

const { version } = require("../../package.json");
const { getGenreNames, GLOBAL_PACKAGE_ID } = require("../data/catalogMeta");

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
 *   sortKey   = 'pop' | 'tnd' | 'new'
 *   shortName = JustWatch package shortName (e.g. nfx, dnp, prv), or the
 *               GLOBAL_PACKAGE_ID pseudo-package for whole-country catalogs
 *               with no provider filter (see ../data/catalogMeta)
 *
 * Up to 6 catalogs are generated per selected provider/pseudo-package (one
 * per selected sort type × 2 types) — which sorts are included is itself
 * configurable, and *independently so* for real providers (config.sorts,
 * shared by all of them) vs the "global" pseudo-package (config.globalSorts)
 * — a user can e.g. want only Trending on Netflix but Popular+New globally.
 *
 * @param {object}  config          - { country, language, packages: string[], sorts?: string[], globalSorts?: string[] }
 * @param {string}  encodedConfig   - base64url-encoded config (for URLs)
 * @param {object}  pkgInfoMap      - technicalName → { clearName, iconUrl, ... }
 * @param {string}  addonBaseUrl    - Full origin e.g. https://my-addon.onrender.com
 */
function buildManifest(config, encodedConfig, pkgInfoMap, addonBaseUrl) {
  const country = config?.country || null;
  const language = config?.language || "en";
  const packages = config?.packages || [];
  const allSortKeys = Object.keys(SORT_LABELS_I18N);
  const sortKeys = config?.sorts?.length > 0 ? config.sorts : allSortKeys;
  const globalSortKeys =
    config?.globalSorts?.length > 0 ? config.globalSorts : allSortKeys;

  const catalogs = [];

  for (const shortName of packages) {
    const isGlobal = shortName === GLOBAL_PACKAGE_ID;
    const info = isGlobal
      ? { clearName: "General" }
      : pkgInfoMap[shortName] || { clearName: shortName };

    for (const sortKey of isGlobal ? globalSortKeys : sortKeys) {
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
    description: `Every streaming platform's catalog in one addon. Discover what's popular, trending, and new on Netflix, Disney+, HBO Max, Prime Video, and many more — organized by country and language, with translated cover art so everything feels native.
    
Pick your platforms and country, and you're set: up-to-date catalogs, filterable by genre, no hassle.${country ? ` Country: ${country}.` : ""}`,
    logo: `${addonBaseUrl}/static/logo.svg`,
    background: `${addonBaseUrl}/static/logo.svg`,
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
