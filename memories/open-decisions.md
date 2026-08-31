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

## 3. Daily randomized catalog order (designed 2026-08-26, paused)

**Request**: an opt-in shuffle of catalog results — not per request, but varying
day to day.

### Design agreed on paper

Deterministic per day: seed = UTC day number
(`Math.floor(Date.now() / 86400000)`) mixed with catalog id, country and
language. Same day → identical output (caches and pagination stay stable); next
day → different. No extra API calls.

Two effects share the seed:

1. **Window rotation** — add a seeded offset (0–450, a multiple of the 50-item
   batch size) to the `skip` Stremio asks for. The shift is identical for every
   page, so pagination stays coherent (same list, rotated) and *which* titles
   appear changes, not just their order. Retry without rotation if the rotated
   window comes back empty.
2. **In-batch shuffle** — seeded PRNG (mulberry32/xorshift) + Fisher-Yates over
   the returned batch.

Known trade-off: catalogs are served with `s-maxage=4h`, so just after UTC
midnight the CDN can serve yesterday's order for up to 4 hours. Judged
acceptable; the alternative is a shorter TTL for randomized configs only.

### Planned footprint

- `src/domain/shuffle.js` (new): seeded PRNG, `dailySeed()`, `seededShuffle()`,
  `dailyOffsetShift()`. **Pure — the date is a parameter, never read
  implicitly**, so it's testable.
- `domain/userConfig.js`: new `rnd-day` segment (`ES_es_rnd-day_nfx_dnp`).
  **Must be added to the prefixes excluded from the packages filter**, both
  server-side and in `configure.html`'s client-side parser, or `rnd-day` gets
  swallowed as a package name. Absent segment → `shuffle: null`, identical
  behavior to today. See [config-codec.md](config-codec.md).
- `domain/catalog.js`: apply rotation + shuffle only when
  `config.shuffle === "day"`, and **never** to the empty/error placeholder metas
  (see [catalogs-and-manifest.md](catalogs-and-manifest.md)).
- `configure.html`: toggle in step 2, read/write the segment in `generateUrl()`
  and in the `?config=` pre-fill.
- `data/uiStrings.js`: `shuffle` + `shuffleHint` keys in all 19 languages —
  `test/uiStrings.test.js` fails if any is missing.
- Tests: segment round-trip, determinism (same seed → same order), different
  days → different orders, and that the result is a permutation (nothing lost
  or duplicated).

### Questions still unanswered by the user

1. Rotation **plus** shuffle, or shuffle-only within the page (more
   conservative, but always the same ~50 titles)?
2. Daily only, or `rnd-day` / `rnd-week` / `rnd-hour` from the start?
3. One global toggle, or independent toggles for global vs provider catalogs
   (mirroring how `sorts`/`gsorts` already work)?
