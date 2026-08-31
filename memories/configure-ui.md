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
   - **Catálogos globales** — `#global-sort-{pop,tnd,new}-toggle`, all
     **unchecked by default** (global is opt-in). There is no separate on/off
     toggle: checking ≥1 chip *is* what adds `"global"` to the packages array;
     unchecking all three removes it. (This replaced an earlier single
     `#global-catalogs-toggle` checkbox, removed 2026-08-25, the same day it
     was added.)
   - **Catálogos de proveedores** — `#sort-{pop,tnd,new}-toggle`, all **checked
     by default** (matches the pre-existing always-generate-all-3 behavior),
     then the provider grid `#pkg-grid` and a LIMPIAR button.
3. **Ratings en las portadas** — poster provider dropdown
   (`#cs-poster-provider`) + `#poster-api-key`.

Plus a sticky language FAB, a sidebar bio, and Discord / Ko-fi links.

## `generateUrl()`

Builds `{country}_{language}_{posterPart}{sortsPart}{gsortsPart}{packages…}` and
renders `${window.location.origin}/${config}/manifest.json`. The install button
rewrites `https?://` → `stremio://`.

Returns **`null`** (no URL) in two cases: providers are selected but their sort
group is fully unchecked (a combination that can never produce anything), or
nothing at all ends up selected.

Segments are **omitted at their default** exactly like the server does —
`sorts-` only for a partial provider selection, `gsorts-` only for a partial
global selection. Format rules: [config-codec.md](config-codec.md).

Pre-fill from `?config=`: `sorts-` always parses into the provider chips, while
`gsorts-` (or its absence, meaning "all three") is only applied to the global
chips when `"global"` is actually in the decoded packages — otherwise they stay
unchecked.

Any change to the chips, the grid or the API-key field re-runs `generateUrl()`,
but **only once the result box is already visible**.

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
