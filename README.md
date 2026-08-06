# JustWatch · Stremio Addon

Discover where to watch movies and series on your favourite streaming platforms, powered by the [JustWatch](https://www.justwatch.com) API.

## Features

- **Per-provider catalogs** — one catalog per selected platform (Netflix, Disney+, Prime Video, …)
- **Two sort orders** — Popular, Trending and New
- **Genre filtering** — 18 genres with localized names (14 languages)
- **Stream links** — direct deep-links to each platform with price/quality labels
- **Language-aware** — titles, descriptions and genres in the language you choose
- **Two-layer cache** — L1 in-memory → L2 Upstash Redis (REST/HTTPS), 24-hour TTL

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

### Vercel

1. Create a free Redis instance at [Upstash](https://console.upstash.com) and copy the REST URL/token.
2. Deploy:
   ```bash
   vercel deploy
   ```
3. Set the following environment variables in the Vercel dashboard:
   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `UPSTASH_REDIS_REST_URL` | `https://<db>.upstash.io` |
   | `UPSTASH_REDIS_REST_TOKEN` | `<token>` |

The addon URL will be `https://<your-project>.vercel.app/<config>/manifest.json`.

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
| `REDIS_KV_REST_API_URL`     | —             | Alternative to `UPSTASH_REDIS_REST_URL` (Vercel KV integration) |
| `REDIS_KV_REST_API_TOKEN`   | —             | Alternative to `UPSTASH_REDIS_REST_TOKEN`                      |
| `INV_KEY`                   | —             | Secret for the manual cache-invalidation route (`/api/inv/<key>`) |

See [`.env.example`](.env.example) for a template.

## Project structure

```
src/
  index.js        — HTTP server, router, logger
  config.js       — Genres (18 × 14 languages), countries, encode/decode
  manifest.js     — Dynamic manifest builder
  catalog.js      — Catalog handler (browse + search + genre filter)
  stream.js       — Stream handler (JustWatch offer links)
  justwatch.js    — JustWatch GraphQL client + two-layer cache
  configure.html  — Configuration UI
api/
  index.js        — Vercel serverless entry point
vercel.json       — Vercel rewrite rules
```

## Supported languages

`es` · `en` · `de` · `fr` · `it` · `pt` · `nl` · `sv` · `no` · `da` · `fi` · `pl` · `ja` · `ko`
