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

## Architecture (current, reorganized 2026-08-24)

`src/` moved from a flat 10-file directory to a layered structure — pure
structural refactor, zero behavior change, done in one commit. `src/index.js`
never moved (kept `api/index.js`'s `require('../src/index')` valid with no
edit) and is now a thin bootstrap only (`http.createServer` + exported
`handler`); everything it used to do directly now lives under `src/http/`.

- `src/index.js` — thin bootstrap: `handler(req,res)` (the exported
  serverless entry) and the `require.main === module` local-dev listener.
  Pulls from `./http/router`, `./http/logger`, `./http/responses`, `./http/request`.
- `src/http/router.js` — the full route table (was the bulk of the old
  `index.js`): `/configure`, `/static/*`, `/manifest.json`, `/api/countries`,
  `/api/languages`, `/api/poster-providers`, `/api/packages`,
  `/api/inv/<INV_KEY>?key=<cache-key>` (manual L1+L2 invalidation),
  `/{config}/configure`, `/{config}/manifest.json`, `/{config}/catalog/...`.
  Also owns `getConfigureHtml()` (prod: cached once at module load; dev:
  re-read from disk per request — see **Config-page caching** below) and the
  Cache-Control constants derived from `../ttl`. **Fixed (2026-08-24, right
  after the reorg)**: the `/static/*` path-traversal-rejection branch used to
  reference the `mime` header value before its own `const mime = ...`
  declaration (TDZ) — moved the `mime`/`ext` computation above that check so
  it's defined by the time it's read. Before the fix this threw a
  `ReferenceError`, caught by `handler`'s own try/catch, degrading to a
  generic 500 instead of the intended clean `400`. The branch is real and
  reachable — not dead code — via an absolute-path bypass of the naive `..`
  substring check: a request like `/static//etc/passwd` makes `fileName`
  start with `/`, and `path.resolve(staticDir, fileName)` discards
  `staticDir` entirely for an absolute second argument, so the result never
  contains `..` (passes the first check) but does escape `staticDir`
  (caught only by this second, previously-buggy check). Verified live:
  `/static//etc/passwd` now returns a clean `400` with no error logged.
  `test/security.test.js`'s traversal tests only assert `status !== 200`,
  not the exact code, so they passed even while this returned a 500 — worth
  remembering next time those tests seem to "confirm" something is fully fine.
- `src/http/responses.js` — `respond`, `respondHtml` (sends
  `Cache-Control: no-store` — see **Config-page caching**), `redirect`.
- `src/http/request.js` — `parseExtra`, `getAddonBaseUrl()` (BeamUp Host-
  header quirk via `ADDON_PUBLIC_URL`), `getLanguageFromRequest()`
  (Accept-Language → per-country fallback map `COUNTRY_LANGUAGE` → `en`), `PORT`.
- `src/http/logger.js` — file+stdout logger, `console.*` monkey-patch,
  `LOG_FILE` (top-level `addon.log`), exports `rawConsoleLog` (pre-patch
  `console.log`) for the local-dev banner print in `index.js`.
- `src/http/configure.html` — config UI, moved alongside the route that serves it.
  Still 3 steps: (1) country/language, (2) platforms — now including the
  global-catalogs toggle as a subsection between the step-2 header and the
  "Proveedores Disponibles" provider grid (not below the grid — repositioned
  same day per explicit user request), not
  its own step (moved there 2026-08-25 per explicit user request, was
  briefly a separate step 3) — (3) poster ratings. The toggle
  (`#global-catalogs-toggle`, `.toggle-item`/`.toggle-card`/`.toggle-dot`
  classes) just appends the literal string `"global"` to the same `selected`
  packages array `generateUrl()` already builds from `#pkg-grid` — no
  separate encoding path. Pre-fill on `?config=` reads it back via
  `pkgs.includes("global")` (`pkgs` there already includes it verbatim,
  nothing filters it out). **Bug fixed same day**: the first version gave the
  toggle's `<label>`/inner dot their checked-state colors via *inline*
  `style="border:...; background:..."` while trying to override them from a
  `:checked` sibling-selector rule in the `<style>` block — inline style
  always wins over any stylesheet rule regardless of selector specificity,
  so the checkbox toggled correctly (the URL reflected it) but the visual
  indicator never updated. Fixed by moving all state-dependent visuals into
  the `.toggle-card`/`.toggle-dot` classes (no inline style on those elements
  at all now), mirroring how `.pkg-item`/`.pkg-label`/`.pkg-check` already
  did it correctly for the provider grid — same class-based, CSS-only
  `input:checked + label` pattern, just done right this time.
- `src/domain/catalog.js` — catalog handler: browse + genre filter, 2-batch
  fetch/merge/dedupe for misaligned pagination offsets, poster resolution via
  `../infra/posterProviders`. Failed/degraded results return
  `{ ok: false, metas: [...placeholder] }`, never cached (`no-store`).
  **Global catalogs (2026-08-25)**: when the catalog ID's package segment is
  `GLOBAL_PACKAGE_ID` ("global", from `../data/catalogMeta`), `packageFilter`
  is `[]` instead of `[pkgName]` — an unfiltered JustWatch search across every
  provider for the country, instead of filtering by a package literally named
  "global" (which would just return zero results).
- `src/domain/manifest.js` — dynamic manifest builder; `resources: ["catalog"]`
  only, no stream resource. Reads `version` from `../../package.json` (two
  levels up now — this path changed in the move, easy one to break again if
  this file ever moves further). **Global catalogs (2026-08-25)**: `packages`
  is just a flat array the existing `for (const shortName of packages)` loop
  already iterates — `"global"` rides through it as a pseudo-package with no
  loop changes, only a special-cased display name (`"General"` instead of a
  `pkgInfoMap` lookup, since that map only ever has real JustWatch packages).
  Produces the same 6 catalogs (3 sorts × 2 types) as any real provider,
  named e.g. `"General · Popular · ES"`.
- `src/domain/userConfig.js` — split out of the old `config.js`:
  `encodeConfig`/`decodeConfig` only (the addon's own URL config codec,
  including the legacy poster-segment backward-compat branch).
- `src/infra/justwatch.js` — JustWatch GraphQL client (`GetPopularTitles`,
  `GetPackages`). Two-layer cache via `./cache`. **Concurrency queue**:
  `QUEUE_ENABLED = false` as of 2026-08-24 — `enqueue()` bypasses the
  semaphore and runs tasks immediately (unbounded), because real Stremio
  usage showed requests hanging on a cache miss (suspected leaked semaphore
  slot from a task that never settles — see **Concurrency tuning** below).
  The bounded-semaphore implementation (`runNext()`, `MAX_CONCURRENCY = 100`,
  `pending`) is still in the file, just dead code while disabled, kept there
  to keep iterating on it rather than deleting it — survived the file move
  byte-for-byte (diff-verified).
- `src/infra/cache.js` — L1 (in-process `Map`, survives warm serverless
  invocations) + L2 (**Upstash Redis over REST/HTTPS** via `@upstash/redis` —
  not ioredis, not host/port; works identically on Vercel/BeamUp/Render).
  Accepts either `UPSTASH_REDIS_REST_URL`/`TOKEN` or the Vercel-KV-integration
  aliases `REDIS_KV_REST_API_URL`/`TOKEN`. Falls back silently to L1-only if unset.
- `src/infra/analytics.js` — Vercel Web Analytics wrapper (`trackCatalogRequest`,
  `trackCacheHit`/`trackCacheMiss`).
- `src/infra/posterProviders.js` — adapter registry for third-party poster
  APIs. RPDB and TOP Posters share the RPDB URL shape
  `{base}/{apiKey}/imdb/poster-default/{imdbId}.jpg`, apiKey a short token in
  a template we own (`requiresKey: true`). **BetterPosters (btttr.cc)** is
  the odd one out: free/keyless by default
  (`https://btttr.cc/poster/imdb/poster-default/{imdbId}.jpg`), but its "key"
  field can optionally hold a *whole custom URL* the user builds themselves
  at `btttr.cc/configure` → "AIOMetadata / Other Addon" path (confirmed by
  reading that page's actual source, pasted in by the user 2026-08-25 — the
  URL always contains the literal placeholder `{imdb_id}`, e.g.
  `https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=es-ES`;
  `poster`/`poster-g`/`poster-r`/`poster-n` + optional `q`/`a` suffix is
  their style-toggle encoding, not something we need to construct ourselves —
  we just substitute `{imdb_id}` into whatever they pasted).
  `requiresKey: false` on an entry means "has a working default with no
  input", not "rejects input" — `keyIsUrlTemplate: true` marks btttr's field
  as accepting one anyway. `buildUrl` for btttr also defends against a real
  btttr.cc-documented gotcha: iOS's clipboard can percent-encode a copied
  pattern (`{imdb_id}` → `%7Bimdb_id%7D`); `resolveImdbIdPlaceholder()` tries
  the raw string first, then its `decodeURIComponent()`'d form.
  `resolvePosterUrl()` order: configured provider (needs an id, and either
  `requiresKey === false` or a key was given) → JustWatch's own poster →
  Metahub as the no-key universal fallback. The `requiresKey === false` check
  is deliberately strict (not just falsy) — a future provider entry that
  forgets to set the flag defaults to "needs a key", not silently keyless.
  **Poster key encoding**: a plain short token (RPDB/TOP Posters) is kept
  human-readable in the URL as-is; anything outside `[A-Za-z0-9-]` (i.e. a
  btttr URL pattern, full of `:/.{}?=`) gets hex-encoded behind a `url-`
  marker (`encodePosterKey`/`decodePosterKey` in `src/domain/userConfig.js`,
  mirrored client-side in `configure.html` via TextEncoder/TextDecoder since
  Buffer isn't available in the browser — **keep both in sync if this ever
  changes**, they're independent implementations of the same scheme, not a
  shared module). Segment shape: `poster-{id}-{encodedKey}`, or bare
  `poster-{id}` with no key at all.
  **`test/posterKeyCodec.test.js`** (2026-08-25) now enforces the client/server
  agreement: it extracts the actual `<script>` snippet between
  `const SAFE_POSTER_KEY_RE` and `function parsePosterSegment` out of
  `configure.html` (`vm.runInContext`, sandboxed with `TextEncoder`/
  `TextDecoder`) and runs the same key vectors through both implementations —
  so a future edit to one side that isn't mirrored on the other now fails a
  test instead of silently drifting. Writing that test caught a real bug on
  first run: a *plain* key shaped exactly like our own marker (e.g. the
  literal string `"url-deadbeef"`) was left un-encoded by `encodePosterKey`
  (charset-safe) but then wrongly hex-decoded by `decodePosterKey`, corrupting
  it. Fixed in both files by extracting one shared predicate
  (`looksLikeEncodedKey` / `looksLikePosterKeyMarker`) that both encode and
  decode consult, so a colliding plain key now gets hex-encoded too instead of
  passed through — the ambiguity can't exist anymore by construction. If the
  marker scheme changes again, keep it as one predicate on each side, not two
  separate `if` conditions that can drift apart the same way.
- `src/data/catalogMeta.js` — split out of the old `config.js`: GENRES
  (18 × 14 languages), `getGenreNames()`/`getGenreCode()`, COUNTRIES,
  `fetchCountriesFromJustWatch()`, `getSupportedLanguages()`, `SORT_MAP`, and
  (2026-08-25) `GLOBAL_PACKAGE_ID = "global"` — the shared pseudo-package
  constant `domain/manifest.js` and `domain/catalog.js` both import instead
  of hardcoding the string independently.
- `src/ttl.js` — **unmoved, still flat at `src/` root** (deliberately — it's
  the one cross-cutting constant both `http/router.js` and
  `infra/justwatch.js` depend on). Single source of truth for cache cadence:
  `TTL_H = 4` (catalog/search) → `TTL_S`; `PACKAGES_TTL_H = TTL_H * 6` = 24h
  (provider lists).
- `api/index.js` — Vercel serverless entry (`module.exports = require('../src/index')`)
  — needed **no edit** for the reorg since `src/index.js` never moved.
- Also dropped one dead import while moving: old `index.js` imported
  `encodeConfig` but never called it — not carried into the new `router.js`.
- `test/translations.test.js` now requires `../src/data/catalogMeta` (was
  `../src/config`); `test/security.test.js` unchanged (`../src/index` still valid).

## Config shape

Human-readable, not base64 (despite an older memory saying otherwise):

```
/{COUNTRY}_{LANGUAGE}_{pkg1}_{pkg2}…/manifest.json
```

Decoded to `{ country, language, packages, posterProvider, posterApiKey }`.
`decodeConfig()` also handles a **legacy poster segment format** for
backwards compatibility with already-installed manifest URLs — don't remove
that branch without checking `src/domain/userConfig.js` (moved there in the
2026-08-24 reorg, was `src/config.js`).

`packages` can also contain the literal value `"global"` (2026-08-25) — a
pseudo-package for whole-country, all-providers catalogs (see
`GLOBAL_PACKAGE_ID` above). It round-trips through `encodeConfig`/
`decodeConfig` unmodified, no codec changes needed for it.

## Key facts

- **Package filter key**: `shortName` (e.g. `nfx`, `dnp`, `prv`) — NOT `technicalName`
- **Catalog ID**: `jw_{sortKey}_{shortName}` (e.g. `jw_pop_nfx`, or
  `jw_pop_global` for the whole-country pseudo-package)
- **Sort keys**: `pop` → POPULAR, `tnd` → TRENDING, `new` → RELEASE_YEAR-ish (`SORT_MAP`)
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
the queue outright. A first "verification" right after the change looked
clean (~0.33-0.46s per request, no errors) but was **invalid** — JustWatch
had started blocking this devcontainer's IP by then (see incident below) and
the fast times were actually the app's own error-fallback path (`ok: false`
→ placeholder metas), not real data; only response *timing*, not body
content, was checked. Once the block lifted, a proper re-run (24 parallel
cold requests, response bodies inspected) confirmed real data: 18/24 genuine
JustWatch results + 6 legitimately-empty catalogs (Filmin has no IE
catalog), 0 error-fallbacks, 0.35s wall time, 0 new 403s. **Lesson**:
verifying a fix against this app must check response *content*, not just
HTTP status/latency — the error path is deliberately fast and returns 200.

### Disabled again — real-world hangs on cache miss (2026-08-24, later same day)

Despite the above local testing showing the bounded semaphore working, the
user reported real Stremio usage still timing out, specifically some
requests "getting stuck" on a cache miss. Leading theory (not confirmed):
BeamUp runs this app as a single long-running Node process shared by every
request — unlike Vercel's per-request isolation — so the semaphore's 100
slots are truly global and persistent. If any one queued task never settles
(resolves or rejects) — e.g. a hung TCP connection, or an edge case the 10s
axios timeout doesn't actually catch — that slot leaks permanently. Over
enough cache misses over enough uptime, leaked slots accumulate, capacity
shrinks, and requests pile up behind the shrinking window until they time
out — which would explain intermittent, hard-to-reproduce stalls that
correlate with misses rather than a specific request pattern.

Rather than debug the leak live in production, `QUEUE_ENABLED` was added and
set to `false`: `enqueue()` short-circuits to `return task()`, so every
outbound call runs immediately and unbounded again (equivalent to no queue
at all). The semaphore code is untouched and still in the file for future
work — e.g. add a hard per-task timeout that always settles the promise
regardless of what axios does, add slot-leak instrumentation/logging, or
reintroduce bounded concurrency once the leak (if that's really what it is)
is fixed. Toggle lives at the top of the "Concurrency queue" section in
`src/infra/justwatch.js` (moved there in the 2026-08-24 reorg, was `src/justwatch.js`).

### Incident: devcontainer IP got 403-blocked by JustWatch (2026-08-24)

The concurrency probe above (bursts up to 256 parallel direct calls) was
followed, a few requests later, by **every** call to
`apis.justwatch.com/graphql` from this devcontainer returning HTTP 403 with
a bare `<!doctype html>...403 Forbidden` body — including a single
non-parallel request with no query complexity. That's an edge/WAF-style
block (unlike the app's normal error handling, no JSON body, no GraphQL
`errors` array), not the "aggressive 429" the original code comment
described. It self-resolved after roughly 5-10 minutes with no action taken.
**Takeaway**: don't run high-concurrency bursts directly against JustWatch's
live API from this environment without expecting a temporary IP block
afterward — prefer testing this app's own server (warm cache, no real
JustWatch calls) when possible, and if a direct-API probe is needed, treat
it as a one-shot, not something to casually repeat. Production (Vercel/
BeamUp) egresses from different IPs and is presumed unaffected, but this
wasn't directly verified.

## Local server capacity (2026-08-24)

Stress-tested this app's own server (not JustWatch) with a warm L1 cache —
93 distinct URLs (5 countries × 3 packages × 2 types × 3 sorts + a few
non-catalog routes) round-robined at increasing concurrency, 5s client
timeout:

| concurrency | requests | failures | throughput | p50 | p99 |
|---|---|---|---|---|---|
| 100 | 1,000 | 0 | ~2,860 req/s | 29ms | 88ms |
| 300 | 3,000 | 0 | ~3,120 req/s | 64ms | 936ms |
| 500 | 5,000 | 0 | ~4,110 req/s | 61ms | 1.19s |
| 1,000 | 10,000 | 0 | ~3,620 req/s | 118ms | 2.66s |
| 2,000 | 20,000 | 224 timeouts (1.1%) | ~3,280 req/s | 244ms | 6.08s |
| 3,000 | 30,000 | 1,269 timeouts (4.2%) | ~4,260 req/s | 403ms | 5.64s |

**Zero errors up to 1,000 concurrent connections** on a warm cache; failures
past 2,000 are client-side 5s timeouts from Node's single-threaded event
loop queueing under load, not server errors — throughput stays flat
(~3-4k req/s) even as failures appear, so it's a latency/queueing effect,
not a crash. At 3,000 concurrency the load-generating client (also Node, same
host) likely contended for CPU too, so results past ~2,000 aren't purely
server-side. 1,000 concurrent with zero failures is a large margin over any
realistic Stremio traffic for a hobby-scale addon.

## Recent history (as of 2026-08-25, branch `beamup`)

-1. Whole-country "global" catalogs (Popular/Trending/New, no provider filter) via the `GLOBAL_PACKAGE_ID` pseudo-package, toggled from a subsection inside the platforms step in `/configure` (not its own step — moved there + fixed a checked-state CSS bug same day) — see **Architecture** entries for catalog.js/manifest.js/configure.html above and the **Config shape** note
0. `src/` reorganized from a flat 10-file directory into `http/` / `domain/` / `infra/` / `data/` — pure structural refactor, zero behavior change, verified via `node --test` + full manual route checklist — see **Architecture** above
1. Concurrency queue changed from serialize-1 to bounded semaphore (100) — see above
1b. Concurrency queue disabled again (`QUEUE_ENABLED = false`) same day — real Stremio hangs on cache miss, suspected slot-leak on BeamUp's single long-running process; semaphore code kept for later
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
