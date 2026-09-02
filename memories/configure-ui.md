# The `/configure` page

One self-contained file, `src/http/configure.html` (~1990 lines: markup, CSS and
JS inline). Served by `http/router.js`, always `no-store` — see
[http-and-caching.md](http-and-caching.md).

## Structure — 3 steps

1. **País e idioma** — two searchable custom dropdowns (`#cs-country`, `#cs-language`)
   plus `#language-warning` for partial-translation languages.
2. **Elige tus plataformas** — opens with the full-width `#randomize-toggle`
   card (`rnd` config segment, applies to **both** catalog groups — global and
   provider), then two **independent** groups, each with its own
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
     by default** (matches the pre-existing always-generate-all-3 behavior).
     Since 2026-09-02 these three live **inside `.pkg-tabbar`**, on the same
     baseline as the Proveedores/Canales tabs and rendered smaller — they
     govern both panes (a channel is a package like any other), which is why
     they sit on the bar and not inside a pane. Then the `.pkg-cycle-hint`
     legend, the grid and a LIMPIAR button.
3. **Ratings en las portadas** — poster provider dropdown
   (`#cs-poster-provider`) + `#poster-api-key`.

Plus a sticky language FAB, a sidebar bio, and Discord / Ko-fi links.

## `generateUrl()`

Builds
`{country}_{language}_{posterPart}{rndPart}{sortsPart}{gsortsPart}{typesPart}{packages…}`
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

## Provider grid — two panes, Proveedores / Canales (2026-09-02)

A **channel** is a service watched through another subscription ("HBO Max
Amazon Channel" rides on Amazon Prime Video). Its catalogue duplicates the
direct provider's, so mixing both in one grid buries the entry people actually
want. They're split into two tabs on `pkg.isAddon`.

`isAddon` is **JustWatch's `addonParent` plus a name-suffix supplement**, because
`addonParent` alone misses ~110 of them in US — every Apple TV channel and a
long tail of Amazon ones. The rule and its 15-country false-positive audit live
in [justwatch-api.md](justwatch-api.md); don't loosen it to a bare `/channel/i`,
which would swallow Channel 4, Criterion Channel and The Roku Channel.

Structure: `.pkg-tabs` (two `.pkg-tab` buttons) → `#pkg-panes`
(the `.grid-container`) → `#pkg-grid` + `#channel-grid`, plus `#channels-hint`
and `#channel-filter`, both shown only on the channels tab.

### The `[hidden]` trap that made both tabs look identical

`#pkg-grid, #channel-grid { display: grid }` is an **ID** selector (1,0,0), so
it outranks the browser's own `[hidden] { display: none }` — the attribute did
nothing and **both panes rendered at once, stacked**, which is why the two tabs
appeared to show the same thing. Fixed with an explicit
`#pkg-grid[hidden], #channel-grid[hidden], .pkg-item[hidden] { display: none }`
at (1,1,0). Never rely on the bare `hidden` attribute against an id-scoped
`display` rule.

### The tab bar

`.pkg-tabbar` is `justify-content: space-between` with `align-items: flex-end`:
`.pkg-tabs` on the left, `.pkg-sorts` (Popular/Tendencias/Nuevos) on the right,
sharing one baseline. It `flex-wrap`s so a narrow screen gets two rows instead
of an overflow — the tab seam survives that because the tabs keep their own row.

The compact chips reuse `.toggle-card` / `.toggle-dot` untouched; `.pkg-sorts`
only overrides **sizing** (padding, gap, radius, font-size, dot dimensions).
Every checked/unchecked visual stays in the shared classes, so the small and
full-size chips can't drift apart. The provider chips' old inline
`font-size`/`padding` were removed for this — the *global* chips still carry
theirs and are deliberately left at full size.

Note `.toggle-item[data-types]` (the 4-state cycle) is only on the global chips,
so the provider sort chips keep a plain filled circle and none of the badge
rules reach them.

### Browser-style tabs

`.pkg-tabs` has no baseline of its own; the baseline is `.grid-container`'s
`border-top`. The active tab sits at `bottom: -1px` so it overlaps that line,
paints over its slice with its own `var(--glass)` fill (85% opaque, enough to
hide the 0.1-alpha border under it) and sets `border-bottom-color: transparent`
so it draws no line of its own. That seam is the whole illusion — remove any of
those three and it goes back to looking like two buttons.

### Parent filter (channels tab)

`#channel-parents` holds one `.chan-chip` per parent service plus an "All" chip,
built from the channels actually present in the country. Real data is thin:
usually **one** parent (Amazon Prime Video), occasionally two (US adds The Roku
Channel with 4; GB adds Now TV with 1).

- Styled **deliberately unlike** `.pkg-item`: dashed outline, pill shape, and
  the secondary purple rather than the selection pink, under an uppercase
  "FILTRAR POR SERVICIO" label — so it can't read as another thing you're
  picking.
- `applyParentFilter()` **hides** non-matching items (`item.hidden`) instead of
  re-rendering. A channel that is selected and then filtered out stays checked
  and stays in the generated URL; the tab badge is what tells the user it's
  still there.
- **The channels pane renders in full** (no expander), unlike providers. A
  parent filter over a lazily-drawn list would silently show nothing whenever
  the matches sat past the undrawn tail. The pane is at most ~105 entries.

- **Both panes stay in the DOM**, one `hidden`. Selections survive a tab switch
  for free, with no state model to keep in sync. Everything that reads the grid
  — `generateUrl`, LIMPIAR, the cycle click handler — is bound to `#pkg-panes`,
  **not** `#pkg-grid`, so it never misses the pane that isn't showing. Binding
  any of them back to `#pkg-grid` silently drops every channel selection.
- `.pkg-tab-count` shows how many items are selected **per pane**. Without it a
  selection in the hidden tab is invisible and the generated URL looks wrong for
  no apparent reason. `updateTabCounts()` must be called after anything that
  changes a checkbox (the cycle handler, LIMPIAR, a re-render).

### Expand / collapse (2026-09-02)

The expander persists once used and flips to the opposite action —
`loadMore` ⇄ `collapseList` — instead of disappearing after one click.

- **`applyVisibility(name)` is the single place deciding what a pane shows**,
  so collapsing and the channels parent filter can't fight over the same items.
  Both set `hidden`; neither removes nodes, because a removed node takes its
  checkbox with it and `generateUrl` reads selections out of the DOM.
- Expanding creates the tail **once** (`growPane`); after that, expand/collapse
  is pure visibility — instant, and it never re-renders an existing item.
- **A checked item is never hidden by collapsing** (`i >= INITIAL_ITEMS &&
  !checked`). Otherwise your own pick would vanish from view while staying in
  the generated URL. Collapsing a 40-item pane with one selection at index 35
  therefore shows 11, not 10.
- **`pane.lazy` gates the control.** Providers are lazy; channels are not (they
  draw whole so the parent filter can match anything). Without the gate,
  channels offered "Contraer lista" having never been expanded, which reads as
  a bug — that is exactly what the DOM-model harness caught.

### Two bugs this rework fixed — don't reintroduce them

Both came from the old `renderPackages`, which re-rendered via `innerHTML` and
recomputed every checkbox from the *pre-fill*:

1. **"Cargar proveedores restantes" wiped manual selections.** `draw(count)`
   replaced the whole grid, so anything the user had clicked came back
   unchecked. Now `growPane()` **appends** with `insertAdjacentHTML("beforeend")`
   and never re-renders an existing item.
2. **A pre-selected provider outside the first 10 vanished on reconfigure.**
   Only `INITIAL_ITEMS` are drawn, and `generateUrl` reads selections out of the
   DOM — so a package at index 35 in a `?config=` pre-fill was simply not there
   and silently dropped from the regenerated URL. `renderPackages` now sorts
   pre-selected entries to the front of their pane and draws
   `Math.max(INITIAL_ITEMS, picked.length)`.

Verified by extracting the real pane block and running it against a DOM model —
see [testing.md](testing.md).

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
- **The three top-level `async` IIFEs race, and the `?config=` init block used
  to crash on it (fixed 2026-09-01).** Poster-providers, languages, and
  countries each load in their own IIFE. `countrySel` / `languageSel` start
  `null` and are only set once their IIFE finishes. The country IIFE also does
  the `?config=` pre-fill after `await loadCountries()` (**one** request), while
  the language dropdown needs 2–3 — so `languageSel` was reliably still `null`
  when the init block hit `languageSel.value = lang`, throwing, which the init
  `catch` swallowed as "Failed to load countries" and **`loadPackages()` never
  ran → empty provider grid on every reconfigure link**. Fix: the init block
  guards both assignments (`if (languageSel) …`) and only `updateLanguageWarning`
  runs unconditionally; the language IIFE applies `cfgParts[1]` itself once its
  dropdown exists (the authoritative place). Any new init code that touches a
  cross-IIFE `let` must assume it can be `null`.
- **`#pkg-grid` needs `padding-top: 5px`.** `.pkg-label:hover` lifts the card
  `translateY(-4px)` while `.grid-container` clips with `overflow-y: auto`, so
  without that clearance the top row's hover animation is cut off. It is not
  decorative spacing — don't fold it into `gap` or delete it as redundant.
- **`.btn-cap-aligned` (LIMPIAR) needed *two* overrides to take effect.** It
  aligns the button's top edge with the **cap height** of the
  "Catálogos de proveedores" label — `align-items: flex-start` on the row lines
  up the boxes, `line-height: 1` on the label makes the gap deterministic, and
  `margin: 1px 0 0` covers what the line box leaves above the capitals. Two
  traps, both hit while writing it: the button carried an inline `margin: 0`
  (inline outranks any rule, so the class did nothing), and the class was
  declared *before* `.btn-show-more`, whose `margin-top: 0.5rem` has identical
  specificity and therefore won on source order. It must stay after it, and the
  button must stay free of an inline `margin`.
- **The cycling surfaces need `user-select: none`.** Picking a content type
  takes up to 4 consecutive clicks, which the browser also reads as a
  double-click: without it the provider name (or chip label) gets highlighted
  mid-cycle and the gesture reads as a failed text selection. On `.pkg-label`
  and `.toggle-card`, `-webkit-` prefixed for iOS Safari. `.pkg-icon` also gets
  `pointer-events: none` + `-webkit-user-drag: none` so a click that drifts a
  pixel doesn't start dragging the logo — clicks fall through to the label,
  which is what `closest(".pkg-label")` wants anyway.
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
