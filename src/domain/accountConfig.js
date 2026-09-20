"use strict";

// Validation and plan-clamping for an account's stored configuration.
//
// Unlike the anonymous `{config}` URL — which decodeConfig() parses
// leniently, silently dropping anything it doesn't understand — this is
// input to a write endpoint, so it is strict: a bad value is a 400 with a
// reason, never quietly fixed up into something the user didn't ask for.
//
// Stored shape:
//   {
//     sources: [{ country, language, packages[], sorts[], globalSorts[],
//                 packageTypes{pkg: movie|series}, globalTypes{sort: movie|series} }],
//     posterProvider, posterApiKey, randomize, hideCountry
//   }
// Each source is exactly what the anonymous flow calls a config, so the whole
// catalog-building path (domain/manifest, domain/catalog) is shared.

const {
  COUNTRIES,
  SORT_MAP,
  MAX_PACKAGES,
  GLOBAL_PACKAGE_ID,
  getSupportedLanguages,
} = require("../data/catalogMeta");
const { listProviders } = require("../infra/posterProviders");
const { buildAccountCatalogs } = require("./manifest");

const ALL_SORT_KEYS = Object.keys(SORT_MAP);
const VALID_COUNTRIES = new Set(COUNTRIES.map((c) => c.code));
const VALID_LANGUAGES = new Set(getSupportedLanguages().map((l) => l.code));
const CONTENT_TYPES = ["movie", "series"];
const PKG_RX = /^[a-z0-9-]{1,30}$/;
// A source is one (country, language) selection; more than this is never
// legitimate whatever the plan, and bounds the size of a stored config.
const MAX_SOURCES = 20;
const MAX_POSTER_KEY_LENGTH = 500;

const fail = (error, code) => ({ ok: false, error, code });

function normalizeSorts(value, label) {
  if (value === undefined || value === null) return { ok: true, sorts: ALL_SORT_KEYS };
  if (!Array.isArray(value) || !value.length) {
    return fail(`${label} must be a non-empty list`, "invalid_sorts");
  }
  const bad = value.find((s) => !ALL_SORT_KEYS.includes(s));
  if (bad !== undefined) return fail(`${label}: unknown sort "${bad}"`, "invalid_sorts");
  return { ok: true, sorts: [...new Set(value)] };
}

function normalizeTypeMap(value, allowedKeys, label) {
  if (value === undefined || value === null) return { ok: true, map: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return fail(`${label} must be an object`, "invalid_types");
  }
  const map = {};
  for (const [key, type] of Object.entries(value)) {
    if (!allowedKeys.includes(key)) continue; // narrows something not selected — meaningless, drop
    if (!CONTENT_TYPES.includes(type)) {
      return fail(`${label}: "${key}" must be movie or series`, "invalid_types");
    }
    map[key] = type;
  }
  return { ok: true, map };
}

function normalizeSource(raw, index) {
  const at = `sources[${index}]`;
  if (!raw || typeof raw !== "object") return fail(`${at} must be an object`, "invalid_source");

  const country = typeof raw.country === "string" ? raw.country.toUpperCase() : "";
  if (!VALID_COUNTRIES.has(country)) return fail(`${at}: unknown country`, "invalid_country");

  const language = typeof raw.language === "string" ? raw.language.toLowerCase() : "en";
  if (!VALID_LANGUAGES.has(language)) return fail(`${at}: unsupported language`, "invalid_language");

  if (!Array.isArray(raw.packages)) return fail(`${at}: packages must be a list`, "invalid_packages");
  const packages = [...new Set(raw.packages)];
  const badPkg = packages.find((p) => typeof p !== "string" || !PKG_RX.test(p));
  if (badPkg !== undefined) return fail(`${at}: invalid provider id`, "invalid_packages");
  const selected = packages.filter((p) => p !== GLOBAL_PACKAGE_ID).length;
  if (selected > MAX_PACKAGES) {
    return fail(`${at}: at most ${MAX_PACKAGES} providers per country`, "too_many_packages");
  }
  if (!packages.length) return fail(`${at}: select at least one provider`, "invalid_packages");

  const sorts = normalizeSorts(raw.sorts, `${at}.sorts`);
  if (!sorts.ok) return sorts;
  const globalSorts = normalizeSorts(raw.globalSorts, `${at}.globalSorts`);
  if (!globalSorts.ok) return globalSorts;

  const packageTypes = normalizeTypeMap(raw.packageTypes, packages, `${at}.packageTypes`);
  if (!packageTypes.ok) return packageTypes;
  const hasGlobal = packages.includes(GLOBAL_PACKAGE_ID);
  const globalTypes = normalizeTypeMap(
    hasGlobal ? raw.globalTypes : undefined,
    globalSorts.sorts,
    `${at}.globalTypes`,
  );
  if (!globalTypes.ok) return globalTypes;

  return {
    ok: true,
    source: {
      country,
      language,
      packages,
      sorts: sorts.sorts,
      globalSorts: globalSorts.sorts,
      packageTypes: packageTypes.map,
      globalTypes: globalTypes.map,
    },
  };
}

function normalizePoster(raw) {
  const provider = raw.posterProvider || null;
  if (!provider) return { ok: true, posterProvider: null, posterApiKey: null };
  const entry = listProviders().find((p) => p.id === provider);
  if (!entry) return fail("Unknown poster provider", "invalid_poster");

  const key = raw.posterApiKey ? String(raw.posterApiKey).trim() : null;
  if (key) {
    if (key.length > MAX_POSTER_KEY_LENGTH || /[\s\u0000-\u001f]/.test(key)) {
      return fail("Invalid poster key", "invalid_poster");
    }
    if (entry.keyIsUrlTemplate && !/^https:\/\//i.test(key)) {
      return fail("This poster provider needs an https:// URL", "invalid_poster");
    }
  } else if (entry.requiresKey) {
    return fail("This poster provider needs an API key", "invalid_poster");
  }
  return { ok: true, posterProvider: provider, posterApiKey: key };
}

/**
 * Validate `raw` and check it against `plan`. Returns { ok: true, config } or
 * { ok: false, error, code } — `code` is stable for the client to switch on,
 * `error` is a human sentence.
 */
function normalizeAccountConfig(raw, plan) {
  if (!raw || typeof raw !== "object") return fail("Config must be an object", "invalid_config");
  if (!Array.isArray(raw.sources) || !raw.sources.length) {
    return fail("Add at least one country", "invalid_config");
  }
  if (raw.sources.length > MAX_SOURCES) return fail("Too many sources", "invalid_config");

  const sources = [];
  for (let i = 0; i < raw.sources.length; i++) {
    const r = normalizeSource(raw.sources[i], i);
    if (!r.ok) return r;
    sources.push(r.source);
  }

  const countries = new Set(sources.map((s) => s.country));
  if (countries.size !== sources.length) {
    return fail("Each country can only appear once", "duplicate_country");
  }
  if (countries.size > plan.maxCountries) {
    return fail(
      `Your plan allows ${plan.maxCountries} countr${plan.maxCountries === 1 ? "y" : "ies"}`,
      "plan_countries",
    );
  }

  const poster = normalizePoster(raw);
  if (!poster.ok) return poster;

  const randomize = !!raw.randomize;
  if (randomize && !plan.features.randomize) {
    return fail("Randomized catalogs are not part of your plan", "plan_feature");
  }

  const config = {
    sources,
    posterProvider: poster.posterProvider,
    posterApiKey: poster.posterApiKey,
    randomize,
    hideCountry: !!raw.hideCountry,
  };

  const catalogs = buildAccountCatalogs(config).length;
  if (catalogs > plan.maxCatalogs) {
    return fail(
      `That is ${catalogs} catalogs; your plan allows ${plan.maxCatalogs}`,
      "plan_catalogs",
    );
  }
  return { ok: true, config, catalogs };
}

/**
 * Bring a stored config within `plan` without failing. A stored config can
 * legitimately exceed its owner's plan after a downgrade or an expiry — the
 * manifest must keep working, just smaller, rather than erroring an install
 * the user already has. Drops trailing countries, then trailing providers.
 */
function clampToPlan(config, plan) {
  const sources = (config.sources || [])
    .slice(0, plan.maxCountries)
    .map((s) => ({ ...s, packages: [...s.packages] }));
  const clamped = {
    ...config,
    sources,
    randomize: !!config.randomize && !!plan.features.randomize,
  };
  while (buildAccountCatalogs(clamped).length > plan.maxCatalogs) {
    const last = [...sources].reverse().find((s) => s.packages.length > 0);
    if (!last) break;
    last.packages.pop();
  }
  clamped.sources = sources.filter((s) => s.packages.length > 0);
  return clamped;
}

/**
 * One country's selection, as the configure page expresses it (the anonymous
 * `{config}` segment), turned into an account source plus the account-wide
 * settings that segment carries. The page already knows how to build that
 * segment from its form, so an account reuses it instead of a second
 * serializer that could drift from the first.
 */
function fromLegacyConfig(decoded) {
  if (!decoded) return null;
  return {
    source: {
      country: decoded.country,
      language: decoded.language,
      packages: decoded.packages,
      sorts: decoded.sorts,
      globalSorts: decoded.globalSorts,
      packageTypes: decoded.packageTypes,
      globalTypes: decoded.globalTypes,
    },
    account: {
      posterProvider: decoded.posterProvider,
      posterApiKey: decoded.posterApiKey,
      randomize: decoded.randomize,
      hideCountry: decoded.hideCountry,
    },
  };
}

module.exports = { normalizeAccountConfig, clampToPlan, fromLegacyConfig, MAX_SOURCES };
