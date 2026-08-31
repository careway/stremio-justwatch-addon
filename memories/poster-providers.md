# Poster providers

`src/infra/posterProviders.js` — an adapter registry. Nothing in `catalog.js`,
the config codec, or the UI knows any provider's specifics; they all just read
the list and call `resolvePosterUrl()`.

## Registered adapters (4)

| id           | Name                  | Key                 | URL shape                                                     |
| ------------ | --------------------- | ------------------- | -------------------------------------------------------------- |
| `rpdb`       | RatingPosterDB        | required, `t8-…`    | `api.ratingposterdb.com/{key}/imdb/poster-default/{imdbId}.jpg` |
| `topposters` | TOP Posters           | required, `TP-…`    | `api.top-posters.com/{key}/imdb/poster-default/{imdbId}.jpg`    |
| `erdb`       | EasyRatingsDB         | required, `Tk-…`    | `easyratingsdb.com/{token}/poster/{imdbId}.jpg`                  |
| `btttr`      | BetterPosters         | **optional** URL    | `btttr.cc/poster/imdb/poster-default/{imdbId}.jpg` by default    |

Provider entry fields: `id`, `name`, `requiresKey`, `keyIsUrlTemplate`,
`keyPlaceholder`, `keyHelpUrl`, `buildUrl`. `listProviders()` returns everything
except `buildUrl`, so no internals leak to the UI.

## `resolvePosterUrl()` order

configured provider (needs an imdbId **and** either `requiresKey === false` or a
key was given) → JustWatch's own `https://images.justwatch.com{posterUrl}` →
`https://images.metahub.space/poster/medium/{imdbId}/img` as the keyless
universal fallback.

The `provider.requiresKey === false` check is **strict on purpose** — a future
entry that forgets the flag defaults to "needs a key" rather than silently
going keyless.

## BetterPosters is the odd one out

`requiresKey: false` means "has a working default with no input", **not**
"rejects input". `keyIsUrlTemplate: true` marks that its field accepts a whole
custom URL the user builds at `btttr.cc/configure` → "AIOMetadata / Other Addon"
and pastes in entire, e.g.
`https://btttr.cc/poster-qa/imdb/poster-default/{imdb_id}.jpg?lang=es-ES`.
The literal `{imdb_id}` placeholder is always present; the
`poster`/`poster-g`/`poster-r`/`poster-n` + optional `q`/`a` suffixes are
btttr's own style encoding — we never construct those, we just substitute.

`resolveImdbIdPlaceholder()` handles a **real, btttr-documented gotcha**: iOS's
clipboard can percent-encode a copied pattern (`{imdb_id}` → `%7Bimdb_id%7D`).
It tries the raw string first, then the `decodeURIComponent()`'d form, and
returns null if neither has the placeholder (falling back to the default URL).

## ERDB notes (added 2026-08-26)

Token-based: every style, layout, badge and rating-provider choice lives
server-side behind the token, so the addon only ever needs the `Tk-…` string —
no TMDB/MDBList keys, no query params. Types available are
poster/backdrop/logo/thumbnail; only `poster` is used.

Adding it required **no changes anywhere else** — `/configure` lists it
automatically from `/api/poster-providers`, and `Tk-…` fits `SAFE_KEY_RE` so
the codec stores it verbatim. That's the test of a correctly-shaped adapter:
**adding a token-based provider should be a one-entry change.**

ERDB's docs mention an optional `erdbBaseUrl` for self-hosted instances —
**deliberately not implemented**; the registry has no notion of a per-provider
base URL and nobody asked.

## Privacy note

Whatever key a user configures is embedded in **every poster URL** returned to
Stremio, so it reaches the client, the CDN and logs regardless of what the
config segment looks like. Relevant to any "encrypt the config URL" idea —
see [open-decisions.md](open-decisions.md).

URL encoding of keys: [config-codec.md](config-codec.md).
