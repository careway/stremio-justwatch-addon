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

**`GetPackages`** — `packages(country:, platform: WEB, includeAddons: true)`
with `id`, `packageId`, `clearName`, `technicalName`, `shortName`,
`monetizationTypes`, `hasTitles`, `hasSport`, `icon(profile: S100)`.

**`includeAddons: true` is load-bearing** (added 2026-09-02). Without it the
query silently omits every channel/add-on package — the "X Amazon Channel" and
"X Roku Premium Channel" entries — even though they are perfectly real,
filterable providers. Screambox Amazon Channel (`asb`) was the reported case:
justwatch.com/us/provider/screambox-amazon-channel exists, a title query with
`packages: ["asb"]` returns its catalogue correctly, and yet it never appeared
in `/configure` because the grid is built from this query.

Raw counts when it was added: US 348 → 422, DE 160 → 268, GB 139 → 211,
ES 99 → 125. Among the recovered: HBO Max, Crunchyroll, AMC+, Shudder, MUBI,
Discovery+ and MGM+ Amazon Channels. Absence is still regional and genuine —
Screambox is US-only, and correctly missing from ES/GB even with the flag.

The `packages:v3:{country}` cache key is **versioned for this reason**: the old
key would have kept serving the pre-addons list for up to `PACKAGES_TTL_S`
(24 h) after deploy. Bump it on any change to this query — v2→v3 was needed
the moment `addonParent` was added, and forgetting it means the new field is
simply absent from the cached payload while everything still "works".

**`addonParent(country:, platform:)`** on `Package` is the classifier for
channels: non-null means the package is watched through another subscription
(Screambox Amazon Channel → Amazon Prime Video). `getPackages` flattens it to
`isAddon` / `addonParentName` / `addonParentShortName`, and `/configure` splits
its grid on that flag and groups the channels tab by parent.

In practice there are only **one or two** parents per country: Amazon Prime
Video everywhere (US 67, DE 105, ES 22), plus The Roku Channel in US (4) and
Now TV in GB (1).

**Don't classify by name.** `"Cinemax Apple TV channel"` has **no**
`addonParent` and is a plain provider, so a `/channel/i` test on `clearName`
disagrees with the API. US splits 286 providers / 71 channels after the existing
filters; DE 117 / 105.

## The schema is closed, so probe it with argument names

Introspection is **disabled** (`introspection disabled`), but GraphQL still
validates argument names and suggests near-misses — `includeChannels` answers
*Did you mean "includeAddons"?*. That is how `includeAddons` was found. Firing a
handful of plausible names at a field and reading the errors is the practical
way to discover this API's surface. `scripts/jw-query.js` is the tool for it.

The same trick works on **fields**, not just arguments: `isAddon` answers
*Did you mean "addons"?* and `addonParent` answers with its required arguments —
which is how that field was found.

Another route: justwatch.com pages ship an Apollo cache in the HTML with the
site's own queries and results inline. `"Package:cGF8MjAy"` on the Screambox
page yielded its full identity (`packageId: 202`, `shortName: "asb"`).

## An invalid `packages` filter is silently ignored

`packages: ["doesnotexist"]` does **not** error — it returns the *unfiltered*
catalogue, byte-identical to sending no package filter at all. So a bad
shortName in a user's config degrades into "all providers" rather than failing
visibly. Keep it in mind when a catalog looks suspiciously generic, and never
infer "the filter worked" from a non-empty response — compare against the
unfiltered result.

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

These filters are *not* what hid the add-on channels — those never reached this
code, see `includeAddons` above. Of the 74 packages US gained, 70 survive these
filters.

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
