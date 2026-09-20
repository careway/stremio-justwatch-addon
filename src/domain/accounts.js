"use strict";

// Account service: passwordless login, stored configuration, and the resolved
// "what may this account do" view the router serves catalogs from. Pure logic
// over the store interface (infra/userStore), so it tests against the
// in-memory store; HTTP concerns (cookies, CSRF, rate limits) live in
// http/accountRoutes.

const crypto = require("crypto");
const { getStore } = require("../infra/userStore");
const { sendMagicLink } = require("../infra/mailer");
const { getPlan } = require("./plans");
const { normalizeAccountConfig, clampToPlan, fromLegacyConfig } = require("./accountConfig");
const { decodeConfig, encodeConfig } = require("./userConfig");
const { buildAccountCatalogs } = require("./manifest");
const { SORT_MAP } = require("../data/catalogMeta");
const { verifyKey, isValidKeyFormat } = require("../infra/tmdbFallback");

const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A resolved account is cached briefly so a catalog request costs no database
// round trip. Everything that changes an account in this process invalidates
// it; a plan set from a script (another process) lands within this window.
const ACCOUNT_CACHE_MS = 60 * 1000;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const randomToken = () => crypto.randomBytes(32).toString("base64url");

const accountCache = new Map(); // uid -> { at, account }

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

// ─── Resolved account (what the manifest/catalog routes serve from) ──────────

async function loadAccount(store, user) {
  const plan = getPlan(user);
  const stored = await store.getConfig(user.id);
  const config = stored
    ? clampToPlan(stored, plan)
    : { sources: [], posterProvider: null, posterApiKey: null, randomize: false, hideCountry: false };

  // The exact set of catalogs this account's manifest declares. A catalog
  // request for anything else is refused: catalog ids carry country and
  // provider, so without this check an account could request other countries
  // by hand and sidestep every limit its manifest is held to.
  const catalogKeys = new Set(buildAccountCatalogs(config).map((c) => `${c.type}|${c.id}`));
  const first = config.sources[0];
  return {
    user,
    plan,
    config,
    catalogKeys,
    // What domain/catalog reads off the config object; ids carry their own
    // country/language, so these are only the fallback.
    handlerConfig: {
      country: first?.country,
      language: first?.language,
      posterProvider: config.posterProvider,
      posterApiKey: config.posterApiKey,
      // null, never undefined: undefined would mean "use the operator's key"
      // to tmdbFallback, which is only for the anonymous flow.
      tmdbApiKey: config.tmdbApiKey || null,
    },
  };
}

/**
 * @returns {Promise<object|null>} the resolved account, or null for an
 *   unknown uid. Throws if the store is configured but down.
 */
async function getAccountByUid(uid) {
  const store = await getStore();
  if (!store) return null;

  const hit = accountCache.get(uid);
  if (hit && Date.now() - hit.at < ACCOUNT_CACHE_MS) return hit.account;

  const user = await store.findByUid(uid);
  if (!user) {
    accountCache.delete(uid);
    return null;
  }
  const account = await loadAccount(store, user);
  accountCache.set(uid, { at: Date.now(), account });
  if (accountCache.size > 5000) accountCache.clear();
  return account;
}

const invalidate = (uid) => accountCache.delete(uid);

// ─── Login ───────────────────────────────────────────────────────────────────

/**
 * Sends a sign-in link. The link points at /configure with the token in the
 * URL *fragment*: a fragment never reaches a server or a proxy log, and the
 * page has to exchange it with a POST — so an email scanner that pre-fetches
 * links (and would burn a one-shot GET token) consumes nothing.
 */
async function requestLogin(rawEmail, baseUrl) {
  const store = await getStore();
  if (!store) return { ok: false, code: "disabled" };
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, code: "invalid_email" };

  const token = randomToken();
  await store.createMagicLink({
    tokenHash: sha256(token),
    email,
    expiresAt: new Date(Date.now() + MAGIC_LINK_TTL_MS),
  });
  await sendMagicLink(email, `${baseUrl}/configure#login=${token}`);
  return { ok: true };
}

async function verifyLogin(token) {
  const store = await getStore();
  if (!store || typeof token !== "string" || token.length > 200) return null;

  const email = await store.consumeMagicLink(sha256(token));
  if (!email) return null;

  let user = await store.findByEmail(email);
  if (!user) {
    try {
      user = await store.createUser({ email });
    } catch (err) {
      // Two first logins racing: the unique index rejects the loser.
      user = await store.findByEmail(email);
      if (!user) throw err;
    }
  }

  const sessionToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await store.createSession({ tokenHash: sha256(sessionToken), userId: user.id, expiresAt });
  return { sessionToken, user, expiresAt };
}

async function userFromSession(sessionToken) {
  const store = await getStore();
  if (!store || typeof sessionToken !== "string" || !sessionToken) return null;
  return store.findSessionUser(sha256(sessionToken));
}

async function logout(sessionToken) {
  const store = await getStore();
  if (store && sessionToken) await store.deleteSession(sha256(sessionToken));
}

// ─── Profile ─────────────────────────────────────────────────────────────────

async function saveConfig(user, raw) {
  const store = await getStore();
  const plan = getPlan(user);
  // A full-config write that says nothing about the TMDb key keeps the one
  // already stored; clearing it is an explicit setTmdbKey(user, null).
  const carried =
    raw && typeof raw === "object" && !("tmdbApiKey" in raw)
      ? { ...raw, tmdbApiKey: (await store.getConfig(user.id))?.tmdbApiKey ?? null }
      : raw;
  const result = normalizeAccountConfig(carried, plan);
  if (!result.ok) return result;
  await store.setConfig(user.id, result.config);
  invalidate(user.uid);
  warmExpectedQueries(result.config);
  return result;
}

/**
 * Save one country from the configure page. `merge` keeps the account's other
 * countries and replaces (or appends) just this one, so several countries can
 * be built up one at a time; without it the account becomes only this one.
 */
async function saveLegacySource(user, legacy, { merge = true } = {}) {
  const parsed = fromLegacyConfig(typeof legacy === "string" ? decodeConfig(legacy) : null);
  if (!parsed) return { ok: false, error: "Invalid configuration", code: "invalid_config" };

  const store = await getStore();
  const stored = await store.getConfig(user.id);
  const existing = merge ? stored : null;
  const sources = [...(existing?.sources || [])];
  const at = sources.findIndex((s) => s.country === parsed.source.country);
  if (at === -1) sources.push(parsed.source);
  else sources[at] = parsed.source;
  // The page's config segment doesn't carry the TMDb key, and starting over
  // with merge:false must not lose it.
  return saveConfig(user, { sources, ...parsed.account, tmdbApiKey: stored?.tmdbApiKey ?? null });
}

/**
 * Set (or clear, with a falsy key) the account's own TMDb key. A malformed or
 * rejected key is reported now; if TMDb simply can't be reached the key is
 * kept — that says nothing about the key, and refusing would make saving
 * depend on a third party being up.
 */
async function setTmdbKey(user, rawKey) {
  const store = await getStore();
  const key = rawKey ? String(rawKey).trim() : null;
  if (key) {
    if (!isValidKeyFormat(key)) {
      return { ok: false, error: "That doesn't look like a TMDb API key", code: "invalid_tmdb_key" };
    }
    const check = await verifyKey(key);
    if (!check.ok && check.reason === "invalid") {
      return { ok: false, error: "TMDb rejected that key", code: "invalid_tmdb_key" };
    }
  }
  const existing = (await store.getConfig(user.id)) || {
    sources: [],
    posterProvider: null,
    posterApiKey: null,
    randomize: false,
    hideCountry: false,
  };
  await store.setConfig(user.id, { ...existing, tmdbApiKey: key });
  invalidate(user.uid);
  return { ok: true };
}

async function removeSource(user, country) {
  const store = await getStore();
  const existing = await store.getConfig(user.id);
  const sources = (existing?.sources || []).filter((s) => s.country !== String(country).toUpperCase());
  if (!existing || sources.length === existing.sources.length) {
    return { ok: false, error: "That country isn't in your account", code: "not_found" };
  }
  if (!sources.length) {
    // An account with no country has no manifest to serve; clearing is
    // simpler and clearer than storing an empty config.
    await store.setConfig(user.id, { ...existing, sources: [] });
    invalidate(user.uid);
    return { ok: true };
  }
  return saveConfig(user, { ...existing, sources });
}

async function rotateUid(user) {
  const store = await getStore();
  const uid = await store.rotateUid(user.id);
  invalidate(user.uid);
  return uid;
}

async function deleteAccount(user) {
  const store = await getStore();
  await store.deleteUser(user.id);
  invalidate(user.uid);
}

async function describeAccount(user, baseUrl) {
  const store = await getStore();
  const plan = getPlan(user);
  const stored = await store.getConfig(user.id);
  // The TMDb key is a secret the owner typed once; the page only needs to
  // know whether one is set, not to be handed it back.
  const config = stored && { ...stored, tmdbApiKey: undefined };
  const tmdbKey = stored?.tmdbApiKey
    ? { set: true, hint: `…${stored.tmdbApiKey.slice(-4)}` }
    : { set: false, hint: null };
  const manifestUrl = `${baseUrl}/api/${user.uid}/manifest.json`;
  return {
    email: user.email,
    plan: plan.id,
    planExpiresAt: user.planExpiresAt || null,
    uid: user.uid,
    manifestUrl,
    installUrl: manifestUrl.replace(/^https?:\/\//, "stremio://"),
    config,
    tmdbKey,
    // What the configure page needs to list, edit and remove each country:
    // `legacy` is the same segment the page produces, so "edit" is just
    // opening /configure?config=<legacy>.
    sources: (config?.sources || []).map((source) => ({
      country: source.country,
      language: source.language,
      providers: source.packages.filter((p) => p !== "global").length,
      global: source.packages.includes("global"),
      legacy: encodeConfig({
        ...source,
        posterProvider: config.posterProvider,
        posterApiKey: config.posterApiKey,
        randomize: config.randomize,
        hideCountry: config.hideCountry,
      }),
    })),
    limits: {
      maxOffset: plan.maxOffset,
      maxCountries: plan.maxCountries,
      maxCatalogs: plan.maxCatalogs,
      features: plan.features,
    },
  };
}

// ─── Load forecasting ────────────────────────────────────────────────────────

// The point of server-side config: we know which queries this account will
// make before it makes them. Register page 0 of every catalog with the cache
// warmer so those rows are refreshed in the background instead of the first
// real request paying for them. Fire-and-forget; a no-op when the warmer is
// off (no DATABASE_URL).
function warmExpectedQueries(config) {
  const TYPE_TO_JW = { movie: "MOVIE", series: "SHOW" };
  (async () => {
    const { buildSearchKey } = require("../infra/justwatch");
    const warmCache = require("../infra/warmCache");
    for (const source of config.sources) {
      const jobs = [];
      for (const pkg of source.packages) {
        const isGlobal = pkg === "global";
        const sorts = isGlobal ? source.globalSorts : source.sorts;
        for (const sort of sorts) {
          const restricted = (isGlobal ? source.globalTypes[sort] : undefined) ?? source.packageTypes[pkg];
          const types = restricted ? [restricted] : ["movie", "series"];
          for (const type of types) {
            jobs.push({ packages: isGlobal ? [] : [pkg], sortBy: SORT_MAP[sort], jwType: TYPE_TO_JW[type] });
          }
        }
      }
      for (const job of jobs) {
        const vars = {
          query: "",
          objectTypes: [job.jwType],
          packages: job.packages,
          genres: [],
          sortBy: job.sortBy,
          country: source.country,
          language: source.language,
          first: 50,
          offset: 0,
        };
        await warmCache.registerRow(buildSearchKey(vars, 50, 0), vars);
      }
    }
  })().catch((err) => console.warn("[accounts] warm registration failed:", err.message));
}

module.exports = {
  normalizeEmail,
  getAccountByUid,
  invalidate,
  requestLogin,
  verifyLogin,
  userFromSession,
  logout,
  saveConfig,
  saveLegacySource,
  setTmdbKey,
  removeSource,
  rotateUid,
  deleteAccount,
  describeAccount,
  MAGIC_LINK_TTL_MS,
  SESSION_TTL_MS,
};
