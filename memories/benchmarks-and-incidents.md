# Benchmarks & incidents

All measured 2026-08-24 unless noted. Numbers are from one devcontainer, not
production hardware — treat them as orders of magnitude.

## JustWatch tolerance to concurrency

Standalone probe: direct axios calls to the real GraphQL endpoint, bypassing
this app's queue and cache entirely, varying country + offset per call to dodge
upstream caching.

| concurrency | result                                                          |
| ----------- | ---------------------------------------------------------------- |
| 1–128       | 100% success, latency ~150 ms → ~2.2 s avg (max 7.1 s at 128)   |
| 192         | 150/192 ok, 42 timeouts (ECONNABORTED at the 10 s axios timeout) |
| 256         | 170/256 ok, 86 timeouts                                          |

**No explicit 429 at any level up to 256** — failures past ~150–190 were pure
latency/timeout, not rate-limit rejection. This directly contradicted the
original queue's code comment, which assumed JustWatch 429s under any
parallelism.

Caveats: single burst from one IP, not sustained volume; and shared IP ranges
(Vercel/BeamUp) may have different reputation than the test IP, so real-world
429s at lower concurrency remain possible.

Outcome and current state of the queue: [justwatch-api.md](justwatch-api.md).

## Incident — devcontainer IP 403-blocked by JustWatch

Minutes after the 256-concurrency burst, **every** call to
`apis.justwatch.com/graphql` from that container returned HTTP 403 with a bare
`<!doctype html>…403 Forbidden` body — including a single non-parallel, trivial
request. That's an edge/WAF block (no JSON body, no GraphQL `errors` array), not
the "aggressive 429" the code comment described. It self-resolved in roughly
5–10 minutes with no action.

**Takeaway**: don't run high-concurrency bursts against JustWatch's live API
from a dev environment without expecting a temporary IP block. Prefer exercising
this app's own server with a warm cache; if a direct probe is genuinely needed,
treat it as one-shot. Production egresses from different IPs and is presumed
unaffected — not directly verified.

This block also invalidated a verification run — see the lesson in
[testing.md](testing.md).

## This app's own capacity

Warm L1 cache, 93 distinct URLs (5 countries × 3 packages × 2 types × 3 sorts +
a few non-catalog routes) round-robined, 5 s client timeout.

| concurrency | requests | failures            | throughput   | p50    | p99    |
| ----------- | -------- | ------------------- | ------------ | ------ | ------ |
| 100         | 1,000    | 0                   | ~2,860 req/s | 29 ms  | 88 ms  |
| 300         | 3,000    | 0                   | ~3,120 req/s | 64 ms  | 936 ms |
| 500         | 5,000    | 0                   | ~4,110 req/s | 61 ms  | 1.19 s |
| 1,000       | 10,000   | 0                   | ~3,620 req/s | 118 ms | 2.66 s |
| 2,000       | 20,000   | 224 timeouts (1.1%) | ~3,280 req/s | 244 ms | 6.08 s |
| 3,000       | 30,000   | 1,269 (4.2%)        | ~4,260 req/s | 403 ms | 5.64 s |

**Zero errors up to 1,000 concurrent connections.** Failures past 2,000 are
client-side 5 s timeouts from Node's single-threaded event loop queueing —
throughput stays flat (~3–4k req/s) as failures appear, so it's a latency
effect, not a crash. At 3,000 the load generator (also Node, same host) was
contending for CPU, so those results aren't purely server-side.

1,000 concurrent with zero failures is a large margin over any realistic traffic
for a hobby-scale addon. **Capacity is not this project's bottleneck** — don't
spend effort optimizing throughput without new evidence.

## Cold-load behavior that started all of this

Stremio requests every configured catalog near-simultaneously on manifest load
(e.g. 4 providers × 2 types × 3 sorts = 24 catalogs). With the original
serialize-to-1 queue, 6 parallel cold requests took 199 ms → 631 ms in a visible
staircase (server-side `addon.log` timings) while warm/L1-cached requests were
0–1 ms. **The queue was the bottleneck, not the cache.**

## Production incidents index

Both Cloudflare staleness incidents and the BeamUp Host-header quirk are
documented where the fix lives:
[http-and-caching.md](http-and-caching.md) and
[project-and-deploy.md](project-and-deploy.md).
