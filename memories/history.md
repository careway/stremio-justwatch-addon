# History — how the current shape came about

Newest first. Branch `beamup` (PRs target `vercel`). Only the entries that
explain *why* something looks the way it does; full detail lives in the
aspect files.

## 2026-08-26 → 08-31

- `bbd08ff` manifest logo/background switched to `logo-256.png` / `background.png`.
- `97d691d` country names localized in the dropdown via ICU `Intl.DisplayNames`
  instead of a hand-maintained table → [i18n.md](i18n.md).
- `6b910b7` EasyRatingsDB (`erdb`) poster provider — a one-entry change, which
  is the sign the adapter registry is shaped right → [poster-providers.md](poster-providers.md).
- `90caa39` **first-party `/configure` translations**: own `uiStrings.js` dataset
  + a language-picker FAB, replacing the Google Translate link.
- `a926a25` searchable country/language dropdowns → [configure-ui.md](configure-ui.md).
- Untracked: `contrib/aiostreams/` → [aiostreams-preset.md](aiostreams-preset.md).

## 2026-08-25 → 08-27

- `15c1cbd` Hindi/Telugu/Malayalam/Kannada added (19 languages) with a
  partial-translation warning, after confirming live that JustWatch returns
  English content for them.
- `1001fff` / `8d1eb8b` unreleased titles filtered out — first client-side by
  exact date, then also pre-filtered server-side by year after "new" catalogs
  were found starving down to ~4 titles → [catalogs-and-manifest.md](catalogs-and-manifest.md).
- `58133a8` static `/api/*` routes switched to `no-store` after BetterPosters
  shipped but stayed invisible behind Cloudflare → [http-and-caching.md](http-and-caching.md).
- `5d0da46` → `ef4c32b` → `842f429` → `78844b1` → `1101fd9`: the **`global`
  pseudo-package** went through four same-week iterations — single on/off
  toggle, then one shared `sorts` selector for everything, then two fully
  independent selectors (`config.sorts` vs `config.globalSorts`), then global
  catalogs ordered first with the "General" prefix dropped. The final shape is
  the one to reason from.
- `15550cd` BetterPosters added — the first provider whose "key" is a whole URL,
  which is what forced the poster-key hex encoding.

## 2026-08-24

- `5f70f4b` **`src/` reorganized** from flat into `http/` `domain/` `infra/`
  `data/` — pure structural refactor, zero behavior change → [architecture.md](architecture.md).
- `e598c18` TDZ bug in the `/static/*` traversal branch (500 instead of 400).
- `7e342fc` / `80aa9b0` `/configure` never cached; re-read from disk in dev.
- `f81495d` concurrency queue **disabled** (`QUEUE_ENABLED = false`) hours after
  being retuned from serialize-1 to a bounded semaphore, because real Stremio
  usage still hung on cache misses → [justwatch-api.md](justwatch-api.md).
- `8eaa48d` `ttl.js` introduced as the single TTL source of truth.
- `09179b9` poster provider registry extracted.

## Earlier

- Dropped the Vercel-only `getCache()` (it crashed on non-Vercel hosts) in favor
  of portable Upstash REST L1/L2.
- Stopped tracking `beamup.json`; added `ADDON_PUBLIC_URL` for BeamUp's
  Host-header quirk.
- `0a1a2c0` (2026-04-11) added `shortDescription` to the titles query.
