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

The `packages:v2:{country}` cache key is **versioned for this reason**: the
unversioned `packages:{country}` key (v1, still what production runs) would
otherwise keep serving the pre-addons list for up to `PACKAGES_TTL_S` (24 h)
after deploy. Forgetting the bump means a new field is simply absent from the
cached payload while everything still appears to "work".

It went v2→v3→v4 during development and was collapsed back to **v2** before
shipping: none of those intermediate shapes ever reached a deploy or the shared
Upstash (no credentials in the dev environment, so L2 is a no-op there and every
local run only touched the in-process L1). Leaving them in would have implied
three production migrations that never happened.

**Bump it on any change to the query *or* to `data/packageFilters.js`** — the
cached value carries `isAddon`/`addonParent*`, so a rule change is a payload
change.

**`addonParent(country:, platform:)`** on `Package` is the classifier for
channels: non-null means the package is watched through another subscription
(Screambox Amazon Channel → Amazon Prime Video). `getPackages` flattens it to
`isAddon` / `addonParentName` / `addonParentShortName`, and `/configure` splits
its grid on that flag and groups the channels tab by parent.

Parents per country, after the supplement below: Amazon Prime Video everywhere
(US 154, DE 114, GB 82, JP 44), Apple TV in most (US 23, GB 6, DE 4, ES 2),
plus The Roku Channel in US (4) and Now TV in GB (1).

### `addonParent` is authoritative but badly incomplete (measured 2026-09-02)

It links **71** packages in US/WEB and misses roughly **110** more that are
plainly channels:

- **Every single "… Apple TV channel."** `addonParent` is null for all 23 of
  them on every platform (WEB/IOS/ANDROID/ANDROID_TV/FIRE_TV), and the reverse
  direction agrees: only `amp` (71 addons), `rkc` (4) and the three Sling TV
  packages (1 each) declare an `addons` list at all — **`atp` Apple TV declares
  zero**. So it is a gap in JustWatch's data, not in our query.
- **A long tail of "… Amazon channel"** entries that sit in the *base* package
  list rather than behind `includeAddons`, and carry no parent link.

Cross-tab that pins the shape of it: of the 74 packages `includeAddons` adds,
**all 74 have `addonParent`**, and none of the base-list packages gained one.
The two flags agree perfectly — the API simply classifies far fewer things as
add-ons than the names suggest.

`src/data/packageFilters.js` supplements it with a display-name suffix rule.
The API's own answer is tried first, so the heuristic never overrules a package
JustWatch did classify. The suffix must be a **platform name immediately
before "channel"**, never the word alone.

Audited across 15 countries: **zero false positives**. These all correctly stay
providers — Channel 4, Channel 4 Plus, Criterion Channel, Science Channel,
Travel Channel, Super Channel Plus, Plex Channel, The Roku Channel
(`rokuchannel`) and RokuChannel Live TV (`rokuchannelfast`). Note the last two:
a `technicalName` prefix rule on `roku` would have caught them wrongly, which is
why the rule reads `clearName`, not `technicalName`.

`"Amzon"` is in the pattern on purpose — a real JustWatch typo, in 2 US
packages.

Each supplemented channel resolves its parent to the **real package** by
`technicalName` (`amazonprime` → `amp`, `appletvplus` → `atp`, `rokuchannel` →
`rkc`) so API-linked and name-linked channels share one shortName; otherwise
`/configure` would draw two filter chips for the same service.

Splits after all of it — US 176 providers / 181 channels, DE 104 / 118,
GB 75 / 89, ES 55 / 27, JP 35 / 44.

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

## Package rules live in `data/packageFilters.js`, not in the API client

`infra/justwatch.js` only fetches and resolves icons. Which packages survive and
how they're classified is two arrays in `src/data/packageFilters.js`, so a rule
can be added or dropped in one edit:

| Stage           | Array           | Applied by           |
| --------------- | --------------- | -------------------- |
| exclusions      | `EXCLUSIONS`    | `keepPackage(pkg)`   |
| channel split   | `CHANNEL_RULES` | `annotateChannels()` |

`CHANNEL_RULES` is `[addonParentRule, nameSuffixRule]`, first match wins, with
the platform suffixes themselves in `CHANNEL_SUFFIXES`. `annotateChannels()`
resolves each parent against the package list by `technicalName`, so an
API-linked channel and a name-matched one **share the parent's real shortName**
— without that, `/configure` draws two filter chips for the same service.
`test/packageFilters.test.js` pins the whole audit as fixtures, including every
provider that merely ends in "Channel".

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
Note also that a semaphore only bounds one process — a host can run
several in parallel and there's no cross-instance coordination point.

## Error handling

`gql()` logs the query, the variables and the response body on failure, then
rethrows. `handleCatalog` catches and returns the `ok: false` placeholder;
`/{config}/manifest.json` catches a failed `getPackages` and serves a degraded
manifest with `no-store` so it retries next request.
