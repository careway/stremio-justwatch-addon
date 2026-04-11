# JustWatch · Stremio Addon

Discover where to watch movies and series on your favourite streaming platforms, powered by the [JustWatch](https://www.justwatch.com) API.

## Features

- **Per-provider catalogs** — one catalog per selected platform (Netflix, Disney+, Prime Video, …)
- **Two sort orders** — Popular, Trending and New
- **Genre filtering** — 18 genres with localized names (14 languages)
- **Stream links** — direct deep-links to each platform with price/quality labels
- **Language-aware** — titles, descriptions and genres in the language you choose
- **Two-layer cache** — L1 in-memory → L2 Redis, 12-hour TTL

## Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. Start Redis (required for L2 cache; falls back to in-memory if unavailable)
redis-server --daemonize yes

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

## Deployment (Vercel)

1. Create a free Redis instance at [Upstash](https://console.upstash.com) and copy the `rediss://…` connection URL.
2. Deploy to Vercel:
   ```bash
   vercel deploy
   ```
3. Set the following environment variables in the Vercel dashboard:
   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `REDIS_URL` | `rediss://default:<password>@<host>:<port>` |

The addon URL will be `https://<your-project>.vercel.app/<config>/manifest.json`.

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

| Variable     | Default       | Description                                   |
| ------------ | ------------- | --------------------------------------------- |
| `PORT`       | `7000`        | HTTP port                                     |
| `NODE_ENV`   | `development` | Set to `production` on Vercel                 |
| `REDIS_URL`  | —             | Full Redis connection URL (takes precedence)  |
| `REDIS_HOST` | `127.0.0.1`   | Redis host (used when `REDIS_URL` is not set) |
| `REDIS_PORT` | `6379`        | Redis port (used when `REDIS_URL` is not set) |

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
