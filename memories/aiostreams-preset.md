# AIOStreams preset (`contrib/aiostreams/`)

**Status: untracked in git as of 2026-08-31** — a work-in-progress contribution
*to another project*, not part of this addon's runtime. Nothing in `src/`
imports it, and `npm test` doesn't touch it.

`contrib/aiostreams/omnicatalog.ts` is a TypeScript `Preset` subclass written
against **AIOStreams'** internals (`../db/index.js`, `./preset.js`,
`../utils/index.js`, `../config/index.js`) so OmniCatalog can be offered as a
built-in there. It will only compile inside that repo.

## How it works

- `DEFAULT_OMNICATALOG_URL = 'https://5cfe2edf73d5-omnicatalogs.baby-beamup.club'`
  is a constant so the preset compiles before a matching entry exists in
  AIOStreams' own config; once it does, `appConfig.presets.omnicatalog.url`
  takes precedence, letting self-hosters point at their own deployment.
- `buildConfigString()` reimplements this addon's URL format —
  `{COUNTRY}_{language}[_sorts-…][_gsorts-…]_{providers…}[_global]` — including
  the **omit-when-default** rule for `sorts-`/`gsorts-`. A `configString`
  override option lets a user paste a hand-made segment instead.
- It throws with a clear message for the two impossible combinations (no
  services *and* no global types; services selected with no catalog types) —
  mirroring `generateUrl()` returning `null` in
  [configure-ui.md](configure-ui.md).
- `getCacheKey()` returns `undefined` for any non-default origin, so
  self-hosted instances aren't cached under the shared key.

## The hardcoded provider list

The preset ships a **static list of ~27 JustWatch shortNames** with display
labels, plus a free-text `extraProviders` option for anything missing. Notable:
Prime Video ships under **two different shortNames by country** — `prv` in
ES/DE/IT/FR, `amp` in US/GB — so both are offered. An unknown shortName is
simply ignored by the addon rather than failing.

Countries and languages are likewise hardcoded there (English labels), because
the preset can't call `/api/countries` at compile time.

**This is a duplicated copy of knowledge that lives in
`src/data/catalogMeta.js`.** If the language set, sort keys or config format
changes, this file drifts silently — nothing links them. Check it whenever
[config-codec.md](config-codec.md) or [i18n.md](i18n.md) changes.
