"use strict";

// ─── Hot cache warming (Postgres-backed) ─────────────────────────────────────
//
// This is NOT a read-through cache tier. The request path never waits on
// Postgres. What lives here:
//
//   1. A registry of every distinct upstream query the addon has served,
//      keyed by the same cache key infra/justwatch.js already computes, with
//      its argument object (`vars`) so it can be replayed.
//   2. The last payload each of those queries returned.
//
// A background loop replays the ones whose payload is going stale, on a fixed
// trickle, and writes the fresh result straight into L1 (in-memory). So the
// upstream sees a steady drip instead of user-driven bursts, and L1 stays warm
// without anyone having asked. On a cold start (deploy, container recycle) the
// stored payloads seed L1 in one bulk read, so there is no thundering herd
// against JustWatch while the process warms up.
//
// Everything degrades to "off" when DATABASE_URL is unset or Postgres is
// unreachable — the addon then behaves exactly as it did before this module.

const { Pool } = require("pg");
const { TTL_S, PACKAGES_TTL_S } = require("../ttl");
const { COUNTRIES } = require("../data/catalogMeta");
const stats = require("./stats");

// JustWatch rejects a request for a country it doesn't recognize with a
// GraphQL error, not a normal empty result — and that's a *permanent*
// failure, not a transient one. A garbage/typo'd country ending up in
// query_cache (e.g. from a malformed user config) would otherwise sit there
// forever: every tick() retries it, it always fails, and repeated failures
// trip the *shared* upstream circuit breaker — which then blocks every
// other country's traffic too for UPSTREAM_COOLDOWN_S. Rejecting it here, at
// the only place new rows get queued, keeps it from ever being scheduled.
const VALID_COUNTRIES = new Set(COUNTRIES.map((c) => c.code));

// Strip sslmode/channel_binding from the URL — TLS is forced by the `ssl`
// option below, and leaving sslmode in triggers a pg deprecation warning on
// every connect.
function cleanConn(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.searchParams.delete("sslmode");
    u.searchParams.delete("channel_binding");
    return u.toString();
  } catch {
    return raw;
  }
}
const CONN = cleanConn(
  process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL || "",
);
const ENABLED = !!CONN;

// Replayed a little before the payload actually expires, so L1 never goes
// genuinely cold for a query that is still being asked for.
const REFRESH_AHEAD = 0.8;

// One upstream replay per tick. 4s ≈ 15/min ≈ 900/h — enough to cycle a few
// hundred combos well inside the refresh-ahead window, invisible to the
// upstream's bot protection.
const TICK_MS = Number(process.env.WARM_TICK_MS || 4000);

// Don't keep replaying a query nobody has asked for in this long.
const RETENTION_DAYS = Number(process.env.WARM_RETENTION_DAYS || 14);

// Bulk-seed L1 from at most this many rows (most-requested first) on startup.
const SEED_LIMIT = Number(process.env.WARM_SEED_LIMIT || 500);

// The background tick() only keeps the top N *search* catalogs warm, ranked
// by request_count (real demand) then seed_priority — everything past that
// cutoff falls back to a normal live fetch on the rare request that actually
// wants it, same as before any of this warming existed. Without a cap the
// warmer eventually cycles through every catalog anyone has ever touched
// within RETENTION_DAYS, most of which get one hit a year — that's cache
// warming for a long tail nobody's waiting on, at the cost of the upstream
// calls that keeps the *actually* popular catalogs fresh. `packages:*` rows
// are exempt (one per country, small and fixed in number, and every one of
// them is load-bearing for that country's manifest to work at all).
const WARM_TOP_N = Number(process.env.WARM_TOP_N || 400);

// A request only bumps its registry row at most once per this window — a busy
// catalog would otherwise write on every hit for no ordering benefit.
const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

let pool = null;
let warmTimer = null;
let pruneTimer = null;
let tickRunning = false;
const lastTouch = new Map(); // key -> ms, in-process debounce for touch()

// Keys currently in L1 because the warmer put them there (bulk seed at
// startup, or a background tick() refresh) rather than because a live
// request's own cache miss fetched and stored them. Lets cacheGet() in
// ../infra/justwatch tell "served from a cold-fetched entry" apart from
// "served from something we kept warm ahead of time" for the cache.warmHit
// stat — same L1 Map either way, this is just provenance for that one
// counter. Unbounded growth guarded the same way as lastTouch above.
const warmKeys = new Set();
function markWarm(key) {
  warmKeys.add(key);
  if (warmKeys.size > 5000) warmKeys.clear();
}
function isWarm(key) {
  return warmKeys.has(key);
}

// `packages:*` keys refresh on the slower cadence; everything else is a catalog.
const ttlFor = (key) => (key.startsWith("packages:") ? PACKAGES_TTL_S : TTL_S);

function dueClause() {
  const cat = Math.round(TTL_S * REFRESH_AHEAD);
  const pkg = Math.round(PACKAGES_TTL_S * REFRESH_AHEAD);
  return `(payload_at IS NULL OR payload_at < now() - (
    CASE WHEN key LIKE 'packages:%' THEN interval '${pkg} seconds'
         ELSE interval '${cat} seconds' END))`;
}

// ─── Public: called from the request path (fire-and-forget) ──────────────────

// Request-path writes are buffered and flushed in bulk rather than sent one
// query each. A single served catalog used to fire four (touch, store,
// registerRow, store for the sibling), and when a manifest loads Stremio asks
// for every catalog at once — dozens of concurrent INSERT/UPDATEs against a
// pool of WARM_POOL_MAX, queued past connectionTimeoutMillis and failing with
// "timeout exceeded when trying to connect". Batched, the whole burst costs a
// handful of statements every FLUSH_MS on one connection at a time.
const FLUSH_MS = Number(process.env.WARM_FLUSH_MS || 2000);
// Payloads are ~tens of KB each; keep one UPDATE's parameter reasonable.
const STORE_CHUNK = 25;
const pendingTouch = new Map(); // key -> { vars, count }
const pendingRegister = new Map(); // key -> vars
const pendingStore = new Map(); // key -> payload (latest wins)
let flushTimer = null;
let flushing = null; // Promise while a flush is in flight

function scheduleFlush() {
  if (flushTimer || !pool) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush();
  }, FLUSH_MS);
  flushTimer.unref();
}

const sortedEntries = (map) =>
  [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

async function flush() {
  if (flushing) return flushing;
  if (!pool) return;
  const touches = sortedEntries(pendingTouch);
  const registers = sortedEntries(pendingRegister);
  const stores = sortedEntries(pendingStore);
  pendingTouch.clear();
  pendingRegister.clear();
  pendingStore.clear();
  if (!touches.length && !registers.length && !stores.length) return;

  flushing = (async () => {
    // Best-effort: a failed batch is dropped, not retried — the next request
    // for the same key queues it again, and the warmer refills payloads.
    try {
      if (touches.length) {
        await pool.query(
          `INSERT INTO query_cache (key, vars, last_requested_at, request_count)
           SELECT k, v, now(), c FROM jsonb_to_recordset($1::jsonb) AS t(k text, v jsonb, c bigint)
           ON CONFLICT (key) DO UPDATE SET
             last_requested_at = now(),
             request_count     = query_cache.request_count + EXCLUDED.request_count,
             vars              = EXCLUDED.vars`,
          [JSON.stringify(touches.map(([k, { vars, count }]) => ({ k, v: vars, c: count })))],
        );
        stats.bump("warm.touch", touches.length);
      }
      if (registers.length) {
        await pool.query(
          `INSERT INTO query_cache (key, vars, last_requested_at, request_count)
           SELECT k, v, now(), 0 FROM jsonb_to_recordset($1::jsonb) AS t(k text, v jsonb)
           ON CONFLICT (key) DO UPDATE SET vars = EXCLUDED.vars`,
          [JSON.stringify(registers.map(([k, v]) => ({ k, v })))],
        );
      }
      for (let i = 0; i < stores.length; i += STORE_CHUNK) {
        const chunk = stores.slice(i, i + STORE_CHUNK);
        await pool.query(
          `UPDATE query_cache q SET payload = t.p, payload_at = now()
             FROM jsonb_to_recordset($1::jsonb) AS t(k text, p jsonb)
            WHERE q.key = t.k`,
          [JSON.stringify(chunk.map(([k, p]) => ({ k, p })))],
        );
      }
    } catch (err) {
      stats.bump("warm.flush.fail");
      console.warn(
        `[warmCache] flush failed (${touches.length} touch, ${registers.length} register, ` +
          `${stores.length} store dropped): ${err.message}`,
      );
    } finally {
      flushing = null;
      // Writes that arrived mid-flush found the timer already spent.
      if (pendingTouch.size || pendingRegister.size || pendingStore.size) scheduleFlush();
    }
  })();
  return flushing;
}

/**
 * Record that `key` was requested. Creates the registry row if new, bumps its
 * recency/count otherwise. Debounced in-process and buffered (see flush());
 * never throws, never awaited by the caller.
 */
function touch(key, vars) {
  if (!pool) return Promise.resolve();
  if (vars?.country && !VALID_COUNTRIES.has(vars.country)) {
    stats.bump("warm.touch.rejected");
    return Promise.resolve();
  }
  const now = Date.now();
  const prev = lastTouch.get(key);
  if (prev && now - prev < TOUCH_DEBOUNCE_MS) return Promise.resolve();
  lastTouch.set(key, now);
  if (lastTouch.size > 5000) lastTouch.clear(); // cheap unbounded-growth guard

  const queued = pendingTouch.get(key);
  pendingTouch.set(key, { vars, count: (queued?.count || 0) + 1 });
  scheduleFlush();
  return Promise.resolve();
}

/**
 * Register `key` exists (creating the row if needed) WITHOUT counting it as
 * demand. For the adjacent 50-page a 100-item block fetch produces for free
 * (see fetchSearchBlock in ../infra/justwatch) — nobody asked for it yet, it
 * just happened to come back alongside a page that did, so it must not bump
 * request_count or the demand filter in scripts/seed-warm-cache.js would
 * treat every provider the warmer merely *touches* as "real demand", which
 * defeats the point of that filter. A real request for this exact key still
 * goes through touch() as normal and starts counting genuinely from there.
 */
function registerRow(key, vars) {
  if (!pool) return Promise.resolve();
  if (vars?.country && !VALID_COUNTRIES.has(vars.country)) return Promise.resolve();
  pendingRegister.set(key, vars);
  scheduleFlush();
  return Promise.resolve();
}

/**
 * Store the payload a live request just produced, so a cold start can seed L1
 * from it. UPDATE-only: if the row isn't there yet, it is created by a
 * touch()/registerRow() in the same flush (those run first), or else by the
 * next touch() and the warmer fills the payload in.
 */
function store(key, payload) {
  if (!pool) return;
  pendingStore.set(key, payload);
  scheduleFlush();
}

// ─── Startup + background loop ───────────────────────────────────────────────

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS query_cache (
      key               text PRIMARY KEY,
      vars              jsonb NOT NULL,
      payload           jsonb,
      payload_at        timestamptz,
      last_requested_at timestamptz NOT NULL DEFAULT now(),
      request_count     bigint NOT NULL DEFAULT 1
    )`);
  // Seed ordering lives here, separate from request_count — see
  // scripts/seed-warm-cache.js's register(). Keeping them apart means
  // request_count stays a clean organic-traffic signal (bumped only by
  // touch() below), safe to rank real per-provider demand on.
  await pool.query(
    `ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS seed_priority bigint NOT NULL DEFAULT 0`,
  );
  // Set while tick() is refetching a row, so the row is claimed without
  // holding a connection (and a transaction) open across the network call.
  await pool.query(
    `ALTER TABLE query_cache ADD COLUMN IF NOT EXISTS leased_until timestamptz`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS query_cache_last_requested
       ON query_cache (last_requested_at)`,
  );
}

async function seedL1(L1Cache) {
  const { rows } = await pool.query(
    `SELECT key, payload, extract(epoch from payload_at) AS payload_epoch
       FROM query_cache
      WHERE payload IS NOT NULL
        AND last_requested_at > now() - interval '${RETENTION_DAYS} days'
      ORDER BY request_count DESC
      LIMIT ${SEED_LIMIT}`,
  );
  let seeded = 0;
  for (const row of rows) {
    const remaining =
      ttlFor(row.key) - (Date.now() / 1000 - Number(row.payload_epoch));
    if (remaining > 30) {
      await L1Cache.set(row.key, row.payload, Math.floor(remaining));
      markWarm(row.key);
      seeded++;
    }
  }
  stats.bump("warm.seed", seeded);
  console.log(
    `[warmCache] seeded ${seeded}/${rows.length} entries into L1 from Postgres`,
  );
}

// How long a claimed row stays off-limits to other ticks/instances. Longer
// than the upstream timeout, so a slow refetch isn't double-claimed; also acts
// as the retry backoff when a refetch fails (the lease just runs out).
const LEASE_S = 60;

async function tick(refetch, L1Cache, breaker) {
  if (tickRunning) return;
  if (breaker && breaker.isOpen()) return; // upstream is refusing us — don't dig
  tickRunning = true;
  try {
    // Claim one due row with a lease, in a single statement — no connection
    // is held while refetch() goes to the network. (It used to keep a
    // transaction open across the upstream call, pinning one of the pool's
    // few connections for up to the 10s upstream timeout every tick.)
    const { rows } = await pool.query(
      // request_count (real traffic) decides once there's any; seed_priority
      // (the backfill script's country/provider ranking — see register() in
      // scripts/seed-warm-cache.js) breaks ties among rows nobody has asked
      // for yet, so a fresh backlog isn't processed in arbitrary order.
      //
      // The inner subquery caps eligible *search* rows to the top WARM_TOP_N
      // by that same ranking — see its comment above for why. `packages:*`
      // rows skip the cap entirely.
      `UPDATE query_cache SET leased_until = now() + interval '${LEASE_S} seconds'
        WHERE key = (
          SELECT key FROM query_cache
           WHERE last_requested_at > now() - interval '${RETENTION_DAYS} days'
             AND ${dueClause()}
             AND (leased_until IS NULL OR leased_until < now())
             AND (
               key LIKE 'packages:%'
               OR key IN (
                 SELECT key FROM query_cache
                  WHERE key NOT LIKE 'packages:%'
                    AND last_requested_at > now() - interval '${RETENTION_DAYS} days'
                  ORDER BY request_count DESC, seed_priority DESC
                  LIMIT ${WARM_TOP_N}
               )
             )
           ORDER BY (payload IS NOT NULL), request_count DESC, seed_priority DESC
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING key, vars`,
    );
    if (!rows.length) return;
    const { key, vars } = rows[0];
    let payload, sibling;
    try {
      ({ payload, sibling } = await refetch(key, vars)); // network; may throw
    } catch (err) {
      // Lease left in place: the row is retried once it expires.
      stats.bump("warm.refresh.fail");
      console.warn(`[warmCache] refresh failed for ${key}: ${err.message}`);
      return;
    }
    await pool.query(
      `UPDATE query_cache
          SET payload = $2::jsonb, payload_at = now(), leased_until = NULL
        WHERE key = $1`,
      [key, JSON.stringify(payload)],
    );
    await L1Cache.set(key, payload, ttlFor(key));
    markWarm(key);
    stats.bump("warm.refresh.ok");

    // The block fetch above already paid for the adjacent 50-page — persist
    // it too (registers the row if new) so it's warm before its own turn
    // comes up. Buffered and best-effort: a failure here just leaves the
    // sibling due for its own tick later.
    if (sibling) {
      registerRow(sibling.key, sibling.vars);
      store(sibling.key, sibling.payload);
      L1Cache.set(sibling.key, sibling.payload, ttlFor(sibling.key));
      markWarm(sibling.key);
      stats.bump("warm.refresh.sibling");
    }
  } catch (err) {
    console.warn("[warmCache] tick error:", err.message);
  } finally {
    tickRunning = false;
  }
}

async function prune() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM query_cache
        WHERE last_requested_at < now() - interval '${RETENTION_DAYS} days'`,
    );
    if (rowCount) console.log(`[warmCache] pruned ${rowCount} stale entries`);
  } catch (err) {
    console.warn("[warmCache] prune failed:", err.message);
  }
}

/**
 * Wire up the warmer. Safe to call unconditionally: a no-op when DATABASE_URL
 * is unset, and it swallows every startup error so the addon still boots if
 * Postgres is down.
 *
 * @param {object}   deps
 * @param {object}   deps.L1Cache  - the in-memory cache from infra/cache
 * @param {Function} deps.refetch  - (key, vars) => Promise<payload>, from justwatch
 * @param {object}   deps.breaker  - upstream circuit breaker (optional)
 */
async function start({ L1Cache, refetch, breaker }) {
  if (process.env.NODE_ENV === "test") return; // never open a pool under the runner
  if (!ENABLED) {
    console.log("[warmCache] disabled (no DATABASE_URL)");
    return;
  }
  try {
    pool = new Pool({
      connectionString: CONN,
      ssl: { rejectUnauthorized: false }, // Neon is always TLS
      max: Number(process.env.WARM_POOL_MAX || 4),
      // Postgres may sit across the internet (self-hosted behind DuckDNS, ~60ms
      // from BeamUp): a fresh connection is TCP + TLS + SCRAM, ~7 round trips.
      // Keep connections around between the warmer's ticks instead of paying
      // that every 30s.
      idleTimeoutMillis: 5 * 60_000,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      // Everything this pool writes is a regenerable cache, so don't wait on
      // a WAL fsync per commit — on the self-hosted box that's an eMMC card
      // whose latency spikes during checkpoints. A crash loses at most the
      // last few hundred ms of cache writes, never consistency. Session-scoped
      // (a startup parameter, no extra query): the accounts pool in
      // ../infra/userStore keeps durable commits. Skipped on Neon, whose
      // pooler doesn't accept arbitrary startup parameters.
      ...(/\.neon\.tech\b/.test(CONN) ? {} : { options: "-c synchronous_commit=off" }),
    });
    pool.on("error", (err) =>
      console.warn("[warmCache] idle client error:", err.message),
    );

    await ensureSchema();
    await seedL1(L1Cache);

    warmTimer = setInterval(
      () => tick(refetch, L1Cache, breaker).catch(() => {}),
      TICK_MS,
    );
    warmTimer.unref();
    pruneTimer = setInterval(prune, 60 * 60 * 1000);
    pruneTimer.unref();
    console.log(
      `[warmCache] warming every ${TICK_MS}ms, retention ${RETENTION_DAYS}d`,
    );
  } catch (err) {
    console.warn(
      `[warmCache] disabled — startup failed: ${err.message}`,
    );
    if (pool) {
      pool.end().catch(() => {});
      pool = null;
    }
  }
}

async function stop() {
  if (warmTimer) clearInterval(warmTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  await flush();
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

module.exports = { start, stop, touch, store, registerRow, markWarm, isWarm };
