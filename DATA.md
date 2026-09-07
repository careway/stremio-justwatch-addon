# Data reference

What this addon stores, where, why, and for how long. Two Postgres tables (both optional — the addon runs fine without `DATABASE_URL`, just without warming/stats history) and one in-process, ephemeral counter set.

## `query_cache` (Postgres) — cache warming registry

Created/managed by [`src/infra/warmCache.js`](src/infra/warmCache.js). One row per distinct upstream query the addon has ever served or pre-warmed.

| Column              | Type          | Meaning |
| ------------------- | ------------- | ------- |
| `key`                | `text` PK     | The same L1/L2 cache key `justwatch.js` computes (e.g. `search::MOVIE:nfx::POPULAR:ES:es:50:0`, `packages:ES`). |
| `vars`               | `jsonb`       | The exact arguments needed to replay this query (country, packages, sortBy, offset, …) — what `_warmRefetch()` calls JustWatch with. |
| `payload`            | `jsonb`, null | The last successful response. Used to seed L1 in bulk on process startup (`seedL1()`) and as the row's "is this filled yet" signal. |
| `payload_at`         | `timestamptz`, null | When `payload` was last refreshed. Compared against each key's TTL to decide if a row is "due" for a background refetch. |
| `last_requested_at`  | `timestamptz` | Bumped on every real request (`touch()`) and every seed run (`register()`). Rows untouched for 14 days (`RETENTION_DAYS`) are pruned hourly. |
| `request_count`      | `bigint`      | **Organic traffic only.** Incremented by `touch()` when a real request asks for this exact key — debounced to once per 5 minutes per key, so a busy catalog doesn't inflate this on every hit. This is the "real demand" signal `scripts/seed-warm-cache.js` filters providers by (see below) — it deliberately does **not** count rows the warmer itself creates as a side effect (see `registerRow()`'s comment for why that distinction exists). |
| `seed_priority`      | `bigint`      | **Not demand — a backfill ordering hint.** Written only by `scripts/seed-warm-cache.js`'s `register()`, as `countryBase + providerRank` (country's rank in the seed plan × 10000, plus a per-entry offset: `packages:` row highest, then `global`, then real providers in JustWatch's own relevance order). Used as a tie-breaker in `tick()`'s queue ordering *only* when `request_count` is 0 for everything tied — once real traffic exists for a key, `request_count` decides first. |

**Why two separate counters (`request_count` vs `seed_priority`)**: they used to share `request_count`, which meant one seed run could inflate it into the hundreds of thousands for every provider in a country alike, making "which providers do people actually use" unanswerable. They were split apart specifically to keep `request_count` an honest organic-only signal — see the commit history around `scripts/migrate-seed-priority.js` (the one-time repair for rows that were already polluted before the split).

**How it's used, end to end**: a live request always calls `touch()` (creates/bumps the row) regardless of cache hit or miss. On a miss, the fresh payload is written via `store()`. A background loop (`tick()`, every `WARM_TICK_MS`, default 4s) picks the single most due-and-important row (`ORDER BY (payload IS NOT NULL), request_count DESC, seed_priority DESC`) and replays it directly against JustWatch, refreshing L1 and the row's `payload` before it actually expires (`REFRESH_AHEAD` = 80% of TTL). `scripts/seed-warm-cache.js` is the one-off/cron tool that seeds new rows ahead of any real traffic, ranked by `seed_priority`, and by default only for providers `request_count` already shows real demand for (`--all-providers` to bootstrap a country with none yet).

**Retention**: rows not requested in 14 days are deleted (`prune()`, hourly). **Not stored**: no user identity, no IP — `vars` only ever contains catalog parameters (country, provider, sort, language), the same information already visible in the manifest/catalog URL itself.

## `hourly_visitors` (Postgres) — unique clients per hour

Created/managed by [`src/infra/visitors.js`](src/infra/visitors.js). Backs the `clientsByHour` field on `/api/stats/<INV_KEY>`.

| Column        | Type          | Meaning |
| ------------- | ------------- | ------- |
| `hour_bucket` | `timestamptz` | The hour this row belongs to (truncated to `:00:00`). |
| `ip_hash`     | `text`        | `SHA-256(client IP)`, truncated to 32 hex chars. **The IP itself is never written to disk.** |

Primary key is `(hour_bucket, ip_hash)`, so a second request from the same client in the same hour is a no-op (`ON CONFLICT DO NOTHING`) — `count(*) GROUP BY hour_bucket` is therefore already a distinct-client count, no separate dedup query needed. The client IP is read from `x-forwarded-for` (set by BeamUp/dokku's proxy), falling back to the raw socket address for direct/local connections.

`track()` is called on every request (`src/index.js`), fire-and-forget, debounced in-process so a request storm from one IP within the same hour costs one write, not one per request.

**Retention**: rows older than 7 days are deleted hourly (`prune()`) — matched exactly to the 7-day window `hourlySeries()` reports, so no hash is ever kept longer than the data it's shown for.

## In-process counters (`src/infra/stats.js`) — not persisted

Everything here resets on restart — a fresh dyno reports a clean slate, not necessarily a healthy one. Exists because the host's own log buffer is cyclic (BeamUp's `logs` command returns a rolling, partial window — a burst visible in one dump can be gone from the next), so it's the only reliable answer to "what has this process actually been doing since it started."

- **`counters`** — flat dotted keys bumped via `stats.bump("upstream.ok")` etc., expanded into nested objects on read. Notable ones: `cache.l1Hit` / `cache.l2Hit` / `cache.miss` / `cache.warmHit` (see below), `upstream.ok` / `upstream.partial` / `upstream.fail.<kind>` (kind is an HTTP status, an axios error code, or `"graphql"`), `upstream.shortCircuited` (calls refused while the circuit breaker was open), `warm.touch` / `warm.touch.rejected` (see below) / `warm.refresh.ok` / `warm.refresh.fail` / `warm.refresh.sibling` / `warm.seed`, `requests.catalog`, `responses.<statusCode>`.

  **`cache.warmHit` vs plain `cache.l1Hit`**: every warm hit is also an L1 hit (same `Map`, `l1Hit` always counts it too) — `warmHit` narrows *which* L1 hits were served from an entry the addon pre-fetched on its own, rather than one a live request's own cache miss just happened to fill. A key is tagged "warm" (`warmCache.markWarm()`, tracked in an in-process `Set`, independent of `DATABASE_URL`/Postgres) when: the startup bulk-seed loads it from `query_cache` (`seedL1()`), the background `tick()` refreshes it before it expired, or a live request's block-fetch pulls in its *adjacent* 50-page for free (see `query_cache`'s `request_count` entry above) — nobody asked for that second page, so serving it later still counts as a warm hit, not an ordinary one. A high `warmHit`-to-`l1Hit` ratio means most of what's being served was anticipated ahead of time rather than fetched cold; the gap between `l1Hit` and `warmHit` is traffic the live-request path itself is responsible for keeping cached.
- **`recentErrors`** — a ring of the last 25 error/warn log lines (`{at, level, message}`, message truncated to 400 chars), newest first. This is "what went wrong recently," not an audit trail — it evicts oldest-first.
- **`upstreamCircuit`** — not from `stats.js` itself, but attached alongside it in the `/api/stats` response: the circuit breaker's live state (`open`, `consecutiveFailures`, `remainingMs`) from `src/infra/circuitBreaker.js`.

`warm.touch.rejected` specifically counts a query that `warmCache.touch()` refused to register because its country code isn't a real one (`VALID_COUNTRIES`, from `src/data/catalogMeta.js`) — a garbage/typo'd country would otherwise sit in `query_cache` forever, permanently failing every time the warmer retried it and tripping the shared circuit breaker for everyone. See that function's comment for the incident this came from.

### `/api/stats/<INV_KEY>` response shape

```jsonc
{
  "uptimeS": 12345,
  "startedAt": "2026-09-01T00:00:00.000Z",
  "counters": { "cache": { "l1Hit": 900, "warmHit": 650, "miss": 40 }, "upstream": { "ok": 120 }, "warm": { "touch": 300 } },
  "recentErrors": [{ "at": "...", "level": "error", "message": "..." }],
  "upstreamCircuit": { "open": false, "consecutiveFailures": 0, "remainingMs": 0 },
  "clientsByHour": [{ "hour": "2026-09-01T00:00:00.000Z", "clients": 12 }, /* … 168 entries, oldest first */]
}
```

Gated behind `INV_KEY` (same secret as the manual cache-invalidation route) because `recentErrors` quotes request variables, which reveal which countries/providers real users pick.

## L1 / L2 cache (`src/infra/cache.js`) — the actual serving path

Not a data store in the "information about users" sense — just the catalog/package payloads themselves, keyed by query parameters, expiring on their own (L1: in-memory `Map` with an `expiresAt` check on read; L2: Upstash Redis, `EX` TTL). See the main [README](README.md#features) for TTLs. Never reads from `query_cache`/Postgres directly — that table only feeds L1 at process startup and via the background warmer.
