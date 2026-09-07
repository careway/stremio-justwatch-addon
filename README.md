# JustWatch · Stremio Addon

Discover where to watch movies and series on your favourite streaming platforms, powered by the [JustWatch](https://www.justwatch.com) API.

## Features

- **Per-provider catalogs** — one catalog per selected platform (Netflix, Disney+, Prime Video, …), plus an opt-in **Global** catalog (Popular/Trending/New across every platform in your country, not just the ones you picked)
- **Multi-country catalogs** — each catalog's id carries its own country + language, so a single install can serve several countries at once. Handy in front-ends like [AIOStreams](https://github.com/Viren070/AIOStreams) that let you mix catalogs from different addons/countries side by side
- **Three sort orders** — Popular, Trending and New, selectable independently per platform and for Global
- **Genre filtering** — 17 genres with localized names (20 languages)
- **Stream links** — direct deep-links to each platform with price/quality labels
- **Language-aware** — titles, descriptions and genres in the language you choose
- **Randomized catalogs** (opt-in) — daily-seeded shuffle instead of straight ranking, paging indefinitely without repeats or gaps
- **Three-tier caching**:
  1. **L1** in-memory, **L2** [Upstash Redis](https://upstash.com/) (REST/HTTPS) — catalog/search results refresh every 4h, provider package lists every 24h.
  2. **Hot cache warming** (optional, Postgres-backed) — a background loop refreshes popular queries *before* they expire (stale-while-revalidate) and keeps L1 warm across restarts, so real user traffic rarely has to wait on a live JustWatch call. See [`DATA.md`](DATA.md).
  3. Every catalog fetch pulls a 100-item block from JustWatch in one call and splits it into two 50-item pages — the second page is cached for free, roughly halving upstream calls for anyone paging through a catalog in order.
  - A failed/degraded fetch is served as a fallback but never cached (`Cache-Control: no-store`), so the next request retries instead of getting stuck on stale placeholder data.
- **Resilient upstream client** — a circuit breaker stops hammering JustWatch during an outage or a DataDome block (403s get a longer, dedicated cooldown — see `src/infra/circuitBreaker.js`), and partial GraphQL responses are served instead of discarded outright.

## Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. (Optional) copy .env.example to .env.development.local and fill in
#    what you want:
#      - UPSTASH_REDIS_REST_URL / TOKEN for the L2 cache
#      - DATABASE_URL(_POOLED) for hot cache warming + client stats
#    The addon runs fine with neither set — L1-only cache, no warming/stats.

# 3. Start the addon
npm start
# → http://127.0.0.1:7000/configure

# Dev mode (auto-restart on file changes, loads .env.development.local)
npm run dev
```

Open `http://127.0.0.1:7000/configure` in your browser, choose your country, description language and streaming providers, then use the generated install link/button to add the addon to Stremio.

### Public tunnel (for testing with Stremio desktop/mobile)

```bash
./dev-tunnel.sh            # port 7000
PORT=8080 ./dev-tunnel.sh  # custom port
```

Requires [`cloudflared`](https://github.com/cloudflare/cloudflared) (`sudo apt install cloudflared`, or drop the binary in `~/.local/bin` if you don't have root). This starts a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) *before* the server, so the addon can self-reference the tunnel's URL (logo/background images), then starts the addon and prints both the public and local `/configure` URLs. No interstitial page — the URL can be pasted into Stremio as-is. The URL changes on every run, so the addon needs reinstalling in Stremio each time.

## Deployment

The addon is a plain Node.js `http` server (no framework lock-in), so it deploys to any Node host that sets `PORT`. The L2 cache (Upstash Redis) talks REST over HTTPS and the warm-cache/stats store is regular Postgres, so neither needs a platform-specific service.

### Stremio BeamUp

[BeamUp](https://github.com/Stremio/stremio-beamup) is a Dokku-based host for Stremio addons. This repo deploys to it via `git push` (see the `beamup` remote) and manages secrets with the [`beamup-cli`](https://www.npmjs.com/package/beamup-cli) package (already a `dependencies` entry, so `npx beamup-cli <command>` works with no global install):

```bash
npx beamup-cli config    # first time only — authenticates against the BeamUp host
npx beamup-cli deploy    # same as `git push beamup master`
```

To enable the optional Redis and Postgres tiers on the deployed instance:

```bash
npx beamup-cli secrets UPSTASH_REDIS_REST_URL https://<db>.upstash.io
npx beamup-cli secrets UPSTASH_REDIS_REST_TOKEN <token>
npx beamup-cli secrets DATABASE_URL_POOLED "postgres://…"
```

Tail the live logs with:

```bash
npx beamup-cli logs
```

## Configuration URL format

Config is encoded directly in the manifest URL path — no base64, fully human-readable:

```
/{COUNTRY}_{LANGUAGE}_{pkg1}_{pkg2}…/manifest.json
```

**Example:**

```
/ES_es_nfx_dnp_prv/manifest.json
 └─ Spain, Spanish descriptions, Netflix + Disney+ + Prime Video
```

| Segment    | Description                                  | Example             |
| ---------- | --------------------------------------------- | -------------------- |
| `COUNTRY`  | ISO 3166-1 alpha-2 country code               | `ES`, `US`, `BR`     |
| `LANGUAGE` | BCP 47 language tag for descriptions          | `es`, `en`, `pt`      |
| `pkg…`     | JustWatch provider `shortName` (one or more), or `global` for the no-filter catalog | `nfx`, `dnp`, `global` |

A few extra segments toggle optional behavior when present — `r` for randomized catalogs, `sorts-…`/`gsorts-…` to narrow which sort types are generated, `m-…`/`s-…` to restrict a provider to movies/series only. All are omitted for an untouched config, so a plain `{COUNTRY}_{LANGUAGE}_{pkg…}` URL is always valid. See `src/domain/userConfig.js` for the full encoding.

Each generated catalog's own `id` additionally carries its country and language (`{COUNTRY}_{LANGUAGE}_jw_{sort}_{provider}`) — see the Features section above for why.

## Environment variables

| Variable                    | Default       | Description                                                   |
| ---------------------------- | ------------- | --------------------------------------------------------------|
| `PORT`                        | `7000`        | HTTP port                                                      |
| `NODE_ENV`                    | `development` | Set to `production` in hosted environments                    |
| `ADDON_PUBLIC_URL`            | —             | Explicit public base URL. Needed on hosts (like BeamUp) whose proxy doesn't forward a usable `Host` header — otherwise the manifest's self-referencing logo/background URLs come out unreachable. |
| `UPSTASH_REDIS_REST_URL`      | —             | Upstash Redis REST URL (L2 cache; falls back to L1-only if unset) |
| `UPSTASH_REDIS_REST_TOKEN`    | —             | Upstash Redis REST token                                       |
| `REDIS_KV_REST_API_URL`       | —             | Legacy alternative to `UPSTASH_REDIS_REST_URL`, still accepted  |
| `REDIS_KV_REST_API_TOKEN`     | —             | Alternative to `UPSTASH_REDIS_REST_TOKEN`                       |
| `DATABASE_URL_POOLED`         | —             | Postgres connection string (pooled — preferred). Enables hot cache warming and per-hour client stats; both are fully optional and off without it. |
| `DATABASE_URL`                | —             | Direct (non-pooled) Postgres connection string — fallback if `_POOLED` isn't set. |
| `WARM_TICK_MS`                | `4000`        | Gap between background cache-warming replays against JustWatch |
| `WARM_RETENTION_DAYS`         | `14`          | Stop replaying / prune a cache-warming query unrequested this long |
| `WARM_SEED_LIMIT`             | `500`         | Max rows to bulk-seed into L1 from Postgres on startup          |
| `WARM_POOL_MAX`                | `4`           | Max Postgres connections for the cache-warming pool             |
| `VISITORS_POOL_MAX`           | `2`           | Max Postgres connections for the per-hour client-stats pool     |
| `INV_KEY`                      | —             | Secret gating two admin routes: manual cache invalidation (`/api/inv/<key>?key=<cache-key>`) and runtime stats (`/api/stats/<key>`) |

See [`.env.example`](.env.example) for a template, and [`DATA.md`](DATA.md) for what gets stored where (cache warming registry, per-hour unique clients, in-process counters) and why.

## Project structure

```
src/
  index.js              — bootstrap: handler() + local dev listener
  ttl.js                — single source of truth for every cache/backoff duration
  http/
    router.js           — the whole route table
    responses.js        — respond / respondHtml / redirect
    request.js          — parseExtra, getAddonBaseUrl, getLanguageFromRequest, PORT
    logger.js           — file + stdout logger
    configure.html      — the configuration UI
  domain/               — business logic (no HTTP, no network)
    catalog.js          — browse, genre, pagination, dedupe, filtering, randomization
    manifest.js         — dynamic manifest builder
    userConfig.js       — config URL encode/decode
    random.js           — seeded shuffle for randomized catalogs
  infra/                — outside world
    justwatch.js        — JustWatch GraphQL client, block-fetch pagination, circuit breaker wiring
    circuitBreaker.js   — generic consecutive-failure breaker (per-kind cooldown override)
    warmCache.js         — Postgres-backed hot cache warming (optional)
    visitors.js          — Postgres-backed unique-clients-per-hour tracking (optional)
    cache.js             — L1 in-memory → L2 Upstash Redis
    stats.js             — in-process runtime counters + recent-errors ring
    analytics.js         — cache-hit/miss/request structured logging
    posterProviders.js   — third-party poster adapters
  data/                 — static datasets + leaf rule sets
    catalogMeta.js       — genres, countries, languages, sort map
    uiStrings.js         — /configure translations (20 languages)
    packageFilters.js    — which packages are offered + provider/channel split
scripts/
  jw-query.js            — run a JustWatch query by hand (no cache, no deps)
  seed-warm-cache.js      — pre-fill the cache-warming backlog for chosen countries
  preview-warm-queue.js   — read-only preview of the warmer's next-up queue, in order
  watch-and-warm.js       — tail production logs and replay failing queries from here
  migrate-warm-keys.js    — one-off cache-key-format migration
  migrate-seed-priority.js — one-off repair for polluted request_count rows
```

## Supported languages

`es` · `en` · `de` · `fr` · `it` · `pt` · `nl` · `sv` · `no` · `da` · `fi` · `pl` · `ja` · `ko` · `ar` · `hi` · `te` · `ml` · `kn` · `tr`

## Supported countries

127 — see `COUNTRIES` in `src/data/catalogMeta.js` for the full list, or `GET /api/countries?lang=xx` on a running instance.
