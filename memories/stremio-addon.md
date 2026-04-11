# stremio-addon workspace

## Project
Stremio addon using JustWatch GraphQL API. Node.js raw `http` module, no Express, no SDK.
- **Path**: `/home/careway/stremio-addon/`
- **Port**: 7000 (`process.env.PORT || 7000`)
- **Entry**: `src/index.js`
- **Start**: `node src/index.js` or `npm start`
- **Tunnel**: `./dev-tunnel.sh` (localtunnel → public HTTPS URL)
- **Log**: `addon.log` (all requests + stack traces)

## Architecture
- `src/index.js` — HTTP server, router, logger, `getLanguageFromRequest()` (Accept-Language header)
- `src/justwatch.js` — JustWatch GraphQL (`GetPopularTitles`), two-layer cache (L1 in-memory + L2 Redis, 12h TTL)
- `src/catalog.js` — catalog handler, genre/sort filtering
- `src/manifest.js` — dynamic manifest builder, `getGenreNames(language)` for localized genres
- `src/config.js` — GENRES (18 genres × 14 languages), `getGenreNames()`, `getGenreCode()`, `encodeConfig/decodeConfig`, COUNTRIES, SORT_MAP
- `src/stream.js` — stream handler, JustWatch offer links
- `src/configure.html` — config UI (country + provider selection, no language picker)

## Config shape
`{ country: string, packages: string[] }` — base64url encoded, no language field (derived from Accept-Language header)

## Key facts
- **Package filter key**: `shortName` (e.g. `nfx`, `dnp`, `prv`) — NOT `technicalName`
- **Catalog ID**: `jw_{sortKey}_{shortName}` (e.g. `jw_pop_nfx`)
- **Sort keys**: `pop` → POPULAR, `new` → RELEASE_YEAR
- **Genre**: manifest declares localized names per language; catalog maps back via `getGenreCode(name, lang)`
- **Language**: parsed per-request from `Accept-Language` header in `index.js`, injected into config as `config.language`
- **JustWatch API**: `https://apis.justwatch.com/graphql` — `GetPopularTitles` query

## Active work (as of 2026-04-11)
- Redis cache integration **complete**
  - Redis 6 installed in devcontainer (`redis-server --daemonize yes`)
  - Client: `ioredis` (added to `dependencies`)
  - TTL: 12 hours (`EX 43200` in Redis, same in-memory)
  - Lookup order: L1 in-memory → L2 Redis → JustWatch API
  - Redis hit promotes value back into L1
  - Write on JustWatch fetch: writes to both L1 and L2 simultaneously
  - `fs`/`path` + disk cache (`cache.json`, flush interval) removed from `justwatch.js`

## Git log (recent)
- `97d189c` feat: multilingual genre names (14 languages)
- `0ed38af` feat: persist cache to disk for recovery after restarts
- `a8b03f4` feat: derive language from Accept-Language header instead of config

## Gitignore
- `addon.log`, `cache.json` — ignored
