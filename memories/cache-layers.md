# Server-side cache (L1 / L2)

`src/infra/cache.js` exports two singletons, `L1Cache` and `L2Cache`.
`src/infra/justwatch.js` wraps them in `cacheGet`/`cacheSet`.

## L1 — in-process

A module-level `Map` declared **outside** the class so it survives warm
serverless invocations. Entries are `{ data, expiresAt }`; `get()` evicts
lazily on read when expired. Not shared between instances or processes.

## L2 — Upstash Redis over REST/HTTPS

Uses `@upstash/redis` — **REST, not ioredis, not host/port** — which is why it
works identically on BeamUp, Render or any Node host. The connection is memoized in a
module-level `_redisConnection` so warm invocations don't exhaust connections.

Credentials, either pair:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- `REDIS_KV_REST_API_URL` + `REDIS_KV_REST_API_TOKEN` (legacy names from the
  removed Vercel↔Upstash integration; still read so existing deploys keep L2)

**Falls back silently to L1-only when unset** — every read/write is guarded by
`if (this._redis)`. Any Redis error is caught and logged, never propagated.
This optionality matters: anything that assumes L2 persistence (e.g. storing
user configs there) would break for deployments without it — see
[open-decisions.md](open-decisions.md).

## Lookup order

`cacheGet(key, ttl)`: L1 → L2 → miss. **A L2 hit is promoted back into L1**
with the same TTL. `cacheSet` writes both. Hits/misses are reported through
`infra/analytics.js` (`trackCacheHit("L1"|"L2")` / `trackCacheMiss`).

## TTLs

From `src/ttl.js` — `TTL_S` (4 h) for search/catalog results, `PACKAGES_TTL_S`
(24 h) for provider lists. The same constants drive the HTTP `Cache-Control`
headers, see [http-and-caching.md](http-and-caching.md).

There is **no cron/scheduler** in any deployment (BeamUp has none), so
freshness comes purely from TTL expiry plus
`stale-while-revalidate` — never from an active refresh job.

## Cache keys

- `search:{query}:{objectTypes}:{packages}:{genres}:{sortBy}:{country}:{language}:{first}:{offset}`
- `packages:{country}`

Note the search key does **not** include the `releaseYear.max` filter (computed
fresh per call from the current year) — see
[justwatch-api.md](justwatch-api.md).

## Manual invalidation

`GET /api/inv/<INV_KEY>?key=<cache-key>` deletes the key from L1 and L2. This
is the only way to flush entries that predate a filtering change — e.g. results
cached before the unreleased-title filter existed keep their old contents until
the 4 h TTL expires. See the `INV_KEY` guard issue in
[http-and-caching.md](http-and-caching.md).

## Upstream circuit breaker (2026-09-02)

`infra/circuitBreaker.js` + one shared instance in `infra/justwatch.js`, gating
**every** outbound GraphQL call. After `UPSTREAM_FAIL_THRESHOLD` (5) consecutive
failures it opens for `UPSTREAM_COOLDOWN_S` (60), during which `gql()` throws
immediately with `err.circuitOpen = true` and never touches the network. Both
constants live in `src/ttl.js`; they are a **backoff, not a freshness window**,
so they're deliberately not derived from `TTL_H`.

**Why a breaker and not a negative cache per key.** The obvious fix — cache the
failure under the key that failed — does nothing for the path that actually
caused the incident. A manifest can hold 1200 catalogs, i.e. 1200 distinct cache
keys, so per-key negative entries would still let 1200 calls through before the
last one was poisoned. The state worth remembering isn't "this key failed", it's
"the upstream is refusing us". Measured with a stubbed 403: 200 catalog requests
produced **5** outbound calls instead of 200 (98% cut; on the real 1200-catalog
manifest it's 1200 → 5).

Deliberately blunt — consecutive failures only, no error classification. 403,
429 and timeout all mean "stop asking"; enumerating which deserve a backoff is
how the one unenumerated case keeps hammering.

A failed **half-open probe re-arms the full cooldown**, otherwise one request per
tick would keep leaking to an upstream that is still down. A successful one
closes the breaker and resets the streak.

Scope is one process. On a single-instance host that's everything; with several,
each learns independently. Sharing it through L2 was considered and skipped — a
Redis round trip on every upstream call to solve a problem this deployment
doesn't have.

Callers are unaffected: the manifest still degrades to technical names and a
catalog still serves its placeholder. The difference is that JustWatch stops
hearing from us while it's refusing.
