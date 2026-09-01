# Open decisions & deferred work

Researched, designed, **deliberately not implemented**. Read the relevant
section before re-investigating any of these — the analysis is already done.

---

## 1. Config URL encoding / security (researched 2026-08-26, paused)

**Trigger**: the config segment is long and noisy
(`ES_es_poster-rpdb-t8-abc…_sorts-tnd-new_gsorts-pop_nfx_prv_…`) and carries the
user's third-party API key in plaintext.

### The finding that matters most

**Encrypting the config URL would not hide the API key.** `resolvePosterUrl()`
embeds the token in *every poster URL* returned to Stremio:

```
https://api.ratingposterdb.com/t8-abc123/imdb/poster-default/tt0133093.jpg
```

Those URLs reach Stremio, the CDN and the logs on every catalog response. The
config segment is only one of two leak channels. Genuinely hiding the key
requires **proxying poster images through the addon**
(`/{config}/poster/{imdbId}.jpg` → fetch upstream), at a bandwidth and latency
cost. **Any future "let's encrypt the URL" request must first decide whether
image proxying is in scope** — otherwise the work is cosmetic.

Secondary: in Stremio the addon URL *is* the bearer secret. Encryption protects
against casual reading (screenshots, support threads, logs), never against reuse.

### The SDK offers nothing to copy

Checked `stremio-addon-sdk/src/getRouter.js`: its route is
`/:config?/:resource/:type/:id/:extra?.json` and the segment is parsed with a
bare `JSON.parse(config)` — percent-encoded JSON in plaintext, **longer** than
the current format and no more private. The protocol treats the segment as
opaque, so any format is fair game.

### Options evaluated

| # | Approach                                              | Shortens? | Hides key? | Verdict                     |
| - | ------------------------------------------------------ | --------- | ---------- | --------------------------- |
| 1 | base64url(JSON), SDK-style                            | no (~40% longer) | no  | rejected                    |
| 2 | deflate + base64url                                   | not at our lengths | no | poor return                 |
| 3 | AES-256-GCM with a server secret, `v1.{blob}`         | no (+~38 chars) | yes  | viable, costly              |
| 4 | server-stored config, short id (`/c/aB3xY7/`)         | **yes**   | yes        | only real win, but stateful |
| 5 | keep the readable format, encrypt only the key        | no        | yes        | **recommended first step**  |

Constraints on all of them:

- **Already-installed URLs must keep working** — `decodeConfig()` would need to
  accept old *and* new behind a distinguishing prefix, with round-trip tests for
  both. Precedent: the legacy `rpdb-{key}` branch. See
  [config-codec.md](config-codec.md).
- Option 3 needs a `CONFIG_SECRET` surviving every deploy on
  BeamUp/Vercel/Render — **losing it breaks every installation** — and moves URL
  generation out of the browser (`/configure` would need a `POST /api/seal`).
- Option 4 depends on the L2 Redis, which is **optional and TTL-based** (see
  [cache-layers.md](cache-layers.md)). Eviction, a missing Redis or a free-tier
  wipe would kill users' installs. It needs non-expiring storage plus a fallback
  to the long format.

**Recommendation on record**: option 5 plus the `INV_KEY` guard below; defer
option 4 until there's guaranteed persistent storage.

---

## 2. `INV_KEY` guard (small, unfixed)

`http/router.js` builds the invalidation route as
`/api/inv/${process.env.INV_KEY || ""}`. With `INV_KEY` unset the target is
`/api/inv/`, which can never match because `rawPath` strips the trailing slash —
**safe by accident, not by design**. It should get an explicit `if (!inv_key)`
guard. See [http-and-caching.md](http-and-caching.md).

---

## 3. Daily randomized catalog order — **SHIPPED 2026-09-01** (`64be7b9`)

No longer an open decision. It is implemented; the notes below record where the
shipped design **differs from the paper design**, because they are not the same
and the old plan is not a guide to the code.

| Paper design (2026-08-26)                  | What shipped                                      |
| ------------------------------------------ | ------------------------------------------------- |
| `src/domain/shuffle.js`                    | `src/domain/random.js`                             |
| window rotation **+** in-batch shuffle     | **block shuffle** — no rotation, no depth limit    |
| `rnd-day` prefixed segment                 | bare `rnd` flag segment                            |
| `config.shuffle === "day"`                 | boolean `config.randomize`                         |
| `shuffle` / `shuffleHint` UI keys          | `randomize` / `randomizeHint`                      |

### How it actually works

`domain/random.js` — `seedFromString` (FNV-1a), `mulberry32`, `seededShuffle`
(Fisher–Yates, non-mutating), `seedWindow(windowMs, now)` (which rotation
window `now` falls in — the length is a *parameter*, because the right value is
a property of how long the data lives, not of shuffling). All pure.

`domain/catalog.js` shuffles in **one-page blocks**, each independently seeded,
with no depth ceiling, and the seed window derived from `TTL_S` rather than a
fixed day. It was briefly 3 pages per block, which saturated JustWatch — see
[benchmarks-and-incidents.md](benchmarks-and-incidents.md). Full rationale (why blocks rather than a growing pool, and the
cadence-vs-phase caveat) lives in
[catalogs-and-manifest.md](catalogs-and-manifest.md) — don't duplicate it here.

**`buildManifest` prefixes the catalog id with `r_`** when the config is
randomized, and `handleCatalog` strips it before parsing sort key/package. A
consequence worth knowing: toggling randomize **changes every catalog id**, so
Stremio treats them as different catalogs.

The `rnd` segment is a **bare, valueless** flag — the only one in the format.
Being unprefixed it is excluded from the packages filter by an exact `!==`
rather than a `startsWith`. It is a plausible shortName *shape* (three letters),
so it was checked: `rnd` is unused across 564 JustWatch shortNames from 15
countries (verified 2026-09-01). If JustWatch ever introduces it, the flag and
that provider collide.

The CDN caveat from the paper design is now moot in its original form: the
seed window and `s-maxage` are both `TTL_S`, so they rotate together instead of
the edge serving a stale order for a quarter of the shuffle's life.

Format details: [config-codec.md](config-codec.md) ·
catalog behavior: [catalogs-and-manifest.md](catalogs-and-manifest.md).
