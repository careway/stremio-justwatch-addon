# Architecture — module map

`src/` was reorganized 2026-08-24 from a flat 10-file directory into layers.
Pure structural refactor, zero behavior change, one commit (`5f70f4b`).
`src/index.js` never moved, which kept `api/index.js`'s
`require('../src/index')` valid with no edit.

```
src/
  index.js          thin bootstrap: handler() + require.main dev listener
  ttl.js            deliberately still flat at the root (see below)
  http/             transport layer
    router.js       the whole route table
    responses.js    respond / respondHtml / redirect
    request.js      parseExtra, getAddonBaseUrl, getLanguageFromRequest, PORT
    logger.js       file+stdout logger, console.* monkey-patch
    configure.html  the config UI, sitting next to the route that serves it
  domain/           business logic, no HTTP, no network
    catalog.js      handleCatalog — browse/genre/pagination/dedupe/filtering
    manifest.js     buildManifest — dynamic Stremio manifest
    userConfig.js   encodeConfig / decodeConfig + poster-key codec
  infra/            outside world
    justwatch.js    GraphQL client + concurrency queue
    cache.js        L1 (Map) + L2 (Upstash Redis)
    posterProviders.js  third-party poster adapter registry
    analytics.js    Vercel Web Analytics wrapper
  data/             static datasets
    catalogMeta.js  GENRES, COUNTRIES, LANGUAGE_NAMES, SORT_MAP, GLOBAL_PACKAGE_ID
    uiStrings.js    /configure translations (19 languages)
api/index.js        Vercel entry — one line, re-exports src/index
test/               node:test suites (two of them extract source text out of
                    src/http/configure.html — see testing.md)
contrib/aiostreams/ upstream AIOStreams preset (see aiostreams-preset.md)
```

## Layering rules that actually hold

- `domain/` never imports from `http/` or touches `req`/`res`. `http/router.js`
  is the only place the two meet.
- `data/` imports nothing from the rest of the app — it's leaf data + pure helpers.
- `src/ttl.js` stayed at the root **on purpose**: it's the one cross-cutting
  constant that both `http/router.js` (HTTP `Cache-Control`) and
  `infra/justwatch.js` (server-side cache TTL) depend on. Keeping it out of any
  layer avoids an http↔infra dependency. See [cache-layers.md](cache-layers.md).
- `data/catalogMeta.js` is the home for constants two modules would otherwise
  hardcode independently — that's why `GLOBAL_PACKAGE_ID` lives there rather
  than as a string literal in both `domain/manifest.js` and `domain/catalog.js`.

## Paths that break silently if a file moves

- `domain/manifest.js` does `require("../../package.json")` for `version` —
  two levels up. This path already changed once in the reorg.
- `http/router.js` resolves static assets as
  `path.resolve(__dirname, "..", "..", "static")`.
- `test/posterKeyCodec.test.js` reads `src/http/configure.html` by path and
  extracts a `<script>` snippet out of it by matching source text — see
  [testing.md](testing.md).

## Where each aspect is documented

Routing and cache headers → [http-and-caching.md](http-and-caching.md) ·
URL config → [config-codec.md](config-codec.md) ·
catalog/manifest generation → [catalogs-and-manifest.md](catalogs-and-manifest.md) ·
GraphQL → [justwatch-api.md](justwatch-api.md) ·
posters → [poster-providers.md](poster-providers.md) ·
translations → [i18n.md](i18n.md) ·
the UI → [configure-ui.md](configure-ui.md).
