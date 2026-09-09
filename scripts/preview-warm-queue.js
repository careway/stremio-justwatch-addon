"use strict";
/**
 * Preview the order warmCache.js's tick() would process query_cache rows in,
 * without calling JustWatch. Read-only — no locks taken, nothing written.
 *
 *   node --env-file=.env.development.local scripts/preview-warm-queue.js [options]
 *
 * Mirrors tick()'s selection exactly (see src/infra/warmCache.js):
 *   - "due" = never fetched, or fetched more than REFRESH_AHEAD × its TTL ago
 *   - order = rows with no payload yet first, then by request_count DESC,
 *     then seed_priority DESC (the backfill script's ranking, only a
 *     tie-breaker among rows with no real traffic yet)
 *   - eligibility = `packages:*` rows always; every other row only if it's
 *     in the top WARM_TOP_N by that same ranking (tick() doesn't keep a
 *     long tail of barely-requested catalogs warm — see its comment)
 *
 * Options
 *   --limit N        how many rows to show (default 20)
 *   --country XX     only this country
 *   --all            ignore the "due" filter, show the full backlog ordered
 *                     the same way (handy to see what's queued but not due yet)
 */
const { Pool } = require("pg");
const { TTL_S, PACKAGES_TTL_S } = require("../src/ttl");

// Must match src/infra/warmCache.js exactly, or this stops being a preview
// of the real queue.
const REFRESH_AHEAD = 0.8;
const WARM_TOP_N = Number(process.env.WARM_TOP_N || 400);

function parseArgs(argv) {
  const o = { limit: 20, country: null, all: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--country") o.country = argv[++i].toUpperCase();
    else if (a === "--all") o.all = true;
    else {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    }
  }
  return o;
}

function dueClause() {
  const cat = Math.round(TTL_S * REFRESH_AHEAD);
  const pkg = Math.round(PACKAGES_TTL_S * REFRESH_AHEAD);
  return `(payload_at IS NULL OR payload_at < now() - (
    CASE WHEN key LIKE 'packages:%' THEN interval '${pkg} seconds'
         ELSE interval '${cat} seconds' END))`;
}

async function main() {
  const opt = parseArgs(process.argv);
  const conn = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
  if (!conn) {
    console.error("DATABASE_URL(_POOLED) not set — run with --env-file=.env.development.local");
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: conn.replace(/[?].*/, ""),
    ssl: { rejectUnauthorized: false },
    max: 2,
  });

  const RETENTION_DAYS = Number(process.env.WARM_RETENTION_DAYS || 14);
  const topNClause = `(
    key LIKE 'packages:%'
    OR key IN (
      SELECT key FROM query_cache
       WHERE key NOT LIKE 'packages:%'
         AND last_requested_at > now() - interval '${RETENTION_DAYS} days'
       ORDER BY request_count DESC, seed_priority DESC
       LIMIT ${WARM_TOP_N}
    )
  )`;
  const where = [
    `last_requested_at > now() - interval '${RETENTION_DAYS} days'`,
    ...(opt.all ? [] : [dueClause()]),
    topNClause,
    ...(opt.country ? [`vars->>'country' = $1`] : []),
  ].join(" AND ");
  const params = opt.country ? [opt.country] : [];

  const { rows } = await pool.query(
    `SELECT key, vars->>'country' AS country, request_count, seed_priority,
            payload IS NOT NULL AS has_payload, payload_at,
            round(extract(epoch from (now() - payload_at)))::int AS age_s
       FROM query_cache
      WHERE ${where}
      ORDER BY (payload IS NOT NULL), request_count DESC, seed_priority DESC
      LIMIT ${Number(opt.limit)}`,
    params,
  );

  if (!rows.length) {
    console.log(opt.all ? "Backlog is empty." : "Nothing due right now.");
    await pool.end();
    return;
  }

  console.log(
    `${opt.all ? "Full backlog" : "Next due"}, in the exact order tick() would process them:\n`,
  );
  rows.forEach((r, i) => {
    const status = r.has_payload
      ? `refresh (${r.age_s}s old, TTL ${r.key.startsWith("packages:") ? PACKAGES_TTL_S : TTL_S}s)`
      : "first fill (no payload yet)";
    console.log(
      `  ${String(i + 1).padStart(3)}. [rc=${String(r.request_count).padStart(4)}] ${r.key}  —  ${status}`,
    );
  });

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
