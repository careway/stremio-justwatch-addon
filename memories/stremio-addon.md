# omnicatalogs / stremio-justwatch-addon — workspace memory

## Project

Stremio addon powered by the JustWatch GraphQL API. Node.js raw `http` module,
no Express, no Stremio Addon SDK. Package name `omnicatalogs`, repo name
`stremio-justwatch-addon`.

- **Path**: `/workspaces/stremio-justwatch-addon/`
- **Port**: 7000 (`process.env.PORT || 7000`)
- **Entry**: `src/index.js` (exports `handler` for serverless; runs its own
  `http.createServer` only under `require.main === module`)
- **Start**: `npm start` · **Dev**: `npm run dev` (nodemon) · **Test**: `npm test`
- **Tunnel**: `./dev-tunnel.sh` (localtunnel → public HTTPS URL for testing in
  the real Stremio app)
- **Log**: `addon.log`, gitignored, skipped entirely when `NODE_ENV=production`
  or `process.env.VERCEL` is set (read-only FS there)

## Remotes / deploy targets

- `origin` → `git@github.com:careway/stremio-justwatch-addon.git` (GitHub, canonical repo)
- `beamup` → `dokku@a.baby-beamup.club:5cfe2edf73d5/omnicatalogs` (Dokku-style push-to-deploy;
  `beamup.json` is per-machine state, gitignored — untracking it was a deliberate fix so
  `beamup-cli` runs first-time setup on a fresh clone instead of skipping `ssh.addRemote()`)
- Also deployable to Vercel (`vercel.json` rewrites everything to `api/index.js`) and Render
  (`render.yaml`, free plan, spins down after 15 min idle)
- **BeamUp quirk**: its nginx doesn't forward a real Host header, so manifest.json's
  self-referencing logo/background URLs come out unreachable unless `ADDON_PUBLIC_URL` is set
  explicitly (`getAddonBaseUrl()` in `src/index.js` prefers it over request headers). Not needed
  on Vercel.

## Architecture (current)

- `src/index.js` — HTTP server, router, request logger (redirects `console.*`
  to file+stdout), `getAddonBaseUrl()`, `getLanguageFromRequest()` (Accept-Language
  → per-country fallback map `COUNTRY_LANGUAGE` → `en`). Also exposes
  `/api/inv/<INV_KEY>?key=<cache-key>` — manual L1+L2 cache invalidation route,
  key gated by the `INV_KEY` env var.
- `src/justwatch.js` — JustWatch GraphQL client (`GetPopularTitles`,
  `GetPackages`). Two-layer cache via `./cache`. **Concurrency queue**: bounded
  semaphore (`enqueue()`/`runNext()`, `MAX_CONCURRENCY = 100`) limiting how
  many outbound GraphQL calls can be in flight at once. Only bounds within one
  warm instance — no cross-instance lock. Was a hard `Promise`-chain
  serializer (concurrency 1) until 2026-08-24 — see **Concurrency tuning**
  below for why it changed and what was measured.
- `src/cache.js` — L1 (in-process `Map`, survives warm serverless invocations)
  + L2 (**Upstash Redis over REST/HTTPS** via `@upstash/redis` — not ioredis,
  not host/port; works identically on Vercel/BeamUp/Render). Accepts either
  `UPSTASH_REDIS_REST_URL`/`TOKEN` or the Vercel-KV-integration aliases
  `REDIS_KV_REST_API_URL`/`TOKEN`. Falls back silently to L1-only if unset.
- `src/ttl.js` — single source of truth for cache cadence: `TTL_H = 4`
  (catalog/search) → `TTL_S`; `PACKAGES_TTL_H = TTL_H * 6` = 24h (provider
  lists). HTTP `Cache-Control` headers in `index.js` derive from the same
  constants — never hardcode a duration elsewhere.
- `src/catalog.js` — catalog handler: browse + genre filter, 2-batch
  fetch/merge/dedupe for misaligned pagination offsets, poster resolution via
  `posterProviders.js`. Failed/degraded results return `{ ok: false, metas: [...placeholder] }`
  and are never cached (`no-store`) so the next request retries instead of
  sticking with fallback data for the full TTL.
- `src/posterProviders.js` — **new (2026-08-21)**. Adapter registry for
  third-party poster APIs (RPDB, TOP Posters), all sharing the RPDB URL shape
  `{base}/{apiKey}/imdb/poster-default/{imdbId}.jpg`. `resolvePosterUrl()`
  order: configured provider (needs both id + key) → JustWatch's own poster →
  Metahub as the no-key universal fallback.
- `src/config.js` — GENRES (18 × 14 languages), `getGenreNames()`/`getGenreCode()`,
  COUNTRIES, SORT_MAP, `encodeConfig`/`decodeConfig`.
- `src/manifest.js` — dynamic manifest builder; `resources: ["catalog"]` only
  — **no stream resource** (README still references a `stream.js` that no
  longer exists in `src/` — stale doc, addon is catalog-only now).
- `src/configure.html` — config UI: country + language + provider + poster
  provider/API key selection.
- `api/index.js` — Vercel serverless entry (`module.exports = require('../src/index')`).

## Config shape

Human-readable, not base64 (despite an older memory saying otherwise):

```
/{COUNTRY}_{LANGUAGE}_{pkg1}_{pkg2}…/manifest.json
```

Decoded to `{ country, language, packages, posterProvider, posterApiKey }`.
`decodeConfig()` also handles a **legacy poster segment format** for
backwards compatibility with already-installed manifest URLs — don't remove
that branch without checking `src/config.js` around line 746.

## Key facts

- **Package filter key**: `shortName` (e.g. `nfx`, `dnp`, `prv`) — NOT `technicalName`
- **Catalog ID**: `jw_{sortKey}_{shortName}` (e.g. `jw_pop_nfx`)
- **Sort keys**: `pop` → POPULAR, `new` → RELEASE_YEAR-ish (`SORT_MAP`)
- **Synopsis/description**: `GET_POPULAR_TITLES_QUERY` requests `shortDescription`
  (added `0a1a2c0`, 2026-04-11); `nodeToMeta()` maps it to `meta.description`.
  Metas returned to Stremio have always included it since then — not a new
  addition, just previously undocumented here.
- **JustWatch API**: `https://apis.justwatch.com/graphql`
- **Language**: parsed per-request from `Accept-Language`, injected into
  `config.language` if not already encoded in the URL

## Concurrency tuning (2026-08-24)

The original concurrency queue (`11e3818`) serialized *every* outbound
JustWatch GraphQL call to concurrency 1, on the assumption JustWatch 429s
under any parallelism. That made cold-cache loads slow: Stremio requests all
configured catalogs near-simultaneously on manifest load (e.g. 4 providers ×
2 types × 3 sort orders = 24 catalogs), and each one queued behind every
other — observed 6 parallel cold requests taking 199ms→631ms in a visible
staircase (server-side `addon.log` timings), while warm/L1-cached requests
were 0-1ms. Root cause was the queue, not the cache.

Ran a standalone probe (direct `axios` calls to
`https://apis.justwatch.com/graphql`, bypassing this app's queue/cache
entirely, varying country+offset per call to dodge upstream caching) at
increasing concurrency levels:

| concurrency | result |
|---|---|
| 1–128 | 100% success, latency ~150ms → ~2.2s avg (max seen 7.1s at 128) |
| 192 | 150/192 ok, 42 timeouts (ECONNABORTED at the 10s axios timeout) |
| 256 | 170/256 ok, 86 timeouts |

**No explicit 429 was seen at any level up to 256** — failures past ~150-190
were pure latency/timeout, not rate-limit rejection. This contradicts the
original code comment's assumption. Two caveats worth remembering: (1) this
was a single burst from one devcontainer IP, not sustained production
volume, and (2) shared IP ranges (Vercel/BeamUp) may have different
JustWatch reputation than the test IP — real-world 429s at lower concurrency
than measured here are still possible.

Based on this, the queue was changed to a bounded semaphore with
`MAX_CONCURRENCY = 100` (well under the ~150-190 knee, but far above the
~24-catalog real-world fan-out this app ever generates) instead of removing
the queue outright. Verified after the change: the same 24-catalog cold-load
scenario resolved all requests in ~0.33-0.46s each (vs. a staircase up to
631ms+ for just 6 requests before), no errors.

## Recent history (as of 2026-08-24, branch `beamup`)

1. Concurrency queue changed from serialize-1 to bounded semaphore (100) — see above
2. `f2cc115` style: configure.html button padding/font-size tweak
3. `09179b9` feat: poster provider support + poster URL resolution refactor (`posterProviders.js` added)
4. `11e3818` feat: GraphQL concurrency queue to cut JustWatch 429s (superseded by #1 above)
5. `8eaa48d` feat: cache-control improvements + `ttl.js` introduced as single TTL source of truth
6. `161b1d1` fix: shorter cache duration for freshness
7. Earlier: dropped Vercel-only `getCache()` (crashed on non-Vercel hosts) in favor of portable Upstash REST L1/L2; stopped tracking `beamup.json`; added `ADDON_PUBLIC_URL` for BeamUp's Host-header quirk.

## Memory tracking

This file lives in the repo (`memories/stremio-addon.md`) and is tracked by
git — it travels with the code to GitHub (`origin`), unlike the assistant's
local-only `~/.claude` memory. Update it here when the architecture shifts;
commit it like any other source change so history + GitHub stay the source of
truth for project context.
