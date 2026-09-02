# Project memory — index

Memory is split **one file per technical aspect** so a session can read only
what the task needs instead of a 40 KB monolith. Read this index first, then
open the two or three files that match the work at hand.

| File                                                     | Read it when…                                                                            |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [project-and-deploy.md](project-and-deploy.md)           | running it locally, env vars, pushing to BeamUp/Render, anything host-specific      |
| [architecture.md](architecture.md)                       | you need the module map — which file owns what, and the layering rules                     |
| [http-and-caching.md](http-and-caching.md)               | touching routes, `Cache-Control`, the edge/Cloudflare staleness class of bug, `/static/*`  |
| [config-codec.md](config-codec.md)                       | touching the `/{config}/` URL segment, `encodeConfig`/`decodeConfig`, the poster-key codec |
| [catalogs-and-manifest.md](catalogs-and-manifest.md)     | catalog ids, sort types, the `global` pseudo-package, pagination, unreleased filtering     |
| [justwatch-api.md](justwatch-api.md)                     | the GraphQL client, query fields, filters, the concurrency queue                           |
| [cache-layers.md](cache-layers.md)                       | L1/L2 (Upstash) server-side cache, TTLs, manual invalidation                               |
| [poster-providers.md](poster-providers.md)               | adding/changing a poster provider adapter                                                  |
| [i18n.md](i18n.md)                                       | languages, genres, UI strings, country names, the partial-translation warning              |
| [configure-ui.md](configure-ui.md)                       | editing `src/http/configure.html`                                                          |
| [testing.md](testing.md)                                 | writing/running tests, or verifying a change — **read before claiming something works**    |
| [benchmarks-and-incidents.md](benchmarks-and-incidents.md) | capacity questions, rate limits, past production incidents                               |
| [aiostreams-preset.md](aiostreams-preset.md)             | working on `contrib/aiostreams/` (the upstream AIOStreams preset)                          |
| [open-decisions.md](open-decisions.md)                   | before researching config-URL encryption or a randomized catalog order — both already done |
| [history.md](history.md)                                 | you need the "how did we get here" narrative                                               |

## Conventions

- These files live in the repo and are **tracked by git** — they travel to
  GitHub with the code, unlike the assistant's local-only `~/.claude` memory.
  Update them in the same commit as the change they describe.
- Facts carry the date they were established, in absolute form.
- Keep each file scoped to its aspect; cross-link instead of duplicating.
  If a fact belongs to two aspects, it lives in one file and the other links to it.
