# HTTP layer — routes & cache policy

Everything here is `src/http/router.js` unless stated otherwise.

## Route table

| Route                                        | Notes                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| `OPTIONS *`                                  | 204 + permissive CORS, handled first                                    |
| `/` and `/configure`                         | the config UI, `no-store`                                              |
| `/favicon.ico`                               | 302 → `/static/favicon.ico`                                            |
| `/static/*`                                  | file serving, `public, max-age=31104000`                               |
| `/manifest.json`                             | config-less manifest, `STATIC_CACHE_CONTROL`                           |
| `/api/countries?lang=xx`                     | localized country list, `no-store`                                     |
| `/api/languages`                             | supported languages, `no-store`                                        |
| `/api/ui-strings?lang=xx`                    | `{ lang, rtl, strings }`, validates the code (400 otherwise), `no-store` |
| `/api/poster-providers`                      | adapter list for the UI, `no-store`                                    |
| `/api/packages?country=XX`                   | real JustWatch call, `STATIC_CACHE_CONTROL`, 400 on a bad code         |
| `/api/inv/<INV_KEY>?key=<cache-key>`         | manual L1+L2 invalidation, 202                                         |
| `/{config}/configure`                        | 302 → `/configure?config=…` (Stremio builds this URL itself)           |
| `/{config}/manifest.json`                    | `CATALOG_CACHE_CONTROL`, or `no-store` if the packages fetch failed    |
| `/{config}/catalog/{type}/{id}[/{extra}].json` | `CATALOG_CACHE_CONTROL`, or `no-store` when `result.ok === false`     |
| anything else                                | 404 JSON                                                               |

`rawPath` strips the query string **and any trailing slash**. The `/{config}/`
match is `/^\/([A-Za-z0-9_-]+)\/(.*)/`, and the config is rejected with 400 if
`decodeConfig()` returns null. Language is injected after decoding when the
config carries none: `getLanguageFromRequest()` → `Accept-Language` primary
subtag (ignored when it's `en`) → the `COUNTRY_LANGUAGE` map in
`src/http/request.js` → `"en"`.

## Cache-Control constants

Both derive from `src/ttl.js`, which is the single source of truth
(`TTL_H = 4` → `TTL_S`; `PACKAGES_TTL_H = TTL_H * 6` = 24 h). Nothing else
should hardcode a duration.

```js
CATALOG_CACHE_CONTROL = `s-maxage=${TTL_S}, stale-while-revalidate=${TTL_S}`
STATIC_CACHE_CONTROL  = `s-maxage=${PACKAGES_TTL_S}, stale-while-revalidate=${PACKAGES_TTL_S * 2}`
```

`respond()`'s own default (`max-age=300, stale-while-revalidate=600`) only
applies to callers that pass nothing — mostly error responses.

## Edge-caching rule

**Default a new static-data route to `no-store`.** Only use
`STATIC_CACHE_CONTROL` when there's a genuine external call behind the route
worth protecting.

Why: BeamUp sits behind Cloudflare (see
[project-and-deploy.md](project-and-deploy.md)), and an edge-cached response
can outlive a deploy by up to ~3 days (`s-maxage` + `stale-while-revalidate`).
This has already caused two incidents:

1. `/configure` served a stale pre-poster-provider page for one specific
   `?config=` URL. Fixed in `respondHtml()`, which now always sends
   `Cache-Control: no-store` — that page carries per-user state in its query
   string and must never sit in a shared cache.
2. **BetterPosters shipped in code but stayed invisible in production** because
   `/api/poster-providers` sent `STATIC_CACHE_CONTROL` and Cloudflare kept
   serving the previous deploy's response.

Fixed 2026-08-25 by switching `/api/countries`, `/api/languages`,
`/api/ui-strings` and `/api/poster-providers` to `no-store`. None of the four
makes an external call — `fetchCountriesFromJustWatch()` is a local ICU
localization of a hardcoded list, `getSupportedLanguages()` derives from
`GENRES`, `listProviders()` reads a static array — so caching them buys nothing
and only risks staleness. `/api/packages` and `/manifest.json` keep
`STATIC_CACHE_CONTROL` deliberately.

**Caveat**: the fix prevents future staleness only. Entries cached before the
fix age out on their own; there's no dashboard access to purge them.

## `configure.html` serving

`CONFIGURE_HTML_CACHED` is read once at module load in production (every deploy
restarts the process anyway) and re-read from disk per request otherwise, so
editing the file shows up in dev without a restart.

## `/static/*` path traversal

Two checks: a naive `fileName.includes("..")` reject, then
`filePath.startsWith(staticDir + path.sep)`.

The second one is **not dead code** — it catches an absolute-path bypass:
`/static//etc/passwd` makes `fileName` start with `/`, and
`path.resolve(staticDir, fileName)` discards `staticDir` entirely for an
absolute second argument, so the result contains no `..` (passes check 1) but
does escape `staticDir`.

Fixed 2026-08-24 (`e598c18`): that branch referenced `mime` before its own
`const mime = …` declaration (TDZ), so it threw a `ReferenceError` that
`handler`'s try/catch degraded into a generic 500 instead of the intended
clean 400. `mime`/`ext` now compute above the check. Verified live:
`/static//etc/passwd` returns 400 with nothing logged.

Worth remembering: `test/security.test.js`'s traversal tests only assert
`status !== 200`, so they passed the whole time it was returning a 500.

## Known unfixed issue — `INV_KEY` guard

`const inv_key = process.env.INV_KEY || ""` then `if (rawPath == "/api/inv/" + inv_key)`.
With `INV_KEY` unset the target is `/api/inv/`, which can never match because
`rawPath` strips the trailing slash — **safe by accident, not by design**.
It should get an explicit `if (!inv_key) ` guard. Tracked in
[open-decisions.md](open-decisions.md).
