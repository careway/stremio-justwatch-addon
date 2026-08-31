# Server-side cache (L1 / L2)

`src/infra/cache.js` exports two singletons, `L1Cache` and `L2Cache`.
`src/infra/justwatch.js` wraps them in `cacheGet`/`cacheSet`.

## L1 — in-process

A module-level `Map` declared **outside** the class so it survives warm
serverless invocations. Entries are `{ data, expiresAt }`; `get()` evicts
lazily on read when expired. Not shared between instances or processes.

## L2 — Upstash Redis over REST/HTTPS

Uses `@upstash/redis` — **REST, not ioredis, not host/port** — which is why it
works identically on Vercel, BeamUp and Render. The connection is memoized in a
module-level `_redisConnection` so warm invocations don't exhaust connections.

Credentials, either pair:

- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
- `REDIS_KV_REST_API_URL` + `REDIS_KV_REST_API_TOKEN` (Vercel↔Upstash integration names)

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

There is **no cron/scheduler** in any deployment (Vercel Hobby only guarantees
daily cron; BeamUp has none), so freshness comes purely from TTL expiry plus
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
