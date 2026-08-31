# Config URL codec

`src/domain/userConfig.js` — `encodeConfig` / `decodeConfig`, plus the poster-key
codec. This is the addon's **own** format; the Stremio SDK is not used and has
nothing to do with it.

## Format

Human-readable, **not** base64 (an older note claimed otherwise), one URL path
segment:

```
/{COUNTRY}_{language}[_poster-…][_sorts-…][_gsorts-…]_{pkg1}_{pkg2}…/manifest.json
e.g.  ES_es_poster-rpdb-t8-abc123_sorts-tnd-new_gsorts-pop_nfx_dnp_global
```

Decodes to `{ country, language, packages, posterProvider, posterApiKey, sorts, globalSorts }`.

Because the whole thing is one path segment split on `_`, every part is limited
to `[A-Za-z0-9-]`. The router's own match is `[A-Za-z0-9_-]+`.

## Segments

| Segment                 | Meaning                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `{COUNTRY}`             | position 0, uppercased, non-letters stripped, max 4. **Required** — null ⇒ decode returns null |
| `{language}`            | position 1, lowercased, max 5, defaults to `en`                          |
| `poster-{id}[-{key}]`   | poster provider, key optional for keyless providers                      |
| `rpdb-{key}`            | **legacy** pre-adapter shape, still decoded — don't remove                |
| `sorts-{k1}-{k2}…`      | which sort types real provider packages generate                         |
| `gsorts-{k1}-{k2}…`     | same, but **only** for the `global` pseudo-package — fully independent    |
| everything else         | package `shortName`s, matched by `/^[a-z0-9-]{1,30}$/`, capped at 200     |

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
   filter currently excludes `rpdb-`, `poster-`, `sorts-`, `gsorts-`.

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
