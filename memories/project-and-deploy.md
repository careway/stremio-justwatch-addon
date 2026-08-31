# Project & deployment

## Identity

Stremio addon that builds catalogs from the **JustWatch GraphQL API**.
Node.js raw `http` module — **no Express, no Stremio Addon SDK**.

- npm package `omnicatalogs`, GitHub repo `stremio-justwatch-addon`,
  manifest id `community.omnicatalogs.stremio.addon`, version from `package.json`
  (1.5.0 as of 2026-08-31).
- Runtime deps are only `axios`, `@upstash/redis`, `@vercel/analytics`.
  Node >= 18.
- Working copy: `/home/ctierno/Documents/own/stremio-justwatch-addon`
  (older notes say `/workspaces/…` — that was the devcontainer).

## Running it

| Command             | What                                                       |
| ------------------- | ---------------------------------------------------------- |
| `npm start`         | `node src/index.js`, port `PORT` or 7000                    |
| `npm run dev`       | nodemon + `--env-file=.env.development.local`               |
| `npm test`          | `node --test test/**/*.test.js` — see [testing.md](testing.md) |
| `./dev-tunnel.sh`   | localtunnel → public HTTPS URL, for testing in real Stremio |

`src/index.js` exports `handler` for serverless and only calls
`http.createServer` under `require.main === module`.

Log file `addon.log` (top-level, gitignored) — writing is skipped entirely when
`NODE_ENV=production` or `process.env.VERCEL` is set (read-only FS there).

## Environment variables

| Var                                                  | Effect                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `PORT`                                               | listen port, default 7000                                     |
| `NODE_ENV=production`                                | caches `configure.html` at startup, disables file logging      |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN`                  | L2 cache — see [cache-layers.md](cache-layers.md)             |
| `REDIS_KV_REST_API_URL` / `_TOKEN`                   | same thing under the Vercel↔Upstash integration's names       |
| `INV_KEY`                                            | enables `GET /api/inv/<INV_KEY>?key=<cache-key>`              |
| `ADDON_PUBLIC_URL`                                   | **BeamUp only** — see the Host-header quirk below              |

## Deploy targets

- `origin` → `git@github.com:careway/stremio-justwatch-addon.git` — canonical repo.
- `beamup` → `dokku@a.baby-beamup.club:5cfe2edf73d5/omnicatalogs`, push-to-deploy.
  Public URL `https://5cfe2edf73d5-omnicatalogs.baby-beamup.club`.
  `beamup.json` is per-machine state and is **deliberately gitignored** — untracking
  it makes `beamup-cli` run first-time setup on a fresh clone instead of skipping
  `ssh.addRemote()`.
- Vercel — `vercel.json` rewrites everything to `api/index.js`, which is just
  `module.exports = require('../src/index')`.
- Render — `render.yaml`, free plan, spins down after 15 min idle.

Current working branch is `beamup`; the "main" branch for PRs is `vercel`.

## BeamUp quirks (both cost real production incidents)

1. **No real Host header.** Its nginx `proxy_pass` doesn't forward the public
   domain, so `req.headers.host` is the internal upstream name. The manifest's
   self-referencing `logo`/`background` URLs come out unreachable. Fix:
   set `ADDON_PUBLIC_URL`, which `getAddonBaseUrl()` (`src/http/request.js`)
   prefers over any request header. Not needed on Vercel.
2. **BeamUp sits behind Cloudflare** — confirmed 2026-08-25 from response
   headers (`server: cloudflare`, `cf-cache-status: HIT`, `age:`). This is the
   root cause of a recurring class of staleness bug; the rule that came out of
   it is in [http-and-caching.md](http-and-caching.md#edge-caching-rule).
   Note there is **no Cloudflare dashboard access** (BeamUp owns the zone), so
   nothing can be force-purged — bad cache entries must age out.

## Local-verification hazard

**Don't trust `curl http://127.0.0.1:7000/...` as proof a code change took
effect** (learned 2026-08-25). Port 7000 has been observed answered by a
process outside the sandbox's process table (the user's own `npm run dev`,
port-forwarded in), serving *stale code* from before edits made seconds
earlier. If `pgrep -af "node src/index.js"` shows nothing right before the
curl, whatever answered isn't a process this session controls. Prefer direct
in-process checks — `node -e "require('./src/…')…"` calling the real
functions. That's exactly what exposed the problem: the HTTP check showed
stale output while a direct `require()` of the same file was already correct.
