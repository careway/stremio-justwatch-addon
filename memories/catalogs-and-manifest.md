# Catalogs & manifest generation

`src/domain/manifest.js` (what Stremio is offered) and `src/domain/catalog.js`
(what it gets back).

## Identifiers

- **Catalog id**: `jw_{sortKey}_{shortName}` — e.g. `jw_pop_nfx`, `jw_new_global`.
  `catalog.js` parses it as `parts[1]` = sortKey, `parts.slice(2).join("_")` =
  package name (shortNames can in principle contain `_`).
- **`r_` prefix** (2026-09-01): `r_jw_pop_nfx` is the *randomized* form of the
  same catalog. `buildManifest` adds it to every id when `config.randomize`;
  `handleCatalog` strips it and sets a `randomize` flag. The prefix keeps
  Stremio's per-id cache separate from the un-shuffled version.
- **Package filter key is `shortName`** (`nfx`, `dnp`, `prv`) — *not*
  `technicalName`. Some JSDoc in the files still says technicalName; the code
  passes shortName.
- **Sort keys** (`SORT_MAP` in `data/catalogMeta.js`):
  `pop` → `POPULAR`, `tnd` → `TRENDING`, `new` → `RELEASE_YEAR`.

## The `global` pseudo-package

`GLOBAL_PACKAGE_ID = "global"` (`data/catalogMeta.js`) — a whole-country,
all-providers catalog. Added 2026-08-25.

- It rides through `config.packages` exactly like a real shortName, so
  `encodeConfig`/`decodeConfig` needed **no changes** for it.
- `catalog.js`: `packageFilter` becomes `[]` instead of `["global"]` — an
  unfiltered JustWatch search. (Filtering by a package literally named "global"
  would just return nothing.)
- `manifest.js`: named `"{sortLabel} · {country}"` with **no provider-name
  segment** — `"Popular · ES"`, not `"General · Popular · ES"` (refined the
  same day it shipped, per explicit request).
- `orderedPackages` is a **stable** sort moving `global` to the front, so global
  catalogs always list first regardless of where `"global"` falls in
  `config.packages` (`nfx_dnp_global` still lists global's catalogs first).

## Sort-type selection — two independent lists

`config.sorts` applies to every **real provider** package; `config.globalSorts`
applies **only** to `global`. `isGlobal` picks which list applies per package
inside the loop. Both default to all three keys.

They were split the same day the feature shipped, per explicit user request
("el catálogo global puede seleccionar tipos diferentes a los de los
proveedores") — so "Netflix on New only, global on Popular + Trending" is a
real, intended combination. URL encoding in [config-codec.md](config-codec.md).

Catalogs generated = (selected sorts) × (that package's content types), up to 6.

## Content types (2026-08-31)

Two maps narrow which of movie/series a catalog row is generated for:

- `config.packageTypes[shortName]` — per package.
- `config.globalTypes[sortKey]` — per *sort*, `global` only.

The inner `for (const type of …)` loop runs over `BOTH_TYPES` unless something
narrowed it. **For `global` the per-sort entry wins over a package-level one**
(`globalTypes[sortKey] ?? packageTypes[shortName]`) — the more specific of the
two. Global has the finer granularity because its three chips each cycle
independently in the UI.

- The value is validated against `BOTH_TYPES` rather than trusted — an unknown
  value falls back to both instead of being emitted as a bogus catalog `type`.
  A test pins this for both maps.
- The manifest's own top-level `types: ["movie", "series"]` is **unchanged** by
  this; it declares what the addon can serve, not what this config selected.
- Catalog **ids are unaffected** (`jw_{sortKey}_{shortName}`) — Stremio keys a
  catalog by type+id, so a restricted package simply declares one of the two
  rows it used to.
- `domain/catalog.js` needed **no change**: Stremio only requests catalogs the
  manifest declares, so the type never reaches the handler in the first place.

URL encoding (`m-`/`s-`/`gm-`/`gs-`), the defensive decode rules, and why they
are list segments: [config-codec.md](config-codec.md).

## Manifest shape

`resources: ["catalog"]` only — **no stream resource**. `types: ["movie", "series"]`.
Each catalog declares `extra`: a `genre` option list from `getGenreNames(language)`
and a non-required `skip`.

Also present and easy to clobber by accident:

- `logo` / `background` → `${addonBaseUrl}/static/logo-256.png` and
  `/static/background.png` (updated in `bbd08ff`). `addonBaseUrl` matters on
  BeamUp — see [project-and-deploy.md](project-and-deploy.md).
- `stremioAddonsConfig` — the **stremio-addons.net issuer + signature JWT**.
  Don't drop it; it's the addon's listing signature.
- `behaviorHints: { configurable: true, configurationRequired: false, adult: false }`.
- `SORT_LABELS_I18N` in this file holds the Popular/Trending/New labels in all
  19 languages — see [i18n.md](i18n.md).

## `handleCatalog` behavior

- **Search is not served.** `if (search !== undefined) return null` — Cinemeta
  handles search, this addon only browses.
- **Two-batch fetch for misaligned offsets.** Batch size 50. When
  `skip % 50 !== 0` a second request at `batchStart + 50` is issued (10 ms
  apart), then both are merged and deduped by imdbId. An aligned offset only
  costs one call.
- Nodes without an `externalIds.imdbId` are dropped (`nodeToMeta` returns null)
  — an imdbId is the meta id.
- Genres are mapped back from JustWatch shortNames to localized names via `GENRES`.
- `description` comes from `content.shortDescription` (in the query since
  `0a1a2c0`, 2026-04-11).
- Posters go through `resolvePosterUrl()` — see [poster-providers.md](poster-providers.md).
- **Randomized catalogs (`r_` id, 2026-09-01; reworked twice the same day).**
  Shuffled in **blocks**, each seeded on its own index:
  `FNV(coreId|type|genreCode|blockIndex|seedWindow)` (see `src/domain/random.js`
  — FNV-1a + mulberry32 + Fisher–Yates). A request at `offset` fetches only its
  own block and slices at `offset - blockStart`.

  **`RANDOM_BLOCK_PAGES = 1`** — one page per block, so a randomized catalog
  costs *exactly* what a plain one costs, at any depth. It was briefly 3 (150
  titles per block) and that saturated JustWatch into erroring; see the incident
  in [benchmarks-and-incidents.md](benchmarks-and-incidents.md). This is the one
  number to change if the trade is revisited, and raising it to N multiplies the
  manifest-load burst by N. Don't reintroduce a "first block is smaller" special
  case — that was tried and it's strictly worse than a uniform 1, because deep
  pages still cost N.

  Consequences of a one-page block, accepted knowingly: the shuffle permutes
  **within** a page only. A title never moves between pages, so page 1 always
  holds the same top 50 by rank, reordered. What the user perceives is that the
  order changes each seed window, not that the selection does.

  **There is no depth ceiling.** The first version capped the shuffle at 150
  titles and fell back to plain ranking past that; now every page is its own
  block, so paging stays shuffled forever.

  **Why per-block seeds and not one growing pool.** Growing a pool and
  re-shuffling it reorders pages already served — reaching a later page
  rearranges an earlier one, so the user sees titles twice and misses others.
  Per-block seeds freeze earlier blocks forever. Stable pagination and an
  ever-widening pool are mutually exclusive; pagination wins because it's the
  one users notice. `test/randomBlocks.test.js` pins both halves, plus the
  one-call-per-page budget.

  **The seed window is `TTL_S`, not a day** (`RANDOM_SEED_WINDOW_MS = TTL_S *
  1000`). A fixed UTC day outlived the data by 6×: the page is cached for
  `TTL_S` (4 h), so it was refetched and changed underneath a frozen seed, and
  anyone paging at that moment got duplicates and gaps. Deriving the window from
  `TTL_S` keeps shuffle and data on one cadence, and keeps following if that TTL
  ever changes — including if it ever becomes per-sort.

  Caveat: this aligns **cadence, not phase**. Cache entries expire `TTL_S` after
  they were *written*, not on a global 4 h grid, so a refresh can still land
  mid-window. Closing that fully would mean caching the shuffled page under its
  seed window instead of the raw one. Not done — see
  [cache-layers.md](cache-layers.md).

  This is also the one place `domain/` imports `src/ttl.js`, which is fine:
  ttl.js sits outside the layers precisely to be shared (see
  [architecture.md](architecture.md)).

## Unreleased-title filtering

JustWatch's `RELEASE_YEAR` sort surfaces **announced/upcoming** titles first —
user-reported: Avatar sequels years out. Two complementary filters, and
**neither replaces the other**:

1. **Server-side pre-filter** (`infra/justwatch.js`): `filter.releaseYear = { max: currentYear }`
   on every `searchTitles()` call. Year granularity only. Measured live for
   ES/movies: took survivors from 4/50 to 37/50, because most of the waste was
   titles dated *years* out.
2. **Exact-date filter** `isUnreleased()` (`domain/catalog.js`): drops nodes
   whose `content.originalReleaseDate` (ISO `YYYY-MM-DD`, lexicographically
   comparable) is after today — this catches the
   released-later-this-same-year remainder (13/50 in that sample).

A **missing** date counts as released, deliberately — incomplete JustWatch
metadata must never silently hide a legitimate title. Applied to *every* sort,
not just `new`. End-to-end: the global "new" movies catalog went from ~4 metas
to 25.

Caveat: entries already in L1/L2 from before this predate the filter and won't
gain it until they expire or are invalidated — see [cache-layers.md](cache-layers.md).

## The two placeholder responses (they are not the same)

| Case              | Return                                   | Cached?                            |
| ----------------- | ----------------------------------------- | ---------------------------------- |
| zero results      | `{ ok: true, metas: [ "Oh No!" ] }`       | **yes**, full `CATALOG_CACHE_CONTROL` |
| thrown error      | `{ ok: false, metas: [ 3 joke titles ] }` | **no**, `no-store`                 |

`ok: false` exists precisely so a degraded fallback isn't cached for the full
4 h TTL. An empty catalog, by contrast, is treated as a real answer.

**A future randomizer or any transform must never be applied to either
placeholder set.**
