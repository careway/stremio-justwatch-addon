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
const stats = require("./stats");

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

// A request only bumps its registry row at most once per this window — a busy
// catalog would otherwise write on every hit for no ordering benefit.
const TOUCH_DEBOUNCE_MS = 5 * 60 * 1000;

let pool = null;
let warmTimer = null;
let pruneTimer = null;
let tickRunning = false;
const lastTouch = new Map(); // key -> ms, in-process debounce for touch()

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

/**
 * Record that `key` was requested. Creates the registry row if new, bumps its
 * recency/count otherwise. Debounced in-process; never throws, never awaited by
 * the caller.
 */
function touch(key, vars) {
  if (!pool) return;
  const now = Date.now();
  const prev = lastTouch.get(key);
  if (prev && now - prev < TOUCH_DEBOUNCE_MS) return;
  lastTouch.set(key, now);
  if (lastTouch.size > 5000) lastTouch.clear(); // cheap unbounded-growth guard

  pool
    .query(
      `INSERT INTO query_cache (key, vars, last_requested_at, request_count)
       VALUES ($1, $2::jsonb, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         last_requested_at = now(),
         request_count     = query_cache.request_count + 1,
         vars              = EXCLUDED.vars`,
      [key, JSON.stringify(vars)],
    )
    .then(() => stats.bump("warm.touch"))
    .catch((err) => console.warn("[warmCache] touch failed:", err.message));
}

/**
 * Store the payload a live request just produced, so a cold start can seed L1
 * from it. UPDATE-only: if the row isn't there yet, the next touch() creates it
 * and the warmer fills the payload in.
 */
function store(key, payload) {
  if (!pool) return;
  pool
    .query(
      `UPDATE query_cache SET payload = $2::jsonb, payload_at = now()
       WHERE key = $1`,
      [key, JSON.stringify(payload)],
    )
    .catch((err) => console.warn("[warmCache] store failed:", err.message));
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
      seeded++;
    }
  }
  stats.bump("warm.seed", seeded);
  console.log(
    `[warmCache] seeded ${seeded}/${rows.length} entries into L1 from Postgres`,
  );
}

async function tick(refetch, L1Cache, breaker) {
  if (tickRunning) return;
  if (breaker && breaker.isOpen()) return; // upstream is refusing us — don't dig
  tickRunning = true;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT key, vars FROM query_cache
        WHERE last_requested_at > now() - interval '${RETENTION_DAYS} days'
          AND ${dueClause()}
        ORDER BY (payload IS NOT NULL), request_count DESC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) {
      await client.query("COMMIT");
      return;
    }
    const { key, vars } = rows[0];
    let payload;
    try {
      payload = await refetch(key, vars); // network; may throw
    } catch (err) {
      await client.query("ROLLBACK"); // release the row for a later retry
      stats.bump("warm.refresh.fail");
      console.warn(`[warmCache] refresh failed for ${key}: ${err.message}`);
      return;
    }
    await client.query(
      `UPDATE query_cache SET payload = $2::jsonb, payload_at = now()
        WHERE key = $1`,
      [key, JSON.stringify(payload)],
    );
    await client.query("COMMIT");
    await L1Cache.set(key, payload, ttlFor(key));
    stats.bump("warm.refresh.ok");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already gone */
    }
    console.warn("[warmCache] tick error:", err.message);
  } finally {
    client.release();
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
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
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
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

module.exports = { start, stop, touch, store };
