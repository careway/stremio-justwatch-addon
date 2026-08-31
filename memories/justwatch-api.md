# JustWatch GraphQL integration

`src/infra/justwatch.js`. Endpoint `https://apis.justwatch.com/graphql`,
POSTed with axios, a desktop-Chrome `User-Agent`, and a **10 s timeout**.
Introspection is disabled on their side, so every field here was confirmed by
live probing, not by reading a schema.

## Queries

**`GetPopularTitles`** — the only catalog query. Variables: `country`, `first`
(capped at 50), `offset`, `popularTitlesFilter`, `popularTitlesSortBy`,
`language`, `sortRandomSeed`. Selected fields per node:

```
objectType
content(country:, language:) {
  title, shortDescription, originalReleaseDate,
  genres { shortName }, externalIds { imdbId }, posterUrl(profile: S718, format: JPG)
}
```

**`GetPackages`** — `packages(country:, platform: WEB)` with `id`, `packageId`,
`clearName`, `technicalName`, `shortName`, `monetizationTypes`, `hasTitles`,
`hasSport`, `icon(profile: S100)`.

## Filter building (`searchTitles`)

`searchQuery` (only when non-empty), `objectTypes`, `packages`, `genres`, and
unconditionally:

```js
filter.releaseYear = { max: new Date().getFullYear() };
```

`TitleFilter.releaseYear.max` is a **real, working field** (confirmed live),
year-granularity only — not a client invention. Applied to every sort, not just
`RELEASE_YEAR`, because `searchTitles()` has one shared filter path; it's
harmless for POPULAR/TRENDING, which don't surface far-future titles anyway.
Rationale and measurements in
[catalogs-and-manifest.md](catalogs-and-manifest.md#unreleased-title-filtering).

It is **not part of the cache key** (computed fresh per call). At a Dec 31 →
Jan 1 boundary a stale year's filter could be served for up to one TTL window —
accepted, same class of imprecision as the TTL system generally.

## Package list filtering (`getPackages`)

Excludes pure cinema-ticketing packages (`monetizationTypes === ["CINEMA"]`)
and sports/live-only providers (`hasTitles === false`), then resolves
`iconUrl` as `https://images.justwatch.com` + `icon` with `{format}` → `webp`.

## Language codes

JustWatch accepts `hi`/`te`/`ml`/`kn` as valid `Language` enum values but
returns **byte-identical English content** for them — a real data gap on their
side, not a general "unsupported language" pattern (`ja`/`es` genuinely
differ on the same titles). Details in [i18n.md](i18n.md).

## Concurrency queue — currently DISABLED

```js
const QUEUE_ENABLED = false;   // enqueue() short-circuits to `return task()`
const MAX_CONCURRENCY = 100;
```

The bounded semaphore (`runNext`, `pending`, `activeCount`) is **still in the
file as dead code, deliberately** — kept to keep iterating on it rather than
ripping it out.

History:

1. Original queue (`11e3818`) serialized *every* outbound call to concurrency 1,
   assuming JustWatch 429s under any parallelism. That made cold loads slow —
   Stremio requests all configured catalogs at once on manifest load (4 providers
   × 2 types × 3 sorts = 24), each queued behind the rest.
2. Live probing disproved the assumption (no 429 up to 256 concurrent) →
   changed to a bounded semaphore at 100. Numbers in
   [benchmarks-and-incidents.md](benchmarks-and-incidents.md).
3. **Disabled the same day (2026-08-24)**: real Stremio usage still hung on
   cache misses. Leading theory (unconfirmed): on BeamUp the app is one
   long-running process shared by every request, so the 100 slots are global and
   persistent — any task that never settles (hung TCP, an edge case the axios
   timeout misses) leaks its slot permanently, capacity shrinks over uptime, and
   requests pile up. That fits intermittent stalls correlated with misses.

If it's ever re-enabled, the prerequisites are: a hard per-task timeout that
always settles the promise regardless of axios, plus slot-leak instrumentation.
Note also that a semaphore only bounds one warm instance — Vercel can run
several in parallel and there's no cross-instance coordination point.

## Error handling

`gql()` logs the query, the variables and the response body on failure, then
rethrows. `handleCatalog` catches and returns the `ok: false` placeholder;
`/{config}/manifest.json` catches a failed `getPackages` and serves a degraded
manifest with `no-store` so it retries next request.
