"use strict";

// ─── Unique clients per hour (Postgres-backed) ───────────────────────────────
//
// Answers "how many distinct clients hit the addon, hour by hour, over the
// last 7 days?" for the /api/stats endpoint. Deliberately NOT in ./stats:
// that module is in-process and resets on every restart (see its own
// comment) — a 7-day series has to survive dyno cycling, so it needs the
// same Postgres store warmCache.js already uses. Degrades to "off" exactly
// like warmCache when DATABASE_URL is unset.
//
// Privacy: the client IP itself is never stored, only a truncated SHA-256 of
// it — enough to dedupe within an hour, not enough to be the IP itself.
// Rows older than the 7-day window this endpoint shows are pruned, so no
// hash outlives the data it's for.

const crypto = require("crypto");
const { Pool } = require("pg");

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

const RETENTION_DAYS = 7;
const HOURS_IN_WINDOW = RETENTION_DAYS * 24;

let pool = null;
let pruneTimer = null;

// In-process debounce: at most one INSERT per (hour, ip) per this instance's
// own lifetime, not one per request — a busy hour would otherwise write on
// every single hit for no dedup benefit (Postgres would just no-op the
// ON CONFLICT anyway, but there's no reason to round-trip for it).
let currentHourKey = null;
let seenThisHour = new Set();

function clientIp(req) {
  // BeamUp/dokku (and any nginx-style proxy) sets this; the client's own IP
  // is the first hop. Falls back to the raw socket for direct/local
  // connections where no proxy is in front.
  const xff = req.headers["x-forwarded-for"];
  if (xff) return String(xff).split(",")[0].trim();
  return req.socket?.remoteAddress || "";
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function hourBucketOf(date) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/**
 * Record that `req` was seen this hour. Fire-and-forget: never throws, never
 * awaited by the caller, a no-op when DATABASE_URL is unset.
 */
function track(req) {
  if (!pool) return;
  const ip = clientIp(req);
  if (!ip) return;

  const hourKey = hourBucketOf(Date.now()).toISOString();
  if (hourKey !== currentHourKey) {
    currentHourKey = hourKey;
    seenThisHour = new Set();
  }
  const ipHash = hashIp(ip);
  if (seenThisHour.has(ipHash)) return;
  seenThisHour.add(ipHash);

  pool
    .query(
      `INSERT INTO hourly_visitors (hour_bucket, ip_hash) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [hourKey, ipHash],
    )
    .catch((err) => console.warn("[visitors] track failed:", err.message));
}

/**
 * Unique clients per hour for the last 7 days, oldest first, zero-filled for
 * hours with no traffic. Empty array when DATABASE_URL is unset.
 */
async function hourlySeries() {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT hour_bucket, count(*)::int AS clients
       FROM hourly_visitors
      WHERE hour_bucket > now() - interval '${RETENTION_DAYS} days'
      GROUP BY hour_bucket`,
  );
  const byHour = new Map(
    rows.map((r) => [new Date(r.hour_bucket).toISOString(), r.clients]),
  );
  const currentHour = hourBucketOf(Date.now());
  const out = [];
  for (let i = HOURS_IN_WINDOW - 1; i >= 0; i--) {
    const hour = new Date(currentHour.getTime() - i * 3600_000).toISOString();
    out.push({ hour, clients: byHour.get(hour) || 0 });
  }
  return out;
}

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hourly_visitors (
      hour_bucket timestamptz NOT NULL,
      ip_hash     text NOT NULL,
      PRIMARY KEY (hour_bucket, ip_hash)
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS hourly_visitors_hour ON hourly_visitors (hour_bucket)`,
  );
}

async function prune() {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM hourly_visitors WHERE hour_bucket < now() - interval '${RETENTION_DAYS} days'`,
    );
    if (rowCount) console.log(`[visitors] pruned ${rowCount} old row(s)`);
  } catch (err) {
    console.warn("[visitors] prune failed:", err.message);
  }
}

/**
 * Wire up client tracking. Safe to call unconditionally: a no-op when
 * DATABASE_URL is unset, and it swallows every startup error so the addon
 * still boots if Postgres is down.
 */
async function start() {
  if (process.env.NODE_ENV === "test") return; // never open a pool under the runner
  if (!ENABLED) {
    console.log("[visitors] disabled (no DATABASE_URL)");
    return;
  }
  try {
    pool = new Pool({
      connectionString: CONN,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.VISITORS_POOL_MAX || 2),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on("error", (err) =>
      console.warn("[visitors] idle client error:", err.message),
    );
    await ensureSchema();
    pruneTimer = setInterval(prune, 60 * 60 * 1000);
    pruneTimer.unref();
    console.log("[visitors] tracking unique clients per hour");
  } catch (err) {
    console.warn(`[visitors] disabled — startup failed: ${err.message}`);
    if (pool) {
      pool.end().catch(() => {});
      pool = null;
    }
  }
}

async function stop() {
  if (pruneTimer) clearInterval(pruneTimer);
  if (pool) await pool.end().catch(() => {});
  pool = null;
}

module.exports = { start, stop, track, hourlySeries };
