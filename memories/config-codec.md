# Config URL codec

`src/domain/userConfig.js` — `encodeConfig` / `decodeConfig`, plus the poster-key
codec. This is the addon's **own** format; the Stremio SDK is not used and has
nothing to do with it.

## Format

Human-readable, **not** base64 (an older note claimed otherwise), one URL path
segment:

```
/{COUNTRY}_{language}[_poster-…][_rnd][_sorts-…][_gsorts-…][_m-…][_s-…][_gm-…][_gs-…]_{pkg1}_{pkg2}…/manifest.json
e.g.  ES_es_poster-rpdb-t8-abc123_rnd_sorts-tnd-new_gsorts-pop-new_m-nfx_s-prv_gs-new_dnp_prv_global
```

Decodes to `{ country, language, packages, posterProvider, posterApiKey, sorts,
globalSorts, packageTypes, globalTypes, randomize }`.

**A package narrowed to one type no longer appears in the trailing list** (2026-08-31):
`m-nfx` alone means nfx is selected *and* movie-only — it is not also written as
a bare `nfx`. `decodeConfig` unions the `m-`/`s-` members back into `packages`.
Legacy URLs that carry both forms (`m-nfx_…_nfx`) still decode identically
(the marker member and the list entry dedupe).

Because the whole thing is one path segment split on `_`, every part is limited
to `[A-Za-z0-9-]`. The router's own match is `[A-Za-z0-9_-]+`.

## Segments

| Segment                 | Meaning                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `{COUNTRY}`             | position 0, uppercased, non-letters stripped, max 4. **Required** — null ⇒ decode returns null |
| `{language}`            | position 1, lowercased, max 5, defaults to `en`                          |
| `poster-{id}[-{key}]`   | poster provider, key optional for keyless providers                      |
| `rpdb-{key}`            | **legacy** pre-adapter shape, still decoded — don't remove                |
| `rnd`                   | bare flag (2026-09-01): every catalog served daily-seeded shuffled — id prefix `r_` in the manifest, see [catalogs-and-manifest.md](catalogs-and-manifest.md) |
| `sorts-{k1}-{k2}…`      | which sort types real provider packages generate                         |
| `gsorts-{k1}-{k2}…`     | same, but **only** for the `global` pseudo-package — fully independent    |
| `m-{p1}-{p2}…`          | packages restricted to **movie** catalogs only (2026-08-31)                |
| `s-{p1}-{p2}…`          | packages restricted to **series** catalogs only (2026-08-31)               |
| `gm-{k1}-{k2}…`         | **global sorts** restricted to movies only (2026-08-31)                    |
| `gs-{k1}-{k2}…`         | **global sorts** restricted to series only (2026-08-31)                    |
| `rnd`                   | bare flag — daily-seeded shuffled order (see catalogs-and-manifest.md)     |
| `nc`                    | bare flag — drop the country code from catalog names (2026-09-02)         |
| everything else         | package `shortName`s, matched by `/^[a-z0-9-]{1,30}$/`, capped at 200     |

## Bare flags need a length no shortName uses

`rnd` and `nc` are whole tokens, not prefixed markers, so `decodeConfig` excludes
them from the packages list with an exact match (`BARE_FLAGS.includes(p)`) rather
than a `startsWith`.

That makes their **length** the only thing standing between a flag and a
provider: every JustWatch shortName is exactly **three characters** (all 801
seen across 18 countries, measured 2026-09-02). So `nc` is collision-proof by
construction, while `rnd` is three characters and merely happens to be
unclaimed today — the day a provider ships with that shortName, the two become
indistinguishable and that provider silently turns into "randomize on".

**Any bare flag added from here on should be 2 or 4+ characters.**

## Invariants — break these and you break installed URLs

1. **Already-installed manifest URLs must keep working.** Users have these
   pasted into Stremio; there is no migration path. Any format change needs to
   accept old *and* new behind a distinguishing prefix, with round-trip tests
   for both. The `rpdb-{key}` legacy branch is the existing precedent.
2. **Omit a segment when it's at its default.** `sorts-`/`gsorts-` are only
   emitted for a partial selection, so a config that never touched those
   selectors encodes byte-identically to how it did before they existed.
   Absent segment ⇒ all of `ALL_SORT_KEYS`. `gsorts-` is only emitted when
   `"global"` is actually in `packages`.
3. **New non-package segments must be excluded from the packages filter** —
   in `decodeConfig` *and* in `configure.html`'s independent client-side
   parser. Otherwise the new prefix gets swallowed as a package name. The
   filter is now driven by the shared `RESERVED_PREFIXES` list (built from the
   two prefix tables plus `rpdb-`/`poster-`/`sorts-`/`gsorts-`) precisely so a
   new prefix can't be added to one encoder and forgotten in the filter.
   `configure.html` mirrors that list.

   `rnd` is a **bare token**, not a `-`-terminated prefix, so it can't go in
   `RESERVED_PREFIXES` (a real 3-letter shortName could start with "rnd").
   It's excluded by an explicit `p !== "rnd"` / `p !== RANDOMIZE_SEGMENT`
   check in both parsers instead.

   **The short markers are prefix-of-each-other hazards.** `s-` vs `sorts-` and
   `gs-` vs `gsorts-` only stay distinct because the marker includes its `-`:
   `"sorts-tnd".startsWith("s-")` is false (`"so"` ≠ `"s-"`), and likewise for
   `gs-`. Tests pin both cases on both sides. Never write a marker check that
   drops the dash.

## Content types (`m-`/`s-` per package, `gm-`/`gs-` per global sort, 2026-08-31)

Two maps, both holding **only** what was narrowed away from the default:

- `config.packageTypes` — `{ shortName: "movie" | "series" }`, per package.
- `config.globalTypes` — `{ sortKey: "movie" | "series" }`, per *sort*, and
  only for the `global` pseudo-package.

Global gets the finer granularity because that's what its UI offers: its three
Popular/Trending/New chips each cycle independently, so "global Popular = only
movies, global New = only series" is a real combination. `buildManifest` lets
the per-sort entry **win** over a package-level one, being the more specific.

A package or sort absent from these maps generates both types — which is what
everything in every URL predating this feature means, so an untouched config
still encodes byte-identically (invariant 2). `decodeConfig` always returns
both keys, `{}` when nothing is narrowed.

*List* segments rather than a per-member pair (`nfx.movie`) because the whole
config is one `_`-split path segment: only `[A-Za-z0-9-]` survives, so `-` is
the sole in-segment separator. That makes the list form ambiguous if a member
could contain a `-`, and neither can: **all 467 JustWatch shortNames across
ES/US/GB/DE/JP/IN/BR are exactly 3 letters, no dashes** (measured 2026-08-31),
and sort keys are the three in `SORT_MAP`. `sorts-`/`gsorts-` already rest on
the same assumption. If shortNames ever gain dashes, every list segment breaks
together.

The markers are one/two letters (`m-`, `s-`, `gm-`, `gs-`) rather than
`mov-`/`ser-` at the user's request, to keep the URL short. The collision
condition is unchanged — a shortName would have to literally start with `m-`
— but see the prefix-of-each-other hazard in invariant 3.

Decode is defensive in three ways, each covered by a test:

- a restriction naming something not selected is dropped — a package missing
  from `packages`, or a global sort missing from `globalSorts`;
- a member named under **both** markers means both types, so it is left out
  rather than letting whichever segment parsed last win. `decodeTypeSegments`
  gathers the types per member into a `Set` first, which also makes a member
  repeated inside one segment (`gm-pop-pop`) a no-op instead of a spurious
  "both";
- `buildManifest` checks the value against `BOTH_TYPES` instead of trusting it
  — a bogus value would otherwise be emitted verbatim as a Stremio catalog
  `type`. (`decodeConfig` can't produce one, but the builder is also called
  with configs assembled elsewhere; a test caught this.)

`m-global`/`s-global` still decode (global rides `packages` like any other), and
act as a package-level default for any global sort that `gm-`/`gs-` doesn't
name. The UI only ever writes the per-sort form.

## Poster-key codec

A provider key is usually a short token (`t8-…`, `TP-…`, `Tk-…`) that already
fits `SAFE_KEY_RE = /^[A-Za-z0-9-]+$/` and stays human-readable in the URL.
BetterPosters' "key" can instead be a whole pasted URL full of `:/.{}?=`, which
can't survive raw — those get hex-encoded behind a `url-` marker.

```
encodePosterKey(raw) = SAFE_KEY_RE.test(raw) && !looksLikeEncodedKey(raw)
                       ? raw : `url-${hex(raw)}`
```

**`looksLikeEncodedKey()` is one shared predicate consulted by both encode and
decode** — that's the whole point. A plain key shaped like the marker (e.g. the
literal `"url-deadbeef"`) used to be left raw by encode (charset-safe) and then
wrongly hex-decoded by decode, corrupting it. Now such a key is forced through
hex-encoding too, so the ambiguity can't exist by construction. **If the marker
scheme ever changes, keep it as one predicate per side — never two separate
`if` conditions that can drift.**

## Client/server mirror

`configure.html` also carries an independent browser copy of all four markers —
`encodeTypeSegments` / `parseTypeSegments`, which take the prefix table as an
argument exactly like the server's, kept honest the same way (see
[testing.md](testing.md)).

`configure.html` carries an **independent** browser implementation of the same
codec (`SAFE_POSTER_KEY_RE`, `looksLikePosterKeyMarker`, `encodePosterKey`,
`decodePosterKey`, `parsePosterSegment`) using `TextEncoder`/`TextDecoder`,
because `Buffer` doesn't exist in the browser. It is **not a shared module** —
two implementations of one scheme.

`test/posterKeyCodec.test.js` enforces they agree: it extracts the actual
`<script>` text between `const SAFE_POSTER_KEY_RE` and `function parsePosterSegment`
out of `configure.html`, runs it in a `vm` sandbox, and pushes the same key
vectors through both sides in both directions. Writing that test is what caught
the `"url-deadbeef"` bug. See [testing.md](testing.md).

`encodePosterKey`/`decodePosterKey` are exported from `userConfig.js` **solely
for that test**.

## Related

Config-URL shortening/encryption was researched in depth and deliberately not
implemented — read [open-decisions.md](open-decisions.md) before revisiting it.
