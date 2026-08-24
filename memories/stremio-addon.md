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
  `GetPackages`). Two-layer cache via `./cache`. **Concurrency queue**:
  `QUEUE_ENABLED = false` as of 2026-08-24 — `enqueue()` bypasses the
  semaphore and runs tasks immediately (unbounded), because real Stremio
  usage showed requests hanging on a cache miss (suspected leaked semaphore
  slot from a task that never settles — see **Concurrency tuning** below).
  The bounded-semaphore implementation (`runNext()`, `MAX_CONCURRENCY = 100`,
  `pending`) is still in the file, just dead code while disabled, kept there
  to keep iterating on it rather than deleting it.
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
`src/justwatch.js`.

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

## Recent history (as of 2026-08-24, branch `beamup`)

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
