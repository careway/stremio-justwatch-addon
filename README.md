# JustWatch · Stremio Addon

Discover where to watch movies and series on your favourite streaming platforms, powered by the [JustWatch](https://www.justwatch.com) API.

## Features

- **Per-provider catalogs** — one catalog per selected platform (Netflix, Disney+, Prime Video, …)
- **Two sort orders** — Popular, Trending and New
- **Genre filtering** — 18 genres with localized names (14 languages)
- **Stream links** — direct deep-links to each platform with price/quality labels
- **Language-aware** — titles, descriptions and genres in the language you choose
- **Two-layer cache** — L1 in-memory → L2 Upstash Redis (REST/HTTPS). Catalog/search results refresh every 4h, provider package lists every 24h. Failed/degraded fetches are served as a fallback but never cached (`Cache-Control: no-store`), so the next request retries instead of getting stuck on stale placeholder data.

## Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. (Optional) Set UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN in .env
#    for the L2 cache — see .env.example. Without it the addon runs fine on
#    the L1 in-memory cache alone.

# 3. Start the addon
npm start
# → http://127.0.0.1:7000/configure

# Dev mode (auto-restart on file changes)
npm run dev
```

Open `http://127.0.0.1:7000/configure` in your browser, choose your country, description language and streaming providers, then click **"Generar enlace de instalación"** to get the manifest URL.

### Public tunnel (for testing with Stremio desktop/mobile)

```bash
./dev-tunnel.sh
```

This starts the server and opens a public HTTPS tunnel via [localtunnel](https://theboroer.github.io/localtunnel-www/). When the tunnel URL appears, open it in a browser first and click _"Click to Continue"_ before using it in Stremio.

## Deployment

The addon is a plain Node.js `http` server (no framework lock-in), so it deploys to any Node host. The L2 cache (Upstash Redis) talks REST over HTTPS, so it works identically everywhere — no platform-specific cache API involved.

### Stremio BeamUp

[BeamUp](https://github.com/Stremio/stremio-beamup) is a Heroku-style host for Stremio addons; it only needs a `package.json` with a `start` script and a server that binds to `process.env.PORT` — both already true here.

```bash
npm install -g beamup-cli
beamup config   # first time only, or when GitHub keys change
beamup          # run from the repo root — deploys and prints the addon URL
```

To enable the shared Redis cache (optional — the addon falls back to L1-only in-memory cache if unset):

```bash
beamup secrets UPSTASH_REDIS_REST_URL https://<db>.upstash.io
beamup secrets UPSTASH_REDIS_REST_TOKEN <token>
```

Redeploy after adding secrets with `beamup` (or `git push beamup master`).

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
| ---------- | -------------------------------------------- | ------------------- |
| `COUNTRY`  | ISO 3166-1 alpha-2 country code              | `ES`, `US`, `BR`    |
| `LANGUAGE` | BCP 47 language tag for descriptions         | `es`, `en`, `pt`    |
| `pkg…`     | JustWatch provider `shortName` (one or more) | `nfx`, `dnp`, `prv` |

## Environment variables

| Variable                    | Default       | Description                                                   |
| --------------------------- | ------------- | --------------------------------------------------------------|
| `PORT`                      | `7000`        | HTTP port                                                      |
| `NODE_ENV`                  | `development` | Set to `production` in hosted environments                    |
| `UPSTASH_REDIS_REST_URL`    | —             | Upstash Redis REST URL (L2 cache; falls back to L1-only if unset) |
| `UPSTASH_REDIS_REST_TOKEN`  | —             | Upstash Redis REST token                                      |
| `REDIS_KV_REST_API_URL`     | —             | Legacy alternative to `UPSTASH_REDIS_REST_URL`, still accepted |
| `REDIS_KV_REST_API_TOKEN`   | —             | Alternative to `UPSTASH_REDIS_REST_TOKEN`                      |
| `INV_KEY`                   | —             | Secret for the manual cache-invalidation route (`/api/inv/<key>`) |

See [`.env.example`](.env.example) for a template.

## Project structure

```
src/
  index.js              — bootstrap: handler() + local dev listener
  ttl.js                — single source of truth for every cache duration
  http/
    router.js           — the whole route table
    responses.js        — respond / respondHtml / redirect
    request.js          — parseExtra, getAddonBaseUrl, PORT
    logger.js           — file + stdout logger
    configure.html      — the configuration UI
  domain/               — business logic (no HTTP, no network)
    catalog.js          — browse, genre, pagination, dedupe, filtering
    manifest.js         — dynamic manifest builder
    userConfig.js       — config URL encode/decode
    random.js           — seeded shuffle for randomized catalogs
  infra/                — outside world
    justwatch.js        — JustWatch GraphQL client
    cache.js            — L1 in-memory → L2 Upstash Redis
    posterProviders.js  — third-party poster adapters
    analytics.js        — cache/request logging
  data/                 — static datasets + leaf rule sets
    catalogMeta.js      — genres, countries, languages, sort map
    uiStrings.js        — /configure translations (20 languages)
    packageFilters.js   — which packages are offered + provider/channel split
scripts/
  jw-query.js           — run a JustWatch query by hand (no cache, no deps)
```

## Supported languages

`es` · `en` · `de` · `fr` · `it` · `pt` · `nl` · `sv` · `no` · `da` · `fi` · `pl` · `ja` · `ko`
