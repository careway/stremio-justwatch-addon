# Testing & verification

`npm test` → `node --test test/**/*.test.js`. No test framework, no mocks
library — plain `node:test` + `node:assert`.
**132 tests / 20 suites, all passing as of 2026-09-01.**

## The suites

| File                      | Guards                                                                    |
| ------------------------- | -------------------------------------------------------------------------- |
| `translations.test.js`    | `GENRES` integrity: every genre has a code + English name + all 19 languages, no duplicate codes, no empty strings; `getGenreNames`/`getGenreCode` round-trip and BCP-47/null handling |
| `uiStrings.test.js`       | UI languages == catalog languages **in both directions**; every language has every key non-empty; no language defines keys English lacks; `{n}` preserved in `loadMore`; `getUiStrings` fallbacks |
| `posterKeyCodec.test.js`  | client (`configure.html`) vs server (`userConfig.js`) codec agreement, plus `encodeConfig`/`decodeConfig` poster-segment round-trips including the legacy `rpdb-` shape |
| `security.test.js`        | path traversal (raw and URL-encoded), long config segments, country-param validation, config-segment injection |
| `packageTypes.test.js`    | the `m-`/`s-` per-package and `gm-`/`gs-` per-global-sort content-type codec, `buildManifest`'s use of both (including per-sort beating package-level), that `s-`/`gs-` are never confused with `sorts-`/`gsorts-`, backward compatibility of pre-feature URLs, **and** a second client-vs-server extraction test (see below) |
| `randomize.test.js`       | `seededShuffle` determinism / permutation / no-mutation, `seedWindow` behavior, that the seed window is *derived from `TTL_S`* rather than hardcoded, the `rnd` config segment round-trip (not swallowed as a package, coexists with other segments), and `buildManifest` applying the `r_` id prefix |
| `randomBlocks.test.js`    | the block shuffler through `handleCatalog` itself: **a randomized page costs exactly one upstream call** (the regression guard for the 2026-09-01 JustWatch saturation) and the same as a plain page, a page holds exactly the titles it would have held unshuffled, no depth ceiling, **earlier pages don't move when a later one is reached**, and `r_` is stripped before the id is parsed |

## The cross-implementation tests are unusual — don't break them

There are now **two** of these, on the same principle: `configure.html` carries
independent browser copies of two server codecs, and each is pinned by
extracting this page's real source text.

| Test                     | Extracts between…                                    |
| ------------------------ | ----------------------------------------------------- |
| `posterKeyCodec.test.js` | `const SAFE_POSTER_KEY_RE` → `function parsePosterSegment` |
| `packageTypes.test.js`   | the `PKG_TYPE_PREFIX` declaration → the `generateUrl` declaration |

A third trap, specific to the second test: **a top-level `const` in a vm script
is not a property of the sandbox.** `function` declarations attach to the vm's
global object, so the extracted functions destructure straight off `sandbox`,
but `PKG_TYPE_PREFIX` / `GLOBAL_TYPE_PREFIX` come back `undefined` (the failure
reads `Cannot convert undefined or null to object` from `Object.entries`). The
test appends explicit `globalThis.X = X` lines to the extracted source, which
doubles as an assertion that the block really declares them.

Two traps the second one hit while being written, both worth remembering:

1. **Don't spell the anchor identifiers in the comment above the block.** The
   first draft's comment named them in backticks, so `indexOf` matched the
   comment mention rather than the declaration and sliced a broken fragment
   (`SyntaxError: Missing initializer in const declaration`). Describe the
   anchors instead of quoting them.
2. **`vm` sandbox objects are cross-realm.** An object built inside the sandbox
   is structurally plain but carries the vm context's `Object.prototype`, so
   `assert.deepEqual` (which is `deepStrictEqual` under `node:assert/strict`)
   fails with "Values have same structure but are not reference-equal". Spread
   it into the host realm (`{ ...clientResult }`) before comparing.
   `posterKeyCodec.test.js` never hit this because it only compares strings.

## The original cross-implementation test

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

3. **A `describe` body that throws is invisible in the summary.** When the
   `packageTypes.test.js` extraction broke, the run printed
   `not ok 3 - configure.html ↔ userConfig.js` — while the totals said
   `# fail 0` and `npm test` **exited 0** (node v22.23.2). Only tests inside a
   suite are counted; a throw in the suite body isn't. So `npm test`'s exit
   code and `# fail` line are *not* sufficient — grep the output for
   `^not ok` too, especially for suites that do work at describe level.

## Stubbing the JustWatch client

`randomBlocks.test.js` tests `handleCatalog` end to end without network by
replacing `require.cache[require.resolve("../src/infra/justwatch")]` **before**
`domain/catalog.js` is first required — that module destructures `searchTitles`
at require time, so patching the export afterwards would be too late. Safe
because `node --test` runs each test file in its own process, so the stub can't
leak into another suite.

The stub serves a bottomless ranked catalog where rank N is always the same
title (`tt{N}`), which makes any reordering unambiguously the handler's own
doing and lets assertions talk in ranks. It also records the query args, which
is how "the `r_` prefix never reaches the package filter" is checked directly
rather than inferred from result ranges — the first draft of that test inferred
it and was simply wrong (a randomized page draws from 150 ranks, a plain one
from 50, so they legitimately don't overlap).

## Verifying the `/configure` UI without a browser

Headless browser verification **does not work in this environment**: the
`chromium` on PATH is the snap build, which cannot read `/tmp` paths and hangs
indefinitely on `http://127.0.0.1` (exit 21/144, empty dump). Don't spend time
on `--dump-dom` against the dev server. What works instead:

- **Extract and drive the real handler.** `scratchpad/cycle-check.js` (throwaway)
  pulled the actual `pkgGrid.addEventListener("click", …)` source out of
  `configure.html` by brace-balancing, compiled it with
  `new Function("pkgGrid", "resultEl", "generateUrl", …)` — *not* `eval`, which
  leaks function declarations into the enclosing scope — and drove it against a
  ~20-line DOM stub (`dataset`, `querySelector`, `closest`). That confirmed the
  real 4-state cycle, card independence, and that non-card clicks no-op.
- **Render the page in-process.** Call `router()` directly with a fake `res`
  (needs `setHeader`, `writeHead`, `end`) and assert on the returned HTML. No
  port, so no stale-process risk. Assert on what should be **absent** too — it
  is what caught that the old checkmark SVG and the replaced `change` listener
  were really gone.
- `node --check` on the extracted inline `<script>` catches syntax errors in
  the page's 800-line script, which nothing else in the suite does.

Also: **don't trust `curl localhost:7000` to verify a code change** — the port
can be answered by an invisible, stale-code process. Details and the preferred
in-process alternative in [project-and-deploy.md](project-and-deploy.md).

## What isn't covered

No tests for `handleCatalog` pagination/dedupe/`isUnreleased`, `buildManifest`
output, the cache layers, or the router's cache headers. Those have all been
verified only manually or by direct `require()` + call. Worth knowing before
claiming a refactor in those areas is safe.
