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
    hi: "लोकप्रिय",
    te: "జనాదరణ",
    ml: "ജനപ്രിയം",
    kn: "ಜನಪ್ರಿಯ",
    tr: "Popüler",
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
    hi: "ट्रेंडिंग",
    te: "ట్రెండింగ్",
    ml: "ട്രെൻഡിംഗ്",
    kn: "ಟ್ರೆಂಡಿಂಗ್",
    tr: "Trendler",
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
    hi: "नया",
    te: "కొత్త",
    ml: "പുതിയത്",
    kn: "ಹೊಸದು",
    tr: "Yeni",
  },
};

// The content types a package generates when it isn't restricted to one.
const BOTH_TYPES = ["movie", "series"];

function getSortLabel(key, language) {
  const lang = (language || "en").toLowerCase().split("-")[0];
  const map = SORT_LABELS_I18N[key] || {};
  return map[lang] || map.en;
}

/**
 * Build a Stremio manifest dynamically for a given user config.
 *
 * Catalog ID format: {COUNTRY}_{language}_jw_{sortKey}_{shortName}
 *   COUNTRY   = ISO country code, uppercase (e.g. ES) — omitted only when the
 *               manifest has no config at all (/manifest.json)
 *   language  = BCP47 primary tag (e.g. es)
 *   sortKey   = 'pop' | 'tnd' | 'new'
 *   shortName = JustWatch package shortName (e.g. nfx, dnp, prv), or the
 *               GLOBAL_PACKAGE_ID pseudo-package for whole-country catalogs
 *               with no provider filter (see ../data/catalogMeta)
 *
 * The country/language live in the id (not just the config URL segment) so a
 * single addon install can serve catalogs for several countries — handy in
 * front-ends like AIOStreams that let you pick catalogs across addons.
 * ../domain/catalog.js parses them back out, and falls back to the config
 * segment for the older bare `jw_{sortKey}_{shortName}` ids.
 *
 * Up to 6 catalogs are generated per selected provider/pseudo-package (one
 * per selected sort type × content type) — which sorts are included is itself
 * configurable, and *independently so* for real providers (config.sorts,
 * shared by all of them) vs the "global" pseudo-package (config.globalSorts)
 * — a user can e.g. want only Trending on Netflix but Popular+New globally.
 *
 * Content types narrow in two places. config.packageTypes does it *per
 * package* — an entry of "movie" or "series" halves that package's catalogs.
 * config.globalTypes does it *per sort* for the "global" pseudo-package only,
 * which is the granularity global's UI offers (its Popular/Trending/New chips
 * each cycle independently), and being the finer-grained of the two it wins
 * where both apply. Anything with no entry gets both types, which is what
 * every config from before these selectors existed means.
 *
 * @param {object}  config          - { country, language, packages: string[], sorts?: string[], globalSorts?: string[], packageTypes?: Record<string, "movie"|"series">, globalTypes?: Record<string, "movie"|"series"> }
 * @param {string}  encodedConfig   - base64url-encoded config (for URLs)
 * @param {object}  pkgInfoMap      - technicalName → { clearName, iconUrl, ... }
 * @param {string}  addonBaseUrl    - Full origin e.g. https://my-addon.onrender.com
 */
function buildManifest(config, encodedConfig, pkgInfoMap, addonBaseUrl) {
  const country = config?.country || null;
  return assembleManifest({
    name: country ? `OmniCatalogs · ${country}` : "OmniCatalogs",
    description: describe(country),
    catalogs: buildCatalogs(config, pkgInfoMap),
    addonBaseUrl,
  });
}

/**
 * The catalog list for ONE country/language selection — the part of
 * buildManifest that is about a config rather than about the manifest
 * envelope, split out so an account (several countries in one manifest, see
 * buildAccountManifest) can build one list per source and concatenate them.
 */
function buildCatalogs(config, pkgInfoMap) {
  const country = config?.country || null;
  const language = config?.language || "en";
  const packages = config?.packages || [];
  const allSortKeys = Object.keys(SORT_LABELS_I18N);
  const sortKeys = config?.sorts?.length > 0 ? config.sorts : allSortKeys;
  const globalSortKeys =
    config?.globalSorts?.length > 0 ? config.globalSorts : allSortKeys;
  const packageTypes = config?.packageTypes || {};
  // Opt-in: leave the country code out of every catalog name. Worth knowing
  // that it's what tells two installs of different countries apart in Stremio.
  const countrySuffix = config?.hideCountry || !country ? "" : ` · ${country}`;
  const globalTypes = config?.globalTypes || {};
  // A randomized config serves every catalog shuffled; the "r_" id prefix
  // both tells domain/catalog.js to shuffle and keeps Stremio's per-id cache
  // separate from the un-shuffled version of the same catalog. It stays the
  // outermost segment: r_{COUNTRY}_{language}_jw_...
  const idPrefix = config?.randomize ? "r_" : "";
  // Country/language segment baked into every catalog id (see the doc comment).
  const geoPrefix = country ? `${country}_${language}_` : "";

  const catalogs = [];

  // Global catalogs are listed before any provider's, regardless of the
  // order packages were selected in — Array#sort is stable, so this only
  // moves GLOBAL_PACKAGE_ID to the front without reshuffling the rest.
  const orderedPackages = [...packages].sort((a, b) => {
    if (a === GLOBAL_PACKAGE_ID) return -1;
    if (b === GLOBAL_PACKAGE_ID) return 1;
    return 0;
  });

  for (const shortName of orderedPackages) {
    const isGlobal = shortName === GLOBAL_PACKAGE_ID;
    const clearName = isGlobal
      ? null
      : pkgInfoMap[shortName]?.clearName || shortName;

    for (const sortKey of isGlobal ? globalSortKeys : sortKeys) {
      const sortLabel = getSortLabel(sortKey, language);
      // Anything restricted to one content type declares only that catalog;
      // anything unlisted keeps both. For global the per-sort entry wins over
      // a package-level one, being the more specific of the two. The value is
      // checked against BOTH_TYPES rather than trusted — decodeConfig can only
      // ever produce "movie"/"series", but a bogus one reaching here would
      // otherwise be emitted verbatim as a catalog type Stremio doesn't know.
      const restrictedType =
        (isGlobal ? globalTypes[sortKey] : undefined) ?? packageTypes[shortName];
      const types = BOTH_TYPES.includes(restrictedType)
        ? [restrictedType]
        : BOTH_TYPES;
      for (const type of types) {
        catalogs.push({
          type,
          id: `${idPrefix}${geoPrefix}jw_${sortKey}_${shortName}`,
          // Global catalogs drop the provider-name segment entirely — just
          // the sort type and country, e.g. "Popular · ES" — instead of
          // naming it after the pseudo-package.
          name: isGlobal
            ? `${sortLabel}${countrySuffix}`
            : `${clearName} · ${sortLabel}${countrySuffix}`,
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

  return catalogs;
}

function describe(countryLabel) {
  return `Every streaming platform's catalog in one addon. Discover what's popular, trending, and new on Netflix, Disney+, HBO Max, Prime Video, and many more — organized by country and language, with translated cover art so everything feels native.

Pick your platforms and country, and you're set: up-to-date catalogs, filterable by genre, no hassle.${countryLabel ? ` Country: ${countryLabel}.` : ""}`;
}

function assembleManifest({ name, description, catalogs, addonBaseUrl }) {
  return {
    id: "community.omnicatalogs.stremio.addon",
    version,
    name,
    description,
    logo: `${addonBaseUrl}/static/logo-256.png`,
    background: `${addonBaseUrl}/static/background.png`,
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

/**
 * Per-source configs of an account, each carrying the account-wide flags.
 * With more than one source the country suffix is forced on: two "Netflix ·
 * Popular" catalogs from different countries would otherwise be
 * indistinguishable in Stremio.
 */
function accountSourceConfigs(account) {
  const sources = account?.sources || [];
  return sources.map((source) => ({
    ...source,
    randomize: !!account.randomize,
    hideCountry: sources.length > 1 ? false : !!account.hideCountry,
  }));
}

/**
 * Catalogs of a whole account — every source's list, concatenated.
 * `pkgInfoByCountry` maps country → (shortName → package info); omit it for a
 * network-free list (names fall back to the shortName), which is what
 * counting and "is this catalog id one this account has?" checks want.
 */
function buildAccountCatalogs(account, pkgInfoByCountry = {}) {
  return accountSourceConfigs(account).flatMap((source) =>
    buildCatalogs(source, pkgInfoByCountry[source.country] || {}),
  );
}

/**
 * One manifest for an account: several countries at once. Same envelope as
 * buildManifest; the catalog ids already carry country + language, which is
 * what lets domain/catalog.js serve them from a single install.
 */
function buildAccountManifest(account, pkgInfoByCountry, addonBaseUrl) {
  const sources = account?.sources || [];
  const single = sources.length === 1 ? sources[0].country : null;
  return assembleManifest({
    name: single ? `OmniCatalogs · ${single}` : "OmniCatalogs",
    description: describe(single),
    catalogs: buildAccountCatalogs(account, pkgInfoByCountry),
    addonBaseUrl,
  });
}

module.exports = {
  buildManifest,
  buildCatalogs,
  buildAccountCatalogs,
  buildAccountManifest,
};
