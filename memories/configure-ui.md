# The `/configure` page

One self-contained file, `src/http/configure.html` (~1990 lines: markup, CSS and
JS inline). Served by `http/router.js`, always `no-store` — see
[http-and-caching.md](http-and-caching.md).

## Structure — 3 steps

1. **País e idioma** — two searchable custom dropdowns (`#cs-country`, `#cs-language`)
   plus `#language-warning` for partial-translation languages.
2. **Elige tus plataformas** — two **independent** groups, each with its own
   Popular/Tendencias/Nuevos chips (`.toggle-item` / `.toggle-card` / `.toggle-dot`,
   with a client-side `ALL_SORT_KEYS` mirroring the server's `SORT_MAP`):
   - **Catálogos globales** — `#global-sort-{pop,tnd,new}-toggle` inside
     `#global-sort-row`, all **unchecked by default** (global is opt-in). There
     is no separate on/off toggle: checking ≥1 chip *is* what adds `"global"`
     to the packages array; unchecking all three removes it. Since 2026-08-31
     each chip is also a **4-state type cycle** — see below. (This replaced an earlier single
     `#global-catalogs-toggle` checkbox, removed 2026-08-25, the same day it
     was added.)
   - **Catálogos de proveedores** — `#sort-{pop,tnd,new}-toggle`, all **checked
     by default** (matches the pre-existing always-generate-all-3 behavior),
     then the `.pkg-cycle-hint` legend, the provider grid `#pkg-grid` and a
     LIMPIAR button.
3. **Ratings en las portadas** — poster provider dropdown
   (`#cs-poster-provider`) + `#poster-api-key`.

Plus a sticky language FAB, a sidebar bio, and Discord / Ko-fi links.

## `generateUrl()`

Builds
`{country}_{language}_{posterPart}{sortsPart}{gsortsPart}{typesPart}{packages…}`
and
renders `${window.location.origin}/${config}/manifest.json`. The install button
rewrites `https?://` → `stremio://`.

Returns **`null`** (no URL) in two cases: providers are selected but their sort
group is fully unchecked (a combination that can never produce anything), or
nothing at all ends up selected.

Segments are **omitted at their default** exactly like the server does —
`sorts-` only for a partial provider selection, `gsorts-` only for a partial
global selection. Format rules: [config-codec.md](config-codec.md).

`typesPart` / `gtypesPart` come from `encodeTypeSegments(members, types,
prefixes)` — the same helper called twice, with `PKG_TYPE_PREFIX` over the
selected packages and `GLOBAL_TYPE_PREFIX` over the enabled global sorts —
emitted in the same position and order the server writes them. Both maps only
collect items whose `data-types` is *not* `"all"`, so an untouched selection
emits nothing. See [config-codec.md](config-codec.md).

Pre-fill from `?config=`: `sorts-` always parses into the provider chips, while
`gsorts-` (or its absence, meaning "all three") is only applied to the global
chips when `"global"` is actually in the decoded packages — otherwise they stay
unchecked.

Any change to the chips, the grid or the API-key field re-runs `generateUrl()`,
but **only once the result box is already visible**.

## The 4-state click cycle (2026-08-31)

Used in **two places**: provider cards (`.pkg-item` / `.pkg-label`) and the
global sort chips (`.toggle-item` / `.toggle-card`). Both are no longer plain
checkboxes — each click walks `PKG_TYPE_CYCLE = ["all", "movie", "series"]`
and then falls off the end back to unselected:

| click | checked | `data-types` | means                 |
| ----- | ------- | ------------ | --------------------- |
| 1     | yes     | `all`        | movies **and** series |
| 2     | yes     | `movie`      | movies only           |
| 3     | yes     | `series`     | series only           |
| 4     | no      | `all`        | deselected, rewound   |

Mechanics that matter:

- **`advanceTypeCycle(item)` is the single shared step**, called by both click
  handlers, so the two surfaces can't drift into behaving differently.
- The hidden `<input type="checkbox">` **stays** as the selected-or-not source
  of truth, so `input:checked` styling, `generateUrl`'s existing
  `querySelectorAll('input:checked')` / `getElementById(…).checked` reads, and
  LIMPIAR all keep working unchanged. The content type rides separately on the
  item's `data-types`.
- For a global chip the 4th state (unchecked) is also what removes that sort
  from `gsorts-`, and dropping all three is still what removes `"global"` from
  the packages array. One control, both meanings — no separate on/off.
- A **`click` listener with `e.preventDefault()`** replaced the old `change`
  listener on both surfaces. Without the preventDefault the `<label for=…>`
  runs its own checked/unchecked toggle underneath and fights the cycle.
  Because no change event fires any more, each listener re-runs `generateUrl()`
  itself. The global chips' entry in the `for (const key of ALL_SORT_KEYS)`
  change-listener loop was **removed** as dead code; the *provider* sort chips
  keep theirs, since those are still plain checkboxes.
- Deselecting **rewinds to `all`**, so the next click starts at "both" rather
  than resuming mid-cycle. LIMPIAR rewinds every card the same way.
- `renderPackageItem(pkg, isChecked, types)` and
  `loadPackages(country, preSelected, preTypes)` thread the state through, so
  a `?config=` prefill restores each card's cycle position.

### The badges

One glyph pair, `MOVIE_GLYPH` / `SERIES_GLYPH` (classes `.type-glyph-movie` /
`.type-glyph-series` — renamed off `pkg-check-*` once they had three call
sites), rendered into three places: the provider badge, each global chip's dot,
and the legend.

- **Provider**: `.pkg-check` grew from a 16px check circle into a pill holding
  both glyphs. `data-types` hides the one that doesn't apply, so "both" shows
  two and a restricted package shows one. `min-width` + `border-radius: 999px`
  let it resize.
- **Global chip**: the existing `.toggle-dot` *is* the badge, per explicit
  request. Its `border-radius` went `50%` → `999px` so it can stretch: 16px
  square (a circle) when empty or holding one 9px glyph, a rounded rectangle
  when holding both. Only chips carrying `data-types` opt in, so the provider
  sort chips keep the plain filled circle and these rules never fire for them.

- Specificity was checked deliberately in both. For the provider badge,
  `.pkg-check svg { display: block }` is (0,1,1) and loses to
  `.pkg-item[data-types="movie"] .type-glyph-series` at (0,3,0). For the chip
  dot the show rule is (0,5,2), so the hide rule **repeats the whole
  `input:checked + .toggle-card` chain** to reach (0,6,1) — the short form
  would have been (0,4,0) and silently lost. Source order alone is not enough
  there. All of it is class/attribute-based — no inline styles, per the gotcha
  below.
- The film glyph's sprocket holes are punched out in `var(--accent)` and only
  read as holes **on top of the accent pill**. That's why the legend reuses the
  real pill (`.pkg-check.pkg-check-inline`, overriding `position`/`display`)
  instead of dropping bare glyphs into the text — recolored loose glyphs render
  as a solid blob.
- `.pkg-check-inline` must stay **after** `.pkg-check` in the stylesheet: same
  specificity, so source order is what beats `display: none`.

## Provider grid

`PINNED = [nfx, prv, atp, dnp, mxx, cru, sst, nfk, fil]` are sorted to the front
by `sortPackages()`; the rest follow in API order, with a "Cargar proveedores
restantes ({n})" expander.

## `initCustomSelect()`

A shared custom-dropdown helper. If a `.cs-search` input exists inside the
`.cs-list`, it live-filters that dropdown's `.cs-option`s via
`normalizeSearchText()` (NFD-normalize + strip combining marks + lowercase, so
`"espana"` matches `"España"`), clears and refocuses it on open, and stops its
own clicks from bubbling to the document (which would close the dropdown).

Only `#cs-country` and `#cs-language` have a `.cs-search`; the poster-provider
dropdown has 3–4 options and doesn't, so `searchInput` is `null` there and every
search path no-ops.

**Structural requirement**: the population target (`#cs-country-list` /
`#cs-language-list`) is a plain nested `<div>`, **not** the `.cs-list` element
itself, so the sticky `.cs-search` sibling survives the `.innerHTML` replacement
when the lists load.

## Language switching (FAB)

Built from `/api/languages`, applies strings instantly via `applyTranslations()`,
sets `<html lang>` and `dir`, and persists to `localStorage`
(`omnicatalog.uiLang`; falls back to `navigator.language`, then `es`).

The FAB lives **inside** the main card as its first child:
`position: sticky; top: 1.5rem; align-self: flex-end; margin-bottom: -54px` —
the negative margin makes it overlap the header instead of pushing it down.

## Gotchas that already bit

- **`data-i18n` must be removed once a real value is selected.** The country and
  language dropdown triggers start as the translated "Cargando…"
  (`data-i18n="loading"`); if the attribute stayed, a later language switch
  would overwrite the user's chosen country with "Loading…". Same class of
  problem for the poster-provider label and the API-key placeholder, which
  aren't `data-i18n` nodes at all and are re-applied explicitly at the end of
  `applyTranslations()`.
- **Never give a state-dependent visual an inline `style`.** The first version
  of the (now-removed) global toggle set its checked colors via inline
  `style="border:…;background:…"` while trying to override them from a
  `:checked` sibling rule — inline style always wins over any stylesheet rule
  regardless of specificity, so the checkbox toggled correctly (the URL updated)
  but the indicator never changed. Fixed by moving all state visuals into the
  `.toggle-card`/`.toggle-dot` classes; only non-state layout properties stay
  inline. Every chip added since reuses those classes, so none hit it again.
  This mirrors how `.pkg-item`/`.pkg-label`/`.pkg-check` already did it right —
  class-based, CSS-only `input:checked + label`.
- **Re-labelling, not rebuilding, on a language switch.** `loadCountries()`
  renames and re-sorts the *existing* `.cs-option` nodes when the list is already
  initialized, because `initCustomSelect`'s listeners are bound to those exact
  nodes and would be lost by an `innerHTML` rebuild.
- **The poster-key codec here is an independent mirror of the server's** and is
  covered by a test that extracts this file's actual source. See
  [config-codec.md](config-codec.md) and [testing.md](testing.md).
- **`encodeTypeSegments` / `parseTypeSegments` are a second such mirror**,
  extracted the same way. The comment above them deliberately does *not* spell
  the anchor identifiers in backticks — the first draft did, and `indexOf`
  matched the mention inside the comment instead of the real declaration,
  slicing a syntactically broken fragment that failed with "Missing initializer
  in const declaration". Describe the anchors, don't quote them.
