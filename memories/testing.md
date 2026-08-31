# Testing & verification

`npm test` → `node --test test/**/*.test.js`. No test framework, no mocks
library — plain `node:test` + `node:assert`.
**75 tests / 11 suites, all passing as of 2026-08-31.**

## The suites

| File                      | Guards                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `translations.test.js`    | `GENRES` integrity: every genre has a code + English name + all 19 languages, no duplicate codes, no empty strings; `getGenreNames`/`getGenreCode` round-trip and BCP-47/null handling |
| `uiStrings.test.js`       | UI languages == catalog languages **in both directions**; every language has every key non-empty; no language defines keys English lacks; `{n}` preserved in `loadMore`; `getUiStrings` fallbacks |
| `posterKeyCodec.test.js`  | client (`configure.html`) vs server (`userConfig.js`) codec agreement, plus `encodeConfig`/`decodeConfig` poster-segment round-trips including the legacy `rpdb-` shape |
| `security.test.js`        | path traversal (raw and URL-encoded), long config segments, country-param validation, config-segment injection |

## The cross-implementation test is unusual — don't break it

`posterKeyCodec.test.js` reads `src/http/configure.html`, **extracts the source
text between `const SAFE_POSTER_KEY_RE` and `function parsePosterSegment`**, and
runs it with `vm.runInContext` in a sandbox providing `TextEncoder`/`TextDecoder`.
It then pushes the same key vectors through both implementations, both
directions, and asserts cross-compatibility.

Consequences: renaming either of those two anchor identifiers, or moving that
block, **breaks the extraction**. That's intentional — it's the only thing
stopping the two independent codec implementations from silently drifting apart.
Writing this test immediately caught a real bug (the `"url-deadbeef"` collision,
see [config-codec.md](config-codec.md)).

## Two verification lessons paid for in production

1. **Check response *content*, not just status or latency.** During the
   concurrency work, a "clean" verification (~0.35 s per request, no errors) was
   entirely invalid: JustWatch had IP-blocked the environment, and the fast
   times were the app's own error-fallback path — which returns **HTTP 200**
   with placeholder metas, deliberately fast. Only timing had been inspected.
   A proper re-run inspected bodies and found 18/24 genuine results + 6
   legitimately-empty catalogs. See
   [benchmarks-and-incidents.md](benchmarks-and-incidents.md).
2. **A passing test isn't proof of the behavior you assume it checks.**
   `security.test.js`'s traversal tests only assert `status !== 200`, so they
   passed happily while that branch was throwing a `ReferenceError` and
   returning 500 instead of the intended 400. See
   [http-and-caching.md](http-and-caching.md).

Also: **don't trust `curl localhost:7000` to verify a code change** — the port
can be answered by an invisible, stale-code process. Details and the preferred
in-process alternative in [project-and-deploy.md](project-and-deploy.md).

## What isn't covered

No tests for `handleCatalog` pagination/dedupe/`isUnreleased`, `buildManifest`
output, the cache layers, or the router's cache headers. Those have all been
verified only manually or by direct `require()` + call. Worth knowing before
claiming a refactor in those areas is safe.
